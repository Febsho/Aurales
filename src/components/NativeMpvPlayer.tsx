import { useEffect, useRef, useState, useCallback } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import type { SubtitleResult } from '../types'
import { logEvent } from '../services/diagnostics'
import { getTmdbApiKey } from '../services/apiKeys'
import { downloadSubtitle, launchEmbeddedPlayer, resizeEmbeddedPlayer, sendPlayerCommand, stopEmbeddedPlayer, getPlayerProperty, isEmbeddedPlayerRunning } from '../services/player'
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
import { saveAniListProgress, saveAniListProgressMapped } from '../services/anilist'
import type { PMDBSkipSegment } from '../services/pmdb'
import { getIntroDBSkips } from '../services/introdb'
import { getAddonStreams, getStreamAddons } from '../services/addons'
import { useAppStore, getLanguageCodeFromTrack, APP_LANGUAGES } from '../stores/appStore'
import { setDiscordActivity, clearDiscordActivity } from '../services/discord'
import { minimalMpvPlayer } from '../services/player/minimalMpvPlayer'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import {
  play as wtPlay,
  pause as wtPause,
  seek as wtSeek,
  sendBuffering as wtSendBuffering,
} from '../services/watch-together/wsClient'
import { shouldCorrectDrift, markCorrectionApplied, resetDriftState } from '../services/watch-together/driftCorrection'

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
  if (item.mediaType !== 'anime' || item.tvdbId == null || item.season == null || item.episode == null) {
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
}: NativeMpvPlayerProps) {

  // ─ Refs ───────────────────────────────────────────────────────────────────
  const activeSessionRef = useRef<PlayerSession | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const trackPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const loadedSubtitleUrlsRef = useRef<Set<string>>(new Set())
  const autoSkippedSegmentsRef = useRef<Set<string>>(new Set())
  const subtitleSourcesRef = useRef<Map<string, { originalUrl: string; localPath: string; label: string }>>(new Map())
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
  const volumeRef = useRef<number>(100)

  // Up Next refs (accessed inside stale poll closure)
  const nextEpInfoRef = useRef<NextEpInfo | null>(null)
  const showUpNextRef = useRef(false)
  const upNextTriggeredRef = useRef(false)
  const upNextCancelledRef = useRef(false)

  // ─ State ─────────────────────────────────────────────────────────────────
  const [controlsVisible, setControlsVisible] = useState(true)
  const [paused, setPaused] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [error, setError] = useState('')
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subTracks, setSubTracks] = useState<TrackOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState<number>(1)
  const [selectedSub, setSelectedSub] = useState<number | 'no'>('no')
  const [tracksLoaded, setTracksLoaded] = useState(false)
  const [playerReady, setPlayerReady] = useState(false)
  const [playerRunning, setPlayerRunning] = useState(true)
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

  // Up Next state
  const [nextEpInfo, setNextEpInfo] = useState<NextEpInfo | null>(null)
  const [showUpNext, setShowUpNext] = useState(false)
  const [upNextCountdown, setUpNextCountdown] = useState(10)
  const [isAutoSearching, setIsAutoSearching] = useState(false)

  // Live subtitle translation overlay
  const [liveTranslateOn, setLiveTranslateOn] = useState(false)
  const [translatedText, setTranslatedText] = useState('')
  const [currentSubText, setCurrentSubText] = useState('')
  const liveTranslateCacheRef = useRef<Map<string, string>>(new Map())
  const liveTranslatePendingRef = useRef<string>('')

  // Current display title/subtitle — updated when autoplay transitions episodes
  const [currentDisplayTitle, setCurrentDisplayTitle] = useState(title)
  const [currentDisplaySubtitle, setCurrentDisplaySubtitle] = useState(subtitle)

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
  const scrobbleTrakt = useAppStore((s) => s.scrobbleTrakt)
  const scrobblePmdb = useAppStore((s) => s.scrobblePmdb)
  const scrobbleAnilist = useAppStore((s) => s.scrobbleAnilist)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const pmdbSaveResumePosition = useAppStore((s) => s.pmdbSaveResumePosition)
  const autoSkipSegments = useAppStore((s) => s.autoSkipSegments)
  const openrouterApiKey = useAppStore((s) => s.openrouterApiKey)
  const openrouterModel = useAppStore((s) => s.openrouterModel)
  const subtitleTranslationLang = useAppStore((s) => s.subtitleTranslationLang)
  const subtitleTranslationEnabled = useAppStore((s) => s.subtitleTranslationEnabled)
  const translationCuesAhead = useAppStore((s) => s.translationCuesAhead)
  const contextAwareTranslation = useAppStore((s) => s.contextAwareTranslation)
  const discordRichPresence = useAppStore((s) => s.discordRichPresence)

  // Keep refs in sync with state for stale-closure access
  const pausedRef = useRef(paused)
  const wtIgnoreNextEvent = useRef(false)
  useEffect(() => { pausedRef.current = paused }, [paused])
  useEffect(() => { nextEpInfoRef.current = nextEpInfo }, [nextEpInfo])
  useEffect(() => { showUpNextRef.current = showUpNext }, [showUpNext])
  useEffect(() => { volumeRef.current = volume }, [volume])

  const applySavedVolume = useCallback((delays = [0, 250, 750, 1500, 3000]) => {
    const target = volumeRef.current
    delays.forEach((delay) => {
      setTimeout(() => {
        sendPlayerCommand('set_property', ['volume', target]).catch(() => {})
      }, delay)
    })
  }, [])

  // ── Watch Together sync ──────────────────────────────────────────────────
  useEffect(() => {
    const wtState = useWatchTogetherStore.getState()
    if (!wtState.currentRoom) return

    resetDriftState()

    const onSyncRequest = (e: Event) => {
      const { time, isPlaying } = (e as CustomEvent).detail as { time: number; isPlaying: boolean }

      const { driftThreshold } = useWatchTogetherStore.getState()
      const { shouldSeek, targetTime } = shouldCorrectDrift(
        progressRef.current.currentTime,
        { currentTime: time, isPlaying, lastUpdatedAt: Date.now() },
        driftThreshold,
        3000,
      )

      if (shouldSeek) {
        wtIgnoreNextEvent.current = true
        sendPlayerCommand('seek', [targetTime, 'absolute']).catch(() => {})
        markCorrectionApplied()
      }

      if (isPlaying && pausedRef.current) {
        wtIgnoreNextEvent.current = true
        sendPlayerCommand('set_property', ['pause', false]).catch(() => {})
      } else if (!isPlaying && !pausedRef.current) {
        wtIgnoreNextEvent.current = true
        sendPlayerCommand('set_property', ['pause', true]).catch(() => {})
      }
    }

    window.addEventListener('wt:sync_request', onSyncRequest)
    return () => {
      window.removeEventListener('wt:sync_request', onSyncRequest)
      resetDriftState()
    }
  }, [])

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
      mediaType: item.mediaType === 'show' ? 'series' : item.mediaType,
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
    if (!item || !pmdbApiKey) return
    if (!tmdbId && !imdbId) return

    const isEpisodic = item.mediaType === 'show' || item.mediaType === 'anime'
    const mediaType = isEpisodic ? 'tv' : 'movie'
    const progress = dur > 0 ? pos / dur : 0

    // Scrobble only when: caller explicitly permits it, we're confident the
    // episode is finished (≥90%), and duration looks real (≥3 min).
    if (allowScrobble && scrobblePmdb && tmdbId && progress >= 0.90 && dur >= 180) {
      ;(async () => {
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
      return // PMDB server already marks it watched — no need to save resume point
    }

    if (pmdbSaveResumePosition && dur > 0) {
      logEvent('PLAYBACK SYNC DEBUG', `Save PMDB resume point: ${Math.floor(pos)}s / ${Math.floor(dur)}s`)
      ;(async () => {
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
      // Note: we intentionally ignore the {action:'completed'} response here.
    }
  }, [pmdbApiKey, pmdbSaveResumePosition, scrobblePmdb])

  // ─ Controls visibility ────────────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 4000)
  }, [])

  const command = useCallback((name: string, args: unknown[] = []) => {
    sendPlayerCommand(name, args).catch((e) => setError(String(e)))
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
    const audio = data
      .filter((t) => t.type === 'audio')
      .map((t) => ({ id: t.id, label: trackLabel(t, `Audio ${t.id}`), lang: t.lang, priority: 0 }))
    const subs = data
      .filter((t) => t.type === 'sub')
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
        let bestAudioId = selAudio?.id
        let bestAudioRank = Infinity
        audio.forEach((t) => {
          const code = getLanguageCodeFromTrack(t.lang)
          const rank = code ? preferredAudio.indexOf(code) : -1
          if (rank !== -1 && rank < bestAudioRank) { bestAudioRank = rank; bestAudioId = t.id }
        })
        if (bestAudioId !== undefined && bestAudioId !== selAudio?.id) {
          sendPlayerCommand('set_property', ['aid', bestAudioId])
          setSelectedAudio(bestAudioId)
        }
        hasAutoSelectedAudioRef.current = true
      }

      // ── Subtitle auto-select ──
      if (!hasAutoSelectedSubRef.current && subs.length > 0) {
        let bestSubId: number | 'no' = selSub?.id || 'no'
        let bestSubRank = Infinity
        subs.forEach((t) => {
          const code = getLanguageCodeFromTrack(t.lang)
          const rank = code ? preferredSubtitles.indexOf(code) : -1
          if (rank !== -1 && rank < bestSubRank) { bestSubRank = rank; bestSubId = t.id }
        })
        if (bestSubId !== 'no' && bestSubId !== selSub?.id) {
          sendPlayerCommand('set_property', ['sid', bestSubId])
          setSelectedSub(bestSubId as number)
        }
        hasAutoSelectedSubRef.current = true
      }
    }
    setTracksLoaded(audio.length > 0 || subs.length > 0)
    return audio.length > 0 || subs.length > 0
  }, [])

  // ─ Live subtitle translation ─────────────────────────────────────────────
  // Fast 200ms poll. Translation fires concurrently (non-blocking) so the poll
  // never stalls waiting for the API. Cached lines display instantly.
  useEffect(() => {
    if (!liveTranslateOn || !openrouterApiKey || !subtitleTranslationLang) return
    const lang = APP_LANGUAGES.find((l) => l.code === subtitleTranslationLang)
    if (!lang) return

    let cancelled = false
    const inflight = new Set<string>()
    let lastText = ''

    const translateLine = async (line: string) => {
      if (inflight.has(line) || liveTranslateCacheRef.current.has(line)) return
      inflight.add(line)
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openrouterApiKey}`,
            'HTTP-Referer': 'https://github.com/itsrenoria/aurales',
            'X-Title': 'Aurales Media Player',
          },
          body: JSON.stringify({
            model: openrouterModel || 'google/gemini-2.5-flash',
            messages: [
              { role: 'system', content: `Translate into natural ${lang.name}. Output ONLY the translation, nothing else. Keep it concise — this is a subtitle line.` },
              { role: 'user', content: line }
            ]
          })
        })
        if (cancelled || !response.ok) return
        const data = await response.json()
        const result = data.choices?.[0]?.message?.content?.trim()
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

  const toggleFullscreen = useCallback(async () => {
    const win = getCurrentWindow()
    const current = await win.isFullscreen().catch(() => false)
    const next = !current
    setIsFullscreen(next)
    await win.setFullscreen(next).catch((e) => setError(`Fullscreen failed: ${e instanceof Error ? e.message : String(e)}`))
    const doResize = () => resizeEmbeddedPlayer(showUpNextRef.current ? buildUpNextPipViewport() : buildVideoViewport()).catch(() => {})
    ;[0, 150, 400, 800, 1500].forEach((d) => setTimeout(doResize, d))
    showControls()
  }, [showControls])

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

        if (e.repeat) return

        if (holdTimeout) clearTimeout(holdTimeout)
        if (spoolInterval) clearInterval(spoolInterval)

        pressedKey = key
        accumulatedSeekRef.current = key === 'ArrowRight' ? 10 : -10
        setAccumulatedSeek(accumulatedSeekRef.current)

        holdTimeout = setTimeout(() => {
          spoolInterval = setInterval(() => {
            if (accumulatedSeekRef.current !== null) {
              accumulatedSeekRef.current += key === 'ArrowRight' ? 5 : -5
              setAccumulatedSeek(accumulatedSeekRef.current)
            }
          }, 150)
        }, 250)
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
          
          if (accumulatedSeekRef.current !== null) {
            logEvent('PLAYER DEBUG', `Keyboard seek triggered for: ${accumulatedSeekRef.current}s`)
            sendPlayerCommand('seek', [accumulatedSeekRef.current, 'relative']).catch(() => {})
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
  }, [showControls, toggleFullscreen])

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
    logEvent('PLAYER DEBUG', `Player started session ${session.id} for media ${session.mediaId}`)

    let cancelled = false
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
          mpvCustomArgs: storeState.mpvCustomArgs
        })
        if (cancelled || session.status === "stopped") return
        setPlayerRunning(true)
        session.status = "playing"

        // Enforce saved volume a few times because mpv can reset filters/audio
        // while the demuxer initializes on some streams.
        applySavedVolume()

        if (playbackItem) {
          const startProgress = startTime && progressRef.current.duration > 0
            ? startTime / progressRef.current.duration : 0
          if (scrobbleSimkl) {
            logEvent('PLAYBACK SYNC DEBUG', `Send Simkl start for session ${session.id}`)
            onSimklPlaybackStart(playbackItem, startProgress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
            const pct = Math.round(startProgress * 10000) / 100
            const payload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
              ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, pct)
              : buildMovieScrobble(playbackItem.imdbId, pct)
            logEvent('PLAYBACK SYNC DEBUG', `Send Trakt start for session ${session.id} at ${pct}%`)
            traktScrobbleStart(payload).catch(() => {})
          }

          // Resolve TMDB ID then fetch skips from PMDB + IntroDB and merge
          const resolveAndFetchSkips = async () => {
            if (!tmdbIdRef.current && playbackItem.imdbId) {
              try {
                const isEpisodic = playbackItem.mediaType === 'show' || playbackItem.mediaType === 'anime'
                const preferredType = isEpisodic ? 'tv' : 'movie'
                const mapping = await lookupTmdbId('imdb', playbackItem.imdbId, preferredType)
                if (mapping) tmdbIdRef.current = mapping.tmdbId
              } catch (_) {}
            }
            const isEpisodic = playbackItem.mediaType === 'show' || playbackItem.mediaType === 'anime'
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
          setTimeout(() => { if (!cancelled && session.status !== "stopped") invoke('setup_player_click_through').catch(() => {}) }, delay)
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
      // Defer stop so a re-mount's launchEmbeddedPlayer (which internally
      // calls stop_embedded_mpv) can claim the player first.  If a new
      // session has already taken over by the time this fires, skip the
      // stop — otherwise we'd kill the new session's mpv process.
      setTimeout(() => {
        if (activeSessionRef.current === null || activeSessionRef.current.id === session.id) {
          stopEmbeddedPlayer().catch(() => {})
        }
      }, 0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, title])

  useEffect(() => {
    if (playerReady || error) return
    let cancelled = false
    const startedAt = Date.now()
    const interval = setInterval(async () => {
      const running = await isEmbeddedPlayerRunning().catch(() => false)
      if (cancelled) return
      setPlayerRunning(running)

      if (!running && Date.now() - startedAt > 3000) {
        await new Promise((r) => setTimeout(r, 500))
        const logs = await invoke<string[]>('get_player_debug_logs').catch(() => [])
        const reversed = [...logs].reverse()
        const stderrLines = reversed.filter((line) => line.includes('[MPV STDERR]'))
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
    const onResize = () => {
      resizeEmbeddedPlayer(showUpNextRef.current ? buildUpNextPipViewport() : buildVideoViewport()).catch(() => {})
      setTimeout(() => invoke('setup_player_click_through').catch(() => {}), 300)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const viewport = showUpNext ? buildUpNextPipViewport() : buildVideoViewport()
    resizeEmbeddedPlayer(viewport).catch(() => {})
    ;[250, 750, 1500].forEach((delay) => {
      setTimeout(() => resizeEmbeddedPlayer(viewport).catch(() => {}), delay)
    })
  }, [showUpNext])

  // ─ Discord Rich Presence ──────────────────────────────────────────────────
  useEffect(() => {
    if (!discordRichPresence) return

    const isEpisodic = playbackItem && (playbackItem.mediaType === 'show' || playbackItem.mediaType === 'anime')
    const details = title || 'Watching something'
    const state = paused
      ? (isEpisodic ? `S${playbackItem!.season ?? 0}E${playbackItem!.episode ?? 0} · Paused` : 'Paused')
      : isEpisodic
        ? `S${playbackItem!.season ?? 0}E${playbackItem!.episode ?? 0}`
        : playbackItem?.mediaType === 'movie' ? 'Watching' : undefined

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

    return () => { clearDiscordActivity().catch(() => {}) }
  }, [discordRichPresence, title, playbackItem, paused, poster])

  // Periodically sync Discord timestamps with actual playback position
  useEffect(() => {
    if (!discordRichPresence || paused) return
    const sync = setInterval(() => {
      const cur = progressRef.current.currentTime || 0
      const dur = progressRef.current.duration || 0
      if (dur <= 0) return
      const nowSec = Math.floor(Date.now() / 1000)

      const isEpisodic = playbackItem && (playbackItem.mediaType === 'show' || playbackItem.mediaType === 'anime')
      const posterUrl = poster && poster.startsWith('http') ? poster : undefined

      setDiscordActivity({
        details: title || 'Watching something',
        state: isEpisodic
          ? `S${playbackItem!.season ?? 0}E${playbackItem!.episode ?? 0}`
          : playbackItem?.mediaType === 'movie' ? 'Watching' : undefined,
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
        mpvCustomArgs: storeState.mpvCustomArgs
      })
      applySavedVolume()
      logEvent('PLAYER DEBUG', `Player restarted successfully`)
    } catch (err) {
      logEvent('PLAYER DEBUG', `Auto-restart failed: ${err}`)
    }
  }, [url, title, applySavedVolume])

  // ─ Polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let polling = false
    pollRef.current = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const [pos, dur, isPause, isBuffering, cacheBuffState, demuxerCacheDur, eofReached, idleActive, coreIdle] = await Promise.all([
          getPlayerProperty('time-pos') as Promise<number | null>,
          getPlayerProperty('duration') as Promise<number | null>,
          getPlayerProperty('pause') as Promise<boolean | null>,
          getPlayerProperty('buffering') as Promise<boolean | null>,
          getPlayerProperty('cache-buffering-state') as Promise<number | null>,
          getPlayerProperty('demuxer-cache-duration') as Promise<number | null>,
          getPlayerProperty('eof-reached') as Promise<boolean | null>,
          getPlayerProperty('idle-active') as Promise<boolean | null>,
          getPlayerProperty('core-idle') as Promise<boolean | null>,
        ])

        const nowMs = Date.now()

        // Log property changes
        if (isPause !== null && isPause !== lastPauseRef.current) {
          lastPauseRef.current = isPause
          logEvent('MPV DEBUG', `pause changed to: ${isPause}`)
        }
        if (isBuffering !== null && isBuffering !== lastBufferingRef.current) {
          lastBufferingRef.current = isBuffering
          logEvent('MPV DEBUG', `buffering changed to: ${isBuffering}`)
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
          setPlayerReady(true)
          progressRef.current.currentTime = pos
        }
        if (dur != null && dur > 0) {
          setDuration(dur)
          setPlayerReady(true)
          progressRef.current.duration = dur
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
          if (Math.abs(pos - lastSavedTimeRef.current) >= 15) {
            lastSavedTimeRef.current = pos
            saveLocalProgress(pos, dur, false)
          }
          const item = currentItemRef.current
          if (item && scrobbleSimkl && pos - lastSimklPlaybackSaveRef.current >= 60) {
            lastSimklPlaybackSaveRef.current = pos
            logEvent('PLAYBACK SYNC DEBUG', `Save Simkl scrobble progress: ${Math.round(pos)}s / ${Math.round(dur)}s`)
            saveSimklPlaybackProgress(item, pos / dur).catch(() => {})
          }
          if (item && scrobbleAnilist && item.mediaType === 'anime' && pos - lastAniListPlaybackSaveRef.current >= 60) {
            lastAniListPlaybackSaveRef.current = pos
            logEvent('PLAYBACK SYNC DEBUG', `Save AniList scrobble progress: ${Math.round(pos)}s / ${Math.round(dur)}s`)
            saveAniListProgressMapped(item, pos / dur).catch(() => {})
          }
          if (item && pmdbApiKey && pmdbSaveResumePosition && (tmdbIdRef.current || item.imdbId) && pos - lastPmdbPlaybackSaveRef.current >= 60) {
            lastPmdbPlaybackSaveRef.current = pos
            savePMDBProgressHelper(pos, dur, false)
          }

          // Detect near-end for Up Next
          // Trigger when ≤90s remaining OR ≥92% through, whichever comes first
          const remaining = dur - pos
          const pctDone = pos / dur
          if (
            (remaining <= 90 || pctDone >= 0.92) &&
            remaining > 0 &&
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
          if (autoSkipSegments && found && foundType) {
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
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [skips, autoSkipSegments, command, saveLocalProgress, savePMDBProgressHelper, scrobbleSimkl, scrobbleAnilist, pmdbApiKey, pmdbSaveResumePosition, triggerRestart])

  // ─ Fetch next episode on mount ────────────────────────────────────────────
  useEffect(() => {
    if (!playbackItem || (playbackItem.mediaType !== 'show' && playbackItem.mediaType !== 'anime')) return
    if (!playbackItem.season || !playbackItem.episode) return

    const doFetch = async () => {
      let tmdbId = tmdbIdRef.current
      if (!tmdbId && playbackItem.imdbId) {
        try {
          const mapping = await lookupTmdbId('imdb', playbackItem.imdbId)
          if (mapping) { tmdbIdRef.current = mapping.tmdbId; tmdbId = mapping.tmdbId }
        } catch (_) {}
      }

      const nextSeason = playbackItem.season!
      const nextEpisode = playbackItem.episode! + 1

      if (tmdbId) {
        const info = await fetchNextEpisodeFromTmdb(tmdbId, nextSeason, nextEpisode)
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
    return () => clearTimeout(timer)
  }, [playbackItem])

  // ─ Up Next countdown ─────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAutoplay = useCallback(async () => {
    const nextEp = nextEpInfoRef.current
    const item = currentItemRef.current
    if (!nextEp || !item?.imdbId) { setShowUpNext(false); return }

    setIsAutoSearching(true)
    const streamId = `${item.imdbId}:${nextEp.season}:${nextEp.episode}`
    const addons = getStreamAddons('series')

    let foundUrl: string | null = null
    for (const addon of addons) {
      try {
        const streams = await getAddonStreams(addon.url, 'series', streamId)
        const valid = streams.find((s) => s.url)
        if (valid?.url) { foundUrl = valid.url; break }
      } catch (_) {}
    }

    setIsAutoSearching(false)
    if (!foundUrl) { setShowUpNext(false); return }

    // Stop current, save progress
    const { currentTime: pos, duration: dur } = progressRef.current
    saveLocalProgress(pos, dur, false)
    if (scrobbleSimkl && item) {
      onSimklPlaybackStop(item, dur > 0 ? pos / dur : 0).catch(() => {})
    }
    if (scrobbleTrakt && isTraktAuthenticated() && item?.imdbId && item.season != null && item.episode != null) {
      const pct = Math.round((dur > 0 ? pos / dur : 0) * 10000) / 100
      const payload = buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
      traktScrobbleStop(payload).catch(() => {})
    }
    await stopEmbeddedPlayer().catch(() => {})

    // Update current playback item refs
    const newItem: PlaybackItem = { ...item, season: nextEp.season, episode: nextEp.episode, title: `${title} · ${nextEp.title}` }
    currentItemRef.current = newItem
    currentPosterRef.current = nextEp.stillPath ?? currentPosterRef.current
    currentBackdropRef.current = nextEp.stillPath ?? currentBackdropRef.current

    try {
      await launchEmbeddedPlayer({ url: foundUrl, title, volume: volumeRef.current, viewport: buildVideoViewport() })
      applySavedVolume()

      // Update title/subtitle in the player controls bar
      const epCode = `S${String(nextEp.season).padStart(2, '0')}E${String(nextEp.episode).padStart(2, '0')}`
      setCurrentDisplayTitle(title)
      setCurrentDisplaySubtitle(`${epCode} · ${nextEp.title}`)

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
      ;[500, 1000, 2000].forEach((d) => setTimeout(() => invoke('setup_player_click_through').catch(() => {}), d))

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
  }, [title, scrobbleSimkl, scrobbleTrakt, saveLocalProgress, refreshTracks, applySavedVolume])

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
    const item = currentItemRef.current
    if (item) {
      const { currentTime: pos, duration: dur } = progressRef.current
      const progress = dur > 0 ? pos / dur : 0
      saveLocalProgress(pos, dur, false)
      const { keepFramesFor, savedFramesCount, setSavedFramesCount } = useAppStore.getState()
      if (keepFramesFor !== 'none') {
        setSavedFramesCount(savedFramesCount + 1)
      }
      if (scrobbleSimkl) {
        saveSimklPlaybackProgress(item, progress).catch(() => {})
        onSimklPlaybackStop(item, progress).catch(() => {})
      }
      if (scrobbleAnilist && item.mediaType === 'anime') {
        saveAniListProgressMapped(item, progress).catch(() => {})
      }
      if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
        const pct = Math.round(progress * 10000) / 100
        const payload = (item.mediaType === 'show' || item.mediaType === 'anime') && item.season != null && item.episode != null
          ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
          : buildMovieScrobble(item.imdbId, pct)
        traktScrobbleStop(payload).catch(() => {})
      }
      savePMDBProgressHelper(pos, dur, true) // allowScrobble: yes, user is done watching
    }
    if (isFullscreen) await getCurrentWindow().setFullscreen(false).catch(() => {})
    await stopEmbeddedPlayer().catch(() => {})
    onClose()
  }

  const pickAnother = async () => {
    const item = currentItemRef.current
    if (item) {
      const { currentTime: pos, duration: dur } = progressRef.current
      const progress = dur > 0 ? pos / dur : 0
      saveLocalProgress(pos, dur, false)
      const { keepFramesFor, savedFramesCount, setSavedFramesCount } = useAppStore.getState()
      if (keepFramesFor !== 'none') {
        setSavedFramesCount(savedFramesCount + 1)
      }
      if (scrobbleSimkl) {
        saveSimklPlaybackProgress(item, progress).catch(() => {})
        onSimklPlaybackStop(item, progress).catch(() => {})
      }
      if (scrobbleAnilist && item.mediaType === 'anime') {
        saveAniListProgressMapped(item, progress).catch(() => {})
      }
      if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
        const pct = Math.round(progress * 10000) / 100
        const payload = (item.mediaType === 'show' || item.mediaType === 'anime') && item.season != null && item.episode != null
          ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
          : buildMovieScrobble(item.imdbId, pct)
        traktScrobbleStop(payload).catch(() => {})
      }
      savePMDBProgressHelper(pos, dur, true) // allowScrobble: yes, user is switching away
    }
    if (isFullscreen) { await getCurrentWindow().setFullscreen(false).catch(() => {}); setIsFullscreen(false) }
    await stopEmbeddedPlayer().catch(() => {})
    onPickAnother()
  }

  const togglePlay = () => {
    if (!playerRunning) {
      setError('The player process has exited. Go back and choose another stream.')
      return
    }
    setPaused((prev) => {
      const newPaused = !prev
      const item = currentItemRef.current
      if (item) {
        const { currentTime: pos, duration: dur } = progressRef.current
        const progress = dur > 0 ? pos / dur : 0
        saveLocalProgress(pos, dur, false)
        if (newPaused) {
          if (scrobbleSimkl) {
            saveSimklPlaybackProgress(item, progress).catch(() => {})
            onSimklPlaybackPause(item, progress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
            const pct = Math.round(progress * 10000) / 100
            const payload = (item.mediaType === 'show' || item.mediaType === 'anime') && item.season != null && item.episode != null
              ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
              : buildMovieScrobble(item.imdbId, pct)
            traktScrobblePause(payload).catch(() => {})
          }
          savePMDBProgressHelper(pos, dur, false)
        } else {
          if (scrobbleSimkl) {
            saveSimklPlaybackProgress(item, progress).catch(() => {})
            onSimklPlaybackStart(item, progress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && item.imdbId) {
            const pct = Math.round(progress * 10000) / 100
            const payload = (item.mediaType === 'show' || item.mediaType === 'anime') && item.season != null && item.episode != null
              ? buildEpisodeScrobble(item.imdbId, item.season, item.episode, pct)
              : buildMovieScrobble(item.imdbId, pct)
            traktScrobbleStart(payload).catch(() => {})
          }
        }
      }
      return newPaused
    })
    command('cycle', ['pause'])

    const wt = useWatchTogetherStore.getState()
    if (wt.currentRoom && !wtIgnoreNextEvent.current) {
      const pos = progressRef.current.currentTime
      if (paused) wtPlay(pos)
      else wtPause(pos)
    }
    wtIgnoreNextEvent.current = false
  }

  const seekBy = (secs: number) => {
    if (!playerRunning) return
    command('seek', [secs, 'relative'])
    const wt = useWatchTogetherStore.getState()
    if (wt.currentRoom && !wtIgnoreNextEvent.current) {
      wtSeek(progressRef.current.currentTime + secs)
    }
    wtIgnoreNextEvent.current = false
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
  const changeSub = (id: number | 'no') => {
    setSelectedSub(id)
    command('set_property', ['sid', id])
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
      style={{ background: playerReady ? 'rgba(0,0,0,0.01)' : '#000' }}
      onMouseMove={showControls}
    >
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
        onClick={() => { showControls(); togglePlay() }}
        onDoubleClick={toggleFullscreen}
      />

      {/* Center play/pause indicator */}
      {paused && (
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

      {/* Error message */}
      {error && (
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

      {/* Skip Intro / Credits button */}
      {activeSkip && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            let endMs: number
            if (skipType === 'intro') endMs = activeSkip.intro_end_ms
            else if (skipType === 'recap') endMs = activeSkip.recap_end_ms ?? activeSkip.intro_end_ms
            else endMs = activeSkip.credits_end_ms ?? duration * 1000
            const targetSec = endMs / 1000
            if (!isNaN(targetSec)) {
              command('seek', [targetSec, 'absolute'])
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
                    onToggleTranslate={() => setLiveTranslateOn((v) => !v)}
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

            {/* Skip back 10s */}
            <button
              onClick={(e) => { e.stopPropagation(); command('seek', [-10, 'relative']) }}
              title="Back 10s (←)"
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
                <text x="11.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>

            {/* Skip forward 10s */}
            <button
              onClick={(e) => { e.stopPropagation(); command('seek', [10, 'relative']) }}
              title="Forward 10s (→)"
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.16-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z" />
                <text x="12.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>

            <div className="relative flex-1 h-1.5 group cursor-pointer transition-[height] duration-150 hover:h-2.5">
              <div className="absolute inset-0 rounded-full bg-white/20 group-hover:bg-white/30 transition-colors" />
              {skipTimelineRanges.map((range, index) => (
                <button
                  key={`${range.type}-${range.start}-${range.end}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    command('seek', [range.end / 1000, 'absolute'])
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
                onMouseDown={() => {
                  setIsDragging(true)
                  draggingProgressRef.current = progressPct
                  setDraggingProgress(progressPct)
                }}
                onMouseUp={() => {
                  setIsDragging(false)
                  command('seek', [draggingProgressRef.current, 'absolute-percent'])
                  const wt = useWatchTogetherStore.getState()
                  if (wt.currentRoom && duration > 0) wtSeek((draggingProgressRef.current / 100) * duration)
                }}
                onTouchStart={() => {
                  setIsDragging(true)
                  draggingProgressRef.current = progressPct
                  setDraggingProgress(progressPct)
                }}
                onTouchEnd={() => {
                  setIsDragging(false)
                  command('seek', [draggingProgressRef.current, 'absolute-percent'])
                  const wt = useWatchTogetherStore.getState()
                  if (wt.currentRoom && duration > 0) wtSeek((draggingProgressRef.current / 100) * duration)
                }}
                onChange={(e) => {
                  const val = Number(e.target.value)
                  draggingProgressRef.current = val
                  setDraggingProgress(val)
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
      {liveTranslateOn && currentSubText && (
        <div className="absolute inset-x-0 bottom-28 z-[8] flex justify-center pointer-events-none px-16">
          <div className="bg-black/75 backdrop-blur-sm rounded-xl px-5 py-2.5 max-w-3xl text-center">
            {translatedText ? (
              <p className="text-base font-semibold text-purple-200 leading-relaxed">{translatedText}</p>
            ) : (
              <p className="text-sm text-white/50 leading-relaxed italic">{currentSubText}</p>
            )}
          </div>
        </div>
      )}

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
