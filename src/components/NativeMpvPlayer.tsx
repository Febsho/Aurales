import { useEffect, useRef, useState, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SubtitleResult } from '../types'
import { logEvent } from '../services/diagnostics'
import { getTmdbApiKey } from '../services/apiKeys'
import { downloadSubtitle, launchEmbeddedPlayer, resizeEmbeddedPlayer, sendPlayerCommand, stopEmbeddedPlayer, getPlayerProperty, getPlayerSnapshot, isEmbeddedPlayerRunning, writeTempSubtitle, updateTempSubtitle, readTempSubtitle, extractEmbeddedSubtitle, openRouterChat } from '../services/player'
import { onSimklPlaybackStart, onSimklPlaybackStop, onSimklPlaybackPause, saveSimklPlaybackProgress } from '../services/simkl/playback'
import type { PlaybackItem } from '../services/simkl/playback'
import { isAuthenticated as isTraktAuthenticated } from '../services/trakt/auth'
import {
  scrobbleStart as traktScrobbleStart,
  scrobblePause as traktScrobblePause,
  scrobbleStop as traktScrobbleStop,
  buildMovieScrobble,
  buildEpisodeScrobble,
  buildMappedEpisodeScrobble,
} from '../services/trakt/scrobble'
import {
  getPMDBSkips,
  savePMDBPlaybackProgress,
  scrobblePMDB,
  removePMDBWatched,
  lookupTmdbId
} from '../services/pmdb'
import { scrobbleMdblist, hasMdblistOAuth } from '../services/mdblist'
import { saveAniListProgress, saveAniListProgressMapped } from '../services/anilist'
import type { PMDBSkipSegment } from '../services/pmdb'
import { getIntroDBSkips } from '../services/introdb'
import { getAddonStreams, getStreamAddons } from '../services/addons'
import { useAppStore, getLanguageCodeFromTrack, APP_LANGUAGES } from '../stores/appStore'
import { setDiscordActivity, restoreDiscordBrowsingActivity } from '../services/discord'
import { minimalMpvPlayer } from '../services/player/minimalMpvPlayer'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import {
  play as wtPlay,
  pause as wtPause,
  seek as wtSeek,
  sendBuffering as wtSendBuffering,
  reportLocalPlayback as wtReportLocalPlayback,
  clearLocalPlayback as wtClearLocalPlayback,
} from '../services/watch-together/wsClient'
import { shouldCorrectDrift, markCorrectionApplied, resetDriftState } from '../services/watch-together/driftCorrection'
import PlayerChatOverlay from './watch-together/PlayerChatOverlay'
import PlayerDrawOverlay from './watch-together/PlayerDrawOverlay'
import { recordPlaybackSample } from '../services/viewingActivity'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NativeMpvPlayerProps {
  url: string
  title: string
  subtitle?: string
  subtitles?: SubtitleResult[]
  playbackItem?: PlaybackItem
  startTime?: number
  poster?: string
  backdrop?: string
  onClose: () => void
  onPickAnother: () => void
  onPlaybackError?: (message: string) => void
  onPlaybackStarted?: () => void
  onReportBad?: () => void
}

interface MpvTrack {
  id: number
  type: 'video' | 'audio' | 'sub'
  lang?: string
  title?: string
  selected?: boolean
  default?: boolean
  forced?: boolean
  external?: boolean
  'external-filename'?: string
  filename?: string
  'ff-index'?: number
}

interface TrackOption {
  id: number
  label: string
  lang?: string
  priority: number
}

interface NextEpInfo {
  season: number
  episode: number
  title: string
  overview?: string
  runtime?: number
  stillPath?: string
}

interface SubtitleSource {
  originalUrl: string
  localPath: string
  label: string
}

interface TimelinePreview {
  visible: boolean
  leftPct: number
  time: number
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function languageName(value?: string): string {
  const code = getLanguageCodeFromTrack(value)
  return APP_LANGUAGES.find((lang) => lang.code === code)?.name || value?.toUpperCase() || 'Unknown'
}

function trackLabel(track: MpvTrack, fallback: string): string {
  if (track.title?.endsWith('(Translated)')) return track.title
  if (track.title?.includes(' · ')) return track.title
  const details = [track.default ? 'Default' : '', track.forced ? 'Forced' : ''].filter(Boolean)
  const source = track.external ? 'External' : 'Embedded'
  const language = languageName(track.lang)
  const title = track.title && track.title.toLowerCase() !== language.toLowerCase() ? ` · ${track.title}` : ''
  return `${language || fallback}${title} · ${source}${details.length ? ` · ${details.join(', ')}` : ''}`
}

function trackPriority(track: MpvTrack): number {
  if (track.title?.endsWith('(Translated)')) return 0
  if (!track.external) return 1
  if (track.title?.includes(' · Stream · ')) return 2
  return 3
}

function normalizeSubtitlePath(path?: string): string {
  return (path || '').replace(/\\/g, '/').toLowerCase()
}

function stripAiSubtitleResponse(value: string): string {
  return value
    .trim()
    .replace(/^```(?:srt|vtt|ass|ssa|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function formatSrtTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const wholeSeconds = Math.floor(safe % 60)
  const millis = Math.floor((safe - Math.floor(safe)) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

interface SubCue {
  start: number // seconds
  end: number   // seconds
  text: string
}

// Parses SRT or WebVTT content into ordered cues. Strips markup/ASS overrides.
function parseSubCueTimestamp(ts: string): number {
  const m = ts.trim().replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)/)
  if (!m) return NaN
  const h = m[1] ? Number(m[1]) : 0
  return h * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function parseSubtitleCues(content: string): SubCue[] {
  const cues: SubCue[] = []
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const tlIdx = lines.findIndex((l) => l.includes('-->'))
    if (tlIdx === -1) continue
    const [rawStart, rawEnd] = lines[tlIdx].split('-->')
    const start = parseSubCueTimestamp(rawStart)
    if (!Number.isFinite(start)) continue
    const end = parseSubCueTimestamp(rawEnd || '')
    const text = lines
      .slice(tlIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')       // HTML/VTT tags
      .replace(/\{\\[^}]*\}/g, '')   // ASS override blocks
      .trim()
    if (!text) continue
    cues.push({ start, end: Number.isFinite(end) && end > start ? end : start + 3, text })
  }
  return cues.sort((a, b) => a.start - b.start)
}

function buildVideoViewport() {
  const scale = window.devicePixelRatio || 1
  return {
    x: 0,
    y: 0,
    width: Math.round(window.innerWidth * scale),
    height: Math.round(window.innerHeight * scale),
  }
}

async function resolvePmdbPlaybackEpisode(
  item: PlaybackItem,
  tmdbId: number,
): Promise<{ tmdbId: number; season?: number; episode?: number }> {
  if (!item.isAnime || item.contentType !== 'series' || item.tvdbId == null || item.season == null || item.episode == null) {
    return { tmdbId, season: item.season, episode: item.episode }
  }

  try {
    const { mapTvdbEpisodeToAnimeProviders, shouldFlattenPmdbAnimeEpisodes } = await import('../services/animeLists')
    const mapped = await mapTvdbEpisodeToAnimeProviders(item.tvdbId, item.season, item.episode)
    if (!mapped?.tmdbId) return { tmdbId, season: item.season, episode: item.episode }
    if (await shouldFlattenPmdbAnimeEpisodes(item.tvdbId, mapped.tmdbId)) {
      return { tmdbId: mapped.tmdbId, season: 1, episode: mapped.episode }
    }
    return { tmdbId: mapped.tmdbId, season: mapped.season, episode: mapped.episode }
  } catch (_) {
    return { tmdbId, season: item.season, episode: item.episode }
  }
}

function buildUpNextPipViewport() {
  const scale = window.devicePixelRatio || 1
  const width = Math.min(Math.max(window.innerWidth * 0.28, 360), 560)
  const height = width * 9 / 16
  const margin = 32
  return {
    x: Math.round((window.innerWidth - width - margin) * scale),
    y: Math.round(72 * scale),
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}

function highQualityTmdbImage(url?: string) {
  if (!url) return undefined
  return url.replace('/t/p/w300', '/t/p/original')
    .replace('/t/p/w500', '/t/p/original')
    .replace('/t/p/w780', '/t/p/original')
    .replace('/t/p/w1280', '/t/p/original')
}

function formatTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

async function fetchNextEpisodeFromTmdb(
  tmdbId: number,
  season: number,
  episode: number
): Promise<NextEpInfo | null> {
  const apiKey = getTmdbApiKey()

  const tryFetch = async (s: number, e: number): Promise<NextEpInfo | null> => {
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${s}/episode/${e}?api_key=${apiKey}`
      )
      if (!res.ok) return null
      const data = await res.json()
      if (!data.name) return null
      return {
        season: s,
        episode: e,
        title: data.name,
        overview: data.overview || undefined,
        runtime: data.runtime || undefined,
        stillPath: data.still_path
          ? `https://image.tmdb.org/t/p/original${data.still_path}`
          : undefined,
      }
    } catch (_) {
      return null
    }
  }

  // `episode` is already the next episode number — fetch it directly.
  // (Callers pass `currentEpisode + 1`; don't increment again.)
  const next = await tryFetch(season, episode)
  if (next) return next
  // If it's the last episode of the season, try S+1 E1
  return tryFetch(season + 1, 1)
}

// Metadata for the currently-playing item, shown in the paused info overlay.
interface CurrentItemMeta {
  overview?: string
  runtime?: number      // minutes
  year?: number
  genres?: string[]
  rating?: number       // vote_average (0–10)
  episodeTitle?: string // TV only
  epCode?: string       // "S01E03", TV only
  stillPath?: string    // TV episode still (original quality)
}

// Fetches rich metadata about the *current* item for the paused overlay.
// TV/anime → episode name/overview/runtime/still plus show-level genres/rating.
// Movie → overview/runtime/year/genres/rating.
async function fetchCurrentItemMeta(
  tmdbId: number,
  isEpisodic: boolean,
  season?: number,
  episode?: number,
): Promise<CurrentItemMeta | null> {
  const apiKey = getTmdbApiKey()
  if (!apiKey) return null
  const tmdbGet = async (path: string): Promise<any | null> => {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${path}?api_key=${apiKey}`)
      if (!res.ok) return null
      return await res.json()
    } catch (_) {
      return null
    }
  }

  if (isEpisodic && season != null && episode != null) {
    const [ep, show] = await Promise.all([
      tmdbGet(`/tv/${tmdbId}/season/${season}/episode/${episode}`),
      tmdbGet(`/tv/${tmdbId}`),
    ])
    if (!ep && !show) return null
    const genres = Array.isArray(show?.genres)
      ? show.genres.map((g: any) => g?.name).filter(Boolean) as string[]
      : undefined
    return {
      overview: ep?.overview || show?.overview || undefined,
      runtime: ep?.runtime || undefined,
      year: (show?.first_air_date as string)?.slice(0, 4)
        ? Number((show.first_air_date as string).slice(0, 4))
        : undefined,
      genres: genres?.length ? genres : undefined,
      rating: typeof show?.vote_average === 'number' ? show.vote_average : undefined,
      episodeTitle: ep?.name || undefined,
      epCode: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
      stillPath: ep?.still_path
        ? `https://image.tmdb.org/t/p/original${ep.still_path}`
        : undefined,
    }
  }

  const movie = await tmdbGet(`/movie/${tmdbId}`)
  if (!movie) return null
  const genres = Array.isArray(movie.genres)
    ? movie.genres.map((g: any) => g?.name).filter(Boolean) as string[]
    : undefined
  return {
    overview: movie.overview || undefined,
    runtime: movie.runtime || undefined,
    year: (movie.release_date as string)?.slice(0, 4)
      ? Number((movie.release_date as string).slice(0, 4))
      : undefined,
    genres: genres?.length ? genres : undefined,
    rating: typeof movie.vote_average === 'number' ? movie.vote_average : undefined,
  }
}

// ── Sub-component: Up Next Overlay ────────────────────────────────────────────

interface UpNextOverlayProps {
  nextEp: NextEpInfo
  showBackdrop?: string
  countdown: number
  isSearching: boolean
  onPlay: () => void
  onDismiss: () => void
}

