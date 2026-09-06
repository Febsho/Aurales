import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { SubtitleResult } from '../types'
import { logEvent } from '../services/diagnostics'
import { setRequestPlaybackActive } from '../services/network/requestCoordinator'
import { getTmdbApiKey } from '../services/apiKeys'
import { clearPlayerThumbnail, downloadSubtitle, launchEmbeddedPlayer, resizeEmbeddedPlayer, sendPlayerCommand, stopEmbeddedPlayer, getPlayerProperty, getPlayerSnapshot, getOrQueueScrubThumbnail, startThumbnailGeneration, isEmbeddedPlayerRunning, requestPlayerThumbnail, writeTempSubtitle, updateTempSubtitle, readTempSubtitle, extractEmbeddedSubtitle, openRouterChat, type ThumbnailMetadata } from '../services/player'
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
import { streamPreloadManager, StreamPreloadPriority, type PreloadedStream, type StreamPreloadRequest } from '../services/streams/preloadManager'
import { canonicalStreamKey } from '../services/streams/preloadUtils'
import { buildSmartContext, preparedStreamRegistry } from '../services/streams/preparedStreams'
import { rankStreams, type SmartStream } from '../services/streams/smartScoring'
import { getPlayableStreamUrl } from '../services/streams/playableUrl'
import { recordReliabilityEvent } from '../services/streams/reliabilityHistory'
import { useAppStore, getLanguageCodeFromTrack, getLanguageNameFromTrack, APP_LANGUAGES } from '../stores/appStore'
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
import { recordPlaybackSample } from '../services/viewingActivity'
import PlayerDebugPanel from './PlayerDebugPanel'
import { collectNativePlayerDebugSnapshot, type NativePlayerDebugSnapshot } from '../services/playerDebug'
import { annotateTorBoxStreams, resolveTorBoxStream } from '../services/torbox'

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
  onPlaybackError?: (message: string, positionSeconds?: number) => void
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
  forced?: boolean
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
  forced?: boolean
}

interface TimelinePreview {
  visible: boolean
  leftPct: number
  time: number
}

function ScrubThumbnailImage({ src, onInvalid }: { src: string; onInvalid: () => void }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className={`h-[135px] w-60 overflow-hidden rounded-xl transition-opacity duration-100 ${loaded ? 'border border-white/20 opacity-100 shadow-[0_18px_55px_rgba(0,0,0,0.72)] ring-1 ring-black/50' : 'opacity-0'}`}>
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={onInvalid}
      />
    </div>
  )
}

interface PlayerChapter {
  title: string
  time: number
}

function findEndingChapterTime(chapters: PlayerChapter[], duration: number): number | null {
  if (duration <= 0) return null

  const endingChapterPattern = /(?:^|\b)(?:end(?:ing)?\s*credits?|credits?|credit\s*roll|outro|ending|end\s*titles?|ending\s*theme|ed\s*\d*)(?:\b|$)/i
  const candidates = chapters
    .filter((chapter) => endingChapterPattern.test(chapter.title.trim()))
    // Ignore malformed early markers and chapters that start after playback.
    .filter((chapter) => chapter.time >= duration * 0.5 && chapter.time < duration - 1)
    .sort((a, b) => a.time - b.time)

  return candidates[0]?.time ?? null
}

