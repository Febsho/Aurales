import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SubtitleResult } from '../types'
import { formatTime, openRouterChat, shouldMarkWatched } from '../services/player'
import { onSimklPlaybackStart, onSimklPlaybackStop, onSimklPlaybackPause } from '../services/simkl/playback'
import type { PlaybackItem } from '../services/simkl/playback'
import { isAuthenticated as isTraktAuthenticated } from '../services/trakt/auth'
import {
  scrobbleStart as traktScrobbleStart,
  scrobblePause as traktScrobblePause,
  scrobbleStop as traktScrobbleStop,
  buildMovieScrobble,
  buildEpisodeScrobble,
} from '../services/trakt/scrobble'
import { scrobbleMdblist, hasMdblistOAuth, mdblistPlaybackAction } from '../services/mdblist'
import { saveAniListProgressMapped } from '../services/anilist'
import { lookupTmdbId, savePMDBPlaybackProgress, scrobblePMDB } from '../services/pmdb'
import { reportJellyfinPlayback } from '../services/serverIntegrations'
import { fetchNextEpisodeFromTmdb, type NextEpInfo } from '../services/nextEpisode'
import { useAppStore, APP_LANGUAGES, getLanguageCodeFromTrack, getLanguageNameFromTrack } from '../stores/appStore'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import { withRequestTimeout } from '../services/network/timeout'
import { readBoundedResponseText } from '../services/network/boundedResponse'
import {
  play as wtPlay,
  pause as wtPause,
  seek as wtSeek,
  reportLocalPlayback as wtReportLocalPlayback,
  clearLocalPlayback as wtClearLocalPlayback,
  sendBuffering as wtSendBuffering,
} from '../services/watch-together/wsClient'
import { shouldCorrectDrift, markCorrectionApplied, resetDriftState } from '../services/watch-together/driftCorrection'
import PlayerChatOverlay from './watch-together/PlayerChatOverlay'
import { recordPlaybackSample } from '../services/viewingActivity'
import { setRequestPlaybackActive } from '../services/network/requestCoordinator'
import { audioLanguageOrder, selectPreferredLanguageTrack, selectStartupSubtitle } from '../services/player/languagePreferences'
import { subtitleToVtt } from '../services/player/subtitleFormats'
import { getPlatformCapabilities, isDashUrl, isHlsUrl, togglePictureInPicture } from '../platform/capabilities'
import { getHttpText } from '../platform/httpText'
import { AUTOPLAY_GESTURE_MESSAGE, browserPlaybackFailureMessage, isAutoplayGestureError, isMediaSessionExpired, isPlaybackInterruptedError, nextPlaybackConversionAfterDecodeFailure } from '../services/player/browserPlayback'
import { cancelMediaConversion, createMediaSession, getSupportedMediaConversionOutputFormat, getMediaConversionOutputFormat, getMediaConversionStatus, getMediaWorkerCapabilities, getMediaWorkerConfig, MediaWorkerHttpError, startMediaConversion, type MediaConversionMode, type MediaConversionOutputFormat, type PlaybackRequestHeaders, type MediaConversionStatus } from '../services/mediaWorker'
import { buildExternalPlayerUrl, getPreferredExternalPlayer, setPreferredExternalPlayer, type ExternalPlayer } from '../services/player/externalPlayers'
import { createExternalPlaybackReturnUrl } from '../services/player/externalPlaybackReturn'

const MOBILE_MEDIA_STALL_RECOVERY_MS = 15_000

interface InAppPlayerProps {
  url: string
  playbackRequestHeaders?: PlaybackRequestHeaders
  title: string
  subtitle?: string
  subtitles?: SubtitleResult[]
  serverTrackInfo?: {
    provider?: string
    sourceItemId?: string
    mediaSourceId?: string
    audioTracks?: Record<string, unknown>[]
  }
  playbackItem?: PlaybackItem
  startTime?: number
  poster?: string
  backdrop?: string
  onClose: () => void
  onPickAnother: () => void
  onPlaybackError?: (message: string, positionSeconds?: number) => void
  onPlaybackStarted?: () => void
  onReportBad?: () => void
  onNextEpisode?: (season: number, episode: number) => void
  nextEpisodeHint?: { season: number; episode: number }
}

interface AudioTrackInfo {
  id: string
  label: string
  language?: string
  index: number
  sourceIndex?: number
  enabled: boolean
}

interface PreparedSubtitle {
  id: string
  url: string
  lang: string
  label: string
  forced: boolean
}

interface HlsTrackController {
  audioTracks: Array<{ name?: string; lang?: string; language?: string; type?: string }>
  audioTrack: number
  subtitleTracks: Array<{ name?: string; lang?: string; language?: string; type?: string; default?: boolean; forced?: boolean }>
  subtitleTrack: number
  startLoad?: () => void
  stopLoad?: () => void
  recoverMediaError?: () => void
}

const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024
const NO_SUBTITLES: SubtitleResult[] = []
const NO_PLAYBACK_REQUEST_HEADERS: PlaybackRequestHeaders = {}

async function resolvePmdbPlaybackEpisode(item: PlaybackItem): Promise<{ tmdbId?: number; season?: number; episode?: number }> {
  const tmdbId = item.tmdbId
  if (!item.isAnime || item.contentType !== 'series' || item.tvdbId == null || item.season == null || item.episode == null) {
    return { tmdbId, season: item.season, episode: item.episode }
  }

  try {
    const { mapTvdbEpisodeToAnimeProviders, shouldFlattenPmdbAnimeEpisodes } = await import('../services/animeLists')
    const mapped = await mapTvdbEpisodeToAnimeProviders(item.tvdbId, item.season, item.episode)
    if (!mapped?.tmdbId) return { tmdbId, season: item.season, episode: item.episode }
    return await shouldFlattenPmdbAnimeEpisodes(item.tvdbId, mapped.tmdbId)
      ? { tmdbId: mapped.tmdbId, season: 1, episode: mapped.episode }
      : { tmdbId: mapped.tmdbId, season: mapped.season, episode: mapped.episode }
  } catch (_) {
    return { tmdbId, season: item.season, episode: item.episode }
  }
}

async function fetchSubtitleText(url: string, signal?: AbortSignal, headers?: PlaybackRequestHeaders): Promise<string> {
  return getHttpText(url, {
    timeoutMs: 15_000,
    signal,
    headers,
    maxBytes: MAX_SUBTITLE_BYTES,
  })
}

async function loadSubtitleText(url: string, signal?: AbortSignal, headers?: PlaybackRequestHeaders): Promise<string> {
  try {
    return await fetchSubtitleText(url, signal, headers)
  } catch (directError) {
    if (!getMediaWorkerConfig()) throw directError
    const session = await createMediaSession(url, signal, headers)
    return fetchSubtitleText(session.url, signal)
  }
}