function UpNextOverlay({ nextEp, showBackdrop, countdown, isSearching, onPlay, onDismiss }: UpNextOverlayProps) {
  const epCode = `S${String(nextEp.season).padStart(2, '0')}E${String(nextEp.episode).padStart(2, '0')}`
  const backdrop = highQualityTmdbImage(nextEp.stillPath || showBackdrop)
  const backdropStyle = backdrop
    ? {
        backgroundImage: `url(${backdrop})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundAttachment: 'fixed',
      } as CSSProperties
    : undefined
  const pipVars = {
    '--pip-w': 'clamp(360px, 28vw, 560px)',
    '--pip-h': 'calc(var(--pip-w) * 0.5625)',
    '--pip-top': '72px',
    '--pip-right': '32px',
  } as CSSProperties
  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-between overflow-hidden" style={pipVars}>
      {/* Draw the backdrop around the PIP hole so native mpv can show through. */}
      {backdropStyle && (
        <>
          <div className="absolute left-0 top-0 bottom-0 right-[calc(var(--pip-right)+var(--pip-w))]" style={backdropStyle} />
          <div className="absolute right-0 top-0 h-[var(--pip-top)] w-[calc(var(--pip-right)+var(--pip-w))]" style={backdropStyle} />
          <div className="absolute right-0 top-[var(--pip-top)] h-[var(--pip-h)] w-[var(--pip-right)]" style={backdropStyle} />
          <div className="absolute right-0 top-[calc(var(--pip-top)+var(--pip-h))] bottom-0 w-[calc(var(--pip-right)+var(--pip-w))]" style={backdropStyle} />
        </>
      )}
      <div className="absolute left-0 top-0 bottom-0 right-[calc(var(--pip-right)+var(--pip-w))] bg-gradient-to-r from-black/75 via-black/50 to-black/35" />
      <div className="absolute right-0 top-0 h-[var(--pip-top)] w-[calc(var(--pip-right)+var(--pip-w))] bg-black/35" />
      <div className="absolute right-0 top-[var(--pip-top)] h-[var(--pip-h)] w-[var(--pip-right)] bg-black/35" />
      <div className="absolute right-0 top-[calc(var(--pip-top)+var(--pip-h))] bottom-0 w-[calc(var(--pip-right)+var(--pip-w))] bg-gradient-to-t from-black/70 via-black/35 to-black/20" />
      <div className="absolute right-[var(--pip-right)] top-[var(--pip-top)] w-[var(--pip-w)] h-[var(--pip-h)] rounded-2xl border border-white/20 shadow-2xl bg-transparent pointer-events-none">
        <div className="absolute inset-0 rounded-2xl ring-1 ring-white/15 shadow-[0_0_80px_rgba(0,0,0,0.9)]" />
        <span className="absolute left-3 top-2 rounded-full bg-black/55 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65 backdrop-blur-sm">
          Now Playing
        </span>
      </div>

      {/* Up Next label */}
      <div className="relative z-10 pt-10 pl-10">
        <span className="text-xs font-semibold tracking-[0.2em] uppercase text-white/60">Up Next</span>
      </div>

      {/* Bottom episode info */}
      <div className="relative z-10 pb-10 px-10" style={{ paddingRight: 'calc(var(--pip-right) + var(--pip-w) + 40px)' }}>
        <div className="flex items-end gap-6 max-w-5xl">
          {/* Episode still */}
          {nextEp.stillPath && (
            <div className="flex-shrink-0 w-44 rounded-lg overflow-hidden aspect-video bg-white/10 shadow-2xl">
              <img src={nextEp.stillPath} className="w-full h-full object-cover" draggable={false} />
            </div>
          )}

          {/* Episode info */}
          <div className="flex-1 min-w-0 pb-1">
            <p className="text-xs text-white/50 font-medium tracking-wider mb-1">{epCode}</p>
            <h3 className="text-xl font-bold text-white leading-tight truncate">{nextEp.title}</h3>
            {nextEp.overview && (
              <p className="text-sm text-white/55 mt-1.5 line-clamp-2 leading-relaxed">{nextEp.overview}</p>
            )}
            {nextEp.runtime != null && (
              <p className="text-xs text-white/35 mt-1">{nextEp.runtime} min</p>
            )}

            {/* Action row */}
            <div className="flex items-center gap-3 mt-4">
              <button
                onClick={onPlay}
                disabled={isSearching}
                className="flex items-center gap-2.5 px-5 py-2.5 bg-white text-black rounded-lg font-semibold text-sm hover:bg-white/90 disabled:opacity-70 transition-all"
              >
                {isSearching ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                    Finding stream…
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Playing in {countdown}…
                  </>
                )}
              </button>

              <button
                onClick={onDismiss}
                className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                title="Dismiss"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Countdown progress bar */}
        <div className="mt-5 h-0.5 bg-white/15 rounded-full overflow-hidden">
          <div
            className="h-full bg-white/70 rounded-full transition-all duration-1000 ease-linear"
            style={{ width: `${((15 - countdown) / 15) * 100}%` }}
          />
        </div>
      </div>
    </div>
  )
}

// ── Sub-component: Paused Info Overlay (Netflix-style) ────────────────────────

interface PausedInfoOverlayProps {
  title: string
  subtitle?: string
  backdrop?: string
  meta: CurrentItemMeta | null
}

function PausedInfoOverlay({ title, subtitle, backdrop, meta }: PausedInfoOverlayProps) {
  const image = highQualityTmdbImage(meta?.stillPath || backdrop)
  const isEpisodic = !!meta?.epCode
  // Meta line: TV → "S01E03 · Episode Name"; movie → "2024 · ★ 8.1 · 142 min".
  const metaBits: string[] = []
  if (isEpisodic) {
    if (meta?.epCode) metaBits.push(meta.epCode)
    if (meta?.episodeTitle) metaBits.push(meta.episodeTitle)
  } else {
    if (meta?.year != null) metaBits.push(String(meta.year))
    if (meta?.rating != null && meta.rating > 0) metaBits.push(`★ ${meta.rating.toFixed(1)}`)
    if (meta?.runtime != null) metaBits.push(`${meta.runtime} min`)
  }
  return (
    <div className="absolute inset-0 z-[5] overflow-hidden pointer-events-none animate-fade-in">
      {/* Backdrop (covers the frozen mpv frame when artwork exists) */}
      {image && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${image})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {/* Scrims: darken left + bottom for legibility */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/45 to-black/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/25" />

      {/* Info block — lower third, left aligned */}
      <div className="absolute left-0 bottom-0 px-16 pb-24 max-w-3xl">
        <p className="text-sm font-semibold tracking-[0.2em] uppercase text-white/55 mb-3">You're watching</p>
        <h1 className="text-4xl md:text-5xl font-bold text-white leading-tight drop-shadow-lg">{title}</h1>
        {metaBits.length > 0 && (
          <p className="mt-3 text-base text-white/70 font-medium">{metaBits.join('  ·  ')}</p>
        )}
        {!metaBits.length && subtitle && (
          <p className="mt-3 text-sm text-white/60 tracking-wider uppercase">{subtitle}</p>
        )}
        {meta?.genres?.length ? (
          <p className="mt-2 text-sm text-white/45">{meta.genres.slice(0, 3).join(' · ')}</p>
        ) : null}
        {meta?.overview && (
          <p className="mt-4 text-base text-white/70 leading-relaxed line-clamp-3">{meta.overview}</p>
        )}
      </div>
    </div>
  )
}

// ── Track Menu ────────────────────────────────────────────────────────────────

interface TrackMenuPanelProps {
  type: 'subs' | 'audio'
  tracks: TrackOption[]
  selected: number | 'no'
  onSelect: (id: number | 'no') => void
  onClose: () => void
  onToggleTranslate?: () => void
  translateActive?: boolean
  hasTranslateKey?: boolean
}

function TrackMenuPanel({ type, tracks, selected, onSelect, onClose, onToggleTranslate, translateActive, hasTranslateKey }: TrackMenuPanelProps) {
  return (
    <div className="absolute bottom-full right-0 mb-3 w-56 bg-black/95 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl py-1.5 z-30 max-h-80 overflow-y-auto">
      <div className="px-4 py-1.5 text-[10px] font-semibold tracking-wider text-white/35 uppercase">
        {type === 'subs' ? 'Subtitles' : 'Audio Track'}
      </div>
      {type === 'subs' && (
        <button
          onClick={() => { onSelect('no'); onClose() }}
          className={`w-full text-left px-4 py-2 text-sm hover:bg-white/8 transition-colors ${selected === 'no' ? 'text-white font-medium' : 'text-white/60'}`}
        >
          Off
        </button>
      )}
      {tracks.map(t => (
        <button
          key={t.id}
          onClick={() => { onSelect(t.id); onClose() }}
          className={`w-full text-left px-4 py-2 text-sm hover:bg-white/8 transition-colors flex items-center gap-2 ${selected === t.id ? 'text-white font-medium' : 'text-white/60'}`}
        >
          {selected === t.id && (
            <svg className="w-3 h-3 flex-shrink-0 text-accent" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          <span className={`truncate ${selected === t.id ? '' : 'pl-5'}`}>{t.label}</span>
        </button>
      ))}
      {tracks.length === 0 && type === 'audio' && (
        <div className="px-4 py-2 text-sm text-white/35">No tracks detected</div>
      )}
      {type === 'subs' && hasTranslateKey && (
        <>
          <div className="mx-3 my-1 border-t border-white/8" />
          <button
            onClick={() => { onClose(); onToggleTranslate?.() }}
            className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center gap-2 ${
              translateActive ? 'text-purple-300 bg-purple-500/15' : 'text-purple-300/60 hover:bg-purple-500/10'
            }`}
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M12.5 18l3.5-7 3.5 7M14.5 16h5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {translateActive ? '● Live Translate On' : 'Live Translate'}
          </button>
        </>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

interface PlayerSession {
  id: string
  mediaId: string
  streamUrl: string
  startedAt: number
  status: "starting" | "playing" | "paused" | "buffering" | "stopped" | "error"
}

let latestFullPlayerSessionId: string | null = null

// True when we're a watch-together guest without playback-control rights.
// Local transport actions (pause, seek) are blocked so the guest doesn't
// desync from the room and then get yanked back by drift correction.
function wtControlBlocked(): boolean {
  const wt = useWatchTogetherStore.getState()
  if (!wt.currentRoom || !wt.currentUserId) return false
  return wt.currentRoom.hostUserId !== wt.currentUserId && !wt.currentRoom.everyoneCanControl
}

// mpv args derived from settings that aren't first-class launch params.
function buildMpvExtraArgs(storeState: { mpvCustomArgs: string; audioPassthrough: boolean }): string {
  const parts = [storeState.mpvCustomArgs?.trim() ?? '']
  if (storeState.audioPassthrough && !parts[0].includes('--audio-spdif')) {
    parts.push('--audio-spdif=ac3,eac3,dts,dts-hd,truehd')
  }
  return parts.filter(Boolean).join(' ')
}

function playerUrlHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function IsolatedNativeMpvPlayer({ url, title, startTime, onClose, onPickAnother }: NativeMpvPlayerProps) {
  const hwdecMode = useAppStore((state) => state.isolatedPlaybackHwdec)
  const resumeEnabled = useAppStore((state) => state.isolatedPlaybackResume)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    console.debug('[PLAYER MOUNT] isolated player', new Error().stack)
    return () => {
      console.debug('[PLAYER UNMOUNT] isolated player; process intentionally retained', new Error().stack)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    minimalMpvPlayer.play(url, {
      title,
      startTime: resumeEnabled ? startTime : undefined,
      hwdecMode,
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { cancelled = true }
  }, [url, title, startTime, hwdecMode, resumeEnabled])

  const close = async (pickAnother = false) => {
    await minimalMpvPlayer.stop(pickAnother ? 'pick-another-stream' : 'close-player').catch(() => {})
    if (pickAnother) onPickAnother()
    else onClose()
  }

  const overlay = (
    <div className="fixed inset-0 z-[60] select-none bg-black text-white">
      <div className="absolute left-0 top-0 z-10 flex gap-3 p-6">
        <button onClick={() => close(false)} className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/60 text-2xl">‹</button>
        <button onClick={() => close(true)} className="rounded-full border border-white/15 bg-black/60 px-4 text-sm font-semibold">Change stream</button>
      </div>
      <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
        <div>
          <p className="text-lg font-semibold">Isolated playback is running in a separate mpv window.</p>
          <p className="mt-2 text-sm text-white/55">Use mpv's native controls. Aurales IPC and window hooks are disabled.</p>
          <p className="mt-4 text-xs text-white/35">Hardware decoding: {hwdecMode}</p>
        </div>
      </div>
      {error && <div className="absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-xl border border-red-500/30 bg-red-950/85 px-5 py-3 text-sm text-red-100">{error}</div>}
    </div>
  )

  return createPortal(overlay, document.body)
}

function FullNativeMpvPlayer({
  url,
  title,
  subtitle,
  subtitles = [],
  playbackItem,
  startTime,
  poster,
  backdrop,
  onClose,
  onPickAnother,
  onPlaybackError,
  onPlaybackStarted,
  onReportBad,
}: NativeMpvPlayerProps) {

  // ─ Refs ───────────────────────────────────────────────────────────────────
  const activeSessionRef = useRef<PlayerSession | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const trackPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const delayedPlayerTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const schedulePlayerTimeout = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      delayedPlayerTimersRef.current.delete(timer)
      callback()
    }, delay)
    delayedPlayerTimersRef.current.add(timer)
  }, [])

  useEffect(() => () => {
    delayedPlayerTimersRef.current.forEach((timer) => clearTimeout(timer))
    delayedPlayerTimersRef.current.clear()
  }, [])
  const loadedSubtitleUrlsRef = useRef<Set<string>>(new Set())
  const autoSkippedSegmentsRef = useRef<Set<string>>(new Set())
  const subtitleSourcesRef = useRef<Map<string, SubtitleSource>>(new Map())
  const subtitleTrackSourcesRef = useRef<Map<number, SubtitleSource>>(new Map())
  const aiSubtitleTrackIdRef = useRef<number | null>(null)
  const aiSubtitleSourceTrackIdRef = useRef<number | null>(null)
  const progressRef = useRef({ currentTime: 0, duration: 0 })
  const lastSavedTimeRef = useRef(0)
  const lastSimklPlaybackSaveRef = useRef(0)
  const lastPmdbPlaybackSaveRef = useRef(0)
  const lastAniListPlaybackSaveRef = useRef(0)
  const lastVolumeEnforceRef = useRef(0)
  const lastPauseRef = useRef<boolean | null>(null)
  const lastBufferingRef = useRef<boolean | null>(null)
  const lastCacheBuffStateRef = useRef<number | null>(null)
  const lastDemuxerCacheDurRef = useRef<number | null>(null)
  const lastEofReachedRef = useRef<boolean | null>(null)
  const lastIdleActiveRef = useRef<boolean | null>(null)
  const lastCoreIdleRef = useRef<boolean | null>(null)
  const lastTimePosUpdateRef = useRef<number>(Date.now())
  const lastTimePosValRef = useRef<number>(-1)
  const autoRestartCountRef = useRef<number>(0)
  const lastRestartTimeRef = useRef<number>(0)
  // Counts auto-select attempts; capped at 10. Resets to 0 on episode transition.
  const autoSelectAttemptsRef = useRef(0)
  const hasAutoSelectedAudioRef = useRef(false)
  const hasAutoSelectedSubRef = useRef(false)
  const tmdbIdRef = useRef<number | undefined>(
    playbackItem?.tmdbId
      ? Number(playbackItem.tmdbId)
      : playbackItem?.localId?.startsWith('tmdb-')
        ? Number(playbackItem.localId.replace('tmdb-', ''))
        : undefined
  )

  // Mutable refs for current playback (updated on autoplay transition)
  const currentItemRef = useRef<PlaybackItem | undefined>(playbackItem)
  const currentPosterRef = useRef<string | undefined>(poster)
  const currentBackdropRef = useRef<string | undefined>(backdrop)
  // The URL mpv is currently playing (updated on autoplay transition). Used as a
  // fallback source for embedded-subtitle extraction when mpv's `path` is empty.
  const currentStreamUrlRef = useRef<string | undefined>(url)
  const volumeRef = useRef<number>(100)

  // Up Next refs (accessed inside stale poll closure)
  const nextEpInfoRef = useRef<NextEpInfo | null>(null)
  const showUpNextRef = useRef(false)
  const upNextTriggeredRef = useRef(false)
  const upNextCancelledRef = useRef(false)

  // ─ State ─────────────────────────────────────────────────────────────────
  const [controlsVisible, setControlsVisible] = useState(true)
  const [paused, setPaused] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const eofClosedRef = useRef(false)
  const closeRef = useRef<(() => Promise<void>) | null>(null)
  const closingRef = useRef(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Ref mirror avoids stale closures; windowedBoundsRef restores size on exit.
  const isFullscreenRef = useRef(false)
  useEffect(() => { isFullscreenRef.current = isFullscreen }, [isFullscreen])
  const windowedBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const fullscreenMonitorBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const fullscreenTransitionRef = useRef(0)
  const [error, setError] = useState('')
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subTracks, setSubTracks] = useState<TrackOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState<number>(1)
  const [selectedSub, setSelectedSub] = useState<number | 'no'>('no')
  const [tracksLoaded, setTracksLoaded] = useState(false)
  const [playerReady, setPlayerReady] = useState(false)
  const [playerRunning, setPlayerRunning] = useState(true)
  const smartStartedNotifiedRef = useRef(false)
  const smartErrorNotifiedRef = useRef(false)
  useEffect(() => { smartStartedNotifiedRef.current = false; smartErrorNotifiedRef.current = false }, [url])
  useEffect(() => {
    if (playerReady && !smartStartedNotifiedRef.current) { smartStartedNotifiedRef.current = true; onPlaybackStarted?.() }
  }, [playerReady, onPlaybackStarted])
  useEffect(() => {
    if (error && !playerReady && !smartErrorNotifiedRef.current) { smartErrorNotifiedRef.current = true; onPlaybackError?.(error) }
  }, [error, playerReady, onPlaybackError])
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [skips, setSkips] = useState<PMDBSkipSegment[]>([])
  const [activeSkip, setActiveSkip] = useState<PMDBSkipSegment | null>(null)
  const [skipType, setSkipType] = useState<'intro' | 'credits' | 'recap' | null>(null)
  const [trackMenu, setTrackMenu] = useState<'subs' | 'audio' | null>(null)
  const [showTimeRemaining, setShowTimeRemaining] = useState(true)
  const [isDragging, setIsDragging] = useState(false)
  const [draggingProgress, setDraggingProgress] = useState(0)
  const draggingProgressRef = useRef(0)
  const [accumulatedSeek, setAccumulatedSeek] = useState<number | null>(null)
  const accumulatedSeekRef = useRef<number | null>(null)

  // Timeline Preview (timestamp bubble while scrubbing)
  const [timelinePreview, setTimelinePreview] = useState<TimelinePreview>({ visible: false, leftPct: 0, time: 0 })
  const isDraggingRef = useRef(false)


  // Up Next state
  const [nextEpInfo, setNextEpInfo] = useState<NextEpInfo | null>(null)
  const [showUpNext, setShowUpNext] = useState(false)
  const [upNextCountdown, setUpNextCountdown] = useState(10)
  const [isAutoSearching, setIsAutoSearching] = useState(false)

  // AI subtitle track generation
  const [liveTranslateOn, setLiveTranslateOn] = useState(false)
  const [translatingSubtitles, setTranslatingSubtitles] = useState(false)
  const [translatedText, setTranslatedText] = useState('')
  const [currentSubText, setCurrentSubText] = useState('')
  const liveTranslateCacheRef = useRef<Map<string, string>>(new Map())
  const liveTranslatePendingRef = useRef<string>('')
  const liveAiSubtitlePathRef = useRef<string | null>(null)
  const liveAiSubtitleContentRef = useRef('')
  const liveAiCueIndexRef = useRef(0)
  const liveAiLastCueRef = useRef('')
  // Full source subtitle cue list (with original timestamps) for ahead-of-time
  // translation, plus a reentry guard so start can't run twice concurrently.
  const sourceCuesRef = useRef<SubCue[]>([])
  const sourceNextIdxRef = useRef(0) // next source cue to translate (persists across effect re-runs)
  const aiStartInProgressRef = useRef(false)

  // Current display title/subtitle — updated when autoplay transitions episodes
  const [currentDisplayTitle, setCurrentDisplayTitle] = useState(title)
  const [currentDisplaySubtitle, setCurrentDisplaySubtitle] = useState(subtitle)

  // Netflix-style paused info overlay — metadata fetched lazily on first pause.
  const [currentMeta, setCurrentMeta] = useState<CurrentItemMeta | null>(null)
  useEffect(() => {
    if (!paused || currentMeta) return
    const tmdbId = tmdbIdRef.current
    if (!tmdbId) return
    const item = currentItemRef.current
    const isEpisodic = item?.contentType === 'series'
    let cancelled = false
    fetchCurrentItemMeta(tmdbId, isEpisodic, item?.season, item?.episode)
      .then((info) => { if (!cancelled && info) setCurrentMeta(info) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [paused, currentMeta])

  // Volume — persisted in localStorage between sessions
  const [volume, setVolume] = useState<number>(() => {
    const stored = localStorage.getItem('orynt_volume')
    const n = stored !== null ? Number(stored) : 100
    return isNaN(n) ? 100 : Math.max(0, Math.min(130, n))
  })

  // Playback speed
  const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const changeSpeed = useCallback((speed: number) => {
    setPlaybackSpeed(speed)
    setShowSpeedMenu(false)
    sendPlayerCommand('set_property', ['speed', speed]).catch(() => {})
  }, [])

  // Store
  const scrobbleSimkl = useAppStore((s) => s.scrobbleSimkl)
  const simklSaveResumePosition = useAppStore((s) => s.simklSaveResumePosition)
  const traktSaveResumePosition = useAppStore((s) => s.traktSaveResumePosition)
  const scrobbleTrakt = useAppStore((s) => s.scrobbleTrakt)
  const scrobblePmdb = useAppStore((s) => s.scrobblePmdb)
  const scrobbleMdblistEnabled = useAppStore((s) => s.scrobbleMdblist)
  const scrobbleAnilist = useAppStore((s) => s.scrobbleAnilist)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()
  const pmdbSaveResumePosition = useAppStore((s) => s.pmdbSaveResumePosition)
  const mdblistSaveResumePosition = useAppStore((s) => s.mdblistSaveResumePosition)
  const autoSkipSegments = useAppStore((s) => s.autoSkipSegments)
  const openrouterApiKey = useAppStore((s) => s.openrouterApiKey)
  const openrouterModel = useAppStore((s) => s.openrouterModel)
  const subtitleTranslationLang = useAppStore((s) => s.subtitleTranslationLang)
  const subtitleTranslationEnabled = useAppStore((s) => s.subtitleTranslationEnabled)
  const subtitleFontSize = useAppStore((s) => s.subtitleFontSize)
  const subtitleBgOpacity = useAppStore((s) => s.subtitleBgOpacity)
  const subtitleColor = useAppStore((s) => s.subtitleColor)
  const subtitleBorderStyle = useAppStore((s) => s.subtitleBorderStyle)
  const subtitleScale = useAppStore((s) => s.subtitleScale)
  const subtitleBold = useAppStore((s) => s.subtitleBold)
  const subtitleItalic = useAppStore((s) => s.subtitleItalic)
  const subtitleOutlineColor = useAppStore((s) => s.subtitleOutlineColor)
  const subtitleBgColor = useAppStore((s) => s.subtitleBgColor)
  const subtitleOutlineThickness = useAppStore((s) => s.subtitleOutlineThickness)
  const subtitleShadowOffset = useAppStore((s) => s.subtitleShadowOffset)
  const subtitleShadowOpacity = useAppStore((s) => s.subtitleShadowOpacity)
  const subtitleVerticalPosition = useAppStore((s) => s.subtitleVerticalPosition)
  const subtitleAlignment = useAppStore((s) => s.subtitleAlignment)
  const subtitleHorizontalMargin = useAppStore((s) => s.subtitleHorizontalMargin)
  const subtitleTextBlur = useAppStore((s) => s.subtitleTextBlur)
  const subtitleScaleWithWindow = useAppStore((s) => s.subtitleScaleWithWindow)
  const subtitleAssOverride = useAppStore((s) => s.subtitleAssOverride)
  const contextAwareTranslation = useAppStore((s) => s.contextAwareTranslation)
  const seekStepSeconds = useAppStore((s) => s.seekStepSeconds)
  const discordRichPresence = useAppStore((s) => s.discordRichPresence)
  const isInWatchTogether = useWatchTogetherStore((s) => !!s.currentRoom)

  // Keep refs in sync with state for stale-closure access
  const pausedRef = useRef(paused)
  const wtIgnoreNextEvent = useRef(false)
  const wtIgnoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressNextWatchTogetherEvent = useCallback(() => {
    wtIgnoreNextEvent.current = true
    if (wtIgnoreTimerRef.current) clearTimeout(wtIgnoreTimerRef.current)
    wtIgnoreTimerRef.current = setTimeout(() => {
      wtIgnoreNextEvent.current = false
      wtIgnoreTimerRef.current = null
    }, 750)
  }, [])
  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { nextEpInfoRef.current = nextEpInfo }, [nextEpInfo])
  useEffect(() => { showUpNextRef.current = showUpNext }, [showUpNext])
  useEffect(() => { volumeRef.current = volume }, [volume])

  // Hide the blurred hero backdrop so the native mpv window is visible through the transparent webview
  useEffect(() => {
    const root = document.documentElement
    const wasActive = root.classList.contains('hero-bg-active')
    root.classList.remove('hero-bg-active')
    return () => { if (wasActive) root.classList.add('hero-bg-active') }
  }, [])

  // Live-sync subtitle styling to mpv when settings change during playback
  const playerRunningRef = useRef(playerRunning)
  useEffect(() => { playerRunningRef.current = playerRunning }, [playerRunning])
  useEffect(() => {
    if (!playerRunningRef.current) return
    
    sendPlayerCommand('set_property', ['sub-font-size', subtitleFontSize]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-scale', subtitleScale]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-bold', subtitleBold ? 'yes' : 'no']).catch(() => {})
    sendPlayerCommand('set_property', ['sub-italic', subtitleItalic ? 'yes' : 'no']).catch(() => {})
    sendPlayerCommand('set_property', ['sub-color', subtitleColor]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-border-color', subtitleOutlineColor]).catch(() => {})
    
    const bgAlpha = Math.round(Number(subtitleBgOpacity) * 255).toString(16).padStart(2, '0')
    const cleanBgColor = subtitleBgColor.replace('#', '')
    sendPlayerCommand('set_property', ['sub-back-color', `#${bgAlpha}${cleanBgColor}`]).catch(() => {})
    
    if (subtitleBorderStyle === 'outline') {
      sendPlayerCommand('set_property', ['sub-border-size', subtitleOutlineThickness]).catch(() => {})
      sendPlayerCommand('set_property', ['sub-shadow-offset', 0]).catch(() => {})
    } else if (subtitleBorderStyle === 'shadow') {
      sendPlayerCommand('set_property', ['sub-border-size', 0]).catch(() => {})
      sendPlayerCommand('set_property', ['sub-shadow-offset', subtitleShadowOffset]).catch(() => {})
      const shadowAlpha = Math.round(subtitleShadowOpacity * 255).toString(16).padStart(2, '0')
      sendPlayerCommand('set_property', ['sub-shadow-color', `#${shadowAlpha}000000`]).catch(() => {})
    } else {
      sendPlayerCommand('set_property', ['sub-border-size', 0]).catch(() => {})
      sendPlayerCommand('set_property', ['sub-shadow-offset', 0]).catch(() => {})
    }

    sendPlayerCommand('set_property', ['sub-pos', subtitleVerticalPosition]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-align-x', subtitleAlignment]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-margin-x', subtitleHorizontalMargin]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-blur', subtitleTextBlur]).catch(() => {})
    sendPlayerCommand('set_property', ['sub-scale-with-window', subtitleScaleWithWindow ? 'yes' : 'no']).catch(() => {})
    
    const overrideMap: Record<string, string> = {
      apply: 'no',
      scale_only: 'scale_only',
      ignore: 'yes'
    }
    sendPlayerCommand('set_property', ['sub-ass-override', overrideMap[subtitleAssOverride] || 'scale_only']).catch(() => {})
  }, [
    subtitleFontSize, subtitleColor, subtitleBgOpacity, subtitleBorderStyle, subtitleScale,
    subtitleBold, subtitleItalic, subtitleOutlineColor, subtitleBgColor, subtitleOutlineThickness,
    subtitleShadowOffset, subtitleShadowOpacity, subtitleVerticalPosition, subtitleAlignment,
    subtitleHorizontalMargin, subtitleTextBlur, subtitleScaleWithWindow, subtitleAssOverride
  ])

  const applySavedVolume = useCallback((delays = [0, 250, 750, 1500, 3000]) => {
    const target = volumeRef.current
    delays.forEach((delay) => {
      setTimeout(() => {
        sendPlayerCommand('set_property', ['volume', target]).catch(() => {})
      }, delay)
    })
  }, [])

  const sendWatchTogetherSeek = useCallback((targetTime: number) => {
    if (!Number.isFinite(targetTime)) return
    const wt = useWatchTogetherStore.getState()
    if (wt.currentRoom && !wtIgnoreNextEvent.current) {
      wtSeek(Math.max(0, targetTime))
    }
  }, [])

  // ── Watch Together sync ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isInWatchTogether) return

    resetDriftState()

    const onSyncRequest = (e: Event) => {
      if (!playerRunningRef.current) return
      // Don't correct until mpv has actually loaded the file — seeking a
      // not-yet-loaded stream errors out or lands at the wrong position.
      if (progressRef.current.duration <= 0) return
      const { time, isPlaying, sentAt } = (e as CustomEvent).detail as { time: number; isPlaying: boolean; sentAt: number }

      const { driftThreshold } = useWatchTogetherStore.getState()
      const { shouldSeek, targetTime } = shouldCorrectDrift(
        progressRef.current.currentTime,
        { currentTime: time, isPlaying, lastUpdatedAt: sentAt },
        driftThreshold,
        3000,
      )

      if (shouldSeek) {
        suppressNextWatchTogetherEvent()
        sendPlayerCommand('seek', [Math.max(0, targetTime), 'absolute']).catch(() => {})
        markCorrectionApplied()
      }

      if (isPlaying && pausedRef.current) {
        suppressNextWatchTogetherEvent()
        sendPlayerCommand('set_property', ['pause', false]).catch(() => {})
      } else if (!isPlaying && !pausedRef.current) {
        suppressNextWatchTogetherEvent()
        sendPlayerCommand('set_property', ['pause', true]).catch(() => {})
      }
    }

    window.addEventListener('wt:sync_request', onSyncRequest)
    return () => {
      window.removeEventListener('wt:sync_request', onSyncRequest)
      if (wtIgnoreTimerRef.current) clearTimeout(wtIgnoreTimerRef.current)
      resetDriftState()
      wtClearLocalPlayback()
    }
  }, [isInWatchTogether, suppressNextWatchTogetherEvent])

  // ── Timeline Preview ──────────────────────────────────────────────────────
  const hideTimelinePreview = useCallback(() => {
    isDraggingRef.current = false
    setTimelinePreview((preview) => ({ ...preview, visible: false }))
  }, [])

  const updateTimelinePreviewAtPct = useCallback((leftPct: number) => {
    if (duration <= 0 || !Number.isFinite(duration)) return
    const pct = Math.max(0, Math.min(100, leftPct))
    const time = Math.max(0, Math.min(duration, (pct / 100) * duration))
    setTimelinePreview({ visible: true, leftPct: pct, time })
  }, [duration])

  const showTimelinePreviewFromPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    updateTimelinePreviewAtPct(((event.clientX - rect.left) / rect.width) * 100)
  }, [updateTimelinePreviewAtPct])

  // ─ Progress / Scrobble ───────────────────────────────────────────────────
  const saveLocalProgress = useCallback((time: number, dur: number, completedFlag: boolean) => {
    const item = currentItemRef.current
    if (!item) return
    const key = item.season != null && item.episode != null
      ? `${item.localId}:${item.season}:${item.episode}`
      : item.localId
    const progressPct = dur > 0 ? (time / dur) * 100 : 0
    const isCompleted = completedFlag || progressPct >= 85
    logEvent('PLAYBACK SYNC DEBUG', `Save watch progress local DB: ${Math.round(time)}s / ${Math.round(dur)}s (Completed: ${isCompleted})`)
    useAppStore.getState().setWatchProgress(key, {
      id: key,
      mediaType: item.contentType === 'series' ? (item.mediaType === 'anime' ? 'anime' : 'series') : 'movie',
      mediaId: item.localId,
      title: item.title,
      poster: currentPosterRef.current,
      backdrop: currentBackdropRef.current,
      season: item.season,
      episode: item.episode,
      progressSeconds: Math.floor(time),
      durationSeconds: Math.floor(dur),
      completed: isCompleted,
      updatedAt: new Date().toISOString(),
      imdbId: item.imdbId,
      tmdbId: item.tmdbId,
    })
  }, [])

  /**
   * Save resume position to PMDB and (only on explicit close/end) scrobble.
   *
   * We intentionally do NOT trust PMDB's {action:'completed'} response to
   * trigger a scrobble — PMDB uses its own stored runtime which often differs
   * from the actual stream duration, causing premature "watched" entries at
   * 33–42%.  Scrobbling is only done when OUR local progress calculation
   * reaches ≥90% AND the duration is reliably detected (≥3 minutes), i.e.
   * when the user actually finishes the content.
   */
  const savePMDBProgressHelper = useCallback((pos: number, dur: number, allowScrobble = false) => {
    const item = currentItemRef.current
    const tmdbId = tmdbIdRef.current
    const imdbId = item?.imdbId
    if (!item || !pmdbApiKey) return Promise.resolve()
    if (!tmdbId && !imdbId) return Promise.resolve()

    const isEpisodic = item.contentType === 'series'
    const mediaType = isEpisodic ? 'tv' : 'movie'
    const progress = dur > 0 ? pos / dur : 0

    // Scrobble only when: caller explicitly permits it, we're confident the
    // episode is finished (≥90%), and duration looks real (≥3 min).
    if (allowScrobble && scrobblePmdb && tmdbId && progress >= 0.90 && dur >= 180) {
      return (async () => {
        const pmdbEpisode = isEpisodic
          ? await resolvePmdbPlaybackEpisode(item, tmdbId)
          : { tmdbId, season: item.season, episode: item.episode }
        await scrobblePMDB(pmdbEpisode.tmdbId, mediaType, pmdbEpisode.season, pmdbEpisode.episode)
        if (
          isEpisodic &&
          pmdbEpisode.season != null &&
          pmdbEpisode.episode != null &&
          (pmdbEpisode.season !== item.season || pmdbEpisode.episode !== item.episode)
        ) {
          await removePMDBWatched(pmdbEpisode.tmdbId, 'tv', item.season, item.episode)
        }
      })().catch(() => {})
    }

    if (pmdbSaveResumePosition && dur > 0) {
      logEvent('PLAYBACK SYNC DEBUG', `Save PMDB resume point: ${Math.floor(pos)}s / ${Math.floor(dur)}s`)
      return (async () => {
        const pmdbEpisode = isEpisodic && tmdbId
          ? await resolvePmdbPlaybackEpisode(item, tmdbId)
          : { tmdbId, season: item.season, episode: item.episode }
        await savePMDBPlaybackProgress(
          pmdbEpisode.tmdbId,
          mediaType,
          pmdbEpisode.season,
          pmdbEpisode.episode,
          Math.floor(pos * 1000),
          Math.floor(dur * 1000),
          imdbId
        )
      })().catch(() => {})
    }

    return Promise.resolve()
  }, [pmdbApiKey, pmdbSaveResumePosition, scrobblePmdb])

  const saveMdblistProgressHelper = useCallback((pos: number, dur: number, allowScrobble = false) => {
    const item = currentItemRef.current
    const tmdbId = tmdbIdRef.current
    if (!item || !mdblistApiKey || dur <= 0) return Promise.resolve()
    const isEpisodic = item.contentType === 'series'
    const mediaType = isEpisodic ? 'series' : 'movie'
    const progressPct = Math.max(0, Math.min(100, (pos / dur) * 100))

    if (allowScrobble && scrobbleMdblistEnabled && progressPct >= 90 && dur >= 180) {
      return scrobbleMdblist('stop', tmdbId, mediaType, progressPct, item.season, item.episode, item.imdbId).catch(() => {})
    }

    if (mdblistSaveResumePosition) {
      return scrobbleMdblist('pause', tmdbId, mediaType, progressPct, item.season, item.episode, item.imdbId).catch(() => {})
    }

    return Promise.resolve()
  }, [mdblistApiKey, mdblistSaveResumePosition, scrobbleMdblistEnabled])

  // ─ Controls visibility ────────────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 4000)
  }, [])

  const command = useCallback((name: string, args: unknown[] = []) => {
    sendPlayerCommand(name, args).catch((e) => {
      const message = String(e)
      logEvent('MPV DEBUG', `command ${name} failed: ${message}`)
      if (!/IPC not ready|No player is running|Failed to send mpv command/i.test(message)) {
        setError(message)
      }
    })
  }, [])

  // ─ Subtitle loading ───────────────────────────────────────────────────────
  const loadAddonSubtitles = useCallback(async () => {
    const pending = subtitles
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => track.url && !loadedSubtitleUrlsRef.current.has(track.url!))
    if (!pending.length) return

    // Mark all as loading immediately to prevent duplicate downloads
    for (const { track } of pending) loadedSubtitleUrlsRef.current.add(track.url!)

    // Download all files in parallel
    const results = await Promise.allSettled(
      pending.map(async ({ track, index }) => {
        const lang = languageName(track.lang)
        const sourceName = track.source === 'addon' ? (track.addonName || 'Addon') : 'Stream'
        const label = `${lang} · ${sourceName} · External`
        let extension = 'srt'
        try { extension = new URL(track.url!).pathname.split('.').pop()?.slice(0, 5) || 'srt' } catch (_) {}
        const fileName = `${track.source || 'external'}-${track.lang || 'und'}-${index}.${extension}`
        const localPath = await downloadSubtitle(track.url!, fileName)
        return { track, localPath, label }
      })
    )

    // Add downloaded files to mpv sequentially (mpv IPC is single-threaded)
    for (const r of results) {
      if (r.status === 'rejected') continue
      const { track, localPath, label } = r.value
      subtitleSourcesRef.current.set(localPath, { originalUrl: track.url!, localPath, label })
      await sendPlayerCommand('sub-add', [localPath, 'auto', label, track.lang || 'und']).catch(() => {
        loadedSubtitleUrlsRef.current.delete(track.url!)
        subtitleSourcesRef.current.delete(localPath)
      })
    }

    // Clean up failed downloads so they can retry
    for (let i = 0; i < pending.length; i++) {
      if (results[i].status === 'rejected') {
        loadedSubtitleUrlsRef.current.delete(pending[i].track.url!)
      }
    }
  }, [subtitles])

  // ─ Track refresh ─────────────────────────────────────────────────────────
  const refreshTracks = useCallback(async () => {
    const data = await getPlayerProperty('track-list') as MpvTrack[]
    if (!Array.isArray(data)) return false
    const trackSources = new Map<number, SubtitleSource>()
    data
      .filter((t) => t.type === 'sub')
      .forEach((track) => {
        const trackPath = normalizeSubtitlePath(track['external-filename'] || track.filename)
        if (!trackPath) return
        const source = [...subtitleSourcesRef.current.values()].find((candidate) => {
          const sourcePath = normalizeSubtitlePath(candidate.localPath)
          return sourcePath === trackPath || trackPath.endsWith(sourcePath) || sourcePath.endsWith(trackPath)
        })
        if (source) trackSources.set(track.id, source)
      })
    subtitleTrackSourcesRef.current = trackSources
    const audio = data
      .filter((t) => t.type === 'audio')
      .map((t) => ({ id: t.id, label: trackLabel(t, `Audio ${t.id}`), lang: t.lang, priority: 0 }))
    const subs = data
      .filter((t) => t.type === 'sub')
      // Hide the AI-translated track from the list — it's driven only by the
      // "Live Translate" toggle, not picked as a normal subtitle option.
      .filter((t) => t.id !== aiSubtitleTrackIdRef.current && !t.title?.endsWith('(Translated)'))
      .map((t) => ({ id: t.id, label: trackLabel(t, `Sub ${t.id}`), lang: t.lang, priority: trackPriority(t) }))
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))
    const selAudio = data.find((t) => t.type === 'audio' && t.selected)
    const selSub = data.find((t) => t.type === 'sub' && t.selected)
    setAudioTracks(audio)
    setSubTracks(subs)
    if (selAudio) setSelectedAudio(selAudio.id)
    if (selSub) setSelectedSub(selSub.id)
    else setSelectedSub('no')

    // Auto-select preferred audio + subtitle tracks independently.
    // Keep retrying (up to 10 attempts) so we don't lock out too early when
    // mpv reports tracks before language tags are populated.
    const MAX_AUTO_SELECT = 10
    const bothDone = hasAutoSelectedAudioRef.current && hasAutoSelectedSubRef.current
    if (!bothDone && autoSelectAttemptsRef.current < MAX_AUTO_SELECT && data.length > 0) {
      autoSelectAttemptsRef.current++
      const preferredAudio = useAppStore.getState().preferredAudio || ['en', 'ja']
      const preferredSubtitles = useAppStore.getState().preferredSubtitles || ['en']

      // ── Audio auto-select ──
      if (!hasAutoSelectedAudioRef.current && audio.length > 0) {
        let bestAudioId: number | undefined
        let bestAudioRank = Infinity
        audio.forEach((t) => {
          const code = getLanguageCodeFromTrack(t.lang)
          const rank = code ? preferredAudio.indexOf(code) : -1
          if (rank !== -1 && rank < bestAudioRank) { bestAudioRank = rank; bestAudioId = t.id }
        })
        if (bestAudioId !== undefined) {
          if (bestAudioId !== selAudio?.id) {
            sendPlayerCommand('set_property', ['aid', bestAudioId])
            setSelectedAudio(bestAudioId)
          }
          hasAutoSelectedAudioRef.current = true
        } else if (autoSelectAttemptsRef.current >= MAX_AUTO_SELECT) {
          hasAutoSelectedAudioRef.current = true
        }
      }

      // ── Subtitle auto-select ──
      if (!hasAutoSelectedSubRef.current && subs.length > 0) {
        let bestSubId: number | undefined
        let bestSubRank = Infinity
        subs.forEach((t) => {
          const code = getLanguageCodeFromTrack(t.lang)
          const rank = code ? preferredSubtitles.indexOf(code) : -1
          if (rank !== -1 && rank < bestSubRank) { bestSubRank = rank; bestSubId = t.id }
        })
        if (bestSubId !== undefined) {
          if (bestSubId !== selSub?.id) {
            sendPlayerCommand('set_property', ['sid', bestSubId])
            setSelectedSub(bestSubId)
          }
          hasAutoSelectedSubRef.current = true
        } else if (autoSelectAttemptsRef.current >= MAX_AUTO_SELECT) {
          hasAutoSelectedSubRef.current = true
        }
      }
    }
    setTracksLoaded(audio.length > 0 || subs.length > 0)
    return audio.length > 0 || subs.length > 0
  }, [])

  // ─ Live subtitle translation ─────────────────────────────────────────────
  // Fast 200ms poll. Translation fires concurrently (non-blocking) so the poll
  // never stalls waiting for the API. Cached lines display instantly.
  useEffect(() => {
    if (!liveTranslateOn || !openrouterApiKey || !subtitleTranslationLang || liveAiSubtitlePathRef.current) return
    const lang = APP_LANGUAGES.find((l) => l.code === subtitleTranslationLang)!
    if (!lang) return

    let cancelled = false
    const inflight = new Set<string>()
    let lastText = ''

    const translateLine = async (line: string) => {
      if (inflight.has(line) || liveTranslateCacheRef.current.has(line)) return
      inflight.add(line)
      try {
        const raw = await openRouterChat(openrouterApiKey, {
          model: openrouterModel || 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: `Translate into natural ${lang.name}. Output ONLY the translation, nothing else. Keep it concise - this is a subtitle line.` },
            { role: 'user', content: line }
          ]
        })
        if (cancelled) return
        const data = JSON.parse(raw)
        const result = stripAiSubtitleResponse(data.choices?.[0]?.message?.content || '')
        if (!result || cancelled) return
        liveTranslateCacheRef.current.set(line, result)
        if (liveTranslatePendingRef.current === line) setTranslatedText(result)
      } catch (_) { /* retry next occurrence */ }
      finally { inflight.delete(line) }
    }

    const poll = setInterval(async () => {
      if (cancelled) return
      try {
        const text = await getPlayerProperty('sub-text') as string | null
        const trimmed = (text || '').trim()

        if (!trimmed) {
          if (lastText) { setTranslatedText(''); setCurrentSubText(''); lastText = '' }
          return
        }
        if (trimmed === lastText) return
        lastText = trimmed
        liveTranslatePendingRef.current = trimmed
        setCurrentSubText(trimmed)

        const cached = liveTranslateCacheRef.current.get(trimmed)
        if (cached) { setTranslatedText(cached); return }

        setTranslatedText('')
        translateLine(trimmed)
      } catch (_) { /* next poll */ }
    }, 250)

    return () => { cancelled = true; clearInterval(poll) }
  }, [liveTranslateOn, openrouterApiKey, openrouterModel, subtitleTranslationLang])

  // Clear translation state when toggling off
  useEffect(() => {
    if (!liveTranslateOn) {
      setTranslatedText('')
      setCurrentSubText('')
      liveTranslatePendingRef.current = ''
    }
  }, [liveTranslateOn])

  useEffect(() => {
    if (!liveTranslateOn || !openrouterApiKey || !subtitleTranslationLang || !liveAiSubtitlePathRef.current) return
    const lang = APP_LANGUAGES.find((l) => l.code === subtitleTranslationLang)
    if (!lang) return
    if (sourceCuesRef.current.length === 0) return

    // Translate the source cue list ahead of playback. Each translated cue keeps
    // its ORIGINAL start/end, so it displays in perfect sync no matter how long
    // the API call took. We stay ~AHEAD cues in front of the playhead.
    const AHEAD = 10
    const RESYNC_GAP = AHEAD * 3 // a jump this far behind playback means a seek
    let cancelled = false

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    const appendTranslatedCue = async (text: string, start: number, end: number) => {
      const path = liveAiSubtitlePathRef.current
      if (!path || cancelled) return
      liveAiCueIndexRef.current += 1
      const cue = [
        String(liveAiCueIndexRef.current),
        `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(Math.max(end, start + 1))}`,
        text,
        '',
        '',
      ].join('\n')
      liveAiSubtitleContentRef.current += cue
      await updateTempSubtitle(path, liveAiSubtitleContentRef.current)
      await sendPlayerCommand('sub-reload').catch(() => {})
    }

    const translateLine = async (line: string): Promise<string> => {
      const cached = liveTranslateCacheRef.current.get(line)
      if (cached) return cached
      const raw = await openRouterChat(openrouterApiKey, {
        model: openrouterModel || 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: `Translate into natural ${lang.name}. Output ONLY the translation, nothing else. Keep it concise; this is a subtitle cue.` },
          { role: 'user', content: contextAwareTranslation ? `${currentDisplayTitle}\n\n${line}` : line }
        ]
      })
      const data = JSON.parse(raw)
      const result = stripAiSubtitleResponse(data.choices?.[0]?.message?.content || '')
      if (result) liveTranslateCacheRef.current.set(line, result)
      return result
    }

    const pump = async () => {
      while (!cancelled) {
        const cues = sourceCuesRef.current
        if (sourceNextIdxRef.current >= cues.length) { await sleep(1500); continue }

        const now = progressRef.current.currentTime
        // Number of cues whose start time is at/behind the playhead.
        let currentIdx = 0
        while (currentIdx < cues.length && cues[currentIdx].start <= now) currentIdx++
        // Big forward jump (seek) → don't waste calls translating skipped cues.
        if (currentIdx - sourceNextIdxRef.current > RESYNC_GAP) sourceNextIdxRef.current = currentIdx

        if (sourceNextIdxRef.current >= currentIdx + AHEAD) { await sleep(400); continue }

        const cue = cues[sourceNextIdxRef.current]
        try {
          const translated = await translateLine(cue.text)
          if (cancelled) return
          if (translated) await appendTranslatedCue(translated, cue.start, cue.end)
        } catch (_) {
          // Skip a failed cue rather than stalling the whole track.
        }
        sourceNextIdxRef.current += 1
      }
    }

    pump()

    return () => { cancelled = true }
  }, [contextAwareTranslation, currentDisplayTitle, liveTranslateOn, openrouterApiKey, openrouterModel, subtitleTranslationLang])

  // Addon subtitle requests can finish after playback has already started.
  // Load every newly received URL and refresh MPV tracks without requiring the
  // subtitle menu to be opened first. This also unlocks automatic translation.
  useEffect(() => {
    let cancelled = false
    const syncExternalSubtitles = async () => {
      await loadAddonSubtitles()
      if (!cancelled) await refreshTracks().catch(() => false)
    }
    syncExternalSubtitles().catch(() => {})
    return () => { cancelled = true }
  }, [subtitles, loadAddonSubtitles, refreshTracks])

  // ─ Background init effects ───────────────────────────────────────────────
  useEffect(() => {
    const origHtml = document.documentElement.style.background
    const origBody = document.body.style.background
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.style.background = origBody
      document.documentElement.style.background = origHtml
    }
  }, [])

  useEffect(() => {
    const root = document.getElementById('root')
    if (root) { root.style.visibility = 'hidden'; root.style.pointerEvents = 'none' }
    return () => {
      if (root) { root.style.visibility = ''; root.style.pointerEvents = '' }
    }
  }, [])

  useEffect(() => {
    const handler = () => showControls()
    const opts = { passive: true, capture: true } as const
    document.addEventListener('pointermove', handler, opts)
    document.addEventListener('pointerdown', handler, opts)
    document.addEventListener('keydown', handler, opts)
    return () => {
      document.removeEventListener('pointermove', handler, { capture: true })
      document.removeEventListener('pointerdown', handler, { capture: true })
      document.removeEventListener('keydown', handler, { capture: true })
    }
  }, [showControls])

  // Size the mpv child window to the host's REAL physical client size. Using
  // window.innerWidth * devicePixelRatio drifts from the true client size across
  // a fullscreen transition (DPI/timing), which left the video not filling the
  // screen. innerSize() is already in physical pixels — exactly what mpv wants.
  const applyFullVideoViewport = useCallback(async () => {
    if (showUpNextRef.current) {
      await resizeEmbeddedPlayer(buildUpNextPipViewport()).catch(() => {})
      return
    }
    // While fullscreen, always target the full monitor. Focus changes (alt-tab)
    // can fire stray resize events with a transient/shrunken client size; using
    // the monitor size keeps the video full instead of snapping it to a strip.
    if (isFullscreenRef.current) {
      const mon = await currentMonitor().catch(() => null)
      if (mon && mon.size.width > 0 && mon.size.height > 0) {
        // Overscan a couple px so no sliver of the top/edge shows through when the
        // window and mpv child round differently at the monitor bounds.
        await resizeEmbeddedPlayer({ x: -2, y: -2, width: mon.size.width + 4, height: mon.size.height + 4 }).catch(() => {})
        return
      }
    }
    try {
      const size = await getCurrentWindow().innerSize()
      if (size.width > 0 && size.height > 0) {
        await resizeEmbeddedPlayer({ x: 0, y: 0, width: size.width, height: size.height })
        return
      }
    } catch (_) { /* fall through to the CSS-based estimate */ }
    await resizeEmbeddedPlayer(buildVideoViewport()).catch(() => {})
  }, [])

  const repairFullscreenWindow = useCallback(async () => {
    if (!isFullscreenRef.current) return
    const win = getCurrentWindow()
    await win.setFullscreen(true).catch(() => {})

    let bounds = fullscreenMonitorBoundsRef.current
    if (!bounds) {
      const monitor = await currentMonitor().catch(() => null)
      if (monitor) {
        bounds = { x: monitor.position.x, y: monitor.position.y, width: monitor.size.width, height: monitor.size.height }
        fullscreenMonitorBoundsRef.current = bounds
      }
    }
    if (bounds) {
      await win.setPosition(new PhysicalPosition(bounds.x, bounds.y)).catch(() => {})
      await win.setSize(new PhysicalSize(bounds.width, bounds.height)).catch(() => {})
    }
    await applyFullVideoViewport()
    await invoke('setup_player_click_through').catch(() => {})
  }, [applyFullVideoViewport])

  const exitFullscreenWindow = useCallback(async () => {
    const transition = ++fullscreenTransitionRef.current
    const win = getCurrentWindow()
    // Disable fullscreen repairs before asking Windows to leave fullscreen.
    // Focus/move events emitted during the transition must not put it back.
    isFullscreenRef.current = false
    setIsFullscreen(false)
    await win.setFullscreen(false).catch(() => {})
    const b = windowedBoundsRef.current
    if (b) {
      const restore = async () => {
        if (fullscreenTransitionRef.current !== transition || isFullscreenRef.current) return
        // Size first: on Windows a borderless window can clamp/recalculate its
        // position when its outer size changes.
        await win.setSize(new PhysicalSize(b.width, b.height)).catch(() => {})
        await win.setPosition(new PhysicalPosition(b.x, b.y)).catch(() => {})
      }
      // Windows finishes the native fullscreen transition after the Tauri
      // promise resolves. Re-assert the exact pre-fullscreen bounds as those
      // delayed native messages settle, preventing cumulative rightward drift.
      await restore()
      await new Promise((resolve) => setTimeout(resolve, 90))
      await restore()
      await new Promise((resolve) => setTimeout(resolve, 180))
      await restore()
    }
    windowedBoundsRef.current = null
    fullscreenMonitorBoundsRef.current = null
    await applyFullVideoViewport()
  }, [applyFullVideoViewport])

  const toggleFullscreen = useCallback(async () => {
    const win = getCurrentWindow()
    if (isFullscreenRef.current) {
      await exitFullscreenWindow()
    } else {
      // Flip state up front so the window-drag strip is gated off immediately —
      // otherwise it lingers over the top of the video until the next re-render.
      ++fullscreenTransitionRef.current
      isFullscreenRef.current = true
      setIsFullscreen(true)
      try {
        const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()])
        windowedBoundsRef.current = { x: pos.x, y: pos.y, width: size.width, height: size.height }
        // setFullscreen hides the taskbar but (on a transparent, decorationless
        // window) doesn't resize the window; force the window to the monitor's
        // full bounds so the video stretches edge-to-edge as well.
        await win.setFullscreen(true)
        const mon = await currentMonitor().catch(() => null)
        if (mon) {
          fullscreenMonitorBoundsRef.current = { x: mon.position.x, y: mon.position.y, width: mon.size.width, height: mon.size.height }
          await win.setPosition(new PhysicalPosition(mon.position.x, mon.position.y)).catch(() => {})
          await win.setSize(new PhysicalSize(mon.size.width, mon.size.height)).catch(() => {})
        }
      } catch (e) {
        isFullscreenRef.current = false
        setIsFullscreen(false)
        setError(`Fullscreen failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // Re-sync the mpv child to the new client size (retries as the transition settles).
    ;[0, 150, 400, 800, 1500].forEach((d) => setTimeout(() => { applyFullVideoViewport() }, d))
    showControls()
  }, [showControls, applyFullVideoViewport, exitFullscreenWindow])

  useEffect(() => {
    let pressedKey: string | null = null
    let holdTimeout: any = null
    let spoolInterval: any = null

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return
      }

      if (useWatchTogetherStore.getState().drawModeActive) return

      const key = e.key
      if (key === ' ' || key === 'Spacebar') {
        e.preventDefault()
        e.stopPropagation()
        togglePlay()
        showControls()
        return
      }

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        showControls()

        if (e.repeat) return

        if (holdTimeout) clearTimeout(holdTimeout)
        if (spoolInterval) clearInterval(spoolInterval)

        const step = useAppStore.getState().seekStepSeconds || 10
        pressedKey = key
        accumulatedSeekRef.current = key === 'ArrowRight' ? step : -step
        setAccumulatedSeek(accumulatedSeekRef.current)

        holdTimeout = setTimeout(() => {
          spoolInterval = setInterval(() => {
            if (accumulatedSeekRef.current !== null) {
              const spool = Math.max(5, Math.round(step / 2))
              accumulatedSeekRef.current += key === 'ArrowRight' ? spool : -spool
              setAccumulatedSeek(accumulatedSeekRef.current)
            }
          }, 150)
        }, 250)
        return
      }

      if (key === 'Escape') {
        if (isFullscreen) {
          e.preventDefault()
          e.stopPropagation()
          toggleFullscreen()
        }
        return
      }

      if (key === 'ArrowUp' || key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        showControls()
        setVolume(prev => {
          const next = prev + (key === 'ArrowUp' ? 5 : -5)
          const clamped = Math.max(0, Math.min(130, next))
          localStorage.setItem('orynt_volume', String(clamped))
          sendPlayerCommand('set_property', ['volume', clamped]).catch(() => {})
          return clamped
        })
        return
      }

      if (key === 'm' || key === 'M') {
        e.preventDefault()
        e.stopPropagation()
        showControls()
        sendPlayerCommand('cycle', ['mute']).catch(() => {})
        return
      }

      if (key === 'f' || key === 'F') {
        e.preventDefault()
        e.stopPropagation()
        toggleFullscreen()
        return
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (pressedKey === key) {
          e.preventDefault()
          e.stopPropagation()
          if (holdTimeout) clearTimeout(holdTimeout)
          if (spoolInterval) clearInterval(spoolInterval)
          
          if (accumulatedSeekRef.current !== null && !wtControlBlocked()) {
            logEvent('PLAYER DEBUG', `Keyboard seek triggered for: ${accumulatedSeekRef.current}s`)
            sendPlayerCommand('seek', [accumulatedSeekRef.current, 'relative']).catch(() => {})
            sendWatchTogetherSeek(progressRef.current.currentTime + accumulatedSeekRef.current)
          }
          
          pressedKey = null
          holdTimeout = null
          spoolInterval = null
          accumulatedSeekRef.current = null
          setAccumulatedSeek(null)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true, passive: false })
    window.addEventListener('keyup', handleKeyUp, { capture: true, passive: false })

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('keyup', handleKeyUp, { capture: true })
      if (holdTimeout) clearTimeout(holdTimeout)
      if (spoolInterval) clearInterval(spoolInterval)
    }
  }, [sendWatchTogetherSeek, showControls, toggleFullscreen, isFullscreen])

  // ─ Player launch ─────────────────────────────────────────────────────────
  useEffect(() => {
    const streamUrl = url
    const mediaId = playbackItem?.localId || url

    if (activeSessionRef.current && activeSessionRef.current.streamUrl === streamUrl && activeSessionRef.current.status !== "stopped") {
      console.warn("[PLAYER DEBUG] startPlayback ignored: already playing same stream")
      return
    }

    const session: PlayerSession = {
      id: Math.random().toString(36).substring(7),
      mediaId,
      streamUrl,
      startedAt: Date.now(),
      status: "starting"
    }
    activeSessionRef.current = session
    latestFullPlayerSessionId = session.id
    logEvent('PLAYER DEBUG', `Player started session ${session.id} for media ${session.mediaId}`)

    let cancelled = false
    const sessionTimers = new Set<ReturnType<typeof setTimeout>>()
    const start = async () => {
      try {
        logEvent('PLAYER DEBUG', `Spawn mpv process for session ${session.id} with URL hash: ${playerUrlHash(url)}`)
        const storeState = useAppStore.getState()
        await launchEmbeddedPlayer({
          url,
          title,
          startTime,
          volume: volumeRef.current,
          viewport: buildVideoViewport(),
          hwdecMode: storeState.hwdecMode,
          cacheBufferSize: storeState.cacheBufferSize,
          mpvCacheSecs: storeState.mpvCacheSecs,
          mpvNetworkTimeout: storeState.mpvNetworkTimeout,
          mpvCustomArgs: buildMpvExtraArgs(storeState)
        })
        if (cancelled || session.status === "stopped") return
        setPlayerRunning(true)
        session.status = "playing"
        setPlayerReady(true)
        showControls()
        const syncNativeSurface = () => {
          resizeEmbeddedPlayer(showUpNextRef.current ? buildUpNextPipViewport() : buildVideoViewport()).catch(() => {})
          invoke('setup_player_click_through').catch(() => {})
        }
        syncNativeSurface()
        ;[100, 300, 700, 1500, 3000, 5000].forEach((delay) => {
          setTimeout(() => {
            if (!cancelled && session.status !== "stopped") syncNativeSurface()
          }, delay)
        })

        // Enforce saved volume and subtitle styling
        applySavedVolume()
        const subState = useAppStore.getState()
        sendPlayerCommand('set_property', ['sub-font-size', subState.subtitleFontSize]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-scale', subState.subtitleScale]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-bold', subState.subtitleBold ? 'yes' : 'no']).catch(() => {})
        sendPlayerCommand('set_property', ['sub-italic', subState.subtitleItalic ? 'yes' : 'no']).catch(() => {})
        sendPlayerCommand('set_property', ['sub-color', subState.subtitleColor]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-border-color', subState.subtitleOutlineColor]).catch(() => {})
        
        const bgAlpha = Math.round(Number(subState.subtitleBgOpacity) * 255).toString(16).padStart(2, '0')
        const cleanBgColor = subState.subtitleBgColor.replace('#', '')
        sendPlayerCommand('set_property', ['sub-back-color', `#${bgAlpha}${cleanBgColor}`]).catch(() => {})
        
        if (subState.subtitleBorderStyle === 'outline') {
          sendPlayerCommand('set_property', ['sub-border-size', subState.subtitleOutlineThickness]).catch(() => {})
          sendPlayerCommand('set_property', ['sub-shadow-offset', 0]).catch(() => {})
        } else if (subState.subtitleBorderStyle === 'shadow') {
          sendPlayerCommand('set_property', ['sub-border-size', 0]).catch(() => {})
          sendPlayerCommand('set_property', ['sub-shadow-offset', subState.subtitleShadowOffset]).catch(() => {})
          const shadowAlpha = Math.round(subState.subtitleShadowOpacity * 255).toString(16).padStart(2, '0')
          sendPlayerCommand('set_property', ['sub-shadow-color', `#${shadowAlpha}000000`]).catch(() => {})
        } else {
          sendPlayerCommand('set_property', ['sub-border-size', 0]).catch(() => {})
          sendPlayerCommand('set_property', ['sub-shadow-offset', 0]).catch(() => {})
        }

        sendPlayerCommand('set_property', ['sub-pos', subState.subtitleVerticalPosition]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-align-x', subState.subtitleAlignment]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-margin-x', subState.subtitleHorizontalMargin]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-blur', subState.subtitleTextBlur]).catch(() => {})
        sendPlayerCommand('set_property', ['sub-scale-with-window', subState.subtitleScaleWithWindow ? 'yes' : 'no']).catch(() => {})
        
        const overrideMap: Record<string, string> = {
          apply: 'no',
          scale_only: 'scale_only',
          ignore: 'yes'
        }
        sendPlayerCommand('set_property', ['sub-ass-override', overrideMap[subState.subtitleAssOverride] || 'scale_only']).catch(() => {})

        if (playbackItem) {
          const startProgress = startTime && progressRef.current.duration > 0
            ? startTime / progressRef.current.duration : 0
          if (scrobbleSimkl) {
            logEvent('PLAYBACK SYNC DEBUG', `Send Simkl start for session ${session.id}`)
            onSimklPlaybackStart(playbackItem, startProgress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
            const pct = Math.round(startProgress * 10000) / 100
            const payload = playbackItem.contentType === 'series' && playbackItem.season != null && playbackItem.episode != null
              ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, pct)
              : buildMovieScrobble(playbackItem.imdbId, pct)
            logEvent('PLAYBACK SYNC DEBUG', `Send Trakt start for session ${session.id} at ${pct}%`)
            traktScrobbleStart(payload).catch(() => {})
          }
          if (scrobbleMdblistEnabled && mdblistApiKey) {
            const pct = Math.round(startProgress * 10000) / 100
            const mediaType = playbackItem.contentType === 'movie' ? 'movie' : 'series'
            scrobbleMdblist('start', tmdbIdRef.current, mediaType, pct, playbackItem.season, playbackItem.episode, playbackItem.imdbId).catch(() => {})
          }

          // Resolve TMDB ID then fetch skips from PMDB + IntroDB and merge
          const resolveAndFetchSkips = async () => {
            if (!tmdbIdRef.current && playbackItem.imdbId) {
              try {
                const isEpisodic = playbackItem.contentType === 'series'
                const preferredType = isEpisodic ? 'tv' : 'movie'
                const mapping = await lookupTmdbId('imdb', playbackItem.imdbId, preferredType)
                if (mapping) tmdbIdRef.current = mapping.tmdbId
              } catch (_) {}
            }
            const isEpisodic = playbackItem.contentType === 'series'
            const mediaType = isEpisodic ? 'tv' : 'movie'
            const [pmdbSkips, introdbSkips] = await Promise.allSettled([
              tmdbIdRef.current
                ? getPMDBSkips(tmdbIdRef.current, mediaType, playbackItem.season, playbackItem.episode)
                : Promise.resolve([]),
              isEpisodic && playbackItem.imdbId && playbackItem.season != null && playbackItem.episode != null
                ? getIntroDBSkips(playbackItem.imdbId, playbackItem.season, playbackItem.episode)
                : Promise.resolve([]),
            ])
            const merged: PMDBSkipSegment[] = [
              ...(pmdbSkips.status === 'fulfilled' ? pmdbSkips.value : []),
              ...(introdbSkips.status === 'fulfilled' ? introdbSkips.value : []),
            ]
            if (!cancelled && session.status !== "stopped") setSkips(merged)
          }
          resolveAndFetchSkips()
        }

        ;[500, 1000, 2000, 3500].forEach((delay) => {
          const timer = setTimeout(() => {
            sessionTimers.delete(timer)
            if (!cancelled && session.status !== "stopped") invoke('setup_player_click_through').catch(() => {})
          }, delay)
          sessionTimers.add(timer)
        })

        await loadAddonSubtitles()
        let attempts = 0
        trackPollRef.current = setInterval(async () => {
          if (cancelled || session.status === "stopped") return
          attempts += 1
          await loadAddonSubtitles()
          try {
            const found = await refreshTracks()
            void found
          } catch (_) {}
          if (attempts >= 20) {
            if (trackPollRef.current) clearInterval(trackPollRef.current)
            trackPollRef.current = null
            setTracksLoaded(true)
          }
        }, 1000)
      } catch (e) {
        if (!cancelled && session.status !== "stopped") setError(e instanceof Error ? e.message : String(e))
      }
    }
    start()
    showControls()
    return () => {
      cancelled = true
      session.status = "stopped"
      logEvent('PLAYER DEBUG', `Stop playback session ${session.id}`)
      if (pollRef.current) clearInterval(pollRef.current)
      if (trackPollRef.current) clearInterval(trackPollRef.current)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      sessionTimers.forEach((timer) => clearTimeout(timer))
      sessionTimers.clear()
      // Defer stop so a re-mount's launchEmbeddedPlayer (which internally
      // calls stop_embedded_mpv) can claim the player first.  If a new
      // session has already taken over by the time this fires, skip the
      // stop — otherwise we'd kill the new session's mpv process.
      setTimeout(() => {
        // Only stop if a new session HAS NOT claimed the player slot.
        // A short delay ensures rapid StrictMode remounts have time to
        // update the global session ID before we check.
        if (latestFullPlayerSessionId === session.id) {
          latestFullPlayerSessionId = null
          stopEmbeddedPlayer().catch(() => {})
        }
      }, 50)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, title])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen<{ sessionId: string; eventId: number }>('mpv-playback-ready', () => {
      if (disposed) return
      setPlayerRunning(true)
      setPlayerReady(true)
      showControls()
      resizeEmbeddedPlayer(showUpNextRef.current ? buildUpNextPipViewport() : buildVideoViewport()).catch(() => {})
      invoke('setup_player_click_through').catch(() => {})
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [showControls])

  useEffect(() => {
    if (playerReady || error) return
    let cancelled = false
    const startedAt = Date.now()
    const interval = setInterval(async () => {
      const running = await isEmbeddedPlayerRunning().catch(() => false)
      if (cancelled) return
      setPlayerRunning(running)

      if (running && Date.now() - startedAt > 5000) {
        setPlayerReady(true)
        showControls()
        clearInterval(interval)
      } else if (!running && Date.now() - startedAt > 3000) {
        await new Promise((r) => setTimeout(r, 500))
        const logs = await invoke<string[]>('get_player_debug_logs').catch(() => [])
        const reversed = [...logs].reverse()
        const stderrLines = reversed.filter((line) =>
          line.includes('[MPV STDERR]') &&
          !line.includes('Ignoring unterminated command on disconnect') &&
          !line.includes('ipc_0')
        )
        const detail = stderrLines[0]
          ?? reversed.find((line) => line.includes('[MPV OUTPUT]'))
          ?? reversed.find((line) => line.includes('[PLAYER EXIT]'))
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
        const cleanDetail = detail?.replace(/^.*?\] /, '')
        const fallback = `The stream closed before video playback started (after ${elapsed}s, ${logs.length} log lines).`
        setError(cleanDetail || fallback)
        if (stderrLines.length > 0) {
          console.error('[MPV CRASH]', stderrLines.map((l) => l.replace(/^.*?\] /, '')).join('\n'))
        }
        clearInterval(interval)
      } else if (Date.now() - startedAt > 30000) {
        setError('The stream did not provide a playable video frame within 30 seconds.')
        clearInterval(interval)
      }
    }, 750)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [playerReady, error, url])

  // ─ Resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let clickThroughTimer: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed) return
        applyFullVideoViewport()
        clearTimeout(clickThroughTimer)
        clickThroughTimer = setTimeout(() => {
          if (!disposed) invoke('setup_player_click_through').catch(() => {})
        }, 300)
      }, 50)
    }
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    window.addEventListener('resize', onResize)
    // Tauri's onResized fires on the fullscreen transition with the true new
    // size, which the DOM 'resize' event can miss or report stale.
    getCurrentWindow().onMoved(() => onResize())
      .then((unlisten) => { if (disposed) unlisten(); else unlistenMoved = unlisten })
      .catch(() => {})
    getCurrentWindow().onResized(() => onResize())
      .then((unlisten) => { if (disposed) unlisten(); else unlistenResized = unlisten })
      .catch(() => {})
    return () => {
      disposed = true
      clearTimeout(resizeTimer)
      clearTimeout(clickThroughTimer)
      window.removeEventListener('resize', onResize)
      unlistenMoved?.()
      unlistenResized?.()
    }
  }, [applyFullVideoViewport])

  // Alt-tabbing a transparent borderless fullscreen window can make Windows
  // temporarily restore a non-client strip at the top. Repair on BOTH blur and
  // focus: waiting for focus to return leaves that strip visible the entire time
  // another app is active. Cached monitor bounds remain valid while unfocused.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const scheduleRepair = (delays: number[]) => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
      delays.forEach((delay) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          repairFullscreenWindow().catch(() => {})
        }, delay)
        timers.add(timer)
      })
    }
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!isFullscreenRef.current) return
      scheduleRepair(focused ? [0, 150, 400] : [0, 50, 150, 400, 800])
    }).then((u) => { unlisten = u }).catch(() => {})
    return () => {
      unlisten?.()
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [repairFullscreenWindow])

  useEffect(() => {
    const viewport = showUpNext ? buildUpNextPipViewport() : buildVideoViewport()
    resizeEmbeddedPlayer(viewport).catch(() => {})
    const timers = [250, 750, 1500].map((delay) => setTimeout(() => resizeEmbeddedPlayer(viewport).catch(() => {}), delay))
    return () => timers.forEach((timer) => clearTimeout(timer))
  }, [showUpNext])

  // ─ Discord Rich Presence ──────────────────────────────────────────────────
  useEffect(() => {
    if (!discordRichPresence) return

    const isEpisodic = playbackItem?.contentType === 'series'
    const details = title || 'Watching something'
    const state = paused
      ? (isEpisodic ? `S${playbackItem!.season ?? 0}E${playbackItem!.episode ?? 0} · Paused` : 'Paused')
      : isEpisodic
        ? `S${playbackItem!.season ?? 0}E${playbackItem!.episode ?? 0}`
        : playbackItem?.contentType === 'movie' ? 'Watching' : undefined

    const posterUrl = poster && poster.startsWith('http') ? poster : undefined
    const nowSec = Math.floor(Date.now() / 1000)
    const cur = progressRef.current.currentTime || 0
    const dur = progressRef.current.duration || 0

    // start = now minus how far we've watched; end = start + total duration
    const startTs = paused ? undefined : nowSec - Math.floor(cur)
    const endTs = (!paused && dur > 0) ? nowSec - Math.floor(cur) + Math.floor(dur) : undefined

    setDiscordActivity({
      details,
      state,
      largeImage: posterUrl || 'aurales_logo',
      largeText: title || 'Aurales',
      smallImage: paused ? 'paused' : 'playing',
      smallText: paused ? 'Paused' : 'Playing',
      startTimestamp: startTs,
      endTimestamp: endTs,
      activityType: 3,
    }).catch(() => {})

    return () => { restoreDiscordBrowsingActivity().catch(() => {}) }
  }, [discordRichPresence, title, playbackItem, paused, poster])

  // Periodically sync Discord timestamps with actual playback position
  useEffect(() => {
    if (!discordRichPresence || paused) return
    const sync = setInterval(() => {
      const cur = progressRef.current.currentTime || 0
      const dur = progressRef.current.duration || 0
      if (dur <= 0) return
      const nowSec = Math.floor(Date.now() / 1000)

      const isEpisodic = playbackItem?.contentType === 'series'
      const posterUrl = poster && poster.startsWith('http') ? poster : undefined

      setDiscordActivity({
        details: title || 'Watching something',
        state: isEpisodic
          ? `S${playbackItem!.season ?? 0}E${playbackItem!.episode ?? 0}`
          : playbackItem?.contentType === 'movie' ? 'Watching' : undefined,
        largeImage: posterUrl || 'aurales_logo',
        largeText: title || 'Aurales',
        smallImage: 'playing',
        smallText: 'Playing',
        startTimestamp: nowSec - Math.floor(cur),
        endTimestamp: nowSec - Math.floor(cur) + Math.floor(dur),
        activityType: 3,
      }).catch(() => {})
    }, 30000)
    return () => clearInterval(sync)
  }, [discordRichPresence, paused, title, playbackItem, poster])

  const triggerRestart = useCallback(async (resumeTime: number) => {
    logEvent('PLAYER DEBUG', `Restarting player session at position ${resumeTime}s...`)
    try {
      await stopEmbeddedPlayer()
      const storeState = useAppStore.getState()
      await launchEmbeddedPlayer({
        url,
        title,
        startTime: resumeTime,
        volume: volumeRef.current,
        viewport: buildVideoViewport(),
        hwdecMode: storeState.hwdecMode,
        cacheBufferSize: storeState.cacheBufferSize,
        mpvCacheSecs: storeState.mpvCacheSecs,
        mpvNetworkTimeout: storeState.mpvNetworkTimeout,
        mpvCustomArgs: buildMpvExtraArgs(storeState)
      })
      applySavedVolume()
      logEvent('PLAYER DEBUG', `Player restarted successfully`)
    } catch (err) {
      logEvent('PLAYER DEBUG', `Auto-restart failed: ${err}`)
    }
  }, [url, title, applySavedVolume])

  // ─ Polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let polling = false
    pollRef.current = setInterval(async () => {
      if (polling || cancelled) return
      polling = true
      try {
        const snapshot = await getPlayerSnapshot()
        if (cancelled) return
        const pos = snapshot.timePos
        const dur = snapshot.duration
        const isPause = snapshot.paused
        const isBuffering = snapshot.buffering
        const cacheBuffState = snapshot.cacheBufferingState
        const demuxerCacheDur = snapshot.demuxerCacheDuration
        const eofReached = snapshot.eofReached
        const idleActive = snapshot.idleActive
        const coreIdle = snapshot.coreIdle

        const nowMs = Date.now()

        // Log property changes
        if (isPause !== null && isPause !== lastPauseRef.current) {
          lastPauseRef.current = isPause
          logEvent('MPV DEBUG', `pause changed to: ${isPause}`)
        }
        // Keep React state in sync with mpv's real pause state. Remote
        // watch-together commands (and mpv itself) change it outside of
        // togglePlay, and a desynced `paused` flips the next WT event.
        if (isPause !== null && isPause !== pausedRef.current) {
          pausedRef.current = isPause
          setPaused(isPause)
        }
        if (isBuffering !== null && isBuffering !== lastBufferingRef.current) {
          lastBufferingRef.current = isBuffering
          logEvent('MPV DEBUG', `buffering changed to: ${isBuffering}`)
          if (useWatchTogetherStore.getState().currentRoom) {
            wtSendBuffering(isBuffering, pos ?? progressRef.current.currentTime)
          }
        }
        setBuffering(isBuffering === true)
        if (cacheBuffState !== null && cacheBuffState !== lastCacheBuffStateRef.current) {
          lastCacheBuffStateRef.current = cacheBuffState
          logEvent('MPV DEBUG', `cache-buffering-state changed: ${cacheBuffState}%`)
        }
        if (demuxerCacheDur !== null && demuxerCacheDur !== lastDemuxerCacheDurRef.current) {
          lastDemuxerCacheDurRef.current = demuxerCacheDur
          logEvent('MPV DEBUG', `demuxer-cache-duration changed: ${demuxerCacheDur}s`)
        }
        if (eofReached !== null && eofReached !== lastEofReachedRef.current) {
          lastEofReachedRef.current = eofReached
          logEvent('MPV DEBUG', `eof-reached changed: ${eofReached}`)
        }
        if (idleActive !== null && idleActive !== lastIdleActiveRef.current) {
          lastIdleActiveRef.current = idleActive
          logEvent('MPV DEBUG', `idle-active changed: ${idleActive}`)
        }
        if (coreIdle !== null && coreIdle !== lastCoreIdleRef.current) {
          lastCoreIdleRef.current = coreIdle
          logEvent('MPV DEBUG', `core-idle changed: ${coreIdle}`)
        }

        if (nowMs - lastVolumeEnforceRef.current >= 5000) {
          lastVolumeEnforceRef.current = nowMs
          const actualVolume = await getPlayerProperty('volume') as number | null
          if (actualVolume != null && Math.abs(actualVolume - volumeRef.current) > 1) {
            sendPlayerCommand('set_property', ['volume', volumeRef.current]).catch(() => {})
          }
        }
        if (pos != null) {
          setCurrentTime(pos)
          setPlayerReady(true)
          progressRef.current.currentTime = pos
        }
        if (dur != null && dur > 0) {
          setDuration(dur)
          setPlayerReady(true)
          progressRef.current.duration = dur
        }

        // Feed the live position to the watch-together sync loop — the room's
        // stored playback time only changes on events and must not be used.
        if (pos != null && useWatchTogetherStore.getState().currentRoom) {
          wtReportLocalPlayback(pos, !isPause && !isBuffering)
        }

        // End of file: mpv runs with --keep-open=no, so the process exits at
        // EOF. Close gracefully (scrobbles the finished state) instead of
        // leaving a dead overlay behind — unless Up Next is on screen.
        if (
          eofReached === true &&
          !eofClosedRef.current &&
          !showUpNextRef.current &&
          progressRef.current.duration > 0 &&
          progressRef.current.currentTime / progressRef.current.duration > 0.8
        ) {
          eofClosedRef.current = true
          closeRef.current?.()
          return
        }

        // Stall detection
        const PLAYER_STALL_TIMEOUT_MS = 30000
        const PLAYER_RESTART_COOLDOWN_MS = 15000
        const MAX_AUTO_RESTARTS = 0

        const isPlaying = pos !== null && !isPause && !isBuffering
        if (isPlaying) {
          if (pos !== lastTimePosValRef.current) {
            lastTimePosValRef.current = pos
            lastTimePosUpdateRef.current = nowMs
          } else {
            const timeSinceLastPosUpdate = nowMs - lastTimePosUpdateRef.current
            if (timeSinceLastPosUpdate >= PLAYER_STALL_TIMEOUT_MS) {
              logEvent('PLAYER DEBUG', `Playback stall detected! No position update for ${Math.round(timeSinceLastPosUpdate / 1000)}s while playing.`)
              if (autoRestartCountRef.current < MAX_AUTO_RESTARTS && nowMs - lastRestartTimeRef.current >= PLAYER_RESTART_COOLDOWN_MS) {
                logEvent('PLAYER DEBUG', `Triggering player auto-restart (attempt ${autoRestartCountRef.current + 1})`)
                autoRestartCountRef.current++
                lastRestartTimeRef.current = nowMs
                lastTimePosUpdateRef.current = nowMs
                triggerRestart(pos)
              } else {
                logEvent('PLAYER DEBUG', `Stall auto-restart skipped: max auto-restarts exceeded or within cooldown.`)
              }
            }
          }
        } else {
          lastTimePosUpdateRef.current = nowMs
        }

        if (pos != null && dur != null && dur > 0) {
          const activityItem = currentItemRef.current
          if (activityItem) recordPlaybackSample({ mediaKey: activityItem.localId, title: activityItem.title, mediaType: activityItem.mediaType === 'anime' ? 'anime' : activityItem.contentType === 'movie' ? 'movie' : 'series', poster: currentPosterRef.current, tmdbId: activityItem.tmdbId, season: activityItem.season, episode: activityItem.episode, positionSeconds: pos, durationSeconds: dur, playing: isPause === false, completed: pos / dur >= 0.85 })
          if (Math.abs(pos - lastSavedTimeRef.current) >= 15) {
            lastSavedTimeRef.current = pos
            saveLocalProgress(pos, dur, false)
          }
          const item = currentItemRef.current
          if (item && scrobbleSimkl && simklSaveResumePosition && pos - lastSimklPlaybackSaveRef.current >= 60) {
            lastSimklPlaybackSaveRef.current = pos
            logEvent('PLAYBACK SYNC DEBUG', `Save Simkl scrobble progress: ${Math.round(pos)}s / ${Math.round(dur)}s`)
            saveSimklPlaybackProgress(item, pos / dur).catch(() => {})
          }
          if (item && scrobbleAnilist && item.isAnime && pos - lastAniListPlaybackSaveRef.current >= 60) {
            lastAniListPlaybackSaveRef.current = pos
            logEvent('PLAYBACK SYNC DEBUG', `Save AniList scrobble progress: ${Math.round(pos)}s / ${Math.round(dur)}s`)
            saveAniListProgressMapped(item, pos / dur).catch(() => {})
          }
          if (item && pmdbApiKey && pmdbSaveResumePosition && (tmdbIdRef.current || item.imdbId) && pos - lastPmdbPlaybackSaveRef.current >= 60) {
            lastPmdbPlaybackSaveRef.current = pos
            savePMDBProgressHelper(pos, dur, false)
            saveMdblistProgressHelper(pos, dur, false)
          }

          // Detect near-end for Up Next, honoring the Next Episode Prompt
          // setting. 'auto' = ≤90s remaining OR ≥92% through; timed options
          // use a fixed remaining threshold; 'off' disables the prompt.
          // Suppressed in Watch Together — autoplaying a new episode locally
          // would desync the whole room.
          const remaining = dur - pos
          const pctDone = pos / dur
          const promptSetting = useAppStore.getState().nextEpisodePrompt
          const promptThresholds: Record<string, number> = { '30s': 30, '45s': 45, '1m': 60, '1.5m': 90, '2m': 120 }
          const shouldPrompt = promptSetting === 'off'
            ? false
            : promptSetting === 'auto'
              ? (remaining <= 90 || pctDone >= 0.92)
              : remaining <= (promptThresholds[promptSetting] ?? 90)
          if (
            shouldPrompt &&
            remaining > 0 &&
            !useWatchTogetherStore.getState().currentRoom &&
            nextEpInfoRef.current &&
            !showUpNextRef.current &&
            !upNextTriggeredRef.current &&
            !upNextCancelledRef.current
          ) {
            upNextTriggeredRef.current = true
            setShowUpNext(true)
            setUpNextCountdown(15)
          }
        }

        // Skip segment detection
        if (pos != null && skips.length > 0) {
          const ms = pos * 1000
          let found: PMDBSkipSegment | null = null
          let foundType: 'intro' | 'credits' | 'recap' | null = null
          for (const s of skips) {
            if (s.recap_start_ms != null && s.recap_end_ms != null && ms >= s.recap_start_ms && ms <= s.recap_end_ms) {
              found = s; foundType = 'recap'; break
            }
            if (ms >= s.intro_start_ms && ms <= s.intro_end_ms && s.intro_end_ms > s.intro_start_ms) {
              found = s; foundType = 'intro'; break
            }
            if (s.credits_start_ms != null && s.credits_end_ms != null) {
              if (ms >= s.credits_start_ms && ms <= s.credits_end_ms) {
                found = s; foundType = 'credits'; break
              }
            }
          }
          setActiveSkip((previous) => previous?.id === found?.id ? previous : found)
          setSkipType((previous) => previous === foundType ? previous : foundType)
          // Auto-skip is disabled for guests without control rights — the
          // local jump would be reverted by drift correction anyway.
          if (autoSkipSegments && found && foundType && !wtControlBlocked()) {
            const endMs = foundType === 'intro'
              ? found.intro_end_ms
              : foundType === 'recap'
                ? found.recap_end_ms
                : found.credits_end_ms
            const startMs = foundType === 'intro'
              ? found.intro_start_ms
              : foundType === 'recap'
                ? found.recap_start_ms
                : found.credits_start_ms
            const segmentKey = `${found.id}:${foundType}:${startMs ?? 0}:${endMs ?? 0}`
            if (endMs != null && endMs > ms && !autoSkippedSegmentsRef.current.has(segmentKey)) {
              autoSkippedSegmentsRef.current.add(segmentKey)
              logEvent('PLAYER DEBUG', `Auto-skipping segment [${foundType}] to ${endMs / 1000}s`)
              await command('seek', [endMs / 1000, 'absolute'])
              sendWatchTogetherSeek(endMs / 1000)
              setActiveSkip(null)
              setSkipType(null)
            }
          }
        } else {
          setActiveSkip(null)
          setSkipType(null)
        }
      } catch (_) { /* transient IPC failures */ }
      finally { polling = false }
    }, 1000)
    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [skips, autoSkipSegments, command, saveLocalProgress, savePMDBProgressHelper, saveMdblistProgressHelper, scrobbleSimkl, simklSaveResumePosition, scrobbleAnilist, pmdbApiKey, pmdbSaveResumePosition, sendWatchTogetherSeek, triggerRestart])

  // ─ Fetch next episode on mount ────────────────────────────────────────────
  useEffect(() => {
    if (!playbackItem || playbackItem.contentType !== 'series') return
    if (!playbackItem.season || !playbackItem.episode) return
    let cancelled = false

    const doFetch = async () => {
      let tmdbId = tmdbIdRef.current
      if (!tmdbId && playbackItem.imdbId) {
        try {
          const mapping = await lookupTmdbId('imdb', playbackItem.imdbId)
          if (cancelled) return
          if (mapping) { tmdbIdRef.current = mapping.tmdbId; tmdbId = mapping.tmdbId }
        } catch (_) {}
      }

      const nextSeason = playbackItem.season!
      const nextEpisode = playbackItem.episode! + 1

      if (tmdbId) {
        const info = await fetchNextEpisodeFromTmdb(tmdbId, nextSeason, nextEpisode)
        if (cancelled) return
        if (info) { setNextEpInfo(info); return }
      }

      // Fallback: build a minimal stub so UpNext overlay can still appear
      // even when TMDB key/id is unavailable
      setNextEpInfo({
        season: nextSeason,
        episode: nextEpisode,
        title: `Episode ${nextEpisode}`,
        overview: undefined,
        runtime: undefined,
        stillPath: undefined,
      })
    }
    // Give the main start effect time to resolve TMDB ID
    const timer = setTimeout(doFetch, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [playbackItem])

  // ─ Up Next countdown ─────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAutoplay = useCallback(async () => {
    const nextEp = nextEpInfoRef.current
    const item = currentItemRef.current
    if (!nextEp || !item?.imdbId) { setShowUpNext(false); return }
    const sessionId = activeSessionRef.current?.id
    const ownsSession = () => Boolean(
      sessionId
      && latestFullPlayerSessionId === sessionId
      && activeSessionRef.current?.id === sessionId
      && activeSessionRef.current.status !== 'stopped'
    )
    if (!ownsSession()) return

    setIsAutoSearching(true)
    const streamId = `${item.imdbId}:${nextEp.season}:${nextEp.episode}`
    const addons = getStreamAddons('series')

    let foundUrl: string | null = null
    for (const addon of addons) {
      try {
        const streams = await getAddonStreams(addon.url, 'series', streamId)
        if (!ownsSession()) return
        const valid = streams.find((s) => s.url)
        if (valid?.url) { foundUrl = valid.url; break }
      } catch (_) {}
    }

    setIsAutoSearching(false)
    if (!ownsSession()) return
    if (!foundUrl) { setShowUpNext(false); return }

    // Stop current, save progress
    const { currentTime: pos, duration: dur } = progressRef.current
    saveLocalProgress(pos, dur, false)
    const promises: Promise<any>[] = []
    if (scrobbleSimkl && item) {
      promises.push(onSimklPlaybackStop(item, dur > 0 ? pos / dur : 0).catch(() => {}))
    }
    if (scrobbleTrakt && isTraktAuthenticated() && item?.imdbId && item.season != null && item.episode != null) {
      const pct = Math.round((dur > 0 ? pos / dur : 0) * 10000) / 100
      const payload = buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
      promises.push(traktScrobbleStop(payload).catch(() => {}))
    }
    await Promise.allSettled(promises)
    if (!ownsSession()) return
    await stopEmbeddedPlayer().catch(() => {})
    if (!ownsSession()) return

    // Update current playback item refs
    const newItem: PlaybackItem = { ...item, season: nextEp.season, episode: nextEp.episode, title: `${title} · ${nextEp.title}` }
    currentItemRef.current = newItem
    currentStreamUrlRef.current = foundUrl
    currentPosterRef.current = nextEp.stillPath ?? currentPosterRef.current
    currentBackdropRef.current = nextEp.stillPath ?? currentBackdropRef.current

    try {
      const storeState = useAppStore.getState()
      await launchEmbeddedPlayer({
        url: foundUrl,
        title,
        volume: volumeRef.current,
        viewport: buildVideoViewport(),
        hwdecMode: storeState.hwdecMode,
        cacheBufferSize: storeState.cacheBufferSize,
        mpvCacheSecs: storeState.mpvCacheSecs,
        mpvNetworkTimeout: storeState.mpvNetworkTimeout,
        mpvCustomArgs: buildMpvExtraArgs(storeState)
      })
      applySavedVolume()

      // Update title/subtitle in the player controls bar
      const epCode = `S${String(nextEp.season).padStart(2, '0')}E${String(nextEp.episode).padStart(2, '0')}`
      setCurrentDisplayTitle(title)
      setCurrentDisplaySubtitle(`${epCode} · ${nextEp.title}`)
      setCurrentMeta(null) // refetch paused-overlay metadata for the new episode

      // Reset progress state
      setCurrentTime(0); setDuration(0); setPaused(false); setPlayerReady(false)
      setTracksLoaded(false); setAudioTracks([]); setSubTracks([])
      setSkips([]); setActiveSkip(null); setSkipType(null)
      setShowUpNext(false)
      upNextTriggeredRef.current = false
      upNextCancelledRef.current = false
      progressRef.current = { currentTime: 0, duration: 0 }
      lastSavedTimeRef.current = 0
      lastSimklPlaybackSaveRef.current = 0
      lastPmdbPlaybackSaveRef.current = 0
      lastAniListPlaybackSaveRef.current = 0
      hasAutoSelectedAudioRef.current = false
      hasAutoSelectedSubRef.current = false
      autoSelectAttemptsRef.current = 0
      loadedSubtitleUrlsRef.current = new Set()
      subtitleSourcesRef.current = new Map()
      autoSkippedSegmentsRef.current = new Set()
      // Reset AI-translation state — mpv relaunches with a new file, so old
      // track ids and the previous source cue list no longer apply.
      setLiveTranslateOn(false)
      aiSubtitleTrackIdRef.current = null
      aiSubtitleSourceTrackIdRef.current = null
      liveAiSubtitlePathRef.current = null
      sourceCuesRef.current = []
      sourceNextIdxRef.current = 0
      autoTranslateStartedRef.current = false

      // Start scrobble for new episode
      if (scrobbleSimkl) onSimklPlaybackStart(newItem, 0).catch(() => {})
      if (scrobbleTrakt && isTraktAuthenticated() && newItem.imdbId) {
        const payload = buildEpisodeScrobble(newItem.imdbId, nextEp.season, nextEp.episode, 0)
        traktScrobbleStart(payload).catch(() => {})
      }

      // Fetch next-next episode
      setNextEpInfo(null)
      nextEpInfoRef.current = null
      const tmdbId = tmdbIdRef.current
      if (tmdbId) {
        fetchNextEpisodeFromTmdb(tmdbId, nextEp.season, nextEp.episode).then((info) => {
          if (info) { setNextEpInfo(info); return }
          // Fallback stub
          setNextEpInfo({ season: nextEp.season, episode: nextEp.episode + 1, title: `Episode ${nextEp.episode + 1}` })
        }).catch(() => {
          setNextEpInfo({ season: nextEp.season, episode: nextEp.episode + 1, title: `Episode ${nextEp.episode + 1}` })
        })
        const nextImdbId = newItem.imdbId ?? ''
        Promise.allSettled([
          getPMDBSkips(tmdbId, 'tv', nextEp.season, nextEp.episode),
          nextImdbId ? getIntroDBSkips(nextImdbId, nextEp.season, nextEp.episode) : Promise.resolve([]),
        ]).then(([pmdb, introdb]) => {
          const merged: PMDBSkipSegment[] = [
            ...(pmdb.status === 'fulfilled' ? pmdb.value : []),
            ...(introdb.status === 'fulfilled' ? introdb.value : []),
          ]
          setSkips(merged)
        }).catch(() => {})
      }

      // Re-setup click-through
      ;[500, 1000, 2000].forEach((delay) => schedulePlayerTimeout(() => invoke('setup_player_click_through').catch(() => {}), delay))

      // Restart track polling
      let attempts = 0
      if (trackPollRef.current) clearInterval(trackPollRef.current)
      trackPollRef.current = setInterval(async () => {
        attempts += 1
        try {
          const found = await refreshTracks()
          if (found && attempts >= 3) {
            if (trackPollRef.current) clearInterval(trackPollRef.current)
            trackPollRef.current = null
          }
        } catch (_) {}
        if (attempts >= 20) {
          if (trackPollRef.current) clearInterval(trackPollRef.current)
          trackPollRef.current = null
          setTracksLoaded(true)
        }
      }, 1000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [title, scrobbleSimkl, scrobbleTrakt, saveLocalProgress, refreshTracks, applySavedVolume, schedulePlayerTimeout])

  useEffect(() => {
    if (!showUpNext) { setUpNextCountdown(15); return }
    const interval = setInterval(() => {
      setUpNextCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          if (!upNextCancelledRef.current) handleAutoplay()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [showUpNext, handleAutoplay])

  // ─ Playback controls ──────────────────────────────────────────────────────
  const close = async () => {
    if (closingRef.current) return
    closingRef.current = true
    const item = currentItemRef.current
    const { currentTime: pos, duration: dur } = progressRef.current
    const progress = dur > 0 ? pos / dur : 0
    if (item) {
      saveLocalProgress(pos, dur, false)
    }

    // Restore the native window before revealing the detail page. Rendering it
    // while Windows is still leaving fullscreen leaves the whole app at the
    // temporary fullscreen bounds/position.
    if (isFullscreenRef.current) await exitFullscreenWindow().catch(() => {})
    // Stopping mpv and remote progress/scrobble writes remain non-blocking.
    void stopEmbeddedPlayer().catch(() => {})
    onClose()

    if (item) {
      const promises: Promise<any>[] = []
      if (scrobbleSimkl) {
        promises.push(onSimklPlaybackStop(item, progress).catch(() => {}))
      }
      if (scrobbleAnilist && item.isAnime) {
        promises.push(saveAniListProgressMapped(item, progress).catch(() => {}))
      }
      if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
        const pct = Math.round(progress * 10000) / 100
        const payload = item.contentType === 'series' && item.season != null && item.episode != null
          ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
          : buildMovieScrobble(item.imdbId, pct)
        promises.push(traktScrobbleStop(payload).catch(() => {}))
      }
      promises.push(savePMDBProgressHelper(pos, dur, true))
      promises.push(saveMdblistProgressHelper(pos, dur, true))
      void Promise.allSettled(promises)
    }
  }
  useEffect(() => { closeRef.current = close })

  const pickAnother = async () => {
    const item = currentItemRef.current
    if (item) {
      const { currentTime: pos, duration: dur } = progressRef.current
      const progress = dur > 0 ? pos / dur : 0
      saveLocalProgress(pos, dur, false)
      const promises: Promise<any>[] = []
      if (scrobbleSimkl) {
        promises.push(onSimklPlaybackStop(item, progress).catch(() => {}))
      }
      if (scrobbleAnilist && item.isAnime) {
        promises.push(saveAniListProgressMapped(item, progress).catch(() => {}))
      }
      if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
        const pct = Math.round(progress * 10000) / 100
        const payload = item.contentType === 'series' && item.season != null && item.episode != null
          ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
          : buildMovieScrobble(item.imdbId, pct)
        promises.push(traktScrobbleStop(payload).catch(() => {}))
      }
      promises.push(savePMDBProgressHelper(pos, dur, true))
      promises.push(saveMdblistProgressHelper(pos, dur, true))
      await Promise.allSettled(promises)
    }
    if (isFullscreenRef.current) await exitFullscreenWindow().catch(() => {})
    await stopEmbeddedPlayer().catch(() => {})
    onPickAnother()
  }

  const retryStream = useCallback(() => {
    setError('')
    // Clearing the error re-arms the startup watchdog, which reports again if
    // the relaunch also fails to produce a video frame.
    triggerRestart(Math.max(progressRef.current.currentTime || 0, startTime || 0))
  }, [triggerRestart, startTime])

  const wtBlockedNotice = useCallback(() => {
    setError('Only the host can control playback in this room.')
    setTimeout(() => setError((prev) => prev === 'Only the host can control playback in this room.' ? '' : prev), 2500)
    showControls()
  }, [showControls])

  const togglePlay = () => {
    if (!playerRunning) {
      setError('The player process has exited. Go back and choose another stream.')
      return
    }
    if (wtControlBlocked()) { wtBlockedNotice(); return }
    const targetPaused = !pausedRef.current
    const { currentTime: pos, duration: dur } = progressRef.current
    const progress = dur > 0 ? pos / dur : 0
    const item = currentItemRef.current

    pausedRef.current = targetPaused
    setPaused(targetPaused)
    command('set_property', ['pause', targetPaused])

    const wt = useWatchTogetherStore.getState()
    if (wt.currentRoom && !wtIgnoreNextEvent.current) {
      if (targetPaused) wtPause(pos)
      else wtPlay(pos)
    }

    if (item) {
      queueMicrotask(() => {
        saveLocalProgress(pos, dur, false)
        if (targetPaused) {
          if (scrobbleSimkl) {
            onSimklPlaybackPause(item, progress).catch(() => {})
          }
          // Trakt derives the resume point from scrobble pause - the
          // "Save Resume Position" setting gates it.
          if (scrobbleTrakt && traktSaveResumePosition && isTraktAuthenticated() && item.imdbId) {
            const pct = Math.round(progress * 10000) / 100
            const payload = item.contentType === 'series' && item.season != null && item.episode != null
              ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
              : buildMovieScrobble(item.imdbId, pct)
            traktScrobblePause(payload).catch(() => {})
          }
          savePMDBProgressHelper(pos, dur, false)
          saveMdblistProgressHelper(pos, dur, false)
        } else {
          if (scrobbleSimkl) {
            onSimklPlaybackStart(item, progress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
            const pct = Math.round(progress * 10000) / 100
            const payload = item.contentType === 'series' && item.season != null && item.episode != null
              ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
              : buildMovieScrobble(item.imdbId, pct)
            traktScrobbleStart(payload).catch(() => {})
          }
        }
      })
    }
  }

  const seekBy = (secs: number) => {
    if (!playerRunning) return
    if (wtControlBlocked()) { wtBlockedNotice(); return }
    const targetTime = progressRef.current.currentTime + secs
    command('seek', [secs, 'relative'])
    sendWatchTogetherSeek(targetTime)
  }
  // seekTo is now handled directly by inline slider events.
  const changeVolume = (val: number) => {
    volumeRef.current = val
    command('set_property', ['volume', val])
  }

  const changeAudio = (id: number) => {
    setSelectedAudio(id)
    command('set_property', ['aid', id])
    setTrackMenu(null)
  }

  const startLiveAiSubtitles = useCallback(async () => {
    if (!openrouterApiKey || !subtitleTranslationLang) {
      setError('Set an OpenRouter key and target subtitle language first.')
      return
    }
    if (aiStartInProgressRef.current) return
    aiStartInProgressRef.current = true

    setTranslatingSubtitles(true)
    setError('')
    try {
      await loadAddonSubtitles()
      await refreshTracks().catch(() => false)

      const sourceTrackId = selectedSub !== 'no' && selectedSub !== aiSubtitleTrackIdRef.current
        ? selectedSub
        : (subTracks.find((track) => track.id !== aiSubtitleTrackIdRef.current)?.id)
      if (sourceTrackId == null) {
        setError('AI subtitles need a subtitle track to translate from.')
        return
      }

      // Pull the full source cue list up front so we can translate ahead of
      // playback with the ORIGINAL timestamps (exact sync, latency-proof).
      const rawList = (await getPlayerProperty('track-list').catch(() => null)) as MpvTrack[] | null
      const sourceTrack = Array.isArray(rawList) ? rawList.find((t) => t.id === sourceTrackId) : undefined
      const externalPath = subtitleTrackSourcesRef.current.get(sourceTrackId)?.localPath
      let sourceContent = ''
      if (externalPath) {
        sourceContent = await readTempSubtitle(externalPath).catch(() => '')
      } else if (sourceTrack?.['ff-index'] != null && Array.isArray(rawList)) {
        const pathProp = (await getPlayerProperty('path').catch(() => null)) as string | null
        const streamName = (await getPlayerProperty('stream-open-filename').catch(() => null)) as string | null
        const mediaPath = pathProp || streamName || currentStreamUrlRef.current
        if (!mediaPath) throw new Error('Could not resolve the media path for extraction.')
        // ffmpeg maps subtitles by their relative index (0:s:N). Embedded sub
        // streams keep the same order as mpv's ff-index, so the chosen track's
        // position among embedded subs (sorted by ff-index) is that N.
        const embeddedSubs = rawList
          .filter((t) => t.type === 'sub' && t['ff-index'] != null)
          .sort((a, b) => (a['ff-index'] as number) - (b['ff-index'] as number))
        const subIndex = embeddedSubs.findIndex((t) => t.id === sourceTrackId)
        if (subIndex < 0) throw new Error('Could not locate the source subtitle stream.')
        sourceContent = await extractEmbeddedSubtitle(mediaPath, subIndex)
      } else {
        throw new Error('Could not access the source subtitle track.')
      }
      const cues = parseSubtitleCues(sourceContent)
      if (cues.length === 0) throw new Error('No subtitle cues found in the source track.')
      sourceCuesRef.current = cues

      // Reuse an existing AI track if we made one earlier (avoids duplicates).
      if (aiSubtitleTrackIdRef.current != null) {
        await sendPlayerCommand('sub-remove', [aiSubtitleTrackIdRef.current]).catch(() => {})
        aiSubtitleTrackIdRef.current = null
      }

      liveAiCueIndexRef.current = 0
      liveAiLastCueRef.current = ''
      sourceNextIdxRef.current = 0
      liveAiSubtitleContentRef.current = '1\n00:00:00,000 --> 00:00:00,100\n.\n\n'
      const translatedPath = await writeTempSubtitle(liveAiSubtitleContentRef.current, 'srt')
      liveAiSubtitlePathRef.current = translatedPath

      const lang = APP_LANGUAGES.find((l) => l.code === subtitleTranslationLang)
      const label = `AI ${lang?.name || subtitleTranslationLang} (Translated)`
      await sendPlayerCommand('sub-add', [translatedPath, 'select', label, subtitleTranslationLang])
      await sendPlayerCommand('set_property', ['sub-ass-override', 'force']).catch(() => {})
      await sendPlayerCommand('set_property', ['sub-visibility', true])
      await refreshTracks().catch(() => false)

      const selected = await getPlayerProperty('sid').catch(() => null)
      if (typeof selected === 'number') {
        setSelectedSub(selected)
        aiSubtitleTrackIdRef.current = selected
      }
      aiSubtitleSourceTrackIdRef.current = sourceTrackId
      setLiveTranslateOn(true)
    } catch (e) {
      setError(`AI subtitle translation failed: ${String(e)}`)
    } finally {
      setTranslatingSubtitles(false)
      aiStartInProgressRef.current = false
    }
  }, [loadAddonSubtitles, openrouterApiKey, refreshTracks, selectedSub, subTracks, subtitleTranslationLang])

  const toggleAiSubtitleTrack = useCallback(async () => {
    if (translatingSubtitles) return
    if (!liveTranslateOn) {
      await startLiveAiSubtitles()
      return
    }

    setLiveTranslateOn(false)
    await sendPlayerCommand('set_property', ['secondary-sid', 'no']).catch(() => {})
    const sourceTrackId = aiSubtitleSourceTrackIdRef.current
    if (sourceTrackId != null) {
      setSelectedSub(sourceTrackId)
      command('set_property', ['sid', sourceTrackId])
      command('set_property', ['sub-visibility', true])
    } else {
      setSelectedSub('no')
      command('set_property', ['sub-visibility', false])
    }
  }, [command, liveTranslateOn, startLiveAiSubtitles, translatingSubtitles])

  // Auto-start live AI subtitle translation once per playback when the
  // "Translate subtitles" setting is on and a source track is available.
  const autoTranslateStartedRef = useRef(false)
  useEffect(() => {
    if (!subtitleTranslationEnabled || autoTranslateStartedRef.current) return
    if (!openrouterApiKey || !subtitleTranslationLang) return
    if (!tracksLoaded || subTracks.length === 0) return
    if (liveTranslateOn || translatingSubtitles) return
    autoTranslateStartedRef.current = true
    startLiveAiSubtitles()
  }, [subtitleTranslationEnabled, openrouterApiKey, subtitleTranslationLang, tracksLoaded, subTracks, liveTranslateOn, translatingSubtitles, startLiveAiSubtitles])

  const changeSub = (id: number | 'no') => {
    setSelectedSub(id)
    setLiveTranslateOn(id !== 'no' && id === aiSubtitleTrackIdRef.current)
    if (id === 'no') {
      sendPlayerCommand('set_property', ['secondary-sid', 'no']).catch(() => {})
      command('set_property', ['sub-visibility', false])
    } else {
      if (id !== aiSubtitleTrackIdRef.current) {
        sendPlayerCommand('set_property', ['secondary-sid', 'no']).catch(() => {})
      }
      command('set_property', ['sid', id])
      sendPlayerCommand('set_property', ['sub-ass-override', 'force']).catch(() => {})
      command('set_property', ['sub-visibility', true])
    }
    setTrackMenu(null)
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0
  const displayProgressPct = isDragging ? draggingProgress : progressPct
  const displayCurrentTime = isDragging ? duration * (draggingProgress / 100) : currentTime
  const displayRemaining = Math.max(0, duration - displayCurrentTime)
  const skipTimelineRanges = duration > 0
    ? skips.flatMap((segment) => {
        const ranges = [
          { type: 'recap', start: segment.recap_start_ms, end: segment.recap_end_ms },
          { type: 'intro', start: segment.intro_start_ms, end: segment.intro_end_ms },
          { type: 'credits', start: segment.credits_start_ms, end: segment.credits_end_ms },
        ]
        return ranges
          .filter((range): range is { type: string; start: number; end: number } => range.start != null && range.end != null && range.end > range.start)
          .map((range) => ({
            ...range,
            left: Math.max(0, Math.min(100, (range.start / 1000 / duration) * 100)),
            width: Math.max(0, Math.min(100, ((range.end - range.start) / 1000 / duration) * 100)),
          }))
      })
    : []

  // ─ Overlay ────────────────────────────────────────────────────────────────

  const overlay = (
    <div
      className={`fixed inset-0 z-[60] text-white select-none ${controlsVisible ? 'cursor-default' : 'cursor-none'}`}
      style={{ background: playerReady ? 'rgba(0,0,0,0.05)' : '#000' }}
      onMouseMove={showControls}
    >
      {onReportBad && controlsVisible && <button onClick={onReportBad} className="absolute right-6 top-6 z-30 rounded-full bg-black/65 px-4 py-2 text-xs text-white/70 hover:text-white">Report bad stream</button>}
      {!playerReady && !error && (
        <div className="absolute inset-0 z-[3] flex items-center justify-center bg-black pointer-events-none">
          <div className="flex flex-col items-center gap-4">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            <p className="text-sm font-semibold text-white/70">Loading video...</p>
          </div>
        </div>
      )}
      {/* Video click area (sit below controls) */}
      <div
        className="absolute inset-0 z-[1]"
        onClick={() => { if (!useWatchTogetherStore.getState().drawModeActive) { showControls(); togglePlay() } }}
        onDoubleClick={() => { if (!useWatchTogetherStore.getState().drawModeActive) toggleFullscreen() }}
      />

      {/* Window drag strip — the player overlay covers the TitleBar, so give back a
          draggable region across the top. Top-corner buttons sit above this (higher z). */}
      {!isFullscreen && (
        <div data-tauri-drag-region className="absolute top-0 inset-x-0 h-14 z-[3]" />
      )}

      {/* Buffering spinner */}
      {buffering && !paused && playerReady && (
        <div className="absolute inset-0 z-[2] flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-white/25 border-t-white rounded-full animate-spin" />
          </div>
        </div>
      )}

      {/* Netflix-style paused info overlay — shown once controls auto-hide */}
      {paused && playerReady && !buffering && !error && !controlsVisible && (
        <PausedInfoOverlay
          title={currentDisplayTitle}
          subtitle={currentDisplaySubtitle}
          backdrop={currentBackdropRef.current}
          meta={currentMeta}
        />
      )}

      {/* Center play/pause indicator — hidden while the paused info panel is up */}
      {paused && controlsVisible && (
        <div className="absolute inset-0 z-[2] flex items-center justify-center pointer-events-none">
          <div className="w-20 h-20 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
            <svg className="w-10 h-10 ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Keyboard Seek HUD */}
      {accumulatedSeek !== null && (
        <div className="absolute inset-0 z-[20] flex items-center justify-center pointer-events-none">
          <div className="bg-black/75 border border-white/10 px-6 py-3.5 rounded-2xl flex items-center gap-3 shadow-2xl backdrop-blur-md">
            <span className="text-xl font-bold font-mono text-white">
              {accumulatedSeek > 0 ? `+${accumulatedSeek}` : accumulatedSeek}s
            </span>
          </div>
        </div>
      )}

      {/* Back button — top left */}
      <div
        className={`absolute top-0 left-0 z-[15] p-6 transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); close() }}
          className="w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Fatal startup failure — playback never began, offer a way out */}
      {error && !playerReady && (
        <div className="absolute inset-0 z-[25] flex items-center justify-center bg-black/80 backdrop-blur-sm px-6">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-950/90 p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10">
              <svg className="h-6 w-6 text-red-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <h3 className="mb-1.5 text-base font-bold text-white">This stream could not be played</h3>
            <p className="mb-5 break-words text-xs leading-relaxed text-white/45">{error}</p>
            <div className="flex items-center justify-center gap-2.5">
              <button
                onClick={(e) => { e.stopPropagation(); pickAnother() }}
                className="cursor-pointer rounded-xl border border-accent/20 bg-accent/15 px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/25"
              >
                Choose another stream
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); retryStream() }}
                className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transient playback notices */}
      {error && playerReady && (
        <div className="absolute left-1/2 top-20 z-20 -translate-x-1/2 max-w-md rounded-2xl border border-red-500/25 bg-red-900/60 backdrop-blur-xl px-5 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Track loading spinner */}
      {!tracksLoaded && !error && (
        <div className="absolute left-1/2 bottom-32 z-20 -translate-x-1/2 flex items-center gap-2 text-xs text-white/40 pointer-events-none">
          <div className="w-3.5 h-3.5 border border-white/30 border-t-transparent rounded-full animate-spin" />
          Detecting tracks…
        </div>
      )}

      {/* Watch Together overlays */}
      {isInWatchTogether && (
        <>
          <PlayerDrawOverlay />
          <PlayerChatOverlay />
        </>
      )}

      {/* Skip Intro / Credits button */}
      {activeSkip && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (wtControlBlocked()) { wtBlockedNotice(); return }
            let endMs: number
            if (skipType === 'intro') endMs = activeSkip.intro_end_ms
            else if (skipType === 'recap') endMs = activeSkip.recap_end_ms ?? activeSkip.intro_end_ms
            else endMs = activeSkip.credits_end_ms ?? duration * 1000
            const targetSec = endMs / 1000
            if (!isNaN(targetSec)) {
              command('seek', [targetSec, 'absolute'])
              sendWatchTogetherSeek(targetSec)
              setActiveSkip(null)
              setSkipType(null)
            }
          }}
          className={`absolute z-[20] right-8 px-6 py-3 bg-black/70 hover:bg-black/90 border border-white/25 text-white rounded-xl text-sm font-semibold shadow-2xl backdrop-blur-md transition-all duration-300 flex items-center gap-2 ${
            controlsVisible ? 'bottom-36' : 'bottom-8'
          }`}
        >
          <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5.88 4.12L13.76 12l-7.88 7.88L8 22l10-10L8 2z" />
            <path d="M18 5h2v14h-2z" />
          </svg>
          Skip {skipType === 'intro' ? 'Intro' : skipType === 'recap' ? 'Recap' : 'Credits'}
        </button>
      )}

      {/* ── Bottom controls bar ── */}
      <div
        className={`absolute inset-x-0 bottom-0 z-[10] transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-8 pt-20 pb-6 bg-gradient-to-t from-black/90 via-black/55 to-transparent">

          {/* Info row: title + track icons */}
          <div className="flex items-end justify-between mb-4">
            <div className="min-w-0 pr-4">
              <h2 className="text-2xl font-bold leading-tight truncate">{currentDisplayTitle}</h2>
              {currentDisplaySubtitle && (
                <p className="text-sm text-white/50 tracking-wider uppercase mt-1 truncate">{currentDisplaySubtitle}</p>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {/* Subtitle button */}
              <div className="relative">
                {trackMenu === 'subs' && (
                  <TrackMenuPanel
                    type="subs"
                    tracks={subTracks}
                    selected={selectedSub}
                    onSelect={changeSub}
                    onClose={() => setTrackMenu(null)}
                    onToggleTranslate={toggleAiSubtitleTrack}
                    translateActive={liveTranslateOn}
                    hasTranslateKey={!!openrouterApiKey && !!subtitleTranslationLang}
                  />
                )}
                <button
                  onClick={() => setTrackMenu(trackMenu === 'subs' ? null : 'subs')}
                  onFocus={() => loadAddonSubtitles().then(() => refreshTracks()).catch(() => {})}
                  title="Subtitles"
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${trackMenu === 'subs' || selectedSub !== 'no' ? 'bg-white/20 text-white' : 'bg-white/8 text-white/60 hover:bg-white/15 hover:text-white'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <rect x="2" y="4" width="20" height="16" rx="2.5" />
                    <path d="M6 11h6M6 15h10" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              {/* Audio button */}
              <div className="relative">
                {trackMenu === 'audio' && (
                  <TrackMenuPanel
                    type="audio"
                    tracks={audioTracks}
                    selected={selectedAudio}
                    onSelect={(id) => changeAudio(id as number)}
                    onClose={() => setTrackMenu(null)}
                  />
                )}
                <button
                  onClick={() => setTrackMenu(trackMenu === 'audio' ? null : 'audio')}
                  onFocus={() => refreshTracks().catch(() => {})}
                  title="Audio track"
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${trackMenu === 'audio' ? 'bg-white/20 text-white' : 'bg-white/8 text-white/60 hover:bg-white/15 hover:text-white'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M9 18V5l12-2v13" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                  </svg>
                </button>
              </div>

              {/* Speed */}
              <div className="relative ml-1">
                {showSpeedMenu && (
                  <div className="absolute bottom-full mb-2 right-0 bg-black/90 backdrop-blur-xl border border-white/15 rounded-xl py-1.5 shadow-2xl z-50 min-w-[100px]">
                    {SPEED_OPTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => changeSpeed(s)}
                        className={`w-full px-4 py-1.5 text-xs font-semibold text-left transition-colors ${
                          playbackSpeed === s ? 'text-accent bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/8'
                        }`}
                      >
                        {s === 1 ? 'Normal' : `${s}x`}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setShowSpeedMenu((v) => !v)}
                  title="Playback speed"
                  className={`h-7 px-2 rounded-lg flex items-center justify-center text-xs font-bold transition-colors ${
                    playbackSpeed !== 1 ? 'bg-accent/20 text-accent' : 'bg-white/8 text-white/60 hover:bg-white/15 hover:text-white'
                  }`}
                >
                  {playbackSpeed === 1 ? '1x' : `${playbackSpeed}x`}
                </button>
              </div>

              {/* Volume */}
              <div className="flex items-center gap-1.5 ml-1 group/vol">
                <button
                  onClick={() => {
                    const newVol = volume > 0 ? 0 : (volumeRef.current > 0 ? volumeRef.current : 100)
                    setVolume(newVol)
                    if (newVol > 0) volumeRef.current = newVol
                    localStorage.setItem('orynt_volume', String(newVol))
                    changeVolume(newVol)
                  }}
                  title={volume > 0 ? 'Mute (M)' : 'Unmute (M)'}
                  className="w-5 h-5 flex items-center justify-center text-white/50 hover:text-white transition-colors flex-shrink-0"
                >
                  {volume === 0 ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M11 5L6 9H2v6h4l5 4V5z" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="23" y1="9" x2="17" y2="15" strokeLinecap="round" />
                      <line x1="17" y1="9" x2="23" y2="15" strokeLinecap="round" />
                    </svg>
                  ) : volume < 50 ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M11 5L6 9H2v6h4l5 4V5z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M15.54 8.46a5 5 0 010 7.07" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                      <path d="M11 5L6 9H2v6h4l5 4V5z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={130}
                  value={volume}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setVolume(v)
                    volumeRef.current = v
                    localStorage.setItem('orynt_volume', String(v))
                    changeVolume(v)
                  }}
                  className="w-20 accent-white cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
                />
              </div>

              {/* Pick another */}
              <button
                onClick={pickAnother}
                title="Pick another stream"
                className="w-9 h-9 rounded-xl bg-white/8 text-white/60 hover:bg-white/15 hover:text-white flex items-center justify-center transition-colors ml-1"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                  <path d="M1 4v6h6M23 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                className="w-9 h-9 rounded-xl bg-white/8 text-white/60 hover:bg-white/15 hover:text-white flex items-center justify-center transition-colors"
              >
                {isFullscreen ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M8 3v3a2 2 0 01-2 2H3M16 3v3a2 2 0 002 2h3M8 21v-3a2 2 0 00-2-2H3M16 21v-3a2 2 0 012-2h3" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Seek bar + playback controls row */}
          <div className="flex items-center gap-3 mb-2 px-10">
            {/* Play/Pause */}
            <button
              onClick={(e) => { e.stopPropagation(); togglePlay() }}
              title={paused ? 'Play (Space)' : 'Pause (Space)'}
              className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors flex-shrink-0"
            >
              {paused ? (
                <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
                </svg>
              )}
            </button>

            {/* Skip back */}
            <button
              onClick={(e) => { e.stopPropagation(); seekBy(-seekStepSeconds) }}
              title={`Back ${seekStepSeconds}s (←)`}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
                <text x="11.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">{seekStepSeconds}</text>
              </svg>
            </button>

            {/* Skip forward */}
            <button
              onClick={(e) => { e.stopPropagation(); seekBy(seekStepSeconds) }}
              title={`Forward ${seekStepSeconds}s (→)`}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.16-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z" />
                <text x="12.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">{seekStepSeconds}</text>
              </svg>
            </button>

            <div
              className="relative flex-1 h-1.5 group cursor-pointer transition-[height] duration-150 hover:h-2.5"
              onPointerMove={showTimelinePreviewFromPointer}
              onPointerLeave={hideTimelinePreview}
            >
              {timelinePreview.visible && (
                <div
                  className="pointer-events-none absolute bottom-7 z-[20] -translate-x-1/2"
                  style={{ left: `${timelinePreview.leftPct}%` }}
                >
                  <span className="rounded-lg border border-white/10 bg-black/85 px-2.5 py-1 text-xs font-semibold text-white/90 shadow-xl backdrop-blur-sm">
                    {formatTime(timelinePreview.time)}
                  </span>
                </div>
              )}
              <div className="absolute inset-0 rounded-full bg-white/20 group-hover:bg-white/30 transition-colors" />
              {skipTimelineRanges.map((range, index) => (
                <button
                  key={`${range.type}-${range.start}-${range.end}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (wtControlBlocked()) { wtBlockedNotice(); return }
                    const targetTime = range.end / 1000
                    command('seek', [targetTime, 'absolute'])
                    sendWatchTogetherSeek(targetTime)
                  }}
                  title={`Skip ${range.type === 'credits' ? 'outro' : range.type}`}
                  aria-label={`Skip ${range.type === 'credits' ? 'outro' : range.type}`}
                  className={`absolute inset-y-[1px] z-[3] min-w-[3px] rounded-sm opacity-65 transition-all hover:inset-y-[-2px] hover:opacity-100 ${
                    range.type === 'recap'
                      ? 'bg-sky-400/90'
                      : range.type === 'intro'
                        ? 'bg-violet-400/90'
                        : 'bg-amber-400/90'
                  }`}
                  style={{ left: `${range.left}%`, width: `${range.width}%` }}
                />
              ))}
              <div
                className="absolute inset-y-0 left-0 z-[1] rounded-full bg-white/90 transition-all"
                style={{ width: `${displayProgressPct}%` }}
              />
              {/* Thumb dot */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ left: `calc(${displayProgressPct}% - 6px)` }}
              />
              <input
                type="range"
                min={0}
                max={100}
                step={0.05}
                value={displayProgressPct}
                onMouseDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const clickPct = rect.width > 0 ? Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)) : progressPct
                  isDraggingRef.current = true
                  setIsDragging(true)
                  draggingProgressRef.current = clickPct
                  setDraggingProgress(clickPct)
                  updateTimelinePreviewAtPct(clickPct)
                }}
                onMouseUp={(e) => {
                  // Seek to the exact release position. Relying on draggingProgressRef
                  // is unreliable: the native range's onChange can overwrite it with a
                  // stepped value on a plain click, which broke backward-clicks.
                  const rect = e.currentTarget.getBoundingClientRect()
                  const upPct = rect.width > 0
                    ? Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100))
                    : draggingProgressRef.current
                  draggingProgressRef.current = upPct
                  setIsDragging(false)
                  hideTimelinePreview()
                  if (wtControlBlocked()) { wtBlockedNotice(); return }
                  command('seek', [upPct, 'absolute-percent'])
                  if (duration > 0) sendWatchTogetherSeek((upPct / 100) * duration)
                }}
                onTouchStart={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const touch = e.touches[0]
                  const clickPct = rect.width > 0 && touch ? Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100)) : progressPct
                  isDraggingRef.current = true
                  setIsDragging(true)
                  draggingProgressRef.current = clickPct
                  setDraggingProgress(clickPct)
                  updateTimelinePreviewAtPct(clickPct)
                }}
                onTouchEnd={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const touch = e.changedTouches[0]
                  const upPct = rect.width > 0 && touch
                    ? Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100))
                    : draggingProgressRef.current
                  draggingProgressRef.current = upPct
                  setIsDragging(false)
                  hideTimelinePreview()
                  if (wtControlBlocked()) { wtBlockedNotice(); return }
                  command('seek', [upPct, 'absolute-percent'])
                  if (duration > 0) sendWatchTogetherSeek((upPct / 100) * duration)
                }}
                onChange={(e) => {
                  const val = Number(e.target.value)
                  draggingProgressRef.current = val
                  setDraggingProgress(val)
                  if (isDraggingRef.current) updateTimelinePreviewAtPct(val)
                }}
                className="absolute inset-0 w-full opacity-0 cursor-pointer h-6 -top-2.5"
              />
            </div>
          </div>

          {/* Timestamps row */}
          <div className="flex items-center justify-between text-[11px] text-white/45 px-10">
            <span>{duration > 0 ? formatTime(displayCurrentTime) : '--:--'}</span>
            <button
              onClick={() => setShowTimeRemaining((r) => !r)}
              className="hover:text-white/70 transition-colors"
            >
              {duration > 0
                ? showTimeRemaining
                  ? `-${formatTime(displayRemaining)}`
                  : formatTime(duration)
                : '--:--'}
            </button>
          </div>
        </div>
      </div>

      {/* Live translated subtitle overlay */}
      {false && liveTranslateOn && currentSubText && (() => {
        const subTextShadow = subtitleBorderStyle === 'outline'
          ? `0 0 3px rgba(0,0,0,0.9), 0 0 1px rgba(0,0,0,0.9), 1px 1px 0 rgba(0,0,0,0.8), -1px -1px 0 rgba(0,0,0,0.8)`
          : subtitleBorderStyle === 'shadow'
            ? `2px 2px 4px rgba(0,0,0,0.9)`
            : 'none'
        return (
          <div className="absolute inset-x-0 bottom-24 z-[8] flex flex-col items-center pointer-events-none px-12 gap-1">
            {translatedText ? (
              <span
                className="inline-block px-3 py-1 rounded font-semibold leading-snug text-center"
                style={{
                  fontSize: `${subtitleFontSize}px`,
                  color: subtitleColor,
                  backgroundColor: `rgba(0, 0, 0, ${subtitleBgOpacity})`,
                  textShadow: subTextShadow,
                }}
              >
                {translatedText}
              </span>
            ) : (
              <span
                className="inline-block px-3 py-1 rounded italic leading-snug text-center"
                style={{
                  fontSize: `${Math.max(14, subtitleFontSize - 4)}px`,
                  color: `${subtitleColor}80`,
                  backgroundColor: `rgba(0, 0, 0, ${Math.max(0.3, Number(subtitleBgOpacity))})`,
                }}
              >
                {currentSubText}
              </span>
            )}
          </div>
        )
      })()}

      {/* Up Next overlay */}
      {showUpNext && nextEpInfo && (
        <UpNextOverlay
          nextEp={nextEpInfo}
          showBackdrop={currentBackdropRef.current}
          countdown={upNextCountdown}
          isSearching={isAutoSearching}
          onPlay={handleAutoplay}
          onDismiss={() => {
            upNextCancelledRef.current = true
            setShowUpNext(false)
          }}
        />
      )}
    </div>
  )

  return createPortal(overlay, document.body)
}

export default function NativeMpvPlayer(props: NativeMpvPlayerProps) {
  const isolatedPlaybackMode = useAppStore((state) => state.isolatedPlaybackMode)
  return isolatedPlaybackMode
    ? <IsolatedNativeMpvPlayer {...props} />
    : <FullNativeMpvPlayer {...props} />
}