function introDbChapters(segments: PMDBSkipSegment[]): PlayerChapter[] {
  const chapters = segments
    .filter((segment) => segment.id.startsWith('introdb-'))
    .flatMap((segment) => [
      { title: 'Recap', time: segment.recap_start_ms },
      { title: 'Intro', time: segment.intro_start_ms },
      { title: 'Credits', time: segment.credits_start_ms },
    ])
    .flatMap((chapter) => typeof chapter.time === 'number' && chapter.time >= 0
      ? [{ title: chapter.title, time: chapter.time / 1000 }]
      : [])

  return chapters
    .sort((a, b) => a.time - b.time)
    .filter((chapter, index) => index === 0 || chapter.time !== chapters[index - 1].time)
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function languageName(value?: string): string {
  return getLanguageNameFromTrack(value)
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
  countdownDuration: number
  autoplayEnabled: boolean
  isSearching: boolean
  onPlay: () => void
  onDismiss: () => void
}

function UpNextOverlay({ nextEp, showBackdrop, countdown, countdownDuration, autoplayEnabled, isSearching, onPlay, onDismiss }: UpNextOverlayProps) {
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
      {/* The native video surface is a rectangle and cannot be clipped by the
          WebView. Keep the frame square too, otherwise its transparent rounded
          corners reveal black patches around the live player. */}
      <div className="absolute right-[var(--pip-right)] top-[var(--pip-top)] w-[var(--pip-w)] h-[var(--pip-h)] border border-white/20 shadow-2xl bg-transparent pointer-events-none">
        <div className="absolute inset-0 ring-1 ring-white/15 shadow-[0_0_80px_rgba(0,0,0,0.9)]" />
        <span className="absolute left-3 top-2 rounded-full bg-black/55 px-2 py-1 text-meta font-semibold uppercase tracking-[0.16em] text-white/65 backdrop-blur-sm">
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
          {backdrop && (
            <div className="flex-shrink-0 w-44 rounded-lg overflow-hidden aspect-video bg-white/10 shadow-2xl">
              <img
                src={backdrop}
                className="w-full h-full object-cover brightness-[.72] contrast-[.96]"
                draggable={false}
              />
            </div>
          )}

          {/* Episode info */}
          <div className="flex-1 min-w-0 pb-1">
            <p className="text-xs text-white/50 font-medium tracking-wider mb-1">{epCode}</p>
            <h3 className="text-xl font-bold text-white leading-tight truncate">{nextEp.title}</h3>
            {nextEp.overview && (
              <p className="text-sm text-white/60 mt-1.5 line-clamp-2 leading-relaxed">{nextEp.overview}</p>
            )}
            {nextEp.runtime != null && (
              <p className="text-xs text-white/60 mt-1">{nextEp.runtime} min</p>
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
                    {autoplayEnabled ? `Playing in ${countdown}…` : 'Play next episode'}
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

      </div>

      {/* Keep the countdown edge-to-edge. It must not inherit the content
          column's right inset, which only exists to leave room for PiP. */}
      {autoplayEnabled && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-white/15 overflow-hidden">
          <div
            className="h-full bg-white/70 transition-all duration-1000 ease-linear"
            style={{ width: `${((countdownDuration - countdown) / countdownDuration) * 100}%` }}
          />
        </div>
      )}
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
        <p className="text-sm font-semibold tracking-[0.2em] uppercase text-white/60 mb-3">You're watching</p>
        <h1 className="text-4xl md:text-5xl font-bold text-white leading-tight drop-shadow-lg">{title}</h1>
        {metaBits.length > 0 && (
          <p className="mt-3 text-base text-white/70 font-medium">{metaBits.join('  ·  ')}</p>
        )}
        {!metaBits.length && subtitle && (
          <p className="mt-3 text-sm text-white/60 tracking-wider uppercase">{subtitle}</p>
        )}
        {meta?.genres?.length ? (
          <p className="mt-2 text-sm text-white/60">{meta.genres.slice(0, 3).join(' · ')}</p>
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
      <div className="px-4 py-1.5 text-meta font-semibold tracking-wider text-white/60 uppercase">
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
        <div className="px-4 py-2 text-sm text-white/60">No tracks detected</div>
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
let fullPlayerMountCount = 0

// True when we're a watch-together guest without playback-control rights.
// Local transport actions (pause, seek) are blocked so the guest doesn't
// desync from the room and then get yanked back by drift correction.
function wtControlBlocked(): boolean {
  const wt = useWatchTogetherStore.getState()
  if (!wt.currentRoom || !wt.currentUserId) return false
  return wt.currentRoom.hostUserId !== wt.currentUserId && !wt.currentRoom.everyoneCanControl
}

// mpv args derived from settings that aren't first-class launch params.
function buildMpvExtraArgs(storeState: { mpvCustomArgs: string; audioPassthrough: boolean; playerQualityProfile: 'performance' | 'balanced' | 'quality' }): string {
  // These mirror mpv's safe renderer presets: the default stays conservative,
  // while users with weaker or stronger GPUs get a one-choice tuning option.
  const qualityArgs = storeState.playerQualityProfile === 'performance'
    ? '--scale=bilinear --cscale=bilinear --dscale=bilinear --dither=no --deband=no --vd-lavc-fast=yes --interpolation=no --hdr-compute-peak=no'
    : storeState.playerQualityProfile === 'quality'
      ? '--scale=ewa_lanczossharp --cscale=ewa_lanczossharp --dscale=mitchell --deband=yes --deband-iterations=2 --dither-depth=auto --correct-downscaling=yes --linear-downscaling=yes --sigmoid-upscaling=yes --hdr-compute-peak=yes'
      : ''
  const parts = [qualityArgs, storeState.mpvCustomArgs?.trim() ?? '']
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
          <p className="mt-2 text-sm text-white/60">Use mpv's native controls. Aurales IPC and window hooks are disabled.</p>
          <p className="mt-4 text-xs text-white/60">Hardware decoding: {hwdecMode}</p>
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
}: NativeMpvPlayerProps) {
  useEffect(() => {
    setRequestPlaybackActive(true)
    return () => setRequestPlaybackActive(false)
  }, [])

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
  const nextPrepareTriggeredRef = useRef(false)

  // ─ State ─────────────────────────────────────────────────────────────────
  const [controlsVisible, setControlsVisible] = useState(true)
  const [paused, setPaused] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const eofClosedRef = useRef(false)
  const closeRef = useRef<(() => Promise<void>) | null>(null)
  const closingRef = useRef(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Ref mirror avoids stale closures during native fullscreen transitions.
  const isFullscreenRef = useRef(false)
  useEffect(() => { isFullscreenRef.current = isFullscreen }, [isFullscreen])
  const fullscreenTransitionRef = useRef(0)
  const fullscreenTransitionPendingRef = useRef(false)
  useEffect(() => {
    let disposed = false
    const syncFullscreenState = async () => {
      const fullscreen = await getCurrentWindow().isFullscreen().catch(() => isFullscreenRef.current)
      if (disposed) return
      isFullscreenRef.current = fullscreen
      setIsFullscreen(fullscreen)
    }
    syncFullscreenState().catch(() => {})
    return () => {
      disposed = true
    }
  }, [])
  const [error, setError] = useState('')
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subTracks, setSubTracks] = useState<TrackOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState<number>(1)
  const [selectedSub, setSelectedSub] = useState<number | 'no'>('no')
  const [tracksLoaded, setTracksLoaded] = useState(false)
  const [playerReady, setPlayerReady] = useState(false)
  const playerReadyRef = useRef(false)
  const [playerRunning, setPlayerRunning] = useState(true)
  const bufferingStartedAtRef = useRef<number | null>(null)
  const unstableStreamNotifiedRef = useRef(false)
  const onPlaybackErrorRef = useRef(onPlaybackError)
  useEffect(() => { playerReadyRef.current = playerReady }, [playerReady])
  useEffect(() => { onPlaybackErrorRef.current = onPlaybackError }, [onPlaybackError])
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
  const [timelineThumbnail, setTimelineThumbnail] = useState<string | null>(null)
  const [mediaBadges, setMediaBadges] = useState<string[]>([])
  const [chapters, setChapters] = useState<PlayerChapter[]>([])
  const [showChapters, setShowChapters] = useState(false)
  const [chapterThumbs, setChapterThumbs] = useState<Record<string, string>>({})
  const chapterThumbsRef = useRef<Record<string, string>>({})
  const chapterThumbRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chapterStripRef = useRef<HTMLDivElement | null>(null)
  const videoOutputFallbackAttemptedRef = useRef(false)
  const restartPlaybackRef = useRef<(resumeTime: number, options?: { hwdecMode?: 'no'; decodedAudio?: boolean }) => void>(() => {})
  const [showMediaInfo, setShowMediaInfo] = useState(false)
  const [showPlayerDebug, setShowPlayerDebug] = useState(false)
  const [playerDebugSnapshot, setPlayerDebugSnapshot] = useState<NativePlayerDebugSnapshot | null>(null)
  const [playerDebugLoading, setPlayerDebugLoading] = useState(false)
  const [playerDebugError, setPlayerDebugError] = useState('')
  const isDraggingRef = useRef(false)
  const activeTimelinePointerRef = useRef<number | null>(null)
  const thumbnailRequestRef = useRef(0)
  const nativeThumbnailResolvedRef = useRef(0)
  const timelinePreviewTimeRef = useRef(0)
  const timelineThumbnailMetadataRef = useRef<Map<number, ThumbnailMetadata>>(new Map())
  const chapterThumbnailWaitersRef = useRef<Map<string, (path: string | null) => void>>(new Map())
  const timelinePreviewVisibleRef = useRef(false)
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)


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
  const getThumbnailMediaId = useCallback(() => {
    const item = currentItemRef.current
    if (!item) return currentDisplayTitle || 'playback'
    return [
      item.localId,
      item.season != null ? `season-${item.season}` : '',
      item.episode != null ? `episode-${item.episode}` : '',
    ].filter(Boolean).join('-')
  }, [currentDisplayTitle])

  // Netflix-style paused info overlay — metadata fetched lazily on first pause.
  const [currentMeta, setCurrentMeta] = useState<CurrentItemMeta | null>(null)
  useEffect(() => {
    if ((!paused && !showMediaInfo) || currentMeta) return
    const tmdbId = tmdbIdRef.current
    if (!tmdbId) return
    const item = currentItemRef.current
    const isEpisodic = item?.contentType === 'series'
    let cancelled = false
    fetchCurrentItemMeta(tmdbId, isEpisodic, item?.season, item?.episode)
      .then((info) => { if (!cancelled && info) setCurrentMeta(info) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [paused, showMediaInfo, currentMeta])

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
  const dismissPlayerOptions = useCallback(() => {
    setTrackMenu(null)
    setShowSpeedMenu(false)
    setShowMediaInfo(false)
    setShowChapters(false)
    setShowPlayerDebug(false)
  }, [])
  const refreshPlayerDebug = useCallback(async () => {
    if (!import.meta.env.DEV) return
    setPlayerDebugLoading(true)
    try {
      const snapshot = await collectNativePlayerDebugSnapshot()
      setPlayerDebugSnapshot(snapshot)
      setPlayerDebugError('')
    } catch (cause) {
      setPlayerDebugError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPlayerDebugLoading(false)
    }
  }, [])
  useEffect(() => {
    if (!import.meta.env.DEV || !showPlayerDebug || !playerReady) return
    refreshPlayerDebug().catch(() => {})
    const interval = window.setInterval(() => refreshPlayerDebug().catch(() => {}), 2000)
    return () => window.clearInterval(interval)
  }, [playerReady, refreshPlayerDebug, showPlayerDebug, url])
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
  const showSkipIntroButton = useAppStore((s) => s.showSkipIntroButton)
  const autoSkipIntro = useAppStore((s) => s.autoSkipIntro)
  const showSkipCreditsButton = useAppStore((s) => s.showSkipCreditsButton)
  const autoSkipCredits = useAppStore((s) => s.autoSkipCredits)
  const autoPlayNextEpisode = useAppStore((s) => s.autoPlayNextEpisode)
  const nextEpisodeCountdownSeconds = useAppStore((s) => s.nextEpisodeCountdownSeconds)
  const scrubThumbnailPreviews = useAppStore((s) => s.scrubThumbnailPreviews)
  const showPlayerLoadingIndicator = useAppStore((s) => s.showPlayerLoadingIndicator)
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
      scale_only: 'scale',
      ignore: 'yes'
    }
    sendPlayerCommand('set_property', ['sub-ass-override', overrideMap[subtitleAssOverride] || 'scale']).catch(() => {})
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
      const { time, isPlaying, sentAt, sequence } = (e as CustomEvent).detail as { time: number; isPlaying: boolean; sentAt: number; sequence?: number }

      const { driftThreshold } = useWatchTogetherStore.getState()
      const { shouldSeek, targetTime } = shouldCorrectDrift(
        progressRef.current.currentTime,
        { currentTime: time, isPlaying, lastUpdatedAt: sentAt },
        driftThreshold,
        1000,
      )

      if (shouldSeek) {
        suppressNextWatchTogetherEvent()
        sendPlayerCommand('seek', [Math.max(0, targetTime), 'absolute']).catch(() => {})
        markCorrectionApplied()
      }

      const targetPaused = !isPlaying
      if (targetPaused !== pausedRef.current) {
        suppressNextWatchTogetherEvent()
        // Apply the authoritative room state locally before the next mpv poll.
        // Otherwise the sender can keep rendering the old play state briefly
        // and report that stale state back into the room sync loop.
        pausedRef.current = targetPaused
        setPaused(targetPaused)
        wtReportLocalPlayback(progressRef.current.currentTime, isPlaying)
        sendPlayerCommand('set_property', ['pause', targetPaused]).catch(() => {})
      }
      if (sequence != null) useWatchTogetherStore.getState().markPendingSyncApplied(sequence)
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
    timelinePreviewVisibleRef.current = false
    thumbnailRequestRef.current += 1
    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
    thumbnailTimerRef.current = null
    setTimelineThumbnail(null)
    setTimelinePreview((preview) => ({ ...preview, visible: false }))
    clearPlayerThumbnail().catch(() => {})
  }, [])

  const cachedTimelineThumbnailAt = useCallback((targetTime: number): string | null => {
    const passes = [...timelineThumbnailMetadataRef.current.values()]
      .sort((a, b) => a.interval - b.interval)
    for (const metadata of passes) {
      const paths = metadata.thumbnailPaths || []
      if (paths.length === 0 || metadata.interval <= 0) continue
      const targetIndex = Math.max(0, Math.round(targetTime / metadata.interval))
      const maxDistance = metadata.interval <= 5 ? 6 : 1
      for (let distance = 0; distance <= maxDistance; distance += 1) {
        const candidates = distance === 0
          ? [targetIndex]
          : [targetIndex - distance, targetIndex + distance]
        for (const index of candidates) {
          if (index < 0) continue
          const path = paths[index]
          if (path) return convertFileSrc(path)
        }
      }
    }
    return null
  }, [])

  const updateTimelinePreviewAtPct = useCallback((leftPct: number) => {
    if (duration <= 0 || !Number.isFinite(duration)) return
    const pct = Math.max(0, Math.min(100, leftPct))
    const time = Math.round(Math.max(0, Math.min(duration, (pct / 100) * duration)))
    timelinePreviewVisibleRef.current = true
    timelinePreviewTimeRef.current = time
    setTimelinePreview({ visible: true, leftPct: pct, time })
    if (!scrubThumbnailPreviews) {
      setTimelineThumbnail(null)
      return
    }

    // Switch between already-generated frames synchronously while dragging.
    // The refined five-second cache is preferred, with the minute wave as an
    // early fallback. No decoder or filesystem request is started here.
    const cachedThumbnail = cachedTimelineThumbnailAt(time)
    setTimelineThumbnail(cachedThumbnail)

    const requestId = ++thumbnailRequestRef.current
    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
    thumbnailTimerRef.current = setTimeout(async () => {
      const streamUrl = currentStreamUrlRef.current || url
      if (!streamUrl || requestId !== thumbnailRequestRef.current) return

      // Prefer ThumbFast inside the active libmpv instance. It already owns
      // the opened debrid stream and therefore works when a second standalone
      // ffmpeg process cannot seek that authenticated/redirected URL.
      // Do not wait for it before consulting the on-disk cache: a nearby
      // frame is far more useful than a blank preview while dragging, and the
      // native exact frame can still replace it when it arrives.
      requestPlayerThumbnail(time).catch(() => {
        // Process-mode mpv and unsupported sources use the cache fallback.
      })

      // Cached frames provide the live drag experience. Exact decoding starts
      // only after the pointer has briefly settled, keeping playback isolated
      // from a stream of throwaway preview requests.
      await new Promise((resolve) => window.setTimeout(resolve, 180))
      if (requestId !== thumbnailRequestRef.current) return
      if (nativeThumbnailResolvedRef.current === requestId) return
      if (cachedThumbnail) return

      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const result = await getOrQueueScrubThumbnail({
            mediaId: getThumbnailMediaId(),
            streamUrl,
            duration,
            time,
            thumbnailInterval: 5,
            thumbnailWidth: 480,
            thumbnailHeight: 270,
            quality: 82,
            maxConcurrentFfmpegWorkers: 2,
          })
          if (requestId !== thumbnailRequestRef.current) return
          if (nativeThumbnailResolvedRef.current === requestId) return
          const path = result.exactPath || result.nearestPath
          if (path) {
            setTimelineThumbnail(convertFileSrc(path))
            // Keep the native request alive for a short moment. ThumbFast is
            // exact and can upgrade this cached nearest frame without holding
            // the scrub interaction hostage.
            return
          }
        } catch {
          // The timestamp preview still works when the source cannot be thumbnailed.
          return
        }
        // The first request queues an ffmpeg extraction. Poll briefly so a
        // first-time hover receives the result without requiring mouse movement.
        await new Promise((resolve) => window.setTimeout(resolve, 250 + attempt * 100))
        if (requestId !== thumbnailRequestRef.current) return
        if (nativeThumbnailResolvedRef.current === requestId) return
      }
    }, 140)
  }, [cachedTimelineThumbnailAt, duration, getThumbnailMediaId, scrubThumbnailPreviews, url])

  const showTimelinePreviewFromPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    updateTimelinePreviewAtPct(((event.clientX - rect.left) / rect.width) * 100)
  }, [updateTimelinePreviewAtPct])

  useEffect(() => () => {
    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const chapterWaiters = chapterThumbnailWaitersRef.current
    listen<{ path: string; width: number; height: number; time?: number; sessionId: string }>('player-thumbnail-ready', (event) => {
      if (disposed || !scrubThumbnailPreviews) return
      if (event.payload.time != null) {
        const waiterKey = event.payload.time.toFixed(3)
        const waiter = chapterWaiters.get(waiterKey)
        if (waiter) {
          chapterWaiters.delete(waiterKey)
          waiter(event.payload.path)
          return
        }
      }
      if (!timelinePreviewVisibleRef.current) return
      if (event.payload.time != null && Math.abs(event.payload.time - timelinePreviewTimeRef.current) > 1) return
      nativeThumbnailResolvedRef.current = thumbnailRequestRef.current
      setTimelineThumbnail(event.payload.path)
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    }).catch(() => {})
    return () => {
      disposed = true
      chapterWaiters.forEach((resolve) => resolve(null))
      chapterWaiters.clear()
      unlisten?.()
    }
  }, [scrubThumbnailPreviews])

  useEffect(() => {
    timelineThumbnailMetadataRef.current.clear()
    let disposed = false
    let unlistenMetadata: (() => void) | undefined
    let unlistenFrame: (() => void) | undefined
    const refreshVisiblePreview = () => {
      if (!timelinePreviewVisibleRef.current) return
      const path = cachedTimelineThumbnailAt(timelinePreviewTimeRef.current)
      if (path) setTimelineThumbnail(path)
    }
    listen<{ metadata: ThumbnailMetadata }>('thumbnail-cache-updated', (event) => {
      if (disposed || event.payload.metadata.cacheKey !== getThumbnailMediaId()) return
      const metadata = event.payload.metadata
      timelineThumbnailMetadataRef.current.set(metadata.interval, metadata)
      refreshVisiblePreview()
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenMetadata = cleanup
    }).catch(() => {})
    listen<{ cacheKey: string; interval: number; index: number; path: string }>('thumbnail-frame-ready', (event) => {
      const frame = event.payload
      if (disposed || frame.cacheKey !== getThumbnailMediaId()) return
      const existing = timelineThumbnailMetadataRef.current.get(frame.interval)
      const thumbnailPaths = [...(existing?.thumbnailPaths || [])]
      thumbnailPaths[frame.index] = frame.path
      timelineThumbnailMetadataRef.current.set(frame.interval, existing
        ? { ...existing, thumbnailPaths, thumbnailCount: Math.max(existing.thumbnailCount || 0, frame.index + 1) }
        : {
            cacheKey: frame.cacheKey,
            interval: frame.interval,
            thumbnailWidth: 480,
            thumbnailHeight: 270,
            columns: 10,
            rows: 10,
            sprites: [],
            thumbnailPaths,
            thumbnailCount: frame.index + 1,
            status: 'generating',
          })
      refreshVisiblePreview()
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenFrame = cleanup
    }).catch(() => {})
    return () => {
      disposed = true
      unlistenMetadata?.()
      unlistenFrame?.()
      timelineThumbnailMetadataRef.current.clear()
    }
  }, [cachedTimelineThumbnailAt, getThumbnailMediaId, url])

  // Build a useful timeline before most viewers first seek: a coarse frame
  // every minute, followed by the full five-second cache in the background.
  // Scrub requests share the refined pass and jump ahead of background work.
  useEffect(() => {
    if (!playerReady || !scrubThumbnailPreviews || duration <= 0) return
    const streamUrl = currentStreamUrlRef.current || url
    if (!streamUrl) return
    const timer = window.setTimeout(() => {
      startThumbnailGeneration({
        streamUrl,
        cacheKey: getThumbnailMediaId(),
        duration,
        fastInterval: 60,
        refinedInterval: 5,
        thumbnailWidth: 480,
        thumbnailHeight: 270,
        columns: 10,
        rows: 10,
        quality: 82,
        maxConcurrentFfmpegWorkers: 2,
      }).then((metadata) => {
        if (metadata) timelineThumbnailMetadataRef.current.set(metadata.interval, metadata)
      }).catch(() => {})
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [duration, getThumbnailMediaId, playerReady, scrubThumbnailPreviews, url])

  useEffect(() => {
    if (scrubThumbnailPreviews) return
    thumbnailRequestRef.current += 1
    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
    thumbnailTimerRef.current = null
    timelinePreviewVisibleRef.current = false
    setTimelineThumbnail(null)
    clearPlayerThumbnail().catch(() => {})
  }, [scrubThumbnailPreviews])

  useEffect(() => {
    if (!playerReady) return
    let cancelled = false
    const retryTimers: ReturnType<typeof setTimeout>[] = []
    const loadMediaDetails = async (attempt = 0) => {
      const [videoCodecValue, audioParamsValue, fpsValue, chapterListValue] = await Promise.all([
        getPlayerProperty('video-codec').catch(() => null),
        getPlayerProperty('audio-params').catch(() => null),
        getPlayerProperty('estimated-vf-fps').catch(() => null),
        getPlayerProperty('chapter-list').catch(() => null),
      ])
      if (cancelled) return

      const codecRaw = String(videoCodecValue || '').toLowerCase()
      const codec = codecRaw.includes('hevc') || codecRaw.includes('h265')
        ? 'HEVC'
        : codecRaw.includes('av1')
          ? 'AV1'
          : codecRaw.includes('h264') || codecRaw.includes('avc')
            ? 'H.264'
            : codecRaw ? codecRaw.toUpperCase() : ''
      const audioParams = audioParamsValue && typeof audioParamsValue === 'object'
        ? audioParamsValue as Record<string, unknown>
        : {}
      const channelCount = Number(audioParams['channel-count'] || 0)
      const channelLabel = channelCount >= 8 ? '7.1' : channelCount >= 6 ? '5.1' : channelCount === 2 ? 'Stereo' : channelCount === 1 ? 'Mono' : ''
      const fps = Number(fpsValue || 0)
      setMediaBadges([codec, channelLabel, fps > 0 ? `${fps.toFixed(2)} FPS` : ''].filter(Boolean))

      const parsedChapters = Array.isArray(chapterListValue)
        ? chapterListValue.flatMap((entry, index) => {
          if (!entry || typeof entry !== 'object') return []
          const chapter = entry as Record<string, unknown>
          const time = Number(chapter.time)
          if (!Number.isFinite(time)) return []
          return [{ title: String(chapter.title || `Chapter ${index + 1}`), time }]
        })
        : []
      if (parsedChapters.length > 0) {
        setChapters(parsedChapters)
      } else if (attempt < 4) {
        retryTimers.push(setTimeout(() => { loadMediaDetails(attempt + 1).catch(() => {}) }, 500 * (attempt + 1)))
      }
    }
    const timer = setTimeout(() => { loadMediaDetails().catch(() => {}) }, 250)
    return () => { cancelled = true; clearTimeout(timer); retryTimers.forEach(clearTimeout) }
  }, [playerReady, tracksLoaded, url])

  // Some sources (notably HMAX WEB-DLs) author chapter times with a constant
  // offset (often +1h) or list chapters past the end of the file, so the raw
  // mpv chapter-list can't be trusted for seeking until it's normalized.
  const displayChapters = useMemo(() => {
    if (chapters.length === 0 || duration <= 0) return chapters
    const sorted = [...chapters].sort((a, b) => a.time - b.time)
    const looksShifted = sorted[0].time > 0
      && (sorted[0].time > duration * 0.5 || sorted[sorted.length - 1].time > duration)
    const offset = looksShifted ? sorted[0].time : 0
    return sorted
      .map((chapter) => ({ ...chapter, time: chapter.time - offset }))
      .filter((chapter) => chapter.time >= 0 && chapter.time < duration - 1)
      .filter((chapter, index, list) => index === 0 || chapter.time - list[index - 1].time >= 1)
  }, [chapters, duration])
  const autoNextEpisodeChapterTime = useMemo(
    () => findEndingChapterTime(displayChapters, duration),
    [displayChapters, duration],
  )
  const autoNextEpisodeChapterTimeRef = useRef<number | null>(null)
  useEffect(() => {
    autoNextEpisodeChapterTimeRef.current = autoNextEpisodeChapterTime
  }, [autoNextEpisodeChapterTime])

  useEffect(() => {
    chapterThumbsRef.current = {}
    setChapterThumbs({})
  }, [url])

  // Chapter tile thumbnails come from the same ffmpeg scrub-thumbnail cache
  // as the timeline preview. Generate them only when the strip is opened so
  // background decoding never competes with normal playback or a real seek.
  useEffect(() => {
    if (!showChapters || !scrubThumbnailPreviews || !playerReady || duration <= 0 || displayChapters.length === 0) return
    const streamUrl = currentStreamUrlRef.current || url
    if (!streamUrl) return
    let cancelled = false
    const chapterWaiters = chapterThumbnailWaitersRef.current
    const mediaId = getThumbnailMediaId()
    const initialTime = progressRef.current.currentTime
    const prioritizedChapters = [...displayChapters].sort((a, b) => {
      const aDistance = Math.abs(a.time - initialTime)
      const bDistance = Math.abs(b.time - initialTime)
      return aDistance - bDistance || a.time - b.time
    })
    const loadThumbs = async (attempt: number) => {
      let stillGenerating = false
      for (const chapter of prioritizedChapters) {
        if (cancelled) return
        const key = `${Math.round(chapter.time)}`
        if (chapterThumbsRef.current[key]) continue
        // A chapter card represents its opening cut, so generate exactly one
        // frame at the chapter start rather than sampling deeper into it.
        const sampleTime = Math.min(chapter.time, Math.max(duration - 1, 0))
        try {
          const waiterKey = sampleTime.toFixed(3)
          const nativePathPromise = new Promise<string | null>((resolve) => {
            let settled = false
            const finish = (path: string | null) => {
              if (settled) return
              settled = true
              chapterWaiters.delete(waiterKey)
              resolve(path)
            }
            chapterWaiters.set(waiterKey, finish)
            requestPlayerThumbnail(sampleTime).catch(() => finish(null))
            window.setTimeout(() => finish(null), 300)
          })
          const fallbackPromise = getOrQueueScrubThumbnail({
            mediaId,
            streamUrl,
            duration,
            time: sampleTime,
            thumbnailInterval: 5,
            thumbnailWidth: 480,
            thumbnailHeight: 270,
            quality: 82,
            maxConcurrentFfmpegWorkers: 1,
          })
          const [nativePath, result] = await Promise.all([nativePathPromise, fallbackPromise])
          if (cancelled) return
          if (nativePath) {
            chapterThumbsRef.current = { ...chapterThumbsRef.current, [key]: nativePath }
            setChapterThumbs(chapterThumbsRef.current)
            continue
          }
          if (result.exactPath) {
            chapterThumbsRef.current = { ...chapterThumbsRef.current, [key]: convertFileSrc(result.exactPath) }
            setChapterThumbs(chapterThumbsRef.current)
          } else {
            stillGenerating = true
          }
        } catch {
          // The tile keeps its placeholder when the source can't be thumbnailed.
        }
      }
      if (!cancelled && stillGenerating && attempt < 12) {
        const retryDelay = Math.min(700 + attempt * 250, 2500)
        chapterThumbRetryRef.current = setTimeout(() => { loadThumbs(attempt + 1).catch(() => {}) }, retryDelay)
      }
    }
    loadThumbs(0).catch(() => {})
    return () => {
      cancelled = true
      if (chapterThumbRetryRef.current) clearTimeout(chapterThumbRetryRef.current)
      chapterWaiters.forEach((resolve) => resolve(null))
      chapterWaiters.clear()
      clearPlayerThumbnail().catch(() => {})
    }
  }, [playerReady, displayChapters, duration, url, getThumbnailMediaId, scrubThumbnailPreviews, showChapters])

  // Center the active chapter tile when the strip opens.
  useEffect(() => {
    if (!showChapters) return
    const active = chapterStripRef.current?.querySelector('[data-active-chapter="true"]')
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ inline: 'center', block: 'nearest' })
    }
  }, [showChapters])

  // Chapter browsing is an overlay only. Never crop or zoom the actual video;
  // also reset panscan in case a reused mpv session came from an older build.
  useEffect(() => {
    if (!playerReady) return
    sendPlayerCommand('set_property', ['panscan', 0]).catch(() => {})
  }, [playerReady, showChapters])

  // ─ Progress / Scrobble ───────────────────────────────────────────────────
  const saveLocalProgress = useCallback((time: number, dur: number, completedFlag: boolean) => {
    const item = currentItemRef.current
    if (!item) return
    const key = item.season != null && item.episode != null
      ? `${item.localId}:${item.season}:${item.episode}`
      : item.localId
    const progressPct = dur > 0 ? (time / dur) * 100 : 0
    // Credit boundaries are stronger evidence than a generic percentage. If
    // they are unavailable, keep the fallback conservative so a long credit
    // roll is not left as an accidental Continue Watching entry.
    const reachedCredits = skips.some((segment) => segment.credits_start_ms != null && time * 1000 >= segment.credits_start_ms)
    const isCompleted = completedFlag || reachedCredits || progressPct >= 90
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
  }, [skips])

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
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
      dismissPlayerOptions()
    }, 4000)
  }, [dismissPlayerOptions])

  useEffect(() => {
    const dismissOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('[data-player-popover]')) return
      dismissPlayerOptions()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePress, true)
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePress, true)
  }, [dismissPlayerOptions])

  const wtBlockedNotice = useCallback(() => {
    setError('Only the host can control playback in this room.')
    setTimeout(() => setError((prev) => prev === 'Only the host can control playback in this room.' ? '' : prev), 2500)
    showControls()
  }, [showControls])

  const command = useCallback((name: string, args: unknown[] = []) => {
    sendPlayerCommand(name, args).catch((e) => {
      const message = String(e)
      logEvent('MPV DEBUG', `command ${name} failed: ${message}`)
      if (!/IPC not ready|No player is running|Failed to send mpv command/i.test(message)) {
        setError(message)
      }
    })
  }, [])

  const commitTimelineSeek = useCallback((percentage: number) => {
    const pct = Math.max(0, Math.min(100, percentage))
    isDraggingRef.current = false
    activeTimelinePointerRef.current = null
    setIsDragging(false)
    hideTimelinePreview()
    if (wtControlBlocked()) { wtBlockedNotice(); return }
    const targetTime = duration > 0 ? (pct / 100) * duration : 0
    progressRef.current.currentTime = targetTime
    setCurrentTime(targetTime)
    command('seek', [pct, 'absolute-percent+keyframes'])
    if (duration > 0) sendWatchTogetherSeek(targetTime)
  }, [command, duration, hideTimelinePreview, sendWatchTogetherSeek, wtBlockedNotice])

  // Pointer capture is normally enough, but WebKit can still omit the range
  // input's pointerup when native video/window layers change under the cursor.
  // A window-level release guard guarantees the drag state is always cleared.
  useEffect(() => {
    const finishDrag = (event: PointerEvent) => {
      if (isDraggingRef.current && activeTimelinePointerRef.current === event.pointerId) {
        commitTimelineSeek(draggingProgressRef.current)
      }
    }
    const cancelDrag = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      activeTimelinePointerRef.current = null
      setIsDragging(false)
      hideTimelinePreview()
    }
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('blur', cancelDrag)
    return () => {
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('blur', cancelDrag)
    }
  }, [commitTimelineSeek, hideTimelinePreview])

  // ─ Subtitle loading ───────────────────────────────────────────────────────
  const loadAddonSubtitles = useCallback(async (loadAll = false) => {
    const state = useAppStore.getState()
    const preferred = state.preferredSubtitles || []
    const available = subtitles
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => track.url)
    const preferredTracks = available.filter(({ track }) => {
      const code = getLanguageCodeFromTrack(track.lang)
      return Boolean(code && preferred.includes(code))
    })
    const forcedTracks = available.filter(({ track }) => /\bforced\b/i.test(track.label || ''))
    const initial = state.subtitleMode === 'hide'
      ? []
      : state.subtitleMode === 'forced'
        ? forcedTracks
        : preferredTracks.length > 0 ? preferredTracks : available.slice(0, 2)
    // Download only the tracks needed for auto-selection during startup.
    // The complete catalog is loaded when the user opens the subtitle menu.
    const selectedTracks = (loadAll ? available : initial).slice(0, loadAll ? undefined : 4)
    const pending = selectedTracks.filter(({ track }) => !loadedSubtitleUrlsRef.current.has(track.url!))
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
      subtitleSourcesRef.current.set(localPath, { originalUrl: track.url!, localPath, label, forced: /\bforced\b/i.test(track.label || '') })
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
      .map((t) => {
        const label = trackLabel(t, `Sub ${t.id}`)
        return { id: t.id, label, lang: t.lang, priority: trackPriority(t), forced: Boolean(t.forced || subtitleTrackSourcesRef.current.get(t.id)?.forced || /\bforced\b/i.test(label)) }
      })
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
      const { preferredAudio = ['en', 'ja'], preferredSubtitles = ['en'], subtitleMode } = useAppStore.getState()

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
      if (!hasAutoSelectedSubRef.current) {
        if (subtitleMode === 'hide') {
          if (selSub) sendPlayerCommand('set_property', ['sid', 'no'])
          setSelectedSub('no')
          hasAutoSelectedSubRef.current = true
        } else if (subs.length > 0) {
          const candidates = subtitleMode === 'forced' ? subs.filter((track) => track.forced) : subs
        let bestSubId: number | undefined
        let bestSubRank = Infinity
          candidates.forEach((t) => {
          const code = getLanguageCodeFromTrack(t.lang)
          const rank = code ? preferredSubtitles.indexOf(code) : -1
          if (rank !== -1 && rank < bestSubRank) { bestSubRank = rank; bestSubId = t.id }
        })
        if (bestSubId === undefined && subtitleMode === 'forced') bestSubId = candidates[0]?.id
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
  useLayoutEffect(() => {
    fullPlayerMountCount += 1
    document.documentElement.classList.add('full-player-active')
    return () => {
      fullPlayerMountCount = Math.max(0, fullPlayerMountCount - 1)
      if (fullPlayerMountCount === 0) document.documentElement.classList.remove('full-player-active')
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
    if (isFullscreenRef.current) {
      // The native command resolves zero dimensions from the real Win32 client
      // rectangle, avoiding stale WebView/DPI sizes during fullscreen changes.
      await resizeEmbeddedPlayer({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {})
      return
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
    await invoke('set_native_player_fullscreen', { fullscreen: true }).catch(() => {})
    await applyFullVideoViewport()
    await invoke('setup_player_click_through').catch(() => {})
  }, [applyFullVideoViewport])

  const exitFullscreenWindow = useCallback(async () => {
    const transition = ++fullscreenTransitionRef.current
    // Disable fullscreen repairs before asking Windows to leave fullscreen.
    // Focus/move events emitted during the transition must not put it back.
    isFullscreenRef.current = false
    setIsFullscreen(false)
    await invoke('set_native_player_fullscreen', { fullscreen: false }).catch(() => {})
    if (fullscreenTransitionRef.current !== transition || isFullscreenRef.current) return
    // Allow the native client rectangle to settle before sizing the mpv child.
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (fullscreenTransitionRef.current !== transition || isFullscreenRef.current) return
    await applyFullVideoViewport()
  }, [applyFullVideoViewport])

  const toggleFullscreen = useCallback(async () => {
    // Tauri's isFullscreen() can lag behind the compositor during a transition.
    // Deriving the next state from that delayed value made both the F hotkey and
    // button occasionally issue the same request twice. The ref is updated
    // optimistically and a lock rejects repeat input until the request settles.
    if (fullscreenTransitionPendingRef.current) return
    fullscreenTransitionPendingRef.current = true
    // Native window calls can occasionally wait on the compositor. Never let
    // that leave the button and F hotkey locked for the rest of playback.
    const forceUnlockTimer = window.setTimeout(() => {
      fullscreenTransitionPendingRef.current = false
    }, 900)
    const targetFullscreen = !isFullscreenRef.current
    try {
      if (targetFullscreen) {
        // Flip state up front so the window-drag strip disappears immediately.
        ++fullscreenTransitionRef.current
        isFullscreenRef.current = true
        setIsFullscreen(true)
        await invoke('set_native_player_fullscreen', { fullscreen: true })
      } else {
        await exitFullscreenWindow()
      }
    } catch (e) {
      if (targetFullscreen) {
        isFullscreenRef.current = false
        setIsFullscreen(false)
      }
      setError(`Fullscreen failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      window.clearTimeout(forceUnlockTimer)
      // Keep the lock through the first compositor frame; otherwise a key-repeat
      // or click followed by F can race the native window-state notification.
      window.setTimeout(() => {
        fullscreenTransitionPendingRef.current = false
      }, 180)
    }
    // Re-sync the mpv child to the new client size (retries as the transition settles).
    const linux = document.documentElement.dataset.platform === 'linux'
    ;[0, 150, 400, 800, 1500].forEach((d) => setTimeout(() => {
      if (linux && isFullscreenRef.current) repairFullscreenWindow().catch(() => {})
      else applyFullVideoViewport()
    }, d))
    showControls()
  }, [showControls, applyFullVideoViewport, exitFullscreenWindow, repairFullscreenWindow])

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
        if (wtControlBlocked()) { wtBlockedNotice(); return }

        if (e.repeat) return

        if (holdTimeout) clearTimeout(holdTimeout)
        if (spoolInterval) clearInterval(spoolInterval)

        const step = useAppStore.getState().seekStepSeconds || 10
        pressedKey = key
        const direction = key === 'ArrowRight' ? 1 : -1
        const initialDelta = direction * step
        const initialTarget = Math.max(0, Math.min(progressRef.current.duration || Number.POSITIVE_INFINITY, progressRef.current.currentTime + initialDelta))
        progressRef.current.currentTime = initialTarget
        setCurrentTime(initialTarget)
        sendPlayerCommand('seek', [initialDelta, 'relative+keyframes']).catch(() => {})
        sendWatchTogetherSeek(initialTarget)
        accumulatedSeekRef.current = initialDelta
        setAccumulatedSeek(accumulatedSeekRef.current)

        holdTimeout = setTimeout(() => {
          spoolInterval = setInterval(() => {
            if (accumulatedSeekRef.current !== null) {
              const spool = Math.max(5, Math.round(step / 2))
              const delta = direction * spool
              const target = Math.max(0, Math.min(progressRef.current.duration || Number.POSITIVE_INFINITY, progressRef.current.currentTime + delta))
              progressRef.current.currentTime = target
              setCurrentTime(target)
              sendPlayerCommand('seek', [delta, 'relative+keyframes']).catch(() => {})
              sendWatchTogetherSeek(target)
              accumulatedSeekRef.current += delta
              setAccumulatedSeek(accumulatedSeekRef.current)
            }
          }, 150)
        }, 250)
        return
      }

      if (key === 'Escape') {
        if (trackMenu || showSpeedMenu || showMediaInfo || showChapters || showPlayerDebug) {
          e.preventDefault()
          e.stopPropagation()
          dismissPlayerOptions()
          return
        }
        if (isFullscreenRef.current) {
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
  }, [sendWatchTogetherSeek, showControls, toggleFullscreen, trackMenu, showSpeedMenu, showMediaInfo, showChapters, showPlayerDebug, dismissPlayerOptions])

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
    playerReadyRef.current = false
    unstableStreamNotifiedRef.current = false
    bufferingStartedAtRef.current = null
    setPlayerReady(false)
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
          scale_only: 'scale',
          ignore: 'yes'
        }
        sendPlayerCommand('set_property', ['sub-ass-override', overrideMap[subState.subtitleAssOverride] || 'scale']).catch(() => {})

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
            if (!cancelled && session.status !== "stopped") {
              setSkips(merged)
              const fallbackChapters = introDbChapters(merged)
              if (fallbackChapters.length > 0) {
                setChapters((existing) => existing.length > 0 ? existing : fallbackChapters)
              }
            }
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

        const startupTimer = setTimeout(() => {
          sessionTimers.delete(startupTimer)
          if (cancelled || session.status === "stopped" || playerReadyRef.current) return
          setError('This source took too long to start. Trying another stream…')
        }, 12_000)
        sessionTimers.add(startupTimer)

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
    const syncSurfaceLayer = () => {
      if (disposed) return
      resizeEmbeddedPlayer(showUpNextRef.current ? buildUpNextPipViewport() : buildVideoViewport()).catch(() => {})
      invoke('setup_player_click_through').catch(() => {})
    }
    listen<{ sessionId: string; eventId: number }>('mpv-playback-ready', (event) => {
      if (disposed) return
      // FILE_LOADED means headers were parsed; PLAYBACK_RESTART means decoded
      // playback actually began. Only the latter should dismiss loading.
      if (event.payload.eventId !== 21) return
      playerReadyRef.current = true
      setPlayerRunning(true)
      setPlayerReady(true)
      setError('')
      showControls()
      syncSurfaceLayer()

    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [showControls])

  // libmpv reports why each file ended (eof/stop/error/redirect). An "error"
  // reason means the stream itself died (404, network, demux failure) — show
  // it instead of leaving a silent black player behind.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen<{ sessionId: string; reason: string; error: string | null }>('mpv-end-file', (event) => {
      if (disposed) return
      const { reason, error: endError } = event.payload
      logEvent('MPV DEBUG', `end-file reason=${reason}${endError ? ` error=${endError}` : ''}`)
      if (reason === 'error') {
        const message = `Playback failed: ${endError || 'the stream ended with an unknown error'}. Trying another stream…`
        if (/video output initialization failed/i.test(endError || '') && !videoOutputFallbackAttemptedRef.current) {
          videoOutputFallbackAttemptedRef.current = true
          setError('')
          restartPlaybackRef.current(Math.max(progressRef.current.currentTime || 0, startTime || 0), { hwdecMode: 'no' })
          return
        }
        setError(message)
        // Startup failures are forwarded by the error/playerReady effect, but
        // an end-file error usually happens after readiness and would otherwise
        // strand Smart Play on a dead source. Watch Together must remain manual
        // so one guest cannot independently advance the room's stream.
        if (!unstableStreamNotifiedRef.current && !useWatchTogetherStore.getState().currentRoom) {
          unstableStreamNotifiedRef.current = true
          smartErrorNotifiedRef.current = true
          onPlaybackErrorRef.current?.(message, progressRef.current.currentTime)
        }
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [startTime])

  useEffect(() => {
    if (playerReady || error) return
    let cancelled = false
    const startedAt = Date.now()
    const interval = setInterval(async () => {
      const running = await isEmbeddedPlayerRunning().catch(() => false)
      if (cancelled) return
      setPlayerRunning(running)

      if (running && playerReadyRef.current) {
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
    let fullscreenSyncTimer: ReturnType<typeof setTimeout> | undefined
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
      clearTimeout(fullscreenSyncTimer)
      fullscreenSyncTimer = setTimeout(async () => {
        if (disposed || fullscreenTransitionPendingRef.current) return
        const actualFullscreen = await getCurrentWindow().isFullscreen().catch(() => isFullscreenRef.current)
        if (disposed) return
        isFullscreenRef.current = actualFullscreen
        setIsFullscreen(actualFullscreen)
      }, 220)
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
      clearTimeout(fullscreenSyncTimer)
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

  const triggerRestart = useCallback(async (resumeTime: number, options?: { hwdecMode?: 'no'; decodedAudio?: boolean }) => {
    logEvent('PLAYER DEBUG', `Restarting player session at position ${resumeTime}s...`)
    playerReadyRef.current = false
    setPlayerReady(false)
    setBuffering(true)
    setError('')
    lastTimePosValRef.current = -1
    lastTimePosUpdateRef.current = Date.now()
    try {
      await stopEmbeddedPlayer()
      const storeState = useAppStore.getState()
      const launchState = options?.decodedAudio ? { ...storeState, audioPassthrough: false } : storeState
      await launchEmbeddedPlayer({
        url,
        title,
        startTime: resumeTime,
        volume: volumeRef.current,
        viewport: buildVideoViewport(),
        hwdecMode: options?.hwdecMode || storeState.hwdecMode,
        cacheBufferSize: storeState.cacheBufferSize,
        mpvCacheSecs: storeState.mpvCacheSecs,
        mpvNetworkTimeout: storeState.mpvNetworkTimeout,
        mpvCustomArgs: buildMpvExtraArgs(launchState)
      })
      applySavedVolume()
      logEvent('PLAYER DEBUG', `Player restarted successfully`)
    } catch (err) {
      setBuffering(false)
      setError('Playback recovery failed. Choose another stream and try again.')
      logEvent('PLAYER DEBUG', `Auto-restart failed: ${err}`)
    }
  }, [url, title, applySavedVolume])

  restartPlaybackRef.current = (resumeTime, options) => { void triggerRestart(resumeTime, options) }

  const useDecodedAudio = useCallback(() => {
    const storeState = useAppStore.getState()
    if (!storeState.audioPassthrough) return
    storeState.setAudioPassthrough(false)
    logEvent('PLAYER DEBUG', 'Passthrough disabled; restarting with decoded audio output.')
    triggerRestart(Math.max(progressRef.current.currentTime || 0, startTime || 0), { decodedAudio: true })
  }, [startTime, triggerRestart])

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
        if (isBuffering === true && playerReadyRef.current) {
          bufferingStartedAtRef.current ??= nowMs
          const bufferingFor = nowMs - bufferingStartedAtRef.current
          if (
            bufferingFor >= 12_000 &&
            !unstableStreamNotifiedRef.current &&
            !useWatchTogetherStore.getState().currentRoom
          ) {
            unstableStreamNotifiedRef.current = true
            const message = 'This source keeps buffering. Trying a more stable stream…'
            setError(message)
            onPlaybackErrorRef.current?.(message, progressRef.current.currentTime)
          }
        } else {
          bufferingStartedAtRef.current = null
        }
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
          playerReadyRef.current = true
          setPlayerReady(true)
          progressRef.current.currentTime = pos
        }
        if (dur != null && dur > 0) {
          setDuration(dur)
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
        const PLAYER_STALL_TIMEOUT_MS = 12000
        const PLAYER_RESTART_COOLDOWN_MS = 15000
        const MAX_AUTO_RESTARTS = 1

        const isPlaying = playerReadyRef.current && pos !== null && !isPause && !isBuffering
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
              } else if (!unstableStreamNotifiedRef.current && !useWatchTogetherStore.getState().currentRoom) {
                unstableStreamNotifiedRef.current = true
                const message = 'Playback stalled on this source. Trying a more stable stream…'
                setError(message)
                onPlaybackErrorRef.current?.(message, progressRef.current.currentTime)
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
          // setting. Auto follows an embedded Credits/Ending/Outro chapter
          // when one is available and falls back to the duration heuristic
          // for streams without a useful ending chapter.
          // Suppressed in Watch Together — autoplaying a new episode locally
          // would desync the whole room.
          const remaining = dur - pos
          const pctDone = pos / dur
          const promptSetting = useAppStore.getState().nextEpisodePrompt
          const promptThresholds: Record<string, number> = { '30s': 30, '45s': 45, '1m': 60, '1.5m': 90, '2m': 120 }
          const endingChapterTime = autoNextEpisodeChapterTimeRef.current
          const shouldPrompt = promptSetting === 'off'
            ? false
            : promptSetting === 'auto'
              ? endingChapterTime != null
                ? pos >= endingChapterTime
                : (remaining <= 90 || pctDone >= 0.92)
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
            setUpNextCountdown(nextEpisodeCountdownSeconds)
          }

          // Warm up the next episode ~90s before the end: preload its addon
          // results, rank them, and probe the top direct link so the Up-Next
          // switch starts instantly. Once per episode; skipped in Watch
          // Together and when the prompt is disabled.
          const approachingAutoChapter = promptSetting === 'auto'
            && endingChapterTime != null
            && endingChapterTime - pos <= 90
          if (
            remaining > 0 && (remaining <= 90 || approachingAutoChapter) &&
            !nextPrepareTriggeredRef.current &&
            promptSetting !== 'off' &&
            !useWatchTogetherStore.getState().currentRoom &&
            nextEpInfoRef.current &&
            currentItemRef.current?.imdbId
          ) {
            nextPrepareTriggeredRef.current = true
            const nextEp = nextEpInfoRef.current
            preparedStreamRegistry.prepare({
              mediaType: 'series',
              mediaId: currentItemRef.current.imdbId,
              imdbId: currentItemRef.current.imdbId,
              tmdbId: tmdbIdRef.current ?? undefined,
              seasonEpisode: { season: nextEp.season, episode: nextEp.episode },
            }, { title, priority: StreamPreloadPriority.CONTINUE_NEXT_EPISODE }).catch(() => {})
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
          const shouldAutoSkip = foundType === 'credits' ? autoSkipCredits : autoSkipIntro
          if (shouldAutoSkip && found && foundType && !wtControlBlocked()) {
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
  }, [skips, autoSkipIntro, autoSkipCredits, nextEpisodeCountdownSeconds, command, saveLocalProgress, savePMDBProgressHelper, saveMdblistProgressHelper, scrobbleSimkl, simklSaveResumePosition, scrobbleAnilist, pmdbApiKey, pmdbSaveResumePosition, sendWatchTogetherSeek, triggerRestart])

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
    const nextRequest: StreamPreloadRequest = {
      mediaType: 'series',
      mediaId: item.imdbId,
      imdbId: item.imdbId,
      tmdbId: tmdbIdRef.current ?? undefined,
      seasonEpisode: { season: nextEp.season, episode: nextEp.episode },
    }

    let foundUrl: string | null = null
    let chosenStream: PreloadedStream | null = null

    // 1) Prepared stream from the near-end warm-up: already ranked + probed.
    const prepared = preparedStreamRegistry.consume(canonicalStreamKey(nextRequest))
    if (prepared) {
      foundUrl = prepared.playableUrl
      chosenStream = prepared.stream
      logEvent('PLAYER DEBUG', `Up Next: using prepared stream from ${prepared.stream.addonName} (score ${prepared.score})`)
    }

    // 2) Preloaded/cached addon results + the same smart ranking the stream
    //    selector uses.
    if (!foundUrl) {
      try {
        const rawResults = await streamPreloadManager.request(nextRequest, { priority: StreamPreloadPriority.PLAYBACK })
        if (!ownsSession()) return
        const results = await annotateTorBoxStreams(rawResults).catch(() => rawResults)
        const top = rankStreams(results as SmartStream[], buildSmartContext({ title, season: nextEp.season, episode: nextEp.episode }))
          .find((candidate) => candidate.score > -500)
        if (top) {
          foundUrl = getPlayableStreamUrl(top.stream) || await resolveTorBoxStream(top.stream, {
            title,
            season: nextEp.season,
            episode: nextEp.episode,
          }).catch(() => null)
          chosenStream = top.stream as PreloadedStream
          logEvent('PLAYER DEBUG', `Up Next: smart-ranked stream from ${chosenStream.addonName} (score ${top.score})`)
        }
      } catch (_) {}
    }

    // 3) Last resort: lenient per-addon loop — some addons only respond here.
    if (!foundUrl) {
      const streamId = `${item.imdbId}:${nextEp.season}:${nextEp.episode}`
      for (const addon of getStreamAddons('series')) {
        try {
          const rawStreams = await getAddonStreams(addon.url, 'series', streamId)
          if (!ownsSession()) return
          const streams = await annotateTorBoxStreams(rawStreams).catch(() => rawStreams)
          const valid = streams.find((stream) => getPlayableStreamUrl(stream) || stream.behaviorHints?.torboxCached === true)
          if (valid) {
            foundUrl = getPlayableStreamUrl(valid) || await resolveTorBoxStream(valid, {
              title,
              season: nextEp.season,
              episode: nextEp.episode,
            }).catch(() => null)
            if (foundUrl) break
          }
        } catch (_) {}
      }
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
    // No stop here: launch_embedded_mpv reuses the live libmpv instance
    // (loadfile replace) when launch options match, so the next episode
    // starts without tearing down the video surface.

    // Update current playback item refs
    const newItem: PlaybackItem = { ...item, season: nextEp.season, episode: nextEp.episode, title: `${title} · ${nextEp.title}` }
    currentItemRef.current = newItem
    currentStreamUrlRef.current = foundUrl
    currentPosterRef.current = nextEp.stillPath ?? currentPosterRef.current
    currentBackdropRef.current = nextEp.stillPath ?? currentBackdropRef.current

    // Reset readiness before replacing the file. libmpv can emit
    // PLAYBACK_RESTART before launchEmbeddedPlayer resolves; resetting after the
    // await would clobber that event and leave the new episode behind a loading
    // overlay. Recovery counters are per stream and must not leak across episodes.
    playerReadyRef.current = false
    pausedRef.current = false
    setPlayerReady(false)
    setPlayerRunning(false)
    setBuffering(true)
    setError('')
    setCurrentTime(0)
    setDuration(0)
    setPaused(false)
    progressRef.current = { currentTime: 0, duration: 0 }
    lastTimePosValRef.current = -1
    lastTimePosUpdateRef.current = Date.now()
    lastSavedTimeRef.current = 0
    lastSimklPlaybackSaveRef.current = 0
    lastPmdbPlaybackSaveRef.current = 0
    lastAniListPlaybackSaveRef.current = 0
    autoRestartCountRef.current = 0
    lastRestartTimeRef.current = 0
    unstableStreamNotifiedRef.current = false
    bufferingStartedAtRef.current = null
    eofClosedRef.current = false

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
      setPlayerRunning(true)
      applySavedVolume()
      // Feed the same reliability history the stream selector uses (paths 1/2
      // only — the lenient fallback has no addon identity attached).
      if (chosenStream) recordReliabilityEvent(chosenStream, 'success')

      // Update title/subtitle in the player controls bar
      const epCode = `S${String(nextEp.season).padStart(2, '0')}E${String(nextEp.episode).padStart(2, '0')}`
      setCurrentDisplayTitle(title)
      setCurrentDisplaySubtitle(`${epCode} · ${nextEp.title}`)
      setCurrentMeta(null) // refetch paused-overlay metadata for the new episode

      // Reset episode-specific controls and metadata.
      setTracksLoaded(false); setAudioTracks([]); setSubTracks([])
      setSkips([]); setActiveSkip(null); setSkipType(null)
      setShowUpNext(false)
      upNextTriggeredRef.current = false
      upNextCancelledRef.current = false
      nextPrepareTriggeredRef.current = false
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
          const fallbackChapters = introDbChapters(merged)
          if (fallbackChapters.length > 0) setChapters(fallbackChapters)
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
      setPlayerRunning(false)
      setBuffering(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [title, scrobbleSimkl, scrobbleTrakt, saveLocalProgress, refreshTracks, applySavedVolume, schedulePlayerTimeout])

  useEffect(() => {
    if (!showUpNext) { setUpNextCountdown(nextEpisodeCountdownSeconds); return }
    if (!autoPlayNextEpisode) {
      setUpNextCountdown(nextEpisodeCountdownSeconds)
      return
    }
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
  }, [showUpNext, handleAutoplay, autoPlayNextEpisode, nextEpisodeCountdownSeconds])

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
    const targetTime = Math.max(0, Math.min(progressRef.current.duration || Number.POSITIVE_INFINITY, progressRef.current.currentTime + secs))
    progressRef.current.currentTime = targetTime
    setCurrentTime(targetTime)
    command('seek', [secs, 'relative+keyframes'])
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

      liveAiCueIndexRef.current = 1
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
      {!playerReady && !error && showPlayerLoadingIndicator && (
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
        onClick={() => { showControls(); togglePlay() }}
        onDoubleClick={toggleFullscreen}
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
            <p className="mb-5 break-words text-xs leading-relaxed text-white/60">{error}</p>
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

      {/* Track loading spinner */}
      {!tracksLoaded && !error && (
        <div className="absolute left-1/2 bottom-32 z-20 -translate-x-1/2 flex items-center gap-2 text-xs text-white/60 pointer-events-none">
          <div className="w-3.5 h-3.5 border border-white/30 border-t-transparent rounded-full animate-spin" />
          Detecting tracks…
        </div>
      )}

      {/* Watch Together overlays */}
      {isInWatchTogether && (
        <PlayerChatOverlay visible={controlsVisible} onInteraction={showControls} />
      )}

      {/* ── Bottom controls bar ── */}
      <div
        className={`absolute inset-x-0 bottom-0 z-[10] transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[clamp(11rem,28vh,20rem)] bg-gradient-to-t from-black/95 via-black/55 to-transparent" />
        <div
          className="player-controls relative mx-[clamp(26px,4.5vw,92px)] mb-[clamp(18px,3vh,42px)] flex flex-col"
        >

          {/* Compact TV-style control row */}
          <div className={`player-controls__info order-3 flex items-center justify-between transition-all duration-250 ${showChapters ? 'pointer-events-none max-h-0 translate-y-2 overflow-hidden opacity-0' : 'mt-1 min-h-12 max-h-16 translate-y-0 overflow-visible opacity-100'}`}>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Media information" title="Info" onClick={() => { setTrackMenu(null); setShowSpeedMenu(false); setShowMediaInfo((value) => !value); setShowChapters(false); setShowPlayerDebug(false) }} className={`grid h-10 w-10 place-items-center rounded-full transition-all ${showMediaInfo ? 'bg-white text-black shadow-lg' : 'text-white/65 hover:bg-white/10 hover:text-white'}`}>
                <svg className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.4h.01" strokeLinecap="round"/></svg>
              </button>
              <button type="button" aria-label="Chapters" title="Chapters" disabled={displayChapters.length === 0} onClick={() => { setTrackMenu(null); setShowSpeedMenu(false); setShowChapters((value) => !value); setShowMediaInfo(false); setShowPlayerDebug(false) }} className={`grid h-10 w-10 place-items-center rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-35 ${showChapters ? 'bg-white text-black shadow-lg' : 'text-white/65 hover:bg-white/10 hover:text-white'}`}>
                <svg className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M8 9h12M8 15h12" strokeLinecap="round"/></svg>
              </button>
              {import.meta.env.DEV && (
                <button
                  type="button"
                  aria-label="Player diagnostics"
                  title="Player diagnostics"
                  onClick={() => { setTrackMenu(null); setShowSpeedMenu(false); setShowMediaInfo(false); setShowChapters(false); setShowPlayerDebug((value) => !value) }}
                  className={`grid h-10 w-10 place-items-center rounded-full transition-all ${showPlayerDebug ? 'bg-amber-300 text-black shadow-lg' : 'text-amber-200/65 hover:bg-amber-300/10 hover:text-amber-100'}`}
                >
                  <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M9 9h6v7a3 3 0 0 1-6 0V9Z"/><path d="M10 9V7a2 2 0 0 1 4 0v2M6 11h3M15 11h3M6 15h3M15 15h3M8 4l2 2M16 4l-2 2" strokeLinecap="round"/></svg>
                </button>
              )}
            </div>

            <div className="player-controls__secondary flex flex-shrink-0 items-center gap-2">
              {activeSkip && (
                (skipType === 'credits' && showSkipCreditsButton)
                || ((skipType === 'intro' || skipType === 'recap') && showSkipIntroButton)
              ) && (
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
                      command('seek', [targetSec, 'absolute+exact'])
                      sendWatchTogetherSeek(targetSec)
                      setActiveSkip(null)
                      setSkipType(null)
                    }
                  }}
                  aria-label={`Skip ${skipType === 'intro' ? 'intro' : skipType === 'recap' ? 'recap' : 'credits'}`}
                  className="flex h-9 items-center gap-2 rounded-full bg-white px-4 text-xs font-bold text-black shadow-[0_8px_28px_rgba(0,0,0,0.4)] transition-transform duration-150 hover:scale-[1.03] active:scale-[0.98]"
                >
                  <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M5.88 4.12L13.76 12l-7.88 7.88L8 22l10-10L8 2z" />
                    <path d="M18 5h2v14h-2z" />
                  </svg>
                  Skip {skipType === 'intro' ? 'Intro' : skipType === 'recap' ? 'Recap' : 'Credits'}
                </button>
              )}

              <div className="flex items-center gap-0.5">
              {/* Subtitle button */}
              <div className="relative" data-player-popover>
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
                  onClick={() => {
                    setShowSpeedMenu(false)
                    setShowMediaInfo(false)
                    setShowChapters(false)
                    setTrackMenu(trackMenu === 'subs' ? null : 'subs')
                  }}
                  onFocus={() => loadAddonSubtitles(true).then(() => refreshTracks()).catch(() => {})}
                  title="Subtitles"
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${trackMenu === 'subs' ? 'bg-white/18 text-white' : 'text-white/65 hover:bg-white/10 hover:text-white'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <rect x="2" y="4" width="20" height="16" rx="2.5" />
                    <path d="M6 11h6M6 15h10" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              {/* Audio button */}
              <div className="relative" data-player-popover>
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
                  onClick={() => {
                    setShowSpeedMenu(false)
                    setShowMediaInfo(false)
                    setShowChapters(false)
                    setTrackMenu(trackMenu === 'audio' ? null : 'audio')
                  }}
                  onFocus={() => refreshTracks().catch(() => {})}
                  title="Audio track"
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${trackMenu === 'audio' ? 'bg-white/18 text-white' : 'text-white/65 hover:bg-white/10 hover:text-white'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                    <path d="M9 18V5l12-2v13" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                  </svg>
                </button>
              </div>

              {/* Speed */}
              <div className="relative ml-1" data-player-popover>
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
                  onClick={() => {
                    setTrackMenu(null)
                    setShowMediaInfo(false)
                    setShowChapters(false)
                    setShowSpeedMenu((v) => !v)
                  }}
                  title="Playback speed"
                  className={`flex h-9 min-w-9 items-center justify-center rounded-full px-2 text-label font-bold transition-colors ${
                    playbackSpeed !== 1 ? 'bg-white/18 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {playbackSpeed === 1 ? '1x' : `${playbackSpeed}x`}
                </button>
              </div>

              {/* Volume */}
              <div className="group/vol ml-1 flex items-center gap-1.5">
                <button
                  onClick={() => {
                    const newVol = volume > 0 ? 0 : (volumeRef.current > 0 ? volumeRef.current : 100)
                    setVolume(newVol)
                    if (newVol > 0) volumeRef.current = newVol
                    localStorage.setItem('orynt_volume', String(newVol))
                    changeVolume(newVol)
                  }}
                  title={volume > 0 ? 'Mute (M)' : 'Unmute (M)'}
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
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
                  className="w-0 cursor-pointer accent-white opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-80 focus:w-20 focus:opacity-100"
                />
              </div>

              {/* Fullscreen */}
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); toggleFullscreen() }}
                title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                className="flex h-9 w-9 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
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

              {/* Primary playback action */}
              <button
                onClick={(event) => { event.stopPropagation(); togglePlay() }}
                title={paused ? 'Play (Space)' : 'Pause (Space)'}
                aria-label={paused ? 'Play' : 'Pause'}
                className="ml-2 grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-[0_10px_32px_rgba(0,0,0,0.35)] transition-transform duration-150 hover:scale-105 active:scale-95"
              >
                {paused ? (
                  <svg className="ml-0.5 h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                ) : (
                  <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
                )}
              </button>
              </div>
            </div>
          </div>

          {/* Seek bar + playback controls row */}
          <div className={`order-1 flex flex-wrap items-center justify-end gap-2.5 transition-all duration-250 ${showChapters ? 'pointer-events-none max-h-0 overflow-hidden opacity-0' : 'max-h-8 overflow-visible opacity-100'}`}>
            {/* Play/Pause */}
            <button
              onClick={(e) => { e.stopPropagation(); togglePlay() }}
              title={paused ? 'Play (Space)' : 'Pause (Space)'}
              className="hidden"
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
              className="hidden"
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
              className="hidden"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.16-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z" />
                <text x="12.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">{seekStepSeconds}</text>
              </svg>
            </button>

            <div
              className="order-1 relative h-[3px] w-full flex-none cursor-pointer group transition-[height] duration-150 hover:h-1"
              onPointerDown={(event) => {
                if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
                if (event.pointerType === 'mouse' && (event.buttons & 1) !== 1) return
                if ((event.target as Element | null)?.closest('button')) return
                const rect = event.currentTarget.getBoundingClientRect()
                const pct = rect.width > 0
                  ? Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
                  : progressPct
                try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* window guard still releases the drag */ }
                isDraggingRef.current = true
                activeTimelinePointerRef.current = event.pointerId
                setIsDragging(true)
                draggingProgressRef.current = pct
                setDraggingProgress(pct)
                updateTimelinePreviewAtPct(pct)
              }}
              onPointerMove={(event) => {
                if (!isDraggingRef.current) {
                  showTimelinePreviewFromPointer(event)
                  return
                }
                const ownsDrag = activeTimelinePointerRef.current === event.pointerId
                const leftButtonHeld = event.pointerType !== 'mouse' || (event.buttons & 1) === 1
                if (!ownsDrag || !leftButtonHeld) {
                  isDraggingRef.current = false
                  activeTimelinePointerRef.current = null
                  setIsDragging(false)
                  showTimelinePreviewFromPointer(event)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                const pct = rect.width > 0
                  ? Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
                  : draggingProgressRef.current
                draggingProgressRef.current = pct
                setDraggingProgress(pct)
                updateTimelinePreviewAtPct(pct)
              }}
              onPointerUp={(event) => {
                if (!isDraggingRef.current || activeTimelinePointerRef.current !== event.pointerId) return
                const rect = event.currentTarget.getBoundingClientRect()
                const pct = rect.width > 0
                  ? Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
                  : draggingProgressRef.current
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                draggingProgressRef.current = pct
                commitTimelineSeek(pct)
              }}
              onPointerCancel={() => {
                isDraggingRef.current = false
                activeTimelinePointerRef.current = null
                setIsDragging(false)
                hideTimelinePreview()
              }}
              onPointerLeave={() => {
                if (!isDraggingRef.current) hideTimelinePreview()
              }}
            >
              {timelinePreview.visible && (
                <div
                  className="seek-preview pointer-events-none absolute bottom-7 z-[20] -translate-x-1/2 overflow-visible bg-transparent"
                  // The bubble is centred on the cursor, so at either end of the
                  // timeline half of it used to render outside the viewport.
                  // Clamping the centre by half the bubble's own width keeps it
                  // fully on screen while staying as close to the scrub position
                  // as possible. --seek-preview-half tracks whether a thumbnail
                  // is present, since that changes the bubble's width.
                  style={{
                    left: `clamp(var(--seek-preview-half), ${timelinePreview.leftPct}%, calc(100% - var(--seek-preview-half)))`,
                    ['--seek-preview-half' as string]: scrubThumbnailPreviews ? '7.5rem' : '2.5rem',
                  }}
                >
                  {scrubThumbnailPreviews && timelineThumbnail && (
                    <ScrubThumbnailImage
                      key={timelineThumbnail}
                      src={timelineThumbnail}
                      onInvalid={() => setTimelineThumbnail(null)}
                    />
                  )}
                  <span className="mt-2 block text-center text-sm font-bold tabular-nums text-white [text-shadow:0_2px_8px_rgba(0,0,0,0.95)]">
                    {formatTime(timelinePreview.time)}
                  </span>
                </div>
              )}
              <div className="absolute inset-0 rounded-full bg-white/25 group-hover:bg-white/35 transition-colors" />
              {skipTimelineRanges.map((range, index) => (
                <button
                  key={`${range.type}-${range.start}-${range.end}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (wtControlBlocked()) { wtBlockedNotice(); return }
                    const targetTime = range.end / 1000
                    progressRef.current.currentTime = targetTime
                    setCurrentTime(targetTime)
                    command('seek', [targetTime, 'absolute+keyframes'])
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
                className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-white opacity-75 shadow-lg transition-opacity group-hover:opacity-100"
                style={{ left: `calc(${displayProgressPct}% - 5px)` }}
              />
              <input
                type="range"
                min={0}
                max={100}
                step={duration > 0 ? Math.max(100 / duration, 0.001) : 0.05}
                value={displayProgressPct}
                aria-label="Playback position"
                aria-valuetext={duration > 0 ? `${formatTime(displayCurrentTime)} of ${formatTime(duration)}` : 'Loading'}
                onChange={(e) => {
                  const val = Number(e.target.value)
                  draggingProgressRef.current = val
                  setDraggingProgress(val)
                  if (isDraggingRef.current) {
                    updateTimelinePreviewAtPct(val)
                  } else {
                    // Native range keyboard controls do not emit pointer events.
                    // Commit them immediately so arrow/Page/Home/End seeking works.
                    commitTimelineSeek(val)
                  }
                }}
                className="pointer-events-none absolute inset-0 w-full touch-none opacity-0 h-6 -top-2.5"
              />
            </div>
          </div>

          {/* Timestamps row */}
          <div className={`relative order-2 flex items-center justify-between text-xs font-medium tabular-nums text-white/58 transition-all duration-250 ${showChapters ? 'pointer-events-none max-h-0 overflow-hidden opacity-0' : 'mt-2 max-h-8 overflow-visible opacity-100'}`} data-player-popover>
            <span>{duration > 0 ? formatTime(displayCurrentTime) : '--:--'}</span>
            <button onClick={() => setShowTimeRemaining((r) => !r)} className="transition-colors hover:text-white/80">
              {duration > 0 ? showTimeRemaining ? `-${formatTime(displayRemaining)}` : formatTime(duration) : '--:--'}
            </button>

            {showMediaInfo && (
              <div className="absolute bottom-full left-0 mb-4 w-[min(34rem,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/90 p-5 text-left shadow-[0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-2xl">
                <div className="flex items-start justify-between gap-5">
                  <div className="min-w-0">
                    <p className="text-meta font-bold uppercase tracking-[0.18em] text-white/60">Now playing</p>
                    <h3 className="mt-1.5 text-lg font-semibold leading-tight text-white">{currentDisplayTitle}</h3>
                    {(currentMeta?.episodeTitle || currentDisplaySubtitle) && (
                      <p className="mt-1 text-sm text-white/50">
                        {[currentMeta?.epCode, currentMeta?.episodeTitle || currentDisplaySubtitle].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                  <button type="button" onClick={() => setShowMediaInfo(false)} aria-label="Close information" className="grid h-8 w-8 flex-none place-items-center rounded-full bg-white/5 text-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white">×</button>
                </div>

                {currentMeta?.overview ? (
                  <p className="mt-4 text-sm leading-6 text-white/68">{currentMeta.overview}</p>
                ) : (
                  <p className="mt-4 text-sm text-white/60">Description unavailable.</p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {currentMeta?.year && <span className="rounded-full bg-white/7 px-2.5 py-1 text-label font-medium text-white/60">{currentMeta.year}</span>}
                  {currentMeta?.runtime && <span className="rounded-full bg-white/7 px-2.5 py-1 text-label font-medium text-white/60">{currentMeta.runtime} min</span>}
                  {currentMeta?.rating != null && <span className="rounded-full bg-white/7 px-2.5 py-1 text-label font-medium text-white/60">★ {currentMeta.rating.toFixed(1)}</span>}
                  {currentMeta?.genres?.slice(0, 3).map((genre) => <span key={genre} className="rounded-full bg-white/7 px-2.5 py-1 text-label font-medium text-white/60">{genre}</span>)}
                  {mediaBadges.map((badge) => <span key={badge} className="rounded-full border border-white/10 px-2.5 py-1 text-meta font-semibold text-white/60">{badge}</span>)}
                </div>
              </div>
            )}

            {import.meta.env.DEV && showPlayerDebug && (
              <PlayerDebugPanel
                snapshot={playerDebugSnapshot}
                sourceHint={currentStreamUrlRef.current || url}
                passthroughConfigured={useAppStore.getState().audioPassthrough}
                loading={playerDebugLoading}
                error={playerDebugError}
                onRefresh={() => refreshPlayerDebug().catch(() => {})}
                onUseDecodedAudio={useDecodedAudio}
                onClose={() => setShowPlayerDebug(false)}
              />
            )}
          </div>

          {/* Chapter strip: compact tabs and a continuous thumbnail rail. */}
          {displayChapters.length > 0 && (
            <div
              aria-hidden={!showChapters}
              data-player-popover
              className={`order-0 grid transition-[grid-template-rows,opacity,transform] duration-300 ease-expo ${showChapters ? 'grid-rows-[1fr] translate-y-0 opacity-100' : 'pointer-events-none grid-rows-[0fr] translate-y-3 opacity-0'}`}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/78">
                  <button
                    type="button"
                    onClick={() => { setShowChapters(false); setShowMediaInfo(true); setShowPlayerDebug(false) }}
                    className="rounded-full px-3 py-2 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    Info
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowChapters(false)}
                    className="flex items-center gap-2 rounded-full bg-white px-4 py-2 font-bold text-black shadow-[0_8px_24px_rgba(0,0,0,.35)] transition-transform hover:scale-[1.02] active:scale-[.98]"
                  >
                    <span>Chapters</span>
                    <span className="h-4 w-px bg-black/20" />
                    <span className="tabular-nums">{displayChapters.length}</span>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.5 13 3.5-3.5 3.5 3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                </div>
                <div
                  ref={chapterStripRef}
                  className="flex gap-2 overflow-x-auto px-0.5 pb-1.5 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {displayChapters.map((chapter, index) => {
                    const next = displayChapters[index + 1]
                    const isActive = displayCurrentTime >= chapter.time && (next == null || displayCurrentTime < next.time)
                    const thumb = chapterThumbs[`${Math.round(chapter.time)}`]
                    return (
                      <button
                        key={`chapter-tile-${chapter.time}-${index}`}
                        type="button"
                        data-active-chapter={isActive || undefined}
                        aria-label={`Go to ${chapter.title}`}
                        title={`${chapter.title} · ${formatTime(chapter.time)}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (wtControlBlocked()) { wtBlockedNotice(); return }
                          setShowChapters(false)
                          progressRef.current.currentTime = chapter.time
                          setCurrentTime(chapter.time)
                          command('seek', [chapter.time, 'absolute+keyframes'])
                          sendWatchTogetherSeek(chapter.time)
                        }}
                        className="group/chapter flex-none rounded-lg text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-white/70"
                      >
                        <div className={`relative aspect-video w-[clamp(12.5rem,min(17vw,27vh),18rem)] overflow-hidden rounded-lg border bg-white/5 transition-all duration-150 ${isActive ? 'border-white/65 shadow-[0_8px_28px_rgba(0,0,0,0.55)]' : 'border-white/10 hover:border-white/35'}`}>
                          {thumb ? (
                            <img src={thumb} alt="" draggable={false} className="h-full w-full object-cover" />
                          ) : (
                            <div className="h-full w-full animate-pulse bg-white/10" />
                          )}
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent px-2.5 pb-2 pt-8">
                            <div className="flex items-end justify-between gap-2">
                              <span className={`grid h-6 w-6 place-items-center rounded bg-black/65 text-white transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover/chapter:opacity-80'}`}>
                                <svg className="ml-px h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                              </span>
                              <span className="rounded bg-black/65 px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-white/95">{formatTime(chapter.time)}</span>
                            </div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
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
          countdownDuration={nextEpisodeCountdownSeconds}
          autoplayEnabled={autoPlayNextEpisode}
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