async function requestSubtitleTranslation(apiKey: string, model: string, content: string, language: string): Promise<string> {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = normalized.split(/\n{2,}/)
  const cues = blocks.map((block, blockIndex) => {
    const lines = block.split('\n')
    const timelineIndex = lines.findIndex((line) => line.includes('-->'))
    return timelineIndex < 0 ? null : {
      blockIndex,
      lines,
      timelineIndex,
      text: lines.slice(timelineIndex + 1).join('\n').trim(),
    }
  }).filter((cue): cue is NonNullable<typeof cue> => Boolean(cue?.text))

  if (cues.length === 0) throw new Error('No subtitle cues were found in this track')

  for (let offset = 0; offset < cues.length; offset += 30) {
    const batch = cues.slice(offset, offset + 30)
    const requestBody = {
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `Translate subtitle dialogue into natural ${language}. Return only a valid JSON array of translated strings in the same order and with exactly the same number of items. Preserve line breaks and simple formatting tags. Do not include timestamps, explanations, or markdown fences.`,
        },
        { role: 'user', content: JSON.stringify(batch.map((cue) => cue.text)) },
      ],
    }

    let raw: string
    if ((window as any).__TAURI_INTERNALS__) {
      raw = await openRouterChat(apiKey, requestBody)
    } else {
      raw = await withRequestTimeout(30_000, async (signal) => {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'Aurales Media Player' },
          body: JSON.stringify(requestBody),
          signal,
        })
        if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`)
        return readBoundedResponseText(response, 16 * 1024 * 1024, 'OpenRouter response')
      }, 'Subtitle translation request timed out')
    }

    const payload = JSON.parse(raw)
    const answer = String(payload.choices?.[0]?.message?.content || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
    const arrayStart = answer.indexOf('[')
    const arrayEnd = answer.lastIndexOf(']')
    const translated = JSON.parse(arrayStart >= 0 && arrayEnd > arrayStart ? answer.slice(arrayStart, arrayEnd + 1) : answer)
    if (!Array.isArray(translated) || translated.length !== batch.length || translated.some((item) => typeof item !== 'string')) {
      throw new Error('The translation model returned an invalid subtitle batch')
    }

    batch.forEach((cue, index) => {
      blocks[cue.blockIndex] = [...cue.lines.slice(0, cue.timelineIndex + 1), translated[index]].join('\n')
    })
  }

  return blocks.join('\n\n')
}

export default function InAppPlayer({ url, playbackRequestHeaders = NO_PLAYBACK_REQUEST_HEADERS, title, subtitle, subtitles = NO_SUBTITLES, serverTrackInfo, playbackItem, startTime, poster, backdrop, onClose, onPickAnother, onPlaybackError, onPlaybackStarted, onNextEpisode, nextEpisodeHint }: InAppPlayerProps) {
  useEffect(() => {
    setRequestPlaybackActive(true)
    return () => setRequestPlaybackActive(false)
  }, [])
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerShellRef = useRef<HTMLDivElement>(null)
  const hlsTracksRef = useRef<HlsTrackController | null>(null)
  const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<Array<{ label: string; language?: string; index: number }>>([])
  const [nativeSubtitleTracks, setNativeSubtitleTracks] = useState<Array<{ label: string; language?: string; index: number }>>([])
  const [playerNotice, setPlayerNotice] = useState('')
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobileStallRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobileStallRecoveryInFlightRef = useRef(false)
  const lastSavedTimeRef = useRef(0)
  const lastAniListPlaybackSaveRef = useRef(0)
  const lastPmdbPlaybackSaveRef = useRef(0)
  const playbackStartedRef = useRef(false)
  const lastJellyfinReportAtRef = useRef(0)
  const bufferingRef = useRef(true)
  const autoplayBlockedRef = useRef(false)
  const playbackRunRef = useRef(0)
  const translatedSubtitleUrlsRef = useRef<Set<string>>(new Set())
  const mediaProxyAttemptedRef = useRef(false)
  const mediaProxyResumeRef = useRef<number | null>(null)
  const trackSwitchResumeRef = useRef<{ time: number; shouldResume: boolean } | null>(null)
  const mediaProxySessionRef = useRef<{ url: string; expiresAt: number } | null>(null)
  const renewedMediaProxyUrlRef = useRef<string | null>(null)
  const conversionModesTriedRef = useRef<MediaConversionMode[]>([])
  const conversionSequenceRunRef = useRef<number | null>(null)
  const conversionControllerRef = useRef<AbortController | null>(null)
  const workerConversionActiveRef = useRef(false)
  const workerNetworkRetryAttemptedRef = useRef(false)
  const workerPlaybackResumeRef = useRef(false)
  const workerLiveSnapshotRef = useRef(false)
  const workerLiveSnapshotActiveRef = useRef(false)
  const lastWorkerConversionModeRef = useRef<Exclude<MediaConversionMode, 'auto'> | null>(null)
  const workerPlaybackDescriptionRef = useRef<string | null>(null)
  const conversionOptionsCheckedRef = useRef(false)
  const conversionOutputFormatRef = useRef<MediaConversionOutputFormat | null>(null)
  const workerConversionTimeoutMsRef = useRef(2 * 60 * 60 * 1000)
  const requestWorkerConversionRef = useRef<((video: HTMLVideoElement, canPlayHls?: boolean) => boolean) | null>(null)
  const retryWorkerConversionRef = useRef<((video: HTMLVideoElement) => boolean) | null>(null)
  const [paused, setPaused] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [error, setError] = useState('')
  const [liveSnapshotEnded, setLiveSnapshotEnded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [externalPlayerMenuOpen, setExternalPlayerMenuOpen] = useState(false)
  const [preferredExternalPlayer, setPreferredExternalPlayerState] = useState<ExternalPlayer | null>(() => getPreferredExternalPlayer())
  const isAndroidDevice = /Android/i.test(navigator.userAgent)
  const externalPlayerName = (player: ExternalPlayer) => ({ infuse: 'Infuse', aether: 'Aether', nextplayer: 'Next Player', mxplayer: 'MX Player', justplayer: 'Just Player', vlc: 'VLC' })[player]
  const [nextEpisode, setNextEpisode] = useState<NextEpInfo | null>(null)
  const [selectedSubtitle, setSelectedSubtitle] = useState('off')
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([])
  const [selectedAudio, setSelectedAudio] = useState('0')
  const userSelectedAudioRef = useRef(false)
  const [audioMenuOpen, setAudioMenuOpen] = useState(false)
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false)
  const [preparedSubtitles, setPreparedSubtitles] = useState<PreparedSubtitle[]>([])
  const [conversionModes, setConversionModes] = useState<MediaConversionMode[]>([])
  const conversionModesRef = useRef<MediaConversionMode[]>([])
  const convertWithWorkerRef = useRef<(mode: MediaConversionMode) => Promise<boolean>>(async () => false)
  const updateConversionModes = useCallback((modes: MediaConversionMode[]) => {
    conversionModesRef.current = modes
    setConversionModes(modes)
  }, [])
  const [conversionMessage, setConversionMessage] = useState('')
  const [conversionBusy, setConversionBusy] = useState(false)
  const [headerSessionUrl, setHeaderSessionUrl] = useState<string | null>(null)
  const [workerPlaybackUrl, setWorkerPlaybackUrl] = useState<string | null>(null)
  const needsHeaderProxy = Object.keys(playbackRequestHeaders).length > 0
  const playbackSourceUrl = workerPlaybackUrl || (needsHeaderProxy ? headerSessionUrl : url)
  const openExternalPlayer = (player: ExternalPlayer) => {
    let targetUrl = playbackSourceUrl || url
    if (targetUrl.startsWith('/')) {
      const workerConfig = getMediaWorkerConfig()
      if (workerConfig) {
        try { targetUrl = new URL(targetUrl, workerConfig.baseUrl).toString() } catch { /* The launcher reports invalid URLs below. */ }
      }
    }
    const video = videoRef.current
    const position = video?.currentTime ?? startTime ?? 0
    const actualDuration = video?.duration || duration
    let successUrl: string | undefined
    if (playbackItem && !workerLiveSnapshotActiveRef.current) {
      const progressId = playbackItem.season != null && playbackItem.episode != null
        ? `${playbackItem.localId}:${playbackItem.season}:${playbackItem.episode}`
        : playbackItem.localId
      successUrl = createExternalPlaybackReturnUrl({
        progress: {
          id: progressId,
          mediaType: playbackItem.contentType === 'series' ? (playbackItem.mediaType === 'anime' ? 'anime' : 'series') : 'movie',
          mediaId: playbackItem.localId,
          title: playbackItem.title,
          poster,
          backdrop,
          season: playbackItem.season,
          episode: playbackItem.episode,
          progressSeconds: Math.floor(position),
          durationSeconds: Math.floor(actualDuration),
          completed: actualDuration > 0 && position / actualDuration >= 0.8,
          updatedAt: new Date().toISOString(),
          imdbId: playbackItem.imdbId,
          tmdbId: playbackItem.tmdbId,
          malId: playbackItem.malId,
          anilistId: playbackItem.anilistId,
        },
        activity: {
          mediaKey: playbackItem.localId,
          title: playbackItem.title,
          mediaType: playbackItem.mediaType === 'anime' ? 'anime' : playbackItem.contentType === 'movie' ? 'movie' : 'series',
          poster,
          tmdbId: playbackItem.tmdbId,
          season: playbackItem.season,
          episode: playbackItem.episode,
        },
      }) || undefined
    }
    const deepLink = buildExternalPlayerUrl(player, targetUrl, {
      filename: title,
      title,
      subtitleUrl: subtitles.find((track) => /^https?:\/\//i.test(track.url))?.url,
      position,
      successUrl,
    })
    if (!deepLink) {
      setPlayerNotice('The external player needs a playable HTTP(S) video URL.')
      return
    }
    setPreferredExternalPlayer(player)
    setPreferredExternalPlayerState(player)
    setExternalPlayerMenuOpen(false)
    window.location.href = deepLink
  }
  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    setHeaderSessionUrl(null)
    if (!needsHeaderProxy) return
    setLoading(true)
    setPlayerNotice('Opening a private, session-bound stream connection for this add-on source…')
    void createMediaSession(url, controller.signal, playbackRequestHeaders).then((session) => {
      if (disposed) return
      mediaProxySessionRef.current = session
      setHeaderSessionUrl(session.url)
    }).catch(() => {
      if (disposed) return
      const video = videoRef.current
      if (video && requestWorkerConversionRef.current?.(video)) return
      const message = 'The add-on stream requires provider headers, but its worker session could not be opened. Check the source access or choose another stream.'
      setLoading(false)
      setError(message)
      playbackStartupRef.current.onPlaybackError?.(message, 0)
    })
    return () => { disposed = true; controller.abort() }
  }, [url, needsHeaderProxy, playbackRequestHeaders])
  useEffect(() => {
    if (mobileStallRecoveryTimerRef.current) clearTimeout(mobileStallRecoveryTimerRef.current)
    mobileStallRecoveryTimerRef.current = null
    mobileStallRecoveryInFlightRef.current = false
    workerPlaybackDescriptionRef.current = null
    setWorkerPlaybackUrl(null)
    workerConversionActiveRef.current = false
    workerNetworkRetryAttemptedRef.current = false
    workerPlaybackResumeRef.current = false
    workerLiveSnapshotRef.current = false
    workerLiveSnapshotActiveRef.current = false
    setLiveSnapshotEnded(false)
    lastWorkerConversionModeRef.current = null
    updateConversionModes([])
    setConversionMessage('')
    setConversionBusy(false)
    conversionModesTriedRef.current = []
    conversionSequenceRunRef.current = null
    conversionOptionsCheckedRef.current = false
    conversionOutputFormatRef.current = null
    workerConversionTimeoutMsRef.current = 2 * 60 * 60 * 1000
    userSelectedAudioRef.current = false
    setSelectedAudio('0')
    setPreparedSubtitles((current) => current.filter((track) => !track.id.startsWith('worker:')))
    conversionControllerRef.current?.abort()
    conversionControllerRef.current = null
  }, [updateConversionModes, url])

  useEffect(() => () => {
    if (mobileStallRecoveryTimerRef.current) clearTimeout(mobileStallRecoveryTimerRef.current)
  }, [])

  // HLS.js is loaded only for browsers that need Media Source Extensions.
  // Safari/iOS uses its native HLS implementation, which has stricter gesture
  // and autoplay policies. Direct non-HLS URLs remain on the native video path.
  useEffect(() => {
    const video = videoRef.current
    setHlsSubtitleTracks([])
    setError('')
    if (!video) return
    if (needsHeaderProxy && !playbackSourceUrl) return
    const sourceUrl = playbackSourceUrl || url
    if (video.dataset.auralesSourceUrl !== url) {
      video.dataset.auralesSourceUrl = url
      mediaProxyAttemptedRef.current = false
      mediaProxyResumeRef.current = null
      mediaProxySessionRef.current = null
      renewedMediaProxyUrlRef.current = null
      video.removeAttribute('src')
      video.load()
    }
    if (!workerPlaybackUrl && (isDashUrl(sourceUrl) || isDashUrl(url)) && video.canPlayType('application/dash+xml') === '') {
      if (getPlatformCapabilities(video).platform === 'web' && requestWorkerConversionRef.current?.(video)) {
        return
      }
    }
    if (!isHlsUrl(sourceUrl)) {
      video.src = sourceUrl
      video.load()
      setPlayerNotice(sourceUrl === url
        ? 'Direct Play. Codec compatibility depends on this browser, device, and source.'
        : 'Direct Play through a private media-worker session. Codec compatibility depends on this browser and device.')
      return
    }
    let disposed = false
    let hls: { destroy: () => void } | undefined
    let networkRecoveryAttempted = false
    let mediaRecoveryAttempted = false
    const capabilities = getPlatformCapabilities(video)
    if (capabilities.nativeHls) {
      video.src = sourceUrl
      setPlayerNotice(workerPlaybackDescriptionRef.current || 'Using native HLS playback. Available audio and subtitle tracks depend on this browser and stream.')
      return () => { video.removeAttribute('src'); video.load() }
    }
    if (!capabilities.mediaSource) {
      if (!requestWorkerConversionRef.current?.(video, capabilities.nativeHls)) {
        setPlayerNotice('This browser does not support HLS playback. Try a direct MP4/WebM stream or configure the Aurales media worker to prepare an MP4 copy.')
      }
      return
    }
    void import('hls.js').then(({ default: Hls }) => {
      if (disposed) return
      if (!Hls.isSupported()) {
        if (!requestWorkerConversionRef.current?.(video, capabilities.nativeHls)) {
          setPlayerNotice('HLS playback is unavailable in this browser. Configure the Aurales media worker to prepare an MP4 copy, or try another stream.')
        }
        return
      }
      const mobileBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent))
      const instance = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        ...(mobileBrowser ? {
          backBufferLength: 30,
          maxMaxBufferLength: 60,
          capLevelToPlayerSize: true,
        } : {}),
      })
      hls = instance
      hlsTracksRef.current = instance as unknown as HlsTrackController
      instance.loadSource(sourceUrl)
      instance.attachMedia(video)
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        const tracks = instance.audioTracks
        const { preferredAudio = ['en', 'ja'], animeAudioMode } = useAppStore.getState()
        const languageOrder = audioLanguageOrder(preferredAudio, Boolean(playbackItem?.isAnime), animeAudioMode)
        const preferred = selectPreferredLanguageTrack(
          tracks.map((track, index) => ({ lang: track.lang, index })),
          languageOrder,
          getLanguageCodeFromTrack,
        )?.index
        if (!userSelectedAudioRef.current && preferred != null) instance.audioTrack = preferred
        const current = instance.audioTrack >= 0 ? instance.audioTrack : 0
        setAudioTracks(tracks.map((track, index) => ({
          id: String(index),
          label: track.name || getLanguageNameFromTrack(track.lang) || `Audio ${index + 1}`,
          language: track.lang,
          index,
          enabled: index === current,
        })))
        setSelectedAudio(String(current >= 0 ? current : 0))
        const subtitleTracks = instance.subtitleTracks
        const audioLanguage = tracks[instance.audioTrack]?.lang
        const preferredSubtitle = selectStartupSubtitle({
          tracks: subtitleTracks.map((track, index) => ({
            id: `hls:${index}`,
            label: track.name || getLanguageNameFromTrack(track.lang) || `Subtitle ${index + 1}`,
            lang: track.lang || '',
            forced: Boolean(track.forced),
            index,
          })),
          preferred: useAppStore.getState().preferredSubtitles || ['en'],
          selectedAudioLanguage: audioLanguage,
          mode: useAppStore.getState().subtitleMode,
          preferSdh: useAppStore.getState().preferSdhSubtitles,
          normalize: getLanguageCodeFromTrack,
        })
        setHlsSubtitleTracks(subtitleTracks.map((track, index) => ({
          index,
          label: track.name || getLanguageNameFromTrack(track.lang) || `Subtitle ${index + 1}`,
          language: track.lang,
        })))
        if (preferredSubtitle.kind === 'track') {
          instance.subtitleTrack = preferredSubtitle.track.index
          setSelectedSubtitle(`hls:${preferredSubtitle.track.index}`)
        } else if (preferredSubtitle.kind === 'off') {
          instance.subtitleTrack = -1
          setSelectedSubtitle('off')
        }
        setPlayerNotice(workerPlaybackDescriptionRef.current || 'Available HLS audio and subtitle tracks depend on the stream and browser. External subtitles remain available when supplied by the source.')
      })
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        const controller = instance as unknown as HlsTrackController
        const activeProxySession = mediaProxySessionRef.current
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR
          && activeProxySession
          && isMediaSessionExpired(activeProxySession.expiresAt)
          && renewedMediaProxyUrlRef.current !== activeProxySession.url) {
          renewedMediaProxyUrlRef.current = activeProxySession.url
          mediaProxyResumeRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0
          setLoading(true)
          setPlayerNotice('The media worker session expired. Renewing the playback link…')
          void createMediaSession(url, undefined, playbackRequestHeaders).then((session) => {
            if (disposed) return
            mediaProxySessionRef.current = session
            instance.loadSource(session.url)
          }).catch(() => {
            const message = 'The media worker playback session expired and could not be renewed. Pick this stream again to refresh its source URL.'
            setLoading(false)
            setError(message)
            playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
          })
          return
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (!networkRecoveryAttempted) {
            networkRecoveryAttempted = true
            setLoading(true)
            setPlayerNotice('The HLS connection stalled. Retrying the stream once…')
            controller.startLoad?.()
            return
          }
          setError('The HLS stream or its segments could not be loaded. The source may block browser CORS requests or its session may have expired.')
          if (workerConversionActiveRef.current) {
            controller.stopLoad?.()
            if (retryWorkerConversionRef.current?.(video)) return
            const message = 'The worker-prepared HLS stream could not be reconnected after one rebuild.'
            setLoading(false)
            setError(message)
            if (workerLiveSnapshotActiveRef.current) setLiveSnapshotEnded(true)
            else playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
            return
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (workerConversionActiveRef.current) {
            const lastMode = lastWorkerConversionModeRef.current
            const nextMode = lastMode ? nextPlaybackConversionAfterDecodeFailure(lastMode) : null
            if (nextMode && conversionModesRef.current.includes(nextMode) && !conversionModesTriedRef.current.includes(nextMode)) {
              setLoading(true)
              setPlayerNotice(nextMode === 'audioAac'
                ? 'The browser rejected the remuxed HLS stream. Trying AAC audio while keeping the video unchanged…'
                : nextMode === 'h264AacLow'
                  ? 'The browser rejected standard H.264. Trying a smaller 720p/30 H.264 stream…'
                  : nextMode === 'h264AacCompat'
                    ? 'The browser rejected 720p H.264. Trying 480p/30 Baseline H.264…'
                  : 'Audio-only HLS conversion was not enough. Trying H.264/AAC video encoding now…')
              void convertWithWorkerFallback(nextMode)
              return
            }
            setError('The browser could not decode the converted HLS stream after the available strategies. This codec or profile may not be supported on this browser and device.')
            setLoading(false)
            return
          }
          if (!mediaRecoveryAttempted) {
            mediaRecoveryAttempted = true
            setLoading(true)
            setPlayerNotice('The browser decoder stalled. Recovering the HLS media pipeline once…')
            controller.recoverMediaError?.()
            return
          }
          if (getMediaWorkerConfig()) {
            requestWorkerConversionRef.current?.(video)
            return
          }
          setError('The browser could not decode this HLS audio/video format. Try another stream.')
        } else {
          setError('HLS playback failed. Try another stream.')
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !mediaProxyAttemptedRef.current) {
          mediaProxyAttemptedRef.current = true
          mediaProxyResumeRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0
          setLoading(true)
          setPlayerNotice('The HLS source is blocked in this browser. Retrying through your configured Aurales media worker…')
          void createMediaSession(url, undefined, playbackRequestHeaders).then((session) => {
            if (disposed) return
            mediaProxySessionRef.current = session
            instance.loadSource(session.url)
          }).catch(() => {
            if (getMediaWorkerConfig()) {
              requestWorkerConversionRef.current?.(video)
              return
            }
            const message = 'The HLS playlist or one of its segments could not be loaded directly or through the media worker.'
            setLoading(false)
            setError(message)
            playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
          })
          return
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && getMediaWorkerConfig()) {
          requestWorkerConversionRef.current?.(video)
          return
        }
        setLoading(false)
        const message = data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? 'The HLS stream could not be loaded after one retry. The source may block browser CORS requests or its session may have expired.'
          : data.type === Hls.ErrorTypes.MEDIA_ERROR
            ? 'The browser could not decode this HLS audio/video format after recovery. Try another stream.'
            : 'HLS playback failed. Try another stream.'
        playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
      })
    }).catch(() => {
      if (disposed) return
      if (!requestWorkerConversionRef.current?.(video, capabilities.nativeHls)) {
        setPlayerNotice('The HLS playback module could not be loaded. Configure the Aurales media worker to prepare an MP4 copy, or try another stream.')
      }
    })
    return () => {
      disposed = true
      hls?.destroy()
      hlsTracksRef.current = null
      video.removeAttribute('src')
      video.load()
    }
  }, [url, playbackSourceUrl, workerPlaybackUrl, needsHeaderProxy, playbackRequestHeaders, playbackItem?.isAnime])
  const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const changePlaybackSpeed = (speed: number) => {
    setPlaybackSpeed(speed)
    setShowSpeedMenu(false)
    if (videoRef.current) videoRef.current.playbackRate = speed
  }

  const scrobbleSimkl = useAppStore((s) => s.scrobbleSimkl)
  const scrobbleTrakt = useAppStore((s) => s.scrobbleTrakt)
  const scrobblePmdb = useAppStore((s) => s.scrobblePmdb)
  const scrobbleMdblistEnabled = useAppStore((s) => s.scrobbleMdblist)
  const scrobbleAnilist = useAppStore((s) => s.scrobbleAnilist)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const pmdbSaveResumePosition = useAppStore((s) => s.pmdbSaveResumePosition)
  const mdblistSaveResumePosition = useAppStore((s) => s.mdblistSaveResumePosition)
  const isInWatchTogether = useWatchTogetherStore((s) => !!s.currentRoom)
  const canSkipEpisode = Boolean(onNextEpisode)
  const nextEpisodeHintSeason = nextEpisodeHint?.season
  const nextEpisodeHintEpisode = nextEpisodeHint?.episode

  useEffect(() => {
    if (!canSkipEpisode || playbackItem?.contentType !== 'series' || playbackItem.season == null || playbackItem.episode == null) return
    let cancelled = false
    const hintedEpisode = nextEpisodeHintEpisode == null
      ? null
      : { season: nextEpisodeHintSeason!, episode: nextEpisodeHintEpisode, title: `Episode ${nextEpisodeHintEpisode}` }
    setNextEpisode(hintedEpisode)
    void (async () => {
      let tmdbId = playbackItem.tmdbId
      if (!tmdbId && playbackItem.imdbId) {
        try { tmdbId = (await lookupTmdbId('imdb', playbackItem.imdbId))?.tmdbId } catch (_) { /* No verified next episode. */ }
      }
      if (!tmdbId || cancelled) return
      const next = await fetchNextEpisodeFromTmdb(tmdbId, playbackItem.season!, playbackItem.episode! + 1)
      if (!cancelled) setNextEpisode(next || hintedEpisode)
    })()
    return () => { cancelled = true }
  }, [canSkipEpisode, playbackItem?.tmdbId, playbackItem?.imdbId, playbackItem?.contentType, playbackItem?.season, playbackItem?.episode, nextEpisodeHintSeason, nextEpisodeHintEpisode])

  // This player is portaled next to #root. Hide the application shell while it
  // is active so top navigation, search affordances, and window-level controls
  // cannot render above the fallback player on systems without X11/XWayland.
  useLayoutEffect(() => {
    const root = document.getElementById('root')
    document.documentElement.classList.add('full-player-active')
    if (root) {
      root.style.visibility = 'hidden'
      root.style.pointerEvents = 'none'
    }
    return () => {
      document.documentElement.classList.remove('full-player-active')
      if (root) {
        root.style.visibility = ''
        root.style.pointerEvents = ''
      }
    }
  }, [])

  const [showTranslateModal, setShowTranslateModal] = useState(false)
  const [translatingSub, setTranslatingSub] = useState(false)
  const [translationError, setTranslationError] = useState('')

  const openrouterApiKey = useAppStore((s) => s.openrouterApiKey)
  const openrouterModel = useAppStore((s) => s.openrouterModel)

  const sendMdblistScrobble = (action: 'start' | 'pause' | 'stop', progress: number) => {
    if (!playbackItem || !mdblistApiKey) return
    const progressPct = Math.round(progress * 10000) / 100
    const effectiveAction = mdblistPlaybackAction(action, progressPct, scrobbleMdblistEnabled, mdblistSaveResumePosition)
    if (!effectiveAction) return
    scrobbleMdblist(
      effectiveAction,
      playbackItem.tmdbId,
      playbackItem.contentType === 'movie' ? 'movie' : 'series',
      progressPct,
      playbackItem.season,
      playbackItem.episode,
      playbackItem.imdbId,
      playbackItem.tvdbId
    ).then(() => {
      if (scrobbleMdblistEnabled && !mdblistSaveResumePosition && progressPct < 80 && action !== 'start') {
        return scrobbleMdblist('clear', playbackItem.tmdbId,
          playbackItem.contentType === 'movie' ? 'movie' : 'series', progressPct,
          playbackItem.season, playbackItem.episode, playbackItem.imdbId, playbackItem.tvdbId)
      }
    }).catch(() => {})
  }

  // Playback startup is keyed only by URL so changing provider preferences or
  // callbacks does not reload the video. Keep those inputs fresh for delayed
  // play/error handlers instead of closing over the first render.
  const playbackStartupRef = useRef({
    playbackItem,
    startTime,
    volume,
    scrobbleSimkl,
    scrobbleTrakt,
    onPlaybackError,
    sendMdblistScrobble,
  })
  playbackStartupRef.current = {
    playbackItem,
    startTime,
    volume,
    scrobbleSimkl,
    scrobbleTrakt,
    onPlaybackError,
    sendMdblistScrobble,
  }

  const saveAniListScrobble = (progress: number) => {
    if (!playbackItem || !scrobbleAnilist || !playbackItem.isAnime) return
    saveAniListProgressMapped(playbackItem, progress).catch(() => {})
  }

  // The primary progress provider controls the UI source only. Every enabled
  // account keeps receiving playback state, including PMDB in the WebView
  // fallback player (which previously lagged behind the native player).
  const syncPmdbPlayback = (time: number, dur: number, allowScrobble = false) => {
    if (!playbackItem || !pmdbApiKey || dur <= 0) return
    const progress = time / dur
    const mediaType = playbackItem.contentType === 'series' ? 'tv' : 'movie'
    resolvePmdbPlaybackEpisode(playbackItem).then((target) => {
      if (allowScrobble && scrobblePmdb && target.tmdbId && progress >= 0.9 && dur >= 180) {
        return scrobblePMDB(target.tmdbId, mediaType, target.season, target.episode)
      }
      if (pmdbSaveResumePosition) {
        return savePMDBPlaybackProgress(
          target.tmdbId,
          mediaType,
          target.season,
          target.episode,
          Math.floor(time * 1000),
          Math.floor(dur * 1000),
          playbackItem.imdbId,
        ).then(() => undefined)
      }
    }).catch(() => {})
  }

  const handleTranslateSubtitle = async (langCode: string, langName: string) => {
    const playbackRun = playbackRunRef.current
    const isCurrentRun = () => playbackRun === playbackRunRef.current
    if (selectedSubtitle === 'off') return
    const trackIdx = Number(selectedSubtitle.startsWith('external:') ? selectedSubtitle.slice('external:'.length) : selectedSubtitle)
    const track = preparedSubtitles[trackIdx]
    if (!track) return

    setTranslatingSub(true)
    setTranslationError('')
    updateConversionModes([])
    setConversionMessage('')
    setConversionBusy(false)
    conversionModesTriedRef.current = []
    conversionOptionsCheckedRef.current = false
    conversionOutputFormatRef.current = null
    conversionControllerRef.current?.abort()
    conversionControllerRef.current = null
    try {
      const text = await loadSubtitleText(track.url, undefined, playbackRequestHeaders)
      if (!isCurrentRun()) return

      const translatedText = await requestSubtitleTranslation(
        openrouterApiKey,
        openrouterModel || 'google/gemini-2.5-flash',
        text,
        langName,
      )
      if (!isCurrentRun()) return

      const blob = new Blob([subtitleToVtt(translatedText)], { type: 'text/vtt' })
      const objectUrl = URL.createObjectURL(blob)
      translatedSubtitleUrlsRef.current.add(objectUrl)

      const newTrack: PreparedSubtitle = {
        id: `ai-translated-${langCode}-${Date.now()}`,
        url: objectUrl,
        lang: langCode,
        forced: false,
        label: `✨ AI Translated (${langName})`
      }

      const newIndex = preparedSubtitles.length
      setPreparedSubtitles((prev) => [...prev, newTrack])
      setSelectedSubtitle(`external:${newIndex}`)

      if (videoRef.current) {
        const video = videoRef.current
        setTimeout(() => {
          if (!isCurrentRun()) return
          Array.from(video.textTracks).forEach((t, idx) => {
            t.mode = idx === newIndex ? 'showing' : 'disabled'
          })
        }, 100)
      }

      setShowTranslateModal(false)
    } catch (err: any) {
      if (!isCurrentRun()) return
      console.error('AI Subtitle Translation error:', err)
      setTranslationError(err?.message || 'Translation failed')
    } finally {
      if (isCurrentRun()) setTranslatingSub(false)
    }
  }

  const reportJellyfinEvent = (event: 'start' | 'progress' | 'pause' | 'unpause' | 'stop', time: number, dur: number, isPaused: boolean) => {
    if (!playbackItem?.serverConnectionId || !playbackItem.serverItemId || !playbackItem.serverPlaySessionId) return
    if (event !== 'start' && !playbackStartedRef.current) return
    const now = Date.now()
    if (event === 'progress' && now - lastJellyfinReportAtRef.current < 10_000) return
    lastJellyfinReportAtRef.current = now
    void reportJellyfinPlayback({
      connectionId: playbackItem.serverConnectionId,
      itemId: playbackItem.serverItemId,
      mediaSourceId: playbackItem.serverMediaSourceId,
      playSessionId: playbackItem.serverPlaySessionId,
      positionTicks: Math.max(0, Math.round(time * 10_000_000)),
      runtimeTicks: dur > 0 ? Math.round(dur * 10_000_000) : undefined,
      event, isPaused,
      playMethod: playbackItem.serverPlayMethod || 'DirectPlay',
    }).catch(() => undefined)
  }

  const saveLocalProgress = (time: number, dur: number, completedFlag: boolean) => {
    if (!playbackItem) return
    reportJellyfinEvent('progress', time, dur, false)
    const key = playbackItem.season != null && playbackItem.episode != null
      ? `${playbackItem.localId}:${playbackItem.season}:${playbackItem.episode}`
      : playbackItem.localId

    const progressPct = dur > 0 ? (time / dur) * 100 : 0
    const isCompleted = completedFlag || shouldMarkWatched(progressPct)

    useAppStore.getState().setWatchProgress(key, {
      id: key,
      mediaType: playbackItem.contentType === 'series' ? (playbackItem.mediaType === 'anime' ? 'anime' : 'series') : 'movie',
      mediaId: playbackItem.localId,
      title: playbackItem.title,
      poster,
      backdrop,
      season: playbackItem.season,
      episode: playbackItem.episode,
      progressSeconds: Math.floor(time),
      durationSeconds: Math.floor(dur),
      completed: isCompleted,
      updatedAt: new Date().toISOString(),
      imdbId: playbackItem.imdbId,
      tmdbId: playbackItem.tmdbId,
      malId: playbackItem.malId,
      anilistId: playbackItem.anilistId,
    })
  }

  const showControlsTemporarily = () => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    const touchDevice = window.matchMedia('(pointer: coarse)').matches
    hideTimerRef.current = setTimeout(() => {
      const video = videoRef.current
      // Keep the full control deck available while paused, stalled, or before
      // the first decoded frame. On touch devices this is also the recovery
      // path when a stream never reaches playable state.
      if (!video || video.paused || bufferingRef.current || !playbackStartedRef.current) {
        setControlsVisible(true)
        return
      }
      setControlsVisible(false)
    }, touchDevice ? 7000 : 2600)
  }

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === playerShellRef.current)
    const video = videoRef.current as (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) | null
    const syncNativeFullscreen = () => setIsFullscreen(Boolean(video?.webkitDisplayingFullscreen))
    document.addEventListener('fullscreenchange', syncFullscreen)
    video?.addEventListener('webkitbeginfullscreen', syncNativeFullscreen)
    video?.addEventListener('webkitendfullscreen', syncNativeFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      video?.removeEventListener('webkitbeginfullscreen', syncNativeFullscreen)
      video?.removeEventListener('webkitendfullscreen', syncNativeFullscreen)
    }
  }, [])

  // Open the run before passive source effects can request a worker conversion.
  useLayoutEffect(() => {
    playbackRunRef.current += 1
    const playbackRun = playbackRunRef.current
    return () => {
      if (playbackRunRef.current === playbackRun) playbackRunRef.current += 1
    }
  }, [url])

  useEffect(() => {
    showControlsTemporarily()
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const translatedSubtitleUrls = translatedSubtitleUrlsRef.current
    const playbackRun = playbackRunRef.current
    const isCurrentRun = () => playbackRun === playbackRunRef.current
    setLoading(true)
    setError('')
    setTranslatingSub(false)
    setTranslationError('')
    setPaused(false)
    playbackStartedRef.current = false
    bufferingRef.current = true
    autoplayBlockedRef.current = false
    lastAniListPlaybackSaveRef.current = 0
    lastPmdbPlaybackSaveRef.current = 0
    video.volume = playbackStartupRef.current.volume
    video.muted = false
    video.load()
    const playTimer = setTimeout(() => {
      if (!isCurrentRun()) return
      video.play().then(() => {
        if (!isCurrentRun()) return
        const startup = playbackStartupRef.current
        setPaused(false)
        if (startup.startTime && startup.startTime > 0) {
          video.currentTime = startup.startTime
        }
        if (startup.playbackItem) {
          const startProgress = startup.startTime && video.duration > 0 ? startup.startTime / video.duration : 0
          if (startup.scrobbleSimkl) {
            onSimklPlaybackStart(startup.playbackItem, startProgress).catch(() => {})
          }
          if (startup.scrobbleTrakt && isTraktAuthenticated() && startup.playbackItem.imdbId) {
            const startProgressPct = Math.round(startProgress * 10000) / 100
            const traktPayload = startup.playbackItem.contentType === 'series' && startup.playbackItem.season != null && startup.playbackItem.episode != null
              ? buildEpisodeScrobble(startup.playbackItem.imdbId, startup.playbackItem.season, startup.playbackItem.episode, startProgressPct)
              : buildMovieScrobble(startup.playbackItem.imdbId, startProgressPct)
            traktScrobbleStart(traktPayload).catch(() => {})
          }
          startup.sendMdblistScrobble('start', startProgress)
        }
      }).catch((error: unknown) => {
        // The user can start playback while the initial autoplay request is
        // still pending. Ignore a late rejection once the video has produced
        // a frame; it belongs to the superseded play attempt, not this session.
        if (!isCurrentRun() || playbackStartedRef.current || !video.paused || isPlaybackInterruptedError(error)) return
        if (isAutoplayGestureError(error)) {
          autoplayBlockedRef.current = true
          setLoading(false)
          setPaused(true)
          setPlayerNotice(AUTOPLAY_GESTURE_MESSAGE)
          showControlsTemporarily()
          return
        }
        if (getPlatformCapabilities(video).platform === 'web'
          && getMediaWorkerConfig()
          && requestWorkerConversionRef.current?.(video)) {
          return
        }
        const message = 'The browser could not start this stream. Check that the source URL is still valid, then choose another source if playback does not begin.'
        setPaused(true)
        setError(message)
        showControlsTemporarily()
        playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
      })
    }, 50)
    const startupTimer = setTimeout(() => {
      if (!isCurrentRun() || playbackStartedRef.current || autoplayBlockedRef.current) return
      if (getPlatformCapabilities(video).platform === 'web'
        && getMediaWorkerConfig()
        && requestWorkerConversionRef.current?.(video)) {
        return
      }
      const message = 'No playable video frame arrived. Aurales is trying another source…'
      setLoading(false)
      setPaused(true)
      setError(message)
      showControlsTemporarily()
      playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
    }, 15_000)
    return () => {
      // The URL-scoped layout effect invalidates this generation before the
      // next passive source effect starts.
      clearTimeout(playTimer)
      clearTimeout(startupTimer)
      conversionControllerRef.current?.abort()
      for (const objectUrl of translatedSubtitleUrls) URL.revokeObjectURL(objectUrl)
      translatedSubtitleUrls.clear()
    }
  }, [url])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const objectUrls: string[] = []
    const prepared = new Array<PreparedSubtitle>(subtitles.length)
    let cursor = 0
    const loadWorker = async () => {
      while (!cancelled) {
        const index = cursor++
        if (index >= subtitles.length) return
        const track = subtitles[index]
      const fallback = {
        id: track.id || `sub-${index}`,
        url: track.url,
        lang: track.lang || 'und',
        label: `${track.label || getLanguageNameFromTrack(track.lang)} · ${track.source === 'addon' ? (track.addonName || 'Addon') : 'Stream'}`,
        forced: /\bforced\b/i.test(track.label || ''),
      }

      try {
        const text = await loadSubtitleText(track.url, controller.signal, playbackRequestHeaders)
        if (cancelled) {
          prepared[index] = fallback
          continue
        }
        const blob = new Blob([subtitleToVtt(text)], { type: 'text/vtt' })
        const objectUrl = URL.createObjectURL(blob)
        objectUrls.push(objectUrl)
        prepared[index] = { ...fallback, url: objectUrl }
      } catch (_) {
        prepared[index] = { ...fallback, label: `${fallback.label} · unavailable in browser` }
      }
      }
    }

    void Promise.all(Array.from({ length: Math.min(4, subtitles.length) }, loadWorker)).then(() => {
      if (!cancelled) setPreparedSubtitles(prepared)
    })

    return () => {
      cancelled = true
      controller.abort()
      objectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl))
    }
  }, [playbackRequestHeaders, subtitles])

  // ── Auto-select subtitle track by language priority ──
  useEffect(() => {
    let cancelled = false
    let selectionTimer: ReturnType<typeof setTimeout> | undefined
    const { preferredSubtitles: preferredSubs = ['en'], subtitleMode, preferSdhSubtitles } = useAppStore.getState()
    if (preparedSubtitles.length === 0) return
    const selectedAudioTrack = audioTracks.find((track) => String(track.index) === selectedAudio)
    const selection = selectStartupSubtitle({
      tracks: preparedSubtitles.map((track, index) => ({ ...track, index })),
      preferred: preferredSubs,
      preferSdh: preferSdhSubtitles,
      mode: subtitleMode,
      selectedAudioLanguage: selectedAudioTrack?.language,
      normalize: getLanguageCodeFromTrack,
    })
    if (selection.kind === 'off') {
      setSelectedSubtitle('off')
      if (videoRef.current) Array.from(videoRef.current.textTracks).forEach((track) => { track.mode = 'disabled' })
      return
    }
    if (selection.kind === 'track') {
      const bestIdx = selection.track.index
      setSelectedSubtitle(`external:${bestIdx}`)
      if (videoRef.current) {
        selectionTimer = setTimeout(() => {
          if (cancelled || !videoRef.current) return
          const selectedExternalId = `external:${bestIdx}`
          Array.from(videoRef.current.querySelectorAll<HTMLTrackElement>('track[data-player-subtitle-id]')).forEach((element) => {
            element.track.mode = element.dataset.playerSubtitleId === selectedExternalId ? 'showing' : 'disabled'
          })
          Array.from(videoRef.current.textTracks).forEach((track) => {
            if (!Array.from(videoRef.current!.querySelectorAll<HTMLTrackElement>('track')).some((element) => element.track === track)) track.mode = 'disabled'
          })
        }, 100)
      }
    }
    return () => {
      cancelled = true
      if (selectionTimer) clearTimeout(selectionTimer)
    }
  }, [audioTracks, preparedSubtitles, selectedAudio])

  // ── Watch Together sync ───────────────────────────────────────────────────
  const wtIgnoreNextEvent = useRef(false)
  const wtIgnoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressNextWatchTogetherEvent = () => {
    wtIgnoreNextEvent.current = true
    if (wtIgnoreTimerRef.current) clearTimeout(wtIgnoreTimerRef.current)
    wtIgnoreTimerRef.current = setTimeout(() => {
      wtIgnoreNextEvent.current = false
      wtIgnoreTimerRef.current = null
    }, 750)
  }

  useEffect(() => {
    const wtState = useWatchTogetherStore.getState()
    if (!wtState.currentRoom) return

    resetDriftState()

    const onSyncRequest = (e: Event) => {
      const { time, isPlaying, sequence } = (e as CustomEvent).detail as { time: number; isPlaying: boolean; sentAt: number; sequence?: number }
      const video = videoRef.current
      if (!video) return

      const { driftThreshold } = useWatchTogetherStore.getState()
      const { shouldSeek, targetTime } = shouldCorrectDrift(
        video.currentTime,
        { currentTime: time, isPlaying, lastUpdatedAt: (e as CustomEvent).detail.sentAt },
        driftThreshold,
        1000,
      )

      if (shouldSeek) {
        suppressNextWatchTogetherEvent()
        video.currentTime = targetTime
        markCorrectionApplied()
      }

      if (isPlaying && video.paused) {
        suppressNextWatchTogetherEvent()
        setPaused(false)
        wtReportLocalPlayback(video.currentTime, true)
        video.play().catch(() => {})
      } else if (!isPlaying && !video.paused) {
        suppressNextWatchTogetherEvent()
        setPaused(true)
        wtReportLocalPlayback(video.currentTime, false)
        video.pause()
      }
      if (sequence != null) useWatchTogetherStore.getState().markPendingSyncApplied(sequence)
    }

    window.addEventListener('wt:sync_request', onSyncRequest)

    // Feed the live position to the watch-together sync loop so the host
    // broadcasts real progress instead of the last event timestamp.
    const reportTimer = setInterval(() => {
      const video = videoRef.current
      if (!video || !useWatchTogetherStore.getState().currentRoom) return
      wtReportLocalPlayback(video.currentTime, !video.paused)
    }, 250)

    return () => {
      window.removeEventListener('wt:sync_request', onSyncRequest)
      if (wtIgnoreTimerRef.current) clearTimeout(wtIgnoreTimerRef.current)
      clearInterval(reportTimer)
      resetDriftState()
      wtClearLocalPlayback()
    }
  }, [])

  const wtSendPlay = () => {
    const video = videoRef.current
    const wt = useWatchTogetherStore.getState()
    if (!video || !wt.currentRoom) return
    if (wtIgnoreNextEvent.current) return
    wtPlay(video.currentTime)
  }

  const wtSendPause = () => {
    const video = videoRef.current
    const wt = useWatchTogetherStore.getState()
    if (!video || !wt.currentRoom) return
    if (wtIgnoreNextEvent.current) return
    wtPause(video.currentTime)
  }

  const refreshAudioTracks = () => {
    const hlsTracks = hlsTracksRef.current
    if (hlsTracks?.audioTracks.length) {
      const next = hlsTracks.audioTracks.map((track, index) => ({
        id: String(index),
        label: track.name || getLanguageNameFromTrack(track.lang || track.language) || `Audio ${index + 1}`,
        language: track.lang || track.language,
        index,
        enabled: index === hlsTracks.audioTrack,
      }))
      setAudioTracks(next)
      setSelectedAudio(String(hlsTracks.audioTrack >= 0 ? hlsTracks.audioTrack : 0))
      return
    }
    const video = videoRef.current as (HTMLVideoElement & { audioTracks?: Array<{ enabled: boolean; id?: string; label?: string; language?: string }> }) | null
    const tracks = video?.audioTracks
    if (!tracks?.length) {
      const serverTracks = serverTrackInfo?.provider === 'jellyfin' ? serverTrackInfo.audioTracks || [] : []
      const serverOptions = serverTracks.flatMap((raw, index) => {
        const sourceIndex = typeof raw.Index === 'number' ? raw.Index : typeof raw.index === 'number' ? raw.index : undefined
        if (sourceIndex === undefined) return []
        const language = typeof raw.Language === 'string' ? raw.Language : typeof raw.language === 'string' ? raw.language : undefined
        const label = typeof raw.DisplayTitle === 'string' ? raw.DisplayTitle
          : typeof raw.Title === 'string' ? raw.Title
            : typeof raw.title === 'string' ? raw.title
              : getLanguageNameFromTrack(language) || `Audio ${index + 1}`
        return [{ id: String(index), label, language, index, sourceIndex, enabled: Boolean(raw.IsDefault ?? raw.isDefault) }]
      })
      setAudioTracks(serverOptions)
      const selected = (userSelectedAudioRef.current
        ? serverOptions.find((track) => String(track.index) === selectedAudio)
        : undefined) || serverOptions.find((track) => track.enabled) || serverOptions[0]
      if (selected) setSelectedAudio(String(selected.index))
      return
    }

    const next = Array.from(tracks).map((track, index) => ({
      id: track.id || String(index),
      label: track.label || getLanguageNameFromTrack(track.language) || `Audio ${index + 1}`,
      language: track.language,
      index,
      enabled: track.enabled,
    }))
    if (next.length > 0 && !next.some((track) => track.enabled)) {
      tracks[0].enabled = true
      next[0].enabled = true
    }

    if (userSelectedAudioRef.current) {
      const selectedIndex = Number(selectedAudio)
      if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < tracks.length) {
        Array.from(tracks).forEach((track, index) => { track.enabled = index === selectedIndex })
        next.forEach((track, index) => { track.enabled = index === selectedIndex })
      }
    } else {
      // Apply language preferences on initial load, but never override a
      // track the user has selected during this playback session.
      const { preferredAudio = ['en', 'ja'], animeAudioMode } = useAppStore.getState()
      const audioPreferences = audioLanguageOrder(preferredAudio, Boolean(playbackItem?.isAnime), animeAudioMode)
      const bestIdx = selectPreferredLanguageTrack(
        Array.from(tracks).map((track, index) => ({ lang: track.language, index })),
        audioPreferences,
        getLanguageCodeFromTrack,
      )?.index ?? -1
      if (bestIdx !== -1) {
        Array.from(tracks).forEach((track, index) => { track.enabled = index === bestIdx })
        next.forEach((track, index) => { track.enabled = index === bestIdx })
      }
    }

    setAudioTracks(next)
    setSelectedAudio(String(next.find((track) => track.enabled)?.index ?? 0))
  }

  const refreshNativeSubtitleTracks = useCallback(() => {
    const video = videoRef.current
    if (!video || hlsTracksRef.current) {
      setNativeSubtitleTracks([])
      return
    }
    const externalTracks = new Set(Array.from(video.querySelectorAll('track')).map((element) => element.track))
    const tracks = Array.from(video.textTracks)
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => !externalTracks.has(track) && (track.kind === 'subtitles' || track.kind === 'captions'))
      .map(({ track, index }) => ({
        index,
        language: track.language || undefined,
        label: track.label || getLanguageNameFromTrack(track.language) || `Subtitle ${index + 1}`,
      }))
    setNativeSubtitleTracks(tracks)
  }, [])

  useEffect(() => {
    const tracks = videoRef.current?.textTracks
    if (!tracks) return
    const refresh = () => refreshNativeSubtitleTracks()
    tracks.addEventListener('addtrack', refresh)
    tracks.addEventListener('removetrack', refresh)
    tracks.addEventListener('change', refresh)
    refresh()
    return () => {
      tracks.removeEventListener('addtrack', refresh)
      tracks.removeEventListener('removetrack', refresh)
      tracks.removeEventListener('change', refresh)
    }
  }, [url, playbackSourceUrl, workerPlaybackUrl, refreshNativeSubtitleTracks])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    showControlsTemporarily()

    if (video.paused) {
      const playbackRun = playbackRunRef.current
      autoplayBlockedRef.current = false
      if (playerNotice === AUTOPLAY_GESTURE_MESSAGE) setPlayerNotice('')
      setError('')
      video.play().then(() => {
        if (playbackRun !== playbackRunRef.current) return
        setPaused(false)
        if (playbackItem && !workerLiveSnapshotActiveRef.current) {
          const progress = video.duration > 0 ? video.currentTime / video.duration : 0
          saveLocalProgress(video.currentTime, video.duration || 0, false)
          if (scrobbleSimkl) {
            onSimklPlaybackStart(playbackItem, progress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
            const progressPct = Math.round(progress * 10000) / 100
            const traktPayload = playbackItem.contentType === 'series' && playbackItem.season != null && playbackItem.episode != null
              ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
              : buildMovieScrobble(playbackItem.imdbId, progressPct)
            traktScrobbleStart(traktPayload).catch(() => {})
          }
          sendMdblistScrobble('start', progress)
        }
      }).catch((error: unknown) => {
        // A prior play request can reject after this video has already started
        // (notably while HLS.js replaces the source through MediaSource). That
        // rejection must not turn working playback into a fatal player error.
        if (playbackRun !== playbackRunRef.current || playbackStartedRef.current || !video.paused || isPlaybackInterruptedError(error)) return
        if (isAutoplayGestureError(error)) {
          autoplayBlockedRef.current = true
          setPaused(true)
          setPlayerNotice(AUTOPLAY_GESTURE_MESSAGE)
          return
        }
        setError('Browser playback could not start. Check the stream URL or choose another source.')
      })
    } else {
      video.pause()
      setPaused(true)
      setControlsVisible(true)
      if (playbackItem && !workerLiveSnapshotActiveRef.current) {
        const progress = video.duration > 0 ? video.currentTime / video.duration : 0
        saveLocalProgress(video.currentTime, video.duration || 0, false)
        if (scrobbleSimkl) {
          onSimklPlaybackPause(playbackItem, progress).catch(() => {})
        }
        if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
          const progressPct = Math.round(progress * 10000) / 100
          const traktPayload = playbackItem.contentType === 'series' && playbackItem.season != null && playbackItem.episode != null
            ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
            : buildMovieScrobble(playbackItem.imdbId, progressPct)
          traktScrobblePause(traktPayload).catch(() => {})
        }
        sendMdblistScrobble('pause', progress)
      }
    }
  }

  const handleClose = () => {
    if (playbackItem && !workerLiveSnapshotActiveRef.current) {
      const video = videoRef.current
      const progress = video && video.duration > 0 ? video.currentTime / video.duration : 0
      const cur = video ? video.currentTime : 0
      const dur = video ? video.duration || 0 : 0
      saveLocalProgress(cur, dur, false)
      if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
        const progressPct = Math.round(progress * 10000) / 100
        const traktPayload = playbackItem.contentType === 'series' && playbackItem.season != null && playbackItem.episode != null
          ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
          : buildMovieScrobble(playbackItem.imdbId, progressPct)
        traktScrobbleStop(traktPayload).catch(() => {})
      }
      if (scrobbleSimkl) {
        onSimklPlaybackStop(playbackItem, progress).catch(() => {})
      }
      reportJellyfinEvent('stop', cur, dur, true)
      saveAniListScrobble(progress)
      syncPmdbPlayback(cur, dur, true)
      sendMdblistScrobble('stop', progress)
      if (progress >= 0.8) {
        import('../services/watchedCacheSync').then((m) => m.invalidateWatchedStatusCache()).catch(() => {})
      }
    }
    onClose()
  }

  const handlePickAnother = () => {
    if (playbackItem && !workerLiveSnapshotActiveRef.current) {
      const video = videoRef.current
      const progress = video && video.duration > 0 ? video.currentTime / video.duration : 0
      const cur = video ? video.currentTime : 0
      const dur = video ? video.duration || 0 : 0
      saveLocalProgress(cur, dur, false)
      if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
        const progressPct = Math.round(progress * 10000) / 100
        const traktPayload = playbackItem.contentType === 'series' && playbackItem.season != null && playbackItem.episode != null
          ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
          : buildMovieScrobble(playbackItem.imdbId, progressPct)
        traktScrobbleStop(traktPayload).catch(() => {})
      }
      if (scrobbleSimkl) {
        onSimklPlaybackStop(playbackItem, progress).catch(() => {})
      }
      reportJellyfinEvent('stop', cur, dur, true)
      saveAniListScrobble(progress)
      syncPmdbPlayback(cur, dur, true)
      sendMdblistScrobble('stop', progress)
      if (progress >= 0.8) {
        import('../services/watchedCacheSync').then((m) => m.invalidateWatchedStatusCache()).catch(() => {})
      }
    }
    onPickAnother()
  }

  const handleEnded = () => {
    if (workerLiveSnapshotActiveRef.current) {
      const message = 'The media worker reached the end of a finite live snapshot. Refresh the snapshot to load the latest live segments.'
      setLiveSnapshotEnded(true)
      setLoading(false)
      setPaused(true)
      setError(message)
      return
    }
    if (playbackItem) {
      const dur = videoRef.current ? videoRef.current.duration || 0 : 0
      recordPlaybackSample({ mediaKey: playbackItem.localId, title: playbackItem.title, mediaType: playbackItem.mediaType === 'anime' ? 'anime' : playbackItem.contentType === 'movie' ? 'movie' : 'series', poster, tmdbId: playbackItem.tmdbId, season: playbackItem.season, episode: playbackItem.episode, positionSeconds: dur, durationSeconds: dur, playing: false, completed: true })
      saveLocalProgress(dur, dur, true)
      reportJellyfinEvent('stop', dur, dur, true)
      if (scrobbleSimkl) {
        onSimklPlaybackStop(playbackItem, 1).catch(() => {})
      }
      if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
        const traktPayload = playbackItem.contentType === 'series' && playbackItem.season != null && playbackItem.episode != null
          ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, 100)
          : buildMovieScrobble(playbackItem.imdbId, 100)
        traktScrobbleStop(traktPayload).catch(() => {})
      }
      saveAniListScrobble(1)
      syncPmdbPlayback(dur, dur, true)
      sendMdblistScrobble('stop', 1)
      import('../services/watchedCacheSync').then((m) => m.invalidateWatchedStatusCache()).catch(() => {})
    }
  }

  const refreshLiveSnapshot = () => {
    const video = videoRef.current
    if (!video || conversionBusy || !getMediaWorkerConfig()) return
    conversionModesTriedRef.current = []
    conversionSequenceRunRef.current = null
    setError('')
    setLoading(true)
    setPlayerNotice('Loading the latest live segments through the media worker…')
    if (!requestWorkerConversionRef.current?.(video)) {
      setLoading(false)
      setError('The live snapshot could not be refreshed. Check the media worker connection and try again.')
      setLiveSnapshotEnded(true)
    }
  }

  const seekBy = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    const targetTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds))
    video.currentTime = targetTime
    showControlsTemporarily()
    const wt = useWatchTogetherStore.getState()
    if (wt.currentRoom && !wtIgnoreNextEvent.current) wtSeek(targetTime)
  }

  const seekTo = (value: string) => {
    const video = videoRef.current
    if (!video) return
    const targetTime = Number(value)
    video.currentTime = targetTime
    showControlsTemporarily()
    const wt = useWatchTogetherStore.getState()
    if (wt.currentRoom && !wtIgnoreNextEvent.current) wtSeek(targetTime)
  }

  const seekFromTimelinePointer = (clientX: number, track: HTMLElement) => {
    if (!Number.isFinite(duration) || duration <= 0) return
    const bounds = track.getBoundingClientRect()
    if (bounds.width <= 0) return
    const progress = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
    seekTo(String(progress * duration))
  }

  const changeVolume = (value: string) => {
    const next = Number(value)
    setVolume(next)
    if (videoRef.current) {
      videoRef.current.volume = next
      videoRef.current.muted = next === 0
    }
    showControlsTemporarily()
  }

  const changeSubtitle = (id: string) => {
    setSelectedSubtitle(id)
    const video = videoRef.current
    const hlsTracks = hlsTracksRef.current
    if (hlsTracks) {
      hlsTracks.subtitleTrack = id.startsWith('hls:') ? Number(id.slice(4)) : -1
    }
    if (!video) return
    const externalElements = Array.from(video.querySelectorAll<HTMLTrackElement>('track[data-player-subtitle-id]'))
    externalElements.forEach((element) => {
      element.track.mode = element.dataset.playerSubtitleId === id ? 'showing' : 'disabled'
    })
    Array.from(video.textTracks).forEach((track, index) => {
      if (externalElements.some((element) => element.track === track)) return
      track.mode = id.startsWith('native:') && Number(id.slice(7)) === index ? 'showing' : 'disabled'
    })
    showControlsTemporarily()
  }

  const changeAudio = (index: string) => {
    userSelectedAudioRef.current = true
    if (hlsTracksRef.current) {
      hlsTracksRef.current.audioTrack = Number(index)
      setSelectedAudio(index)
      setAudioTracks((current) => current.map((track) => ({ ...track, enabled: String(track.index) === index })))
      showControlsTemporarily()
      return
    }
    const video = videoRef.current as (HTMLVideoElement & { audioTracks?: Array<{ enabled: boolean }> }) | null
    const tracks = video?.audioTracks
    if (!tracks?.length) {
      const selectedTrack = audioTracks.find((track) => String(track.index) === index)
      if (serverTrackInfo?.provider === 'jellyfin' && selectedTrack?.sourceIndex !== undefined && video) {
        try {
          const source = new URL(url)
          source.searchParams.set('AudioStreamIndex', String(selectedTrack.sourceIndex))
          trackSwitchResumeRef.current = { time: video.currentTime || 0, shouldResume: !video.paused }
          setSelectedAudio(index)
          setLoading(true)
          setPlayerNotice(`Switching to ${selectedTrack.label}…`)
          if (needsHeaderProxy) {
            void createMediaSession(source.toString(), undefined, playbackRequestHeaders).then((session) => {
              mediaProxySessionRef.current = session
              setHeaderSessionUrl(session.url)
            }).catch(() => {
              trackSwitchResumeRef.current = null
              setLoading(false)
              setPlayerNotice('Could not reopen the Jellyfin stream with the selected audio track.')
            })
          } else {
            video.src = source.toString()
            video.load()
          }
        } catch {
          setPlayerNotice('This Jellyfin stream cannot switch audio tracks in the browser.')
        }
      }
      showControlsTemporarily()
      return
    }
    Array.from(tracks).forEach((track, trackIndex) => {
      track.enabled = String(trackIndex) === index
    })
    setSelectedAudio(index)
    setAudioTracks((current) => current.map((track) => ({ ...track, enabled: String(track.index) === index })))
    showControlsTemporarily()
  }

  const openPictureInPicture = async () => {
    const video = videoRef.current
    if (!video || !getPlatformCapabilities(video).pictureInPicture) return
    try {
      await togglePictureInPicture(video)
    } catch {
      setPlayerNotice('Picture-in-picture could not be started. Try again while video is playing.')
    }
  }

  const openAirPlayPicker = () => {
    const video = videoRef.current as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | null
    if (!video || !getPlatformCapabilities(video).airPlay) return
    try {
      video.webkitShowPlaybackTargetPicker?.()
    } catch {
      setPlayerNotice('AirPlay is unavailable for this stream or device.')
    }
  }

  const convertWithWorker = async (mode: MediaConversionMode): Promise<boolean> => {
    if (conversionModesTriedRef.current.includes(mode)) return false
    conversionModesTriedRef.current = [...conversionModesTriedRef.current, mode]
    const controller = new AbortController()
    conversionControllerRef.current?.abort()
    conversionControllerRef.current = controller
    setConversionBusy(true)
    setLoading(true)
    setError('')
    let conversionJobId: string | null = null
    setConversionMessage(mode === 'auto'
      ? 'Inspecting the source on your media worker. It will try stream copy, then AAC-only conversion, then video encoding…'
      : mode === 'remux'
      ? 'Preparing a seekable MP4 copy on your media worker…'
      : mode === 'audioAac'
        ? 'Converting audio to AAC while copying the video unchanged…'
        : mode === 'h264AacLow'
          ? 'Preparing a smaller 720p/30 H.264 copy for older mobile decoders…'
        : mode === 'h264AacCompat'
          ? 'Preparing a 480p/30 Baseline H.264 copy for maximum mobile compatibility…'
        : 'Encoding video to H.264 and audio to AAC. This can take several minutes…')
    try {
      const outputFormat = conversionOutputFormatRef.current || getMediaConversionOutputFormat()
      const mobileCompatibility = getMediaConversionOutputFormat() === 'mp4'
      const { preferredAudio = ['en', 'ja'], animeAudioMode } = useAppStore.getState()
      const preferredAudioLanguages = mobileCompatibility
        ? audioLanguageOrder(preferredAudio, Boolean(playbackItem?.isAnime), animeAudioMode)
        : []
      let jobId: string
      let startRetries = 0
      while (true) {
        try {
          jobId = await startMediaConversion(url, mode, controller.signal, playbackRequestHeaders, outputFormat, mobileCompatibility, preferredAudioLanguages)
          break
        } catch (error) {
          if (!(error instanceof MediaWorkerHttpError && error.status === 429 && error.errorCode === 'conversion_worker_busy') || startRetries >= 2) {
            throw error
          }
          startRetries += 1
          setConversionMessage('The media worker is busy. Waiting for a conversion slot…')
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              window.clearTimeout(timer)
              controller.signal.removeEventListener('abort', onAbort)
              reject(controller.signal.reason || new DOMException('Conversion start cancelled', 'AbortError'))
            }
            const timer = window.setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort)
              resolve()
            }, startRetries * 1_500)
            controller.signal.addEventListener('abort', onAbort, { once: true })
          })
        }
      }
      conversionJobId = jobId
      const startedAt = Date.now()
      const maxConversionWaitMs = workerConversionTimeoutMsRef.current + 10 * 60 * 1000
      let consecutiveStatusFailures = 0
      while (true) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            window.clearTimeout(timer)
            reject(controller.signal.reason || new DOMException('Conversion status polling cancelled', 'AbortError'))
          }
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort)
            resolve()
          }, 1000)
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })
        let status: MediaConversionStatus
        try {
          status = await withRequestTimeout(
            10_000,
            (signal) => getMediaConversionStatus(jobId, signal),
            'Media worker status request timed out',
            controller.signal,
          )
          consecutiveStatusFailures = 0
        } catch (error) {
          if (controller.signal.aborted) throw error
          const retryable = error instanceof MediaWorkerHttpError
            ? error.status === 429 || error.status >= 500
            : error instanceof TypeError
              || error instanceof SyntaxError
              || (error instanceof DOMException && error.name === 'TimeoutError')
          if (!retryable) throw error
          if (Date.now() - startedAt >= maxConversionWaitMs) {
            throw new Error('The media worker conversion exceeded its configured time limit.')
          }
          consecutiveStatusFailures += 1
          setConversionMessage('The connection to the media worker was interrupted. Reconnecting while conversion continues…')
          const retryDelay = Math.min(1_000 * 2 ** Math.min(consecutiveStatusFailures - 1, 4), 15_000)
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              window.clearTimeout(timer)
              controller.signal.removeEventListener('abort', onAbort)
              reject(controller.signal.reason || new DOMException('Conversion polling cancelled', 'AbortError'))
            }
            const timer = window.setTimeout(() => {
              controller.signal.removeEventListener('abort', onAbort)
              resolve()
            }, retryDelay)
            controller.signal.addEventListener('abort', onAbort, { once: true })
          })
          continue
        }
        if (status.status === 'cancelled') return false
        if (status.status === 'failed') throw new Error('The media worker could not convert this stream.')
        if (status.status !== 'ready') {
          if (Date.now() - startedAt >= maxConversionWaitMs) {
            throw new Error('The media worker conversion exceeded its configured time limit.')
          }
          continue
        }
        const video = videoRef.current
        if (!video || controller.signal.aborted) return false
        // A live playlist converted by the worker is a finite snapshot, so its
        // original live timeline position cannot be applied to the new VOD file.
        const position = status.liveSnapshot ? 0 : Number.isFinite(video.currentTime) ? video.currentTime : 0
        workerLiveSnapshotRef.current = Boolean(status.liveSnapshot)
        workerLiveSnapshotActiveRef.current = Boolean(status.liveSnapshot)
        setLiveSnapshotEnded(false)
        mediaProxyResumeRef.current = position
        mediaProxySessionRef.current = null
        workerConversionActiveRef.current = true
        workerPlaybackResumeRef.current = true
        lastWorkerConversionModeRef.current = status.mode
        setLoading(true)
        setPaused(true)
        setError('')
      const inputCodecs = status.sourceInfo?.streams
        .map((stream) => stream.codec_name && `${stream.codec_type || 'stream'}: ${stream.codec_name}${stream.profile ? ` (${stream.profile})` : ''}`)
        .filter((value): value is string => Boolean(value))
        .join(', ')
      const audioTrackNotice = status.audioTracksReduced
        ? ' Some source audio tracks could not be converted together, so this copy keeps one working audio track.'
        : ''
      const conversionProfile = status.mode === 'remux'
        ? 'stream copy'
        : status.mode === 'audioAac'
          ? outputFormat === 'mp4' ? 'AAC-LC stereo audio with copied video' : 'AAC audio with copied video'
          : status.mode === 'h264AacLow'
            ? '720p/30 H.264 Baseline Level 3.1/AAC-LC stereo'
          : status.mode === 'h264AacCompat'
            ? '480p/30 H.264 Baseline Level 3.0/AAC-LC stereo'
            : outputFormat === 'mp4' ? 'H.264/AAC-LC stereo' : 'H.264/AAC'
      const description = status.liveSnapshot
        ? `Playing a finite snapshot of the current live stream as ${outputFormat.toUpperCase()}; playback will not continue updating.${audioTrackNotice}${inputCodecs ? ` Source detected as ${status.sourceInfo?.container}: ${inputCodecs}.` : ''}`
        : `Playing worker-prepared ${outputFormat.toUpperCase()} stream (${conversionProfile}).${audioTrackNotice}${inputCodecs ? ` Source detected as ${status.sourceInfo?.container}: ${inputCodecs}.` : ''}`
      workerPlaybackDescriptionRef.current = description
      setPlayerNotice(description)
      if (status.subtitles.length > 0) {
        setPreparedSubtitles((current) => [
          ...current.filter((track) => !track.id.startsWith('worker:')),
          ...status.subtitles.map((track, index) => ({
            id: `worker:${index}:${track.url}`,
            url: track.url,
            lang: track.lang,
            label: track.label,
            forced: track.forced,
          })),
        ])
      }
      setWorkerPlaybackUrl(status.url)
        setConversionMessage('Conversion is ready. Resuming from the previous position when the browser loads the new stream.')
        return true
      }
    } catch (error) {
      if (controller.signal.aborted) return false
      const message = error instanceof Error ? error.message : 'The media worker conversion failed.'
      setConversionMessage(message)
      if (conversionSequenceRunRef.current !== playbackRunRef.current) {
        setLoading(false)
        setError(message)
      }
      return false
    } finally {
      if (controller.signal.aborted && conversionJobId) void cancelMediaConversion(conversionJobId).catch(() => undefined)
      if (conversionControllerRef.current === controller) {
        conversionControllerRef.current = null
        setConversionBusy(false)
      }
    }
  }
  convertWithWorkerRef.current = convertWithWorker

  const convertWithWorkerFallback = async (mode: Exclude<MediaConversionMode, 'auto'>): Promise<boolean> => {
    const playbackRun = playbackRunRef.current
    const hasMode = (candidate: Exclude<MediaConversionMode, 'auto'>) =>
      conversionModesRef.current.includes(candidate) && !conversionModesTriedRef.current.includes(candidate)
    let candidate: Exclude<MediaConversionMode, 'auto'> | null = mode
    while (candidate) {
      if (await convertWithWorkerRef.current(candidate)) return true
      if (playbackRun !== playbackRunRef.current) return false
      candidate = nextPlaybackConversionAfterDecodeFailure(candidate)
      if (candidate && !hasMode(candidate)) candidate = null
      if (candidate) {
        setLoading(true)
        setPlayerNotice(candidate === 'audioAac'
          ? 'Trying AAC audio while keeping the video unchanged…'
          : candidate === 'h264AacLow'
            ? 'Trying a smaller 720p/30 H.264 copy for this decoder…'
          : candidate === 'h264AacCompat'
            ? 'Trying a 480p/30 Baseline H.264 copy for this decoder…'
            : 'Trying H.264/AAC video encoding…')
      }
    }
    if (playbackRun === playbackRunRef.current) {
      setLoading(false)
      setError('The media worker could not produce a browser-compatible copy with the remaining conversion strategies.')
    }
    return false
  }

  const requestWorkerConversion = (video: HTMLVideoElement, canPlayHls?: boolean) => {
    if (!getMediaWorkerConfig()) return false
    const playbackRun = playbackRunRef.current
    const isCurrentRun = () => playbackRun === playbackRunRef.current
    if (conversionSequenceRunRef.current === playbackRun) return true
    conversionSequenceRunRef.current = playbackRun
    const browserCapabilities = getPlatformCapabilities(video)
    const supportsHlsOutput = canPlayHls ?? (browserCapabilities.nativeHls || browserCapabilities.mediaSource)
    const message = browserPlaybackFailureMessage(url, video)
    const refreshingLiveSnapshot = liveSnapshotEnded
    autoplayBlockedRef.current = true
    setLoading(true)
    setPaused(true)
    setError('')
    setPlayerNotice(refreshingLiveSnapshot
      ? 'Loading the latest live segments through the media worker…'
      : 'Checking playback support and preparing a compatible copy automatically…')
    const begin = (modes: MediaConversionMode[]) => {
      if (!isCurrentRun()) return
      updateConversionModes(modes)
      if (modes.length === 0) {
        const unavailable = `${message} The configured media worker does not offer a compatible output format or encoder.`
        setLoading(false)
        setError(unavailable)
        if (!refreshingLiveSnapshot) playbackStartupRef.current.onPlaybackError?.(unavailable, video.currentTime)
        if (conversionSequenceRunRef.current === playbackRun) conversionSequenceRunRef.current = null
        return
      }
      setLoading(true)
      setError('')
      setPlayerNotice(refreshingLiveSnapshot
        ? 'Preparing a fresh live snapshot…'
        : 'Preparing a browser-compatible copy. The original source is not modified.')
      void (async () => {
        for (const mode of modes) {
          if (!isCurrentRun()) return
          if (conversionModesTriedRef.current.includes(mode)) continue
          if (await convertWithWorker(mode)) {
            if (conversionSequenceRunRef.current === playbackRun) conversionSequenceRunRef.current = null
            return
          }
          // The worker's automatic ladder already tried remux, AAC-only, and
          // standard H.264. One lower mobile profile remains useful if the
          // standard encode itself could not be produced.
          if (mode === 'auto') {
            if (modes.includes('h264AacLow') && !conversionModesTriedRef.current.includes('h264AacLow')) {
              if (await convertWithWorkerFallback('h264AacLow')) {
                if (conversionSequenceRunRef.current === playbackRun) conversionSequenceRunRef.current = null
                return
              }
            }
            break
          }
        }
        if (!isCurrentRun()) return
        const failed = `${message} Automatic conversion attempts failed. Pick another source or check the media worker logs.`
        setLoading(false)
        setError(failed)
        if (!refreshingLiveSnapshot) playbackStartupRef.current.onPlaybackError?.(failed, video.currentTime)
        if (conversionSequenceRunRef.current === playbackRun) conversionSequenceRunRef.current = null
      })()
    }
    if (conversionOptionsCheckedRef.current) {
      begin(conversionModesRef.current)
    } else {
      conversionOptionsCheckedRef.current = true
      const loadCapabilities = async () => {
        let retries = 0
        while (true) {
          try {
            return await getMediaWorkerCapabilities()
          } catch (error) {
            if (!isCurrentRun()) throw error
            const retryable = error instanceof MediaWorkerHttpError
              ? error.status === 429 || error.status >= 500
              : error instanceof TypeError
                || error instanceof SyntaxError
                || (error instanceof DOMException && error.name === 'TimeoutError')
            if (!retryable || retries >= 2) throw error
            retries += 1
            setLoading(true)
            setPlayerNotice('The media worker connection was interrupted. Retrying its capability check…')
            await new Promise((resolve) => window.setTimeout(resolve, 1_000 * 2 ** (retries - 1)))
          }
        }
      }
      void loadCapabilities().then((capabilities) => {
        if (!isCurrentRun()) return
        const timeoutSeconds = capabilities.conversionTimeoutSeconds
        if (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
          workerConversionTimeoutMsRef.current = Math.min(timeoutSeconds, 24 * 60 * 60) * 1000
        }
        conversionOutputFormatRef.current = getSupportedMediaConversionOutputFormat(capabilities, undefined, supportsHlsOutput)
        const modes: MediaConversionMode[] = []
        if (conversionOutputFormatRef.current && capabilities.mediaRemux) modes.push('auto')
        if (conversionOutputFormatRef.current && capabilities.audioTranscode) modes.push('audioAac')
        if (conversionOutputFormatRef.current && capabilities.audioTranscode && capabilities.videoTranscode) {
          modes.push('h264Aac')
          if (capabilities.mobileSafeVideoTranscode && getMediaConversionOutputFormat() === 'mp4') {
            modes.push('h264AacLow', 'h264AacCompat')
          }
        }
        begin(modes)
      }).catch(() => {
        if (!isCurrentRun()) return
        conversionOptionsCheckedRef.current = false
        setLoading(false)
        setError(`${message} The media worker could not be reached to check conversion support.`)
        if (!refreshingLiveSnapshot) playbackStartupRef.current.onPlaybackError?.(message, video.currentTime)
        if (conversionSequenceRunRef.current === playbackRun) conversionSequenceRunRef.current = null
      })
    }
    return true
  }
  requestWorkerConversionRef.current = requestWorkerConversion
  retryWorkerConversionRef.current = (video: HTMLVideoElement) => {
    if (workerNetworkRetryAttemptedRef.current || !getMediaWorkerConfig()) return false
    workerNetworkRetryAttemptedRef.current = true
    workerConversionActiveRef.current = false
    lastWorkerConversionModeRef.current = null
    conversionModesTriedRef.current = []
    conversionSequenceRunRef.current = null
    mediaProxyResumeRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0
    setLoading(true)
    setError('')
    setPlayerNotice('The prepared stream connection was interrupted. Rebuilding it through the media worker…')
    return requestWorkerConversion(video)
  }

  const handleTimeUpdate = (time: number, dur: number) => {
    setCurrentTime(time)
    if (workerLiveSnapshotActiveRef.current) return
    if (playbackItem) recordPlaybackSample({ mediaKey: playbackItem.localId, title: playbackItem.title, mediaType: playbackItem.mediaType === 'anime' ? 'anime' : playbackItem.contentType === 'movie' ? 'movie' : 'series', poster, tmdbId: playbackItem.tmdbId, season: playbackItem.season, episode: playbackItem.episode, positionSeconds: time, durationSeconds: dur, playing: !videoRef.current?.paused, completed: dur > 0 && time / dur >= 0.85 })
    if (Math.abs(time - lastSavedTimeRef.current) >= 15) {
      lastSavedTimeRef.current = time
      saveLocalProgress(time, dur, false)
    }
    if (playbackItem && scrobbleAnilist && playbackItem.isAnime && dur > 0 && time - lastAniListPlaybackSaveRef.current >= 60) {
      lastAniListPlaybackSaveRef.current = time
      saveAniListProgressMapped(playbackItem, time / dur).catch(() => {})
    }
    if (time - lastPmdbPlaybackSaveRef.current >= 60) {
      lastPmdbPlaybackSaveRef.current = time
      syncPmdbPlayback(time, dur)
    }
  }

  const subtitleOptions = [
    ...hlsSubtitleTracks.map((track) => ({ id: `hls:${track.index}`, label: track.label })),
    ...nativeSubtitleTracks.map((track) => ({ id: `native:${track.index}`, label: track.label })),
    ...preparedSubtitles.map((track, index) => ({ id: `external:${index}`, label: track.label || track.lang || `Subtitle ${index + 1}` })),
  ]

  return createPortal((
    <div
      ref={playerShellRef}
      className={`fixed inset-0 z-[10000] bg-black text-white ${controlsVisible ? 'cursor-default' : 'cursor-none'}`}
      data-player-fullscreen={isFullscreen || undefined}
      onMouseMove={showControlsTemporarily}
      onClick={showControlsTemporarily}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full bg-black object-contain"
        preload="auto"
        playsInline
        autoPlay
        onPlay={() => { setPaused(false); showControlsTemporarily(); wtSendPlay() }}
        onPause={() => {
          setPaused(true); showControlsTemporarily(); wtSendPause()
          const video = videoRef.current
          reportJellyfinEvent('pause', video?.currentTime || 0, video?.duration || 0, true)
        }}
        onWaiting={() => {
          bufferingRef.current = true
          const video = videoRef.current
          if (!video?.error && !error) setLoading(true)
          showControlsTemporarily()
          const wt = useWatchTogetherStore.getState()
          if (wt.currentRoom) wtSendBuffering(true, video?.currentTime ?? 0)

          // Mobile Safari/Chromium can leave a source in `waiting` without
          // ever dispatching `error`. After playback has genuinely stalled,
          // move it through the worker proxy and then conversion if the
          // proxied source stalls too. Startup has its own shorter guard.
          if (!video || !playbackStartedRef.current
            || getMediaConversionOutputFormat() !== 'mp4'
            || !getMediaWorkerConfig()
            || mobileStallRecoveryInFlightRef.current
            || workerLiveSnapshotActiveRef.current) return
          if (mobileStallRecoveryTimerRef.current) clearTimeout(mobileStallRecoveryTimerRef.current)
          const stalledAt = video.currentTime
          const playbackRun = playbackRunRef.current
          mobileStallRecoveryTimerRef.current = window.setTimeout(() => {
            mobileStallRecoveryTimerRef.current = null
            const currentVideo = videoRef.current
            if (playbackRun !== playbackRunRef.current || currentVideo !== video
              || currentVideo.paused || currentVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
              || Math.abs(currentVideo.currentTime - stalledAt) > 0.25) return
            mobileStallRecoveryInFlightRef.current = true

            if (workerConversionActiveRef.current) {
              const lastMode = lastWorkerConversionModeRef.current
              const nextMode = lastMode ? nextPlaybackConversionAfterDecodeFailure(lastMode) : null
              if (nextMode && conversionModesRef.current.includes(nextMode) && !conversionModesTriedRef.current.includes(nextMode)) {
                void convertWithWorkerFallback(nextMode)
                return
              }
              if (!retryWorkerConversionRef.current?.(currentVideo)) {
                setLoading(false)
                setPaused(true)
                const message = 'The worker-prepared stream stopped responding after its recovery attempt. Refresh this source or choose another stream.'
                setError(message)
                playbackStartupRef.current.onPlaybackError?.(message, currentVideo.currentTime)
              }
              return
            }
            if (mediaProxyAttemptedRef.current || mediaProxySessionRef.current || needsHeaderProxy) {
              if (!requestWorkerConversionRef.current?.(currentVideo)) mobileStallRecoveryInFlightRef.current = false
              return
            }

            mediaProxyAttemptedRef.current = true
            mediaProxyResumeRef.current = Number.isFinite(currentVideo.currentTime) ? currentVideo.currentTime : 0
            setPlayerNotice('Playback stalled. Retrying this video through the Aurales media worker…')
            void createMediaSession(url, undefined, playbackRequestHeaders).then((session) => {
              if (playbackRun !== playbackRunRef.current || videoRef.current !== currentVideo) return
              mediaProxySessionRef.current = session
              mobileStallRecoveryInFlightRef.current = false
              currentVideo.src = session.url
              currentVideo.load()
            }).catch(() => {
              if (playbackRun === playbackRunRef.current) {
                if (!requestWorkerConversionRef.current?.(currentVideo)) mobileStallRecoveryInFlightRef.current = false
              }
            })
          }, MOBILE_MEDIA_STALL_RECOVERY_MS)
        }}
        onCanPlay={() => {
          bufferingRef.current = false
          setLoading(false)
        }}
        onPlaying={() => {
          if (mobileStallRecoveryTimerRef.current) clearTimeout(mobileStallRecoveryTimerRef.current)
          mobileStallRecoveryTimerRef.current = null
          mobileStallRecoveryInFlightRef.current = false
          bufferingRef.current = false
          setLoading(false)
          setPaused(false)
          // A recovered HLS or media-worker fallback can reach `playing`
          // after an earlier source error. Clear that transient error only
          // once the browser confirms that playback resumed.
          setError('')
          if (!playbackStartedRef.current) {
            playbackStartedRef.current = true
            onPlaybackStarted?.()
          } else if (videoRef.current) reportJellyfinEvent('unpause', videoRef.current.currentTime, videoRef.current.duration || 0, false)
          const wt = useWatchTogetherStore.getState()
          if (wt.currentRoom) wtSendBuffering(false, videoRef.current?.currentTime ?? 0)
        }}
        onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget.currentTime, event.currentTarget.duration || 0)}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration || 0)
          refreshAudioTracks()
          refreshNativeSubtitleTracks()
          const proxyResume = mediaProxyResumeRef.current
          mediaProxyResumeRef.current = null
          const liveSnapshotResume = workerLiveSnapshotRef.current
          workerLiveSnapshotRef.current = false
          const trackSwitchResume = trackSwitchResumeRef.current
          trackSwitchResumeRef.current = null
          if (liveSnapshotResume) {
            event.currentTarget.currentTime = 0
          } else if (trackSwitchResume) {
            event.currentTarget.currentTime = trackSwitchResume.time
            if (trackSwitchResume.shouldResume) void event.currentTarget.play().catch(() => {})
          } else if (proxyResume !== null && proxyResume > 0) {
            event.currentTarget.currentTime = proxyResume
          } else if (startTime && startTime > 0) {
            event.currentTarget.currentTime = startTime
          }
          if (workerPlaybackResumeRef.current) {
            workerPlaybackResumeRef.current = false
            void event.currentTarget.play().catch((playError: unknown) => {
              if (isPlaybackInterruptedError(playError)) return
              if (isAutoplayGestureError(playError)) {
                autoplayBlockedRef.current = true
                setLoading(false)
                setPaused(true)
                setPlayerNotice(AUTOPLAY_GESTURE_MESSAGE)
                showControlsTemporarily()
                return
              }
              setLoading(false)
              setPaused(true)
              setError('The browser could not start the prepared stream. Tap Play to retry or choose another source.')
            })
          }
        }}
        onEnded={handleEnded}
        onError={() => {
          bufferingRef.current = true
          showControlsTemporarily()
          const video = videoRef.current
          const activeProxySession = mediaProxySessionRef.current
          if (video && getPlatformCapabilities(video).platform === 'web'
            && video.error?.code === 2
            && activeProxySession
            && isMediaSessionExpired(activeProxySession.expiresAt)
            && renewedMediaProxyUrlRef.current !== activeProxySession.url) {
            renewedMediaProxyUrlRef.current = activeProxySession.url
            mediaProxyResumeRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0
            setLoading(true)
            setError('')
            setPlayerNotice('The media worker session expired. Renewing the playback link…')
            void createMediaSession(url, undefined, playbackRequestHeaders).then((session) => {
              if (!videoRef.current || videoRef.current !== video) return
              mediaProxySessionRef.current = session
              video.src = session.url
              video.load()
            }).catch(() => {
              const message = 'The media worker playback session expired and could not be renewed. Pick this stream again to refresh its source URL.'
              setLoading(false)
              setError(message)
              onPlaybackError?.(message, video.currentTime)
            })
            return
          }
          if (video && getPlatformCapabilities(video).platform === 'web'
            && video.error?.code === 2
            && workerConversionActiveRef.current
            && getMediaWorkerConfig()) {
            if (retryWorkerConversionRef.current?.(video)) return
            const liveSnapshot = workerLiveSnapshotActiveRef.current
            const message = 'The worker-prepared stream could not reconnect after one rebuild. Try refreshing the stream or choose another source.'
            setLoading(false)
            setPaused(true)
            setError(message)
            if (liveSnapshot) setLiveSnapshotEnded(true)
            else onPlaybackError?.(message, video.currentTime)
            return
          }
          if (video && getPlatformCapabilities(video).platform === 'web' && video.error?.code === 2 && !mediaProxyAttemptedRef.current) {
            mediaProxyAttemptedRef.current = true
            void createMediaSession(url, undefined, playbackRequestHeaders).then((session) => {
              if (!videoRef.current || videoRef.current !== video) return
              const position = video.currentTime
              mediaProxySessionRef.current = session
              mediaProxyResumeRef.current = position
              video.src = session.url
              video.load()
              setLoading(true)
              setError('')
              setPlayerNotice('Retrying through your configured Aurales media worker…')
            }).catch(() => {
              if (getMediaWorkerConfig()) {
                requestWorkerConversionRef.current?.(video)
                return
              }
              const message = browserPlaybackFailureMessage(url, video)
              setLoading(false)
              setError(message)
              onPlaybackError?.(message, video.currentTime)
            })
            return
          }
          if (video && getPlatformCapabilities(video).platform === 'web' && video.error?.code === 2
            && mediaProxyAttemptedRef.current && getMediaWorkerConfig()) {
            requestWorkerConversionRef.current?.(video)
            return
          }
          const unsupportedMedia = video?.error?.code === 3 || video?.error?.code === 4
          if (video && unsupportedMedia && workerConversionActiveRef.current) {
            const lastMode = lastWorkerConversionModeRef.current
            const nextMode = lastMode ? nextPlaybackConversionAfterDecodeFailure(lastMode) : null
            if (nextMode && conversionModes.includes(nextMode) && !conversionModesTriedRef.current.includes(nextMode)) {
              setLoading(true)
              setError('The browser could not decode the prepared stream. Trying the next playback strategy…')
              setPlayerNotice(nextMode === 'audioAac'
                ? 'Stream copy was not browser-decodable. Trying AAC audio while keeping the video unchanged…'
                : nextMode === 'h264AacLow'
                  ? 'The browser rejected standard H.264. Trying a smaller 720p/30 H.264 stream…'
                  : nextMode === 'h264AacCompat'
                    ? 'The browser rejected 720p H.264. Trying 480p/30 Baseline H.264…'
                  : 'Audio-only conversion was not enough. Trying H.264/AAC video encoding now…')
              void convertWithWorkerFallback(nextMode)
              return
            }
            const message = 'The browser could not decode the prepared stream after the available playback strategies. The source may use an unsupported codec or profile, including some HEVC, VP9, AV1, HDR, or Dolby Vision combinations.'
            setLoading(false)
            setPaused(true)
            setError(message)
            onPlaybackError?.(message, video.currentTime)
            return
          }
          if (video && getPlatformCapabilities(video).platform === 'web' && unsupportedMedia && getMediaWorkerConfig()) {
            requestWorkerConversionRef.current?.(video)
            return
          }
          if (video && getPlatformCapabilities(video).platform === 'web' && unsupportedMedia && !getMediaWorkerConfig()) {
            const message = 'The browser could not play this stream. Its format may be incompatible, cross-origin access may be blocked, or the signed URL may have expired. Browsers cannot convert media on-device. Add an Aurales media worker in Settings for an automatic playback copy, or choose another stream.'
            setLoading(false)
            setPaused(true)
            setError(message)
            onPlaybackError?.(message, video.currentTime)
            return
          }
          const message = browserPlaybackFailureMessage(url, videoRef.current)
          setLoading(false)
          setError(message)
          onPlaybackError?.(message, videoRef.current?.currentTime)
        }}
      >
        {preparedSubtitles.map((track, index) => (
          <track
            key={`${track.id}-${track.url}`}
            src={track.url}
            srcLang={track.lang || 'und'}
            label={track.label || track.lang || `Subtitle ${index + 1}`}
            kind="subtitles"
            data-player-subtitle-id={`external:${index}`}
          />
        ))}
      </video>
      {playerNotice && <div className={`inapp-player-notice absolute left-4 top-4 z-10 max-w-xl rounded-lg bg-black/70 px-3 py-2 text-xs text-white/70 transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} style={{ top: 'max(1rem, env(safe-area-inset-top))', left: 'max(1rem, env(safe-area-inset-left))' }}>{playerNotice}</div>}

      {/* Watch Together overlays */}
      {isInWatchTogether && (
        <PlayerChatOverlay visible={controlsVisible} onInteraction={showControlsTemporarily} />
      )}

      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-2 border-white/80 border-t-transparent rounded-full animate-spin" />
            <p className="max-w-[min(85vw,28rem)] text-center text-sm text-white/75">
              {conversionBusy
                ? conversionMessage || 'Preparing a compatible stream…'
                : conversionSequenceRunRef.current === playbackRunRef.current
                  ? 'Checking playback support and preparing a compatible stream…'
                  : 'Buffering stream…'}
            </p>
          </div>
        </div>
      )}

      {paused && !loading && (
        <button onClick={togglePlay} aria-label="Play" className="inapp-player-paused-overlay absolute inset-0 flex items-center justify-center">
          <span className="w-24 h-24 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur-xl flex items-center justify-center">
            <svg className="w-12 h-12 ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}

      <div className={`inapp-player-header absolute inset-x-0 top-0 flex items-start justify-between p-7 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button onClick={handleClose} className="w-11 h-11 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="text-right">
          <h2 className="font-bold text-lg">{title}</h2>
          {subtitle && <p className="text-xs text-white/60 uppercase tracking-[0.2em]">{subtitle}</p>}
        </div>
      </div>

      {error && (
        <div role="alert" className="absolute left-1/2 top-24 z-20 max-h-[calc(100dvh-8rem)] w-[min(92vw,44rem)] -translate-x-1/2 overflow-y-auto overscroll-contain rounded-2xl border border-red-500/20 bg-black/85 px-5 py-4 text-sm text-red-200 shadow-xl backdrop-blur-xl">
          {error}
          {liveSnapshotEnded && <button type="button" onClick={refreshLiveSnapshot} disabled={conversionBusy} className="mt-3 block min-h-11 rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-50">Refresh live snapshot</button>}
          {conversionModes.length > 0 && (
            <div className="mt-3 border-t border-white/10 pt-3">
              <p className="mb-2 text-xs text-white/65">The worker downloads the source and prepares a browser-compatible MP4 or HLS copy. This uses worker disk space; source access headers are sent to the worker and are not embedded in playback URLs.</p>
              <div className="flex flex-wrap gap-2">
                {conversionModes.filter((mode) => !conversionModesTriedRef.current.includes(mode)).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={conversionBusy}
                    onClick={() => { void convertWithWorker(mode) }}
                    className="min-h-11 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-50"
                  >
                    {mode === 'auto' ? 'Try automatic conversion' : mode === 'remux' ? 'Try stream-copy remux' : mode === 'audioAac' ? 'Convert audio to AAC' : mode === 'h264AacLow' ? 'Try smaller 720p/30 H.264' : mode === 'h264AacCompat' ? 'Try 480p/30 H.264' : 'Convert video to H.264'}
                  </button>
                ))}
              </div>
              {conversionMessage && <p role="status" className="mt-2 text-xs text-white/65">{conversionMessage}</p>}
            </div>
          )}
        </div>
      )}

      <div className={`inapp-player-controls absolute inset-x-0 bottom-0 p-7 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} style={{ paddingBottom: 'max(1.75rem, env(safe-area-inset-bottom))', paddingLeft: 'max(1.75rem, env(safe-area-inset-left))', paddingRight: 'max(1.75rem, env(safe-area-inset-right))' }}>
        <div className="flex items-center gap-3 text-xs text-white/70 mb-4">
          <span className="tabular-nums">{formatTime(currentTime)}</span>
          <div
            className="relative flex-1 h-1.5 group cursor-pointer transition-[height] duration-150 hover:h-2.5"
            onPointerDown={(event) => seekFromTimelinePointer(event.clientX, event.currentTarget)}
          >
            <div className="pointer-events-none absolute inset-0 rounded-full bg-white/20 group-hover:bg-white/30 transition-colors" />
            <div className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-white/90" style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' }} />
            <div
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 6px)` }}
            />
            <input type="range" min="0" max={duration || 0} step="0.1" value={currentTime} onChange={(event) => seekTo(event.target.value)} className="absolute inset-0 z-10 w-full h-6 -top-2.5 opacity-0 cursor-pointer" />
          </div>
          <span className="tabular-nums">{duration ? formatTime(duration) : '--:--'}</span>
        </div>

        <div className="inapp-player-control-row flex items-center justify-between gap-6">
          <div className="inapp-player-transport flex items-center gap-4">
            <button onClick={() => seekBy(-10)} aria-label="Back 10 seconds" title="Back 10s" className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
                <text x="11.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>
            <button onClick={togglePlay} aria-label={paused ? 'Resume playback' : 'Pause playback'} className="w-14 h-14 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors">
              {paused ? (
                <svg className="w-7 h-7 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              ) : (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
              )}
            </button>
            <button onClick={() => seekBy(10)} aria-label="Forward 10 seconds" title="Forward 10s" className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.16-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z" />
                <text x="12.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>
            {nextEpisode && onNextEpisode && !isInWatchTogether && (
              <button
                type="button"
                onClick={() => { handleClose(); onNextEpisode(nextEpisode.season, nextEpisode.episode) }}
                aria-label={`Skip to next episode, season ${nextEpisode.season} episode ${nextEpisode.episode}`}
                title={`Next episode · S${nextEpisode.season} E${nextEpisode.episode}`}
                className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5v15l11-7.5L5 4.5Zm13 .5h2v14h-2V5Z" /></svg>
              </button>
            )}
            <button onClick={handlePickAnother} className="px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm">Pick another</button>
            <div className="relative">
              <div className="flex overflow-hidden rounded-full bg-white/10">
                <button
                  type="button"
                  onClick={() => preferredExternalPlayer ? openExternalPlayer(preferredExternalPlayer) : setExternalPlayerMenuOpen((open) => !open)}
                  className="min-h-11 px-4 py-2 text-sm hover:bg-white/10"
                >
                  {preferredExternalPlayer ? `Open in ${externalPlayerName(preferredExternalPlayer)}` : 'Open with…'}
                </button>
                <button type="button" aria-label="Choose another player" aria-haspopup="menu" aria-expanded={externalPlayerMenuOpen} onClick={() => setExternalPlayerMenuOpen((open) => !open)} className="min-h-11 border-l border-white/10 px-3 text-sm hover:bg-white/10">▾</button>
              </div>
              {externalPlayerMenuOpen && (
                <div role="menu" className="absolute bottom-full left-0 z-50 mb-2 min-w-52 rounded-xl border border-white/15 bg-black/95 p-1.5 shadow-2xl backdrop-blur-xl">
                  {isAndroidDevice ? <>
                    <button type="button" role="menuitem" onClick={() => openExternalPlayer('nextplayer')} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Play in Next Player</button>
                    <button type="button" role="menuitem" onClick={() => openExternalPlayer('mxplayer')} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Play in MX Player</button>
                    <button type="button" role="menuitem" onClick={() => openExternalPlayer('justplayer')} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Play in Just Player</button>
                    <button type="button" role="menuitem" onClick={() => openExternalPlayer('vlc')} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Play in VLC</button>
                  </> : <>
                    <button type="button" role="menuitem" onClick={() => openExternalPlayer('infuse')} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Play in Infuse</button>
                    <button type="button" role="menuitem" onClick={() => openExternalPlayer('aether')} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10">Play in Aether</button>
                  </>}
                  <a href={playbackSourceUrl || url} target="_blank" rel="noreferrer" onClick={() => setExternalPlayerMenuOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10">Open video directly</a>
                </div>
              )}
            </div>
            <button type="button" onClick={() => {
              const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
              if (!video) return
              const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
                || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
              // Safari's native video fullscreen needs the original tap event;
              // calling it after a rejected requestFullscreen promise loses
              // that gesture on iPhone and iPad.
              if (document.fullscreenElement === playerShellRef.current) { void document.exitFullscreen(); return }
              const shell = playerShellRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null
              if (shell?.requestFullscreen) {
                void shell.requestFullscreen().catch(() => {
                  if (isAppleMobile && video.webkitEnterFullscreen) video.webkitEnterFullscreen()
                  else setPlayerNotice('Full screen is not available in this browser for the current stream.')
                })
                return
              }
              if (isAppleMobile && video.webkitEnterFullscreen) {
                if (video.error || video.readyState < HTMLMediaElement.HAVE_METADATA) {
                  setPlayerNotice('Safari can open native full screen after a playable stream has loaded.')
                  return
                }
                video.webkitEnterFullscreen()
                return
              }
              if (document.fullscreenElement) { void document.exitFullscreen(); return }
              if (video.requestFullscreen) {
                void video.requestFullscreen().catch(() => {
                  if (video.webkitEnterFullscreen) video.webkitEnterFullscreen()
                  else setPlayerNotice('Full screen is not available in this browser for the current stream.')
                })
                return
              }
              if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return }
              setPlayerNotice('Full screen is not available in this browser for the current stream.')
            }} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} title={isFullscreen ? 'Exit full screen' : 'Full screen'} className="grid h-11 w-11 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white">
              <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" /></svg>
            </button>
          </div>

          <div className="inapp-player-options flex items-center gap-3">
            <div className="relative">
              {showSpeedMenu && (
                <div className="absolute bottom-full mb-2 left-0 bg-black/90 backdrop-blur-xl border border-white/15 rounded-xl py-1.5 shadow-2xl z-50 min-w-[100px]">
                  {SPEED_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => changePlaybackSpeed(s)}
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
                className={`px-3 py-2 rounded-xl text-sm font-bold transition-colors ${
                  playbackSpeed !== 1 ? 'bg-accent/20 text-accent border border-accent/30' : 'bg-black/80 text-white border border-white/15 hover:bg-white/10'
                }`}
              >
                {playbackSpeed === 1 ? '1x' : `${playbackSpeed}x`}
              </button>
            </div>
            <div className="relative" data-player-popover>
              {audioMenuOpen && (
                <div role="menu" aria-label="Audio tracks" className="inapp-player-track-menu absolute bottom-full right-0 z-50 mb-3 min-w-60 max-w-[min(24rem,80vw)] overflow-hidden rounded-2xl border border-white/10 bg-[#111318]/95 p-1.5 shadow-2xl backdrop-blur-2xl">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[.18em] text-white/40">Audio</p>
                  {audioTracks.length ? audioTracks.map((track) => (
                    <button key={track.id} type="button" role="menuitemradio" aria-checked={selectedAudio === String(track.index)} onClick={() => { changeAudio(String(track.index)); setAudioMenuOpen(false) }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-white/80 transition hover:bg-white/10 hover:text-white">
                      <span className="grid h-4 w-4 shrink-0 place-items-center">{selectedAudio === String(track.index) ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}</span>
                      <span className="truncate">{track.label}</span>
                    </button>
                  )) : <p className="px-3 py-2.5 text-sm text-white/45">No audio tracks detected in this browser for this source.</p>}
                </div>
              )}
              <button type="button" onClick={() => { setAudioMenuOpen((open) => !open); setSubtitleMenuOpen(false); setShowSpeedMenu(false) }} aria-label="Audio tracks" aria-haspopup="menu" aria-expanded={audioMenuOpen} title={`Audio · ${audioTracks.find((track) => String(track.index) === selectedAudio)?.label || 'Default audio'}`} className={`grid h-10 w-10 place-items-center rounded-full text-white/75 transition hover:bg-white/10 hover:text-white ${audioMenuOpen ? 'bg-white/15 text-white' : ''}`}>
                <svg className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Z" strokeLinejoin="round"/><path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a8.5 8.5 0 0 1 0 11" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="relative" data-player-popover>
              {subtitleMenuOpen && (
                <div role="menu" aria-label="Subtitle tracks" className="inapp-player-track-menu absolute bottom-full right-0 z-50 mb-3 min-w-64 max-w-[min(26rem,80vw)] overflow-hidden rounded-2xl border border-white/10 bg-[#111318]/95 p-1.5 shadow-2xl backdrop-blur-2xl">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[.18em] text-white/40">Subtitles</p>
                  {[{ id: 'off', label: 'Subtitles off' }, ...subtitleOptions].map((track) => (
                    <button key={track.id} type="button" role="menuitemradio" aria-checked={selectedSubtitle === track.id} onClick={() => { changeSubtitle(track.id); setSubtitleMenuOpen(false) }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-white/80 transition hover:bg-white/10 hover:text-white">
                      <span className="grid h-4 w-4 shrink-0 place-items-center">{selectedSubtitle === track.id ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}</span>
                      <span className="truncate">{track.label}</span>
                    </button>
                  ))}
                  {subtitleOptions.length === 0 && <p className="px-3 pb-2 text-xs text-white/40">No subtitle tracks received from this source yet.</p>}
                </div>
              )}
              <button type="button" onClick={() => { setSubtitleMenuOpen((open) => !open); setAudioMenuOpen(false); setShowSpeedMenu(false) }} aria-label="Subtitle tracks" aria-haspopup="menu" aria-expanded={subtitleMenuOpen} title={`Subtitles · ${selectedSubtitle === 'off' ? 'Off' : subtitleOptions.find((track) => track.id === selectedSubtitle)?.label || 'On'}`} className={`grid h-10 w-10 place-items-center rounded-full text-white/75 transition hover:bg-white/10 hover:text-white ${subtitleMenuOpen ? 'bg-white/15 text-white' : ''}`}>
                <svg className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M6 10h5M13 10h5M6 14h3M11 14h7" strokeLinecap="round"/></svg>
              </button>
            </div>
            {selectedSubtitle !== 'off' && (
              <button
                onClick={() => {
                  setTranslationError('')
                  setShowTranslateModal(true)
                }}
                className="bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/30 text-purple-200 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                title="AI Translate Subtitles"
              >
                <span>✨ AI Translate</span>
              </button>
            )}
            <input aria-label="Volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => changeVolume(event.target.value)} className="w-28 accent-white" />
            <div className="flex items-center gap-2">
              {getPlatformCapabilities(videoRef.current).pictureInPicture && (
                <button type="button" onClick={() => { void openPictureInPicture() }} aria-label="Picture in picture" title="Picture in picture" className="grid h-11 w-11 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none" /></svg>
                </button>
              )}
              {getPlatformCapabilities(videoRef.current).airPlay && (
                <button type="button" onClick={openAirPlayPicker} aria-label="AirPlay" title="AirPlay" className="grid h-11 w-11 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="2" /><path d="m8 21 4-5 4 5H8Z" fill="currentColor" stroke="none" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* AI Subtitle Translation Modal */}
      {showTranslateModal && (
        <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-md flex items-center justify-center p-4" onClick={() => !translatingSub && setShowTranslateModal(false)}>
          <div 
            className="w-full max-w-lg bg-surface-elevated/90 border border-border-subtle rounded-2xl p-6 shadow-2xl backdrop-blur-xl animate-fade-in text-white relative overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
              <div>
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <span className="flex items-center justify-center w-5 h-5 rounded bg-purple-500/20 text-purple-300 text-xs font-black">
                    AI
                  </span>
                  Translate Subtitles
                </h3>
                <p className="text-xs text-muted mt-1">Translate the active subtitle track using OpenRouter.</p>
              </div>
              {!translatingSub && (
                <button 
                  onClick={() => setShowTranslateModal(false)}
                  className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center cursor-pointer transition-colors text-white/70 hover:text-white"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Error message */}
            {translationError && (
              <div className="bg-red-500/15 border border-red-500/20 rounded-xl p-3 mb-4 text-xs text-red-200 flex gap-2">
                <svg className="w-4 h-4 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" />
                </svg>
                <span>{translationError}</span>
              </div>
            )}

            {!openrouterApiKey ? (
              <div className="space-y-4">
                <div className="bg-yellow-500/10 border border-yellow-500/25 rounded-xl p-4 text-sm text-yellow-250 leading-relaxed">
                  OpenRouter API Key is not configured. Please go to Settings -&gt; Accounts &amp; API Keys to set up your OpenRouter credentials first.
                </div>
                <button
                  onClick={() => setShowTranslateModal(false)}
                  className="w-full py-2.5 bg-white/5 hover:bg-white/10 text-white rounded-xl text-sm font-semibold transition-colors cursor-pointer"
                >
                  Go Back
                </button>
              </div>
            ) : translatingSub ? (
              <div className="flex flex-col items-center justify-center py-10 space-y-4">
                <div className="w-10 h-10 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                <div className="text-center">
                  <p className="text-sm font-bold text-white">Translating Subtitles...</p>
                  <p className="text-xs text-muted mt-1 max-w-xs leading-relaxed">
                    Analyzing dialogue and generating translation via {openrouterModel}. This may take 10-20 seconds.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-muted font-bold uppercase tracking-wider">Select Target Language</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                  {APP_LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => handleTranslateSubtitle(lang.code, lang.name)}
                      className="flex items-center gap-2 p-2.5 bg-white/5 hover:bg-purple-500/15 border border-white/5 hover:border-purple-500/30 rounded-xl text-left transition-all cursor-pointer group"
                    >
                      <span className="text-sm">{lang.flag}</span>
                      <span className="text-xs font-semibold text-white/80 group-hover:text-white truncate">{lang.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  ), document.body)
}
