import { lazy, Suspense, useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { StreamResult, SubtitleResult } from '../types'
import { useAppStore, getLanguageCodeFromTrack, getLanguageNameFromTrack } from '../stores/appStore'
import { getAddonSubtitles, getStreamAddons, getSubtitleAddons } from '../services/addons'
import { streamPreloadManager, StreamPreloadPriority } from '../services/streams/preloadManager'
import NativeMpvPlayer from './NativeMpvPlayer'

// Lazy: keeps the heavy player stack out of page chunks â€” it only loads once
// the user actually starts playback.
const InAppPlayer = lazy(() => import('./InAppPlayer'))
import type { PlaybackItem } from '../services/simkl/playback'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import { getBestKnownTime as wtBestKnownTime, play as wtPlay, useManualLocalSource as wtUseManualLocalSource } from '../services/watch-together/wsClient'
import { getPlayableStreamUrl } from '../services/streams/playableUrl'
import { getPlayerSnapshot, stopEmbeddedPlayer } from '../services/player'
import { useNativePlayerSupported } from '../hooks/useNativePlayerSupported'
import { rankStreams, type SmartPlayMode, type SmartStream } from '../services/streams/smartScoring'
import { SmartFallbackQueue } from '../services/streams/smartFallback'
import { recordReliabilityEvent } from '../services/streams/reliabilityHistory'
import { classifyPlaybackFailure, diagnosticForStream, recoveryCandidates, type SourceDiagnostic } from '../services/streams/playbackHealth'
import { buildSmartContext, preparedStreamRegistry, type PreparedStream } from '../services/streams/preparedStreams'
import { canonicalStreamKey } from '../services/streams/preloadUtils'
import { probeStreamUrl } from '../services/streams/streamProbe'
import { cachedImage } from '../services/imageCache'
import { annotateTorBoxStreams, isTorBoxCachedStream, isTorBoxConnected, resolveTorBoxStream } from '../services/torbox'
import { loadPlaybackMemory, playbackMemoryKey, seriesPlaybackMemoryKey, recordPlaybackPreference } from '../services/streams/playbackMemory'
import { cacheClearCategory } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'

interface AddonStream extends StreamResult {
  addonName: string
  addonId: string
}

function isDiagnosticStream(stream: AddonStream): boolean {
  const text = [stream.name, stream.title, stream.description].filter(Boolean).join(' ')
  return /scrape summary|removal reasons|status\s*:\s*success|successfully fetched streams/i.test(text)
}

interface StreamSelectorProps {
  open: boolean
  onClose: () => void
  mediaType: 'movie' | 'series'
  mediaId: string
  title: string
  artwork?: {
    poster?: string
    backdrop?: string
  }
  seasonEpisode?: { season: number; episode: number }
  startTime?: number
  tmdbId?: number
  tvdbId?: number | string
  malId?: number
  anilistId?: number
  sourceAddonId?: string
  sourceAddonItemId?: string
  onResolvingChange?: (resolving: boolean) => void
}

type FilterGroupId = 'quality' | 'resolution' | 'visual' | 'audio' | 'source'

interface StreamFilterOption {
  id: string
  label: string
  token: RegExp
  badge?: string
}

const STREAM_FILTER_GROUPS: { id: FilterGroupId; title: string; options: StreamFilterOption[] }[] = [
  {
    id: 'quality',
    title: 'Quality',
    options: [
      { id: 'remux', label: 'Remux', token: /\bremux\b/i },
      { id: 'bluray', label: 'BluRay', token: /\bblu[-\s]?ray|bdrip|brrip\b/i },
      { id: 'webdl', label: 'WebDL', token: /\bweb[-\s]?dl|webdl|web\b/i },
      { id: 'webrip', label: 'WebRip', token: /\bweb[-\s]?rip|webrip\b/i },
    ],
  },
  {
    id: 'resolution',
    title: 'Resolution',
    options: [
      { id: '4k', label: '4K', token: /\b(4k|2160p|uhd)\b/i },
      { id: '1080p', label: '1080p', token: /\b1080p\b/i },
      { id: '720p', label: '720p', token: /\b720p\b/i },
      { id: '480p', label: '480p', token: /\b480p\b/i },
    ],
  },
  {
    id: 'visual',
    title: 'Visual',
    options: [
      { id: 'seadex', label: 'SeaDex', token: /\bseadex\b/i },
      { id: 'hdr10plus', label: 'HDR10+', token: /\bhdr10\+|hdr10plus\b/i },
      { id: 'hdr10', label: 'HDR10', token: /\bhdr10\b/i },
      { id: 'hdr', label: 'HDR', token: /\bhdr\b/i },
      { id: 'dv', label: 'Dolby Vision', token: /\bdv\b|dolby\s*vision/i, badge: 'DV' },
      { id: 'imax', label: 'IMAX', token: /\bimax\b/i },
    ],
  },
  {
    id: 'audio',
    title: 'Audio',
    options: [
      { id: 'atmos', label: 'Atmos', token: /\batmos\b/i },
      { id: 'truehd', label: 'TrueHD', token: /\btruehd\b/i },
      { id: 'ddp', label: 'DD+', token: /\bddp|dd\+|eac3|e-ac-3\b/i },
      { id: 'dts', label: 'DTS', token: /\bdts|dts[-\s]?hd\b/i },
      { id: '51', label: '5.1', token: /\b5\.1\b/i },
      { id: '71', label: '7.1', token: /\b7\.1\b/i },
    ],
  },
  {
    id: 'source',
    title: 'Source',
    options: [
      { id: 'direct', label: 'Direct', token: /\bdirect\b/i },
      { id: 'hls', label: 'HLS', token: /\bhls|m3u8\b/i },
      { id: 'torrent', label: 'Torrent', token: /\btorrent|infohash|magnet\b/i },
    ],
  },
]

export default function StreamSelector({ open, onClose, mediaType, mediaId, title, artwork, seasonEpisode, startTime, tmdbId, tvdbId, malId, anilistId, sourceAddonId, sourceAddonItemId, onResolvingChange }: StreamSelectorProps) {
  const nativePlayerAvailable = useNativePlayerSupported()
  const [streams, setStreams] = useState<AddonStream[]>([])
  const [loading, setLoading] = useState(true)
  const [playError, setPlayError] = useState('')
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [playback, setPlayback] = useState<{ url: string; stream: AddonStream; startTime?: number } | null>(null)
  const [smartMode, setSmartMode] = useState<SmartPlayMode>(() => (localStorage.getItem('aurales_smart_play_mode') as SmartPlayMode) || 'best')
  const [smartStatus, setSmartStatus] = useState('')
  const [sourceDiagnostics, setSourceDiagnostics] = useState<Record<string, SourceDiagnostic>>({})
  const [selectedProvider, setSelectedProvider] = useState<string>('all')
  const [refreshRevision, setRefreshRevision] = useState(0)
  const smartQueueRef = useRef<SmartFallbackQueue<AddonStream> | null>(null)
  const smartActiveRef = useRef(false)
  const autoSmartStartedRef = useRef(false)
  const manualSelectionRequestedRef = useRef(false)
  const startSmartPlayRef = useRef<() => void>(() => {})
  const handlePlayRef = useRef<(stream: AddonStream, index: number, urlOverride?: string, recoveryStartTime?: number) => void>(() => {})
  const fastPathTriedRef = useRef(false)
  const pendingSmartFallbackRef = useRef<AddonStream | null>(null)
  const warmedStreamUrlsRef = useRef(new Map<string, string>())
  const warmingStreamUrlsRef = useRef(new Set<string>())
  const resumeSmartFallbackRef = useRef<(failed: AddonStream) => void>(() => {})
  const hadPlaybackRef = useRef(false)
  const playbackEvidenceTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleResult[]>([])
  const addons = useAppStore((s) => s.addons)
  const autoPlayFirstStream = useAppStore((s) => s.autoPlayFirstStream)
  const preferredAudio = useAppStore((s) => s.preferredAudio)
  const preferredSubtitles = useAppStore((s) => s.preferredSubtitles)
  const automaticStreamRecovery = useAppStore((s) => s.automaticStreamRecovery)
  const sessionFailedSourcesRef = useRef(new Set<string>())
  const sessionFailedAddonsRef = useRef(new Map<string, number>())

  const [showStreamName, setShowStreamName] = useState(() => localStorage.getItem('orynt_stream_show_name') !== 'false')
  const [showStreamDesc, setShowStreamDesc] = useState(() => localStorage.getItem('orynt_stream_show_desc') !== 'false')
  const [showStreamTags, setShowStreamTags] = useState(() => localStorage.getItem('orynt_stream_show_tags') !== 'false')

  const toggleStreamName = () => setShowStreamName((visible) => {
    localStorage.setItem('orynt_stream_show_name', String(!visible))
    return !visible
  })
  const toggleStreamDesc = () => setShowStreamDesc((visible) => {
    localStorage.setItem('orynt_stream_show_desc', String(!visible))
    return !visible
  })
  const toggleStreamTags = () => setShowStreamTags((visible) => {
    localStorage.setItem('orynt_stream_show_tags', String(!visible))
    return !visible
  })

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) {
      hadPlaybackRef.current = !!playback
      return
    }
    if (hadPlaybackRef.current && !playback) {
      stopEmbeddedPlayer().catch(() => {})
    }
    hadPlaybackRef.current = !!playback
  }, [playback])

  useEffect(() => {
    return () => {
      if (playbackEvidenceTimerRef.current) window.clearTimeout(playbackEvidenceTimerRef.current)
      if (hadPlaybackRef.current && (window as any).__TAURI_INTERNALS__) {
        stopEmbeddedPlayer().catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    if (!open || !mediaId) return
    if (playback) return
    setStreams([])
    setLoading(true)
    setPlayError('')
    setPlayingIndex(null)
    setPlayback(null)
    setSubtitles([])
    setSourceDiagnostics({})
    sessionFailedSourcesRef.current.clear()
    sessionFailedAddonsRef.current.clear()

    const cleanMediaId = String(mediaId).trim().replace(/:(\d+):(\d+)$/, '')
    if (!cleanMediaId) {
      setPlayError('This Continue Watching item has no valid media ID. Open its detail page and play it once to refresh progress data.')
      setLoading(false)
      return
    }
    const makeStreamId = (baseId: string) => seasonEpisode && !/:\d+:\d+$/.test(baseId)
      ? `${baseId}:${seasonEpisode.season}:${seasonEpisode.episode}`
      : baseId

    // Merge installed addons (in-memory map) with store addons
    const installedStream = getStreamAddons(mediaType)
    const storeStream = addons.filter((a) => a.enabled)

    const seenUrls = new Set<string>()
    const allAddons = [...installedStream]
    for (const a of allAddons) seenUrls.add(a.url)
    for (const a of storeStream) {
      if (!seenUrls.has(a.url)) allAddons.push(a)
    }

    if (allAddons.length === 0) {
      setLoading(false)
      return
    }

    streamPreloadManager.request({
      mediaType,
      mediaId: cleanMediaId,
      tmdbId,
      seasonEpisode,
      sourceAddonId,
      sourceAddonItemId,
    }, {
      priority: StreamPreloadPriority.PLAYBACK,
      onUpdate: (results, status) => {
        setStreams(results)
        if (results.length > 0 || status.complete) setLoading(false)
      },
    }).then((results) => {
      setStreams(results)
      setLoading(false)
    }).catch(() => setLoading(false))

    const subtitleAddons = getSubtitleAddons(mediaType)
    const subtitleSeenUrls = new Set(seenUrls)
    const allSubAddons = [...allAddons]
    for (const a of subtitleAddons) {
      if (!subtitleSeenUrls.has(a.url)) { allSubAddons.push(a); subtitleSeenUrls.add(a.url) }
    }

    const subtitleBaseIds = Array.from(new Set([
      sourceAddonItemId,
      cleanMediaId,
      tmdbId ? `tmdb:${tmdbId}` : undefined,
      tvdbId ? `tvdb:${tvdbId}` : undefined,
    ].filter((id): id is string => Boolean(id))))

    Promise.all(allSubAddons.flatMap((addon) => subtitleBaseIds.map(async (baseId) => {
      try {
        const streamId = makeStreamId(baseId)
        const tracks = await getAddonSubtitles(addon.url, mediaType, streamId)
        return tracks.map((track) => ({
          ...track,
          label: track.label || getLanguageNameFromTrack(track.lang),
          source: 'addon' as const,
          addonName: addon.manifest.name,
        }))
      } catch (_) {
        return []
      }
    }))).then((results) => {
      const unique = results.flat().filter((subtitle, index, all) =>
        all.findIndex((candidate) => candidate.url === subtitle.url && candidate.lang === subtitle.lang) === index
      )
      setSubtitles(unique)
    })
  }, [open, mediaId, mediaType, seasonEpisode, addons, sourceAddonId, sourceAddonItemId, playback, refreshRevision])

  useEffect(() => {
    const unchecked = isTorBoxConnected() && streams.some((stream) => stream.infoHash && stream.behaviorHints?.torboxChecked !== true)
    if (!unchecked) return
    let cancelled = false
    annotateTorBoxStreams(streams).then((annotated) => {
      if (!cancelled) setStreams(annotated as AddonStream[])
    }).catch(() => {
      if (!cancelled) setStreams((current) => current.map((stream) => stream.infoHash ? {
        ...stream,
        behaviorHints: { ...stream.behaviorHints, torboxChecked: true, torboxCached: false },
      } : stream))
    })
    return () => { cancelled = true }
  }, [streams])

  const getPlayableUrl = (stream: AddonStream): string | null => {
    return getPlayableStreamUrl(stream)
  }

  const getStreamHeading = (stream: AddonStream, index: number): string => {
    return stream.name || stream.title?.split('\n')[0] || `Stream ${index + 1}`
  }

  const getStreamDescription = (stream: AddonStream): string | null => {
    const heading = stream.name || ''
    const looksLikeRawFile = (value: string) => {
      // Filter out absolute URLs
      if (value.startsWith('http://') || value.startsWith('https://')) return true
      // Filter out magnet links
      if (value.startsWith('magnet:?')) return true
      // Filter out absolute Windows paths (e.g. C:\path or \\server\path)
      if (/^[a-zA-Z]:\\/i.test(value) || value.startsWith('\\\\')) return true
      // Filter out absolute Unix paths ending with a dot-extension
      if (value.startsWith('/') && /\.[a-z0-9]+$/i.test(value)) return true
      // Filter out raw hashes (e.g. infohashes or long hex strings)
      if (/^[a-f0-9]{20,}$/i.test(value)) return true
      return false
    }
    const values = [
      stream.description,
      stream.title,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .filter((value) => !looksLikeRawFile(value))
      .filter((value, index, all) => value !== heading && all.indexOf(value) === index)

    if (false && values.length === 0 && stream.url) {
      try {
        const parsed = new URL(stream.url || '')
        values.push(`${parsed.hostname}${parsed.pathname.split('/').pop() ? ` Â· ${decodeURIComponent(parsed.pathname.split('/').pop() || '')}` : ''}`)
      } catch (_) {
        // ignore invalid display URLs
      }
    }

    return values.length ? values.join('\n') : 'No extended description was returned by this addon for this stream.'
  }

  const streamText = (stream: AddonStream): string => {
    const behaviorHints = stream.behaviorHints || {}
    return [
      stream.name,
      stream.title,
      stream.description,
      stream.filename,
      behaviorHints.filename,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
  }

  const getFilterText = (stream: AddonStream): string => {
    return [
      streamText(stream),
      stream.addonName,
      stream.url?.includes('.m3u8') ? 'hls' : stream.url ? 'direct' : '',
      stream.infoHash ? 'torrent infohash' : '',
    ].filter(Boolean).join(' ')
  }

  const getStreamSubtitles = (stream: AddonStream): SubtitleResult[] => {
    const behaviorHints = stream.behaviorHints || {}
    const hinted = Array.isArray(behaviorHints.subtitles) ? behaviorHints.subtitles : []
    const fromStream = Array.isArray(stream.subtitles) ? stream.subtitles : []
    return [...fromStream, ...hinted]
      .filter((subtitle): subtitle is SubtitleResult => {
        if (!subtitle || typeof subtitle !== 'object') return false
        return typeof (subtitle as SubtitleResult).url === 'string'
      })
      .map((subtitle, index) => {
        const raw = subtitle as SubtitleResult & { language?: string; languageCode?: string; title?: string; name?: string }
        const lang = raw.lang || raw.language || raw.languageCode || 'und'
        let subtitleUrl = raw.url
        try { subtitleUrl = new URL(raw.url, stream.url || window.location.href).toString() } catch (_) { /* keep original */ }
        return {
          id: raw.id || `stream-sub-${index}`,
          url: subtitleUrl,
          lang,
          label: raw.label || raw.title || raw.name || getLanguageNameFromTrack(lang) || `Stream subtitle ${index + 1}`,
          source: 'stream' as const,
        }
      })
  }

  const mergeSubtitles = (stream: AddonStream): SubtitleResult[] => {
    const allSubs = [...getStreamSubtitles(stream), ...subtitles].filter((subtitle, index, all) =>
      all.findIndex((candidate) => candidate.url === subtitle.url && candidate.lang === subtitle.lang) === index
    )

    const preferredSubtitles = useAppStore.getState().preferredSubtitles || ['en']
    return allSubs.sort((a, b) => {
      const aLang = a.lang ? a.lang.toLowerCase() : ''
      const bLang = b.lang ? b.lang.toLowerCase() : ''

      const aCode = getLanguageCodeFromTrack(aLang)
      const bCode = getLanguageCodeFromTrack(bLang)

      const aIdx = aCode ? preferredSubtitles.indexOf(aCode) : -1
      const bIdx = bCode ? preferredSubtitles.indexOf(bCode) : -1

      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
      if (aIdx !== -1) return -1
      if (bIdx !== -1) return 1
      return 0
    })
  }

  const getStreamBadges = (stream: AddonStream): string[] => {
    const badges: string[] = []
    if (stream.url && stream.url.includes('.m3u8')) badges.push('HLS')
    if (stream.externalUrl) badges.push('External')
    if (stream.ytId) badges.push('YouTube')
    if (stream.infoHash) badges.push('Torrent')
    if (isTorBoxCachedStream(stream)) badges.push('TorBox Cached')
    if (typeof stream.fileIdx === 'number') badges.push(`File ${stream.fileIdx + 1}`)
    return badges
  }

  const matchedFilterLabels = (stream: AddonStream): string[] => {
    const text = getFilterText(stream)
    return STREAM_FILTER_GROUPS.flatMap((group) =>
      group.options
        .filter((option) => option.token.test(text))
        .map((option) => option.badge || option.label)
    ).slice(0, 8)
  }

  const filteredStreams = useMemo(
    () => streams.filter((stream) => (Boolean(getPlayableStreamUrl(stream)) || isTorBoxCachedStream(stream)) && !isDiagnosticStream(stream)),
    [streams],
  )
  const torBoxChecking = isTorBoxConnected() && streams.some((stream) => stream.infoHash && stream.behaviorHints?.torboxChecked !== true)

  const providerOptions = useMemo(() => Array.from(new Map(
    filteredStreams.map((stream) => [stream.addonId, stream.addonName] as const)
  ).entries()), [filteredStreams])

  const providerStreams = useMemo(() => selectedProvider === 'all'
    ? filteredStreams
    : filteredStreams.filter((stream) => stream.addonId === selectedProvider), [filteredStreams, selectedProvider])

  const visibleStreams = useMemo(() => selectedProvider === 'all'
    ? filteredStreams
    : filteredStreams.filter((stream) => stream.addonId === selectedProvider), [filteredStreams, selectedProvider])

  useEffect(() => {
    if (selectedProvider !== 'all' && !providerOptions.some(([id]) => id === selectedProvider)) {
      setSelectedProvider('all')
    }
  }, [providerOptions, selectedProvider])

  // Memoize merged subtitles â€” must be before any early return (rules of hooks).
  // Keeps the array reference stable so NativeMpvPlayer's loadAddonSubtitles
  // useCallback isn't recreated on every StreamSelector re-render.
  const mergedSubtitles = useMemo(
    () => (playback ? mergeSubtitles(playback.stream) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playback?.stream, subtitles]
  )

  // Fast path: a prepared (ranked + probed) stream from the detail-page dwell
  // lets playback start before the addon fetch even settles. The fetch effect
  // above has already kicked off, so streams/subtitles still arrive for the
  // fallback queue.
  useEffect(() => {
    if (!open || playback || !autoPlayFirstStream || manualSelectionRequestedRef.current || autoSmartStartedRef.current || fastPathTriedRef.current) return
    fastPathTriedRef.current = true
    const cleanMediaId = String(mediaId).trim().replace(/:(\d+):(\d+)$/, '')
    if (!cleanMediaId) return
    const request = { mediaType, mediaId: cleanMediaId, tmdbId, seasonEpisode }
    const playPrepared = (prepared: PreparedStream) => {
      autoSmartStartedRef.current = true
      smartActiveRef.current = true
      smartQueueRef.current = null // backfilled on demand if this stream fails
      setSmartStatus(`Instant play from ${prepared.stream.addonName}`)
      handlePlayRef.current(prepared.stream as AddonStream, -1, prepared.playableUrl)
    }
    const ready = preparedStreamRegistry.consume(canonicalStreamKey(request))
    if (ready) { playPrepared(ready); return }
    // Not ready yet (Play clicked before the detail-page prepare finished, or
    // no dwell happened at all): join/start the prepare and race it against
    // the ranked smart-play path — whichever settles first starts playback.
    let cancelled = false
    void Promise.race([
      preparedStreamRegistry.prepare(request, { title, priority: StreamPreloadPriority.PLAYBACK }),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 3_000)),
    ]).then((prepared) => {
      if (cancelled || !prepared) return
      if (autoSmartStartedRef.current || manualSelectionRequestedRef.current || hadPlaybackRef.current) return
      preparedStreamRegistry.consume(prepared.mediaKey)
      playPrepared(prepared)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [open, playback, autoPlayFirstStream, mediaId, mediaType, seasonEpisode, tmdbId])

  useEffect(() => {
    if (!open || loading || torBoxChecking || playback || !autoPlayFirstStream || manualSelectionRequestedRef.current || filteredStreams.length === 0 || autoSmartStartedRef.current) return
    autoSmartStartedRef.current = true
    startSmartPlayRef.current()
  }, [open, loading, torBoxChecking, playback, autoPlayFirstStream, filteredStreams.length])

  // A fast-path stream failed before the addon results had arrived: resume the
  // smart fallback as soon as there is something to fall back to.
  useEffect(() => {
    if (!pendingSmartFallbackRef.current || filteredStreams.length === 0) return
    const failed = pendingSmartFallbackRef.current
    pendingSmartFallbackRef.current = null
    resumeSmartFallbackRef.current(failed)
  }, [filteredStreams.length])

  useEffect(() => {
    const resolving = open && autoPlayFirstStream && !manualSelectionRequestedRef.current && !playback && (loading || torBoxChecking || streams.length > 0)
    onResolvingChange?.(resolving)
    return () => onResolvingChange?.(false)
  }, [open, autoPlayFirstStream, playback, loading, torBoxChecking, streams.length, onResolvingChange])

  useEffect(() => {
    if (!open) return
    autoSmartStartedRef.current = false
    manualSelectionRequestedRef.current = false
    fastPathTriedRef.current = false
    pendingSmartFallbackRef.current = null
  }, [open, mediaId, seasonEpisode?.season, seasonEpisode?.episode, refreshRevision])

  if (!open) return null


  const handlePlay = async (stream: AddonStream, index: number, urlOverride?: string, recoveryStartTime?: number) => {
    const originalUrl = getPlayableUrl(stream)
    setPlayingIndex(index)
    setPlayError('')
    let url = urlOverride || (originalUrl ? warmedStreamUrlsRef.current.get(originalUrl) : undefined) || originalUrl
    try {
      if (!url && stream.infoHash) {
        setSmartStatus('Preparing cached TorBox stream…')
        url = await resolveTorBoxStream(stream, { title, season: seasonEpisode?.season, episode: seasonEpisode?.episode })
      }
    } catch (error) {
      setPlayingIndex(null)
      setPlayError(error instanceof Error ? error.message : String(error))
      return
    }
    if (!url) {
      setPlayingIndex(null)
      setPlayError('This stream is not a direct playable video URL. Connect TorBox for cached torrent streams or pick a direct source.')
      return
    }

    const wtState = useWatchTogetherStore.getState()
    if (wtState.currentRoom) {
      if (!wtState.isHost || !wtState.currentRoom.selectedMedia) {
        setPlayingIndex(null)
        setPlayError(wtState.isHost
          ? 'Choose “Watch in Room” for this title before selecting a room source.'
          : 'Only the host can replace the local room source manually.')
        return
      }
      wtUseManualLocalSource({
        stream,
        addonId: stream.addonId,
        addonName: stream.addonName,
        playableUrl: url,
        score: Number.MAX_SAFE_INTEGER,
        reasons: ['manual selection'],
      })
      onClose()
      wtPlay(Math.max(startTime ?? 0, wtBestKnownTime()))
      return
    }

    setPlayback({ url, stream, startTime: recoveryStartTime ?? startTime })
    setPlayingIndex(null)
  }

  const warmManualStream = (stream: AddonStream) => {
    const url = getPlayableUrl(stream)
    if (!url || warmedStreamUrlsRef.current.has(url) || warmingStreamUrlsRef.current.has(url) || warmingStreamUrlsRef.current.size >= 2) return
    warmingStreamUrlsRef.current.add(url)
    probeStreamUrl(url, 2_500).then((probe) => {
      if (probe?.ok) warmedStreamUrlsRef.current.set(url, probe.finalUrl || url)
    }).finally(() => warmingStreamUrlsRef.current.delete(url))
  }

  const rankSelectorStreams = (candidates: AddonStream[]): AddonStream[] =>
    rankStreams(candidates as SmartStream[], buildSmartContext({
      title, season: seasonEpisode?.season, episode: seasonEpisode?.episode, subtitles, mode: smartMode,
      playbackMemories: (() => {
        const memory = loadPlaybackMemory()
        const exact = playbackMemoryKey(mediaType, String(tmdbId || mediaId), seasonEpisode?.season, seasonEpisode?.episode)
        const series = mediaType === 'series' ? seriesPlaybackMemoryKey(String(tmdbId || mediaId)) : undefined
        return [memory[exact], series ? memory[series] : undefined].filter((value): value is NonNullable<typeof value> => Boolean(value))
      })(),
    })).filter((candidate) => candidate.score > -500).map((candidate) => candidate.stream as AddonStream)

  const selectorMediaKey = (): string => canonicalStreamKey({
    mediaType, mediaId: String(mediaId).trim().replace(/:(\d+):(\d+)$/, ''), tmdbId, seasonEpisode,
  })

  const startSmartPlay = () => {
    const ranked = rankSelectorStreams(providerStreams)
    // A validated prepared stream beats pure heuristics: move it to the front
    // and play it via its probed (post-redirect) URL.
    let urlOverride: string | undefined
    const prepared = preparedStreamRegistry.peek(selectorMediaKey())
    if (prepared?.stream.url) {
      const index = ranked.findIndex((candidate) => candidate.url === prepared.stream.url)
      if (index >= 0) {
        if (index > 0) ranked.unshift(ranked.splice(index, 1)[0])
        urlOverride = prepared.playableUrl
        preparedStreamRegistry.consume(prepared.mediaKey)
      }
    }
    smartQueueRef.current = new SmartFallbackQueue(ranked)
    smartActiveRef.current = true
    const first = smartQueueRef.current.next()
    if (!first) { setPlayError('No playable streams were found.'); return }
    setSmartStatus(`Smart Play selected ${first.addonName}`)
    handlePlay(first, streams.indexOf(first), urlOverride)
  }
  const retryFailedSources = () => {
    const addonIds = Object.values(sourceDiagnostics).filter((diagnostic) => diagnostic.failureReason).map((diagnostic) => diagnostic.addonId)
    if (!addonIds.length) return
    setSmartStatus('Retrying failed sources…')
    void streamPreloadManager.retryAddons({ mediaType, mediaId: String(mediaId).trim().replace(/:(\d+):(\d+)$/, ''), tmdbId, seasonEpisode, sourceAddonId, sourceAddonItemId }, addonIds).then((fresh) => {
      setStreams((current) => [...current.filter((stream) => !addonIds.includes(stream.addonId)), ...fresh])
      setSourceDiagnostics((current) => Object.fromEntries(Object.entries(current).filter(([addonId]) => !addonIds.includes(addonId))))
      setSmartStatus(fresh.length ? 'Failed sources responded with fresh results.' : 'Failed sources did not return playable results.')
    })
  }
  startSmartPlayRef.current = startSmartPlay
  handlePlayRef.current = handlePlay

  const resumeSmartFallback = (failed: AddonStream) => {
    if (!smartActiveRef.current) return
    const ranked = recoveryCandidates(rankSelectorStreams(providerStreams), sessionFailedSourcesRef.current, sessionFailedAddonsRef.current)
    smartQueueRef.current = new SmartFallbackQueue(ranked)
    const next = smartQueueRef.current.next()
    if (!next) { smartActiveRef.current = false; setSmartStatus('No more working streams were found.'); return }
    setSmartStatus(`Stream failed — trying ${next.addonName}`)
    handlePlay(next, streams.indexOf(next))
  }
  resumeSmartFallbackRef.current = resumeSmartFallback

  const handlePlaybackError = (message?: string, positionSeconds?: number) => {
    if (!playback) return
    if (playbackEvidenceTimerRef.current) window.clearTimeout(playbackEvidenceTimerRef.current)
    const reason = classifyPlaybackFailure(message)
    const state = /buffer|stutter|unstable/i.test(message || '') ? 'UNSTABLE' : 'FAILED'
    const diagnostic = diagnosticForStream(playback.stream, state, reason, undefined, sourceDiagnostics[playback.stream.addonId])
    setSourceDiagnostics((current) => ({ ...current, [playback.stream.addonId]: diagnostic }))
    sessionFailedSourcesRef.current.add(diagnostic.sourceFingerprint)
    sessionFailedAddonsRef.current.set(playback.stream.addonId, (sessionFailedAddonsRef.current.get(playback.stream.addonId) || 0) + 1)
    recordReliabilityEvent(playback.stream, state === 'UNSTABLE' ? 'unstable' : 'failed_start')
    const key = playbackMemoryKey(mediaType, String(tmdbId || mediaId), seasonEpisode?.season, seasonEpisode?.episode)
    recordPlaybackPreference(key, playback.stream, 'failure', { audioLanguage: preferredAudio[0], subtitleLanguage: preferredSubtitles[0] })
    if (!smartActiveRef.current || !automaticStreamRecovery) return
    if (!smartQueueRef.current) {
      // Fast path started before the addon fetch settled — build the fallback
      // queue now, or wait for results if none have arrived yet.
      if (filteredStreams.length === 0) { pendingSmartFallbackRef.current = playback.stream; return }
      resumeSmartFallback(playback.stream)
      return
    }
    const next = smartQueueRef.current.next()
    if (!next) { smartActiveRef.current = false; setSmartStatus('No more working streams were found.'); return }
    setSmartStatus('Stream interrupted — switching source…')
    const resumeAt = Math.max(0, positionSeconds ?? playback.startTime ?? startTime ?? 0)
    void getPlayerSnapshot().then((snapshot) => handlePlay(next, streams.indexOf(next), undefined, Math.max(resumeAt, snapshot.timePos ?? 0))).catch(() => handlePlay(next, streams.indexOf(next), undefined, resumeAt))
  }

  const handlePlaybackStarted = () => {
    if (playback) {
      recordReliabilityEvent(playback.stream, 'success')
      setSourceDiagnostics((current) => ({ ...current, [playback.stream.addonId]: diagnosticForStream(playback.stream, 'HEALTHY', undefined, undefined, current[playback.stream.addonId]) }))
    }
    // Player startup alone is weak evidence. A stream only becomes a durable
    // preference after it has survived two minutes without Smart Play needing
    // to fall back; URLs themselves are never retained.
    if (playback) {
      if (playbackEvidenceTimerRef.current) window.clearTimeout(playbackEvidenceTimerRef.current)
      const observed = playback
      playbackEvidenceTimerRef.current = window.setTimeout(() => {
        if (playback !== observed) return
        const prefs = { audioLanguage: preferredAudio[0], subtitleLanguage: preferredSubtitles[0] }
        const exact = playbackMemoryKey(mediaType, String(tmdbId || mediaId), seasonEpisode?.season, seasonEpisode?.episode)
        recordPlaybackPreference(exact, observed.stream, 'success', prefs)
        if (mediaType === 'series') recordPlaybackPreference(seriesPlaybackMemoryKey(String(tmdbId || mediaId)), observed.stream, 'success', prefs)
      }, 120_000)
    }
    if (smartActiveRef.current) setSmartStatus(`Playback resumed · ${playback?.stream.addonName || 'the best source'}`)
  }

  const reportBad = () => {
    if (!playback) return
    recordReliabilityEvent(playback.stream, 'reported_bad')
    setSmartStatus('Bad stream reported; choosing another source.')
    handlePlaybackError()
  }

  const pickAnotherManually = () => {
    autoSmartStartedRef.current = true
    manualSelectionRequestedRef.current = true
    smartActiveRef.current = false
    setPlayback(null)
  }

  const displayTitle = seasonEpisode
    ? `${title} S${seasonEpisode.season}E${seasonEpisode.episode}`
    : title

  if (playback) {
    if (nativePlayerAvailable === undefined) return null
    const isAnimePlayback = Boolean(anilistId || malId)
    const simklMediaType: 'movie' | 'show' | 'anime' = isAnimePlayback ? 'anime' : mediaType === 'series' ? 'show' : 'movie'
    const playbackItem: PlaybackItem = {
      localId: String(mediaId).trim().replace(/:(\d+):(\d+)$/, ''),
      title,
      type: simklMediaType,
      mediaType: simklMediaType,
      contentType: mediaType,
      isAnime: isAnimePlayback,
      // imdbId derived from mediaId if it looks like an IMDB id
      imdbId: mediaId.startsWith('tt') ? mediaId : undefined,
      tmdbId: tmdbId || (mediaId.startsWith('tmdb-') ? Number(mediaId.replace('tmdb-', '')) : undefined),
      // tvdbId enables the TVDBâ†’AniList/PMDB episode mapping during scrobbling
      tvdbId: tvdbId != null
        ? Number(String(tvdbId).replace('tvdb-', ''))
        : mediaId.startsWith('tvdb-') ? Number(mediaId.replace('tvdb-', '').split(':')[0]) : undefined,
      malId,
      anilistId,
      season: seasonEpisode?.season,
      episode: seasonEpisode?.episode,
    }

    if (nativePlayerAvailable) {
      return createPortal(
        <NativeMpvPlayer
          // A smart-play fallback is a new playback session, not merely a
          // source change. Remount so startup/error state from a failed mpv
          // attempt cannot immediately fail the next candidate as well.
          key={playback.url}
          url={playback.url}
          title={title}
          subtitle={seasonEpisode ? `From S${seasonEpisode.season} E${seasonEpisode.episode}` : undefined}
          subtitles={mergedSubtitles}
          playbackItem={playbackItem}
          startTime={playback.startTime}
          poster={artwork?.poster}
          backdrop={artwork?.backdrop}
          onClose={onClose}
          onPickAnother={pickAnotherManually}
          onPlaybackError={handlePlaybackError}
          onPlaybackStarted={handlePlaybackStarted}
          onReportBad={reportBad}
        />,
        document.body
      )
    }

    return createPortal(
      <Suspense fallback={null}>
        <InAppPlayer
          key={playback.url}
          url={playback.url}
          title={title}
          subtitle={seasonEpisode ? `From S${seasonEpisode.season} E${seasonEpisode.episode}` : undefined}
          subtitles={mergedSubtitles}
          playbackItem={playbackItem}
        startTime={playback.startTime}
          poster={artwork?.poster}
          backdrop={artwork?.backdrop}
          onClose={onClose}
          onPickAnother={pickAnotherManually}
          onPlaybackError={handlePlaybackError}
          onPlaybackStarted={handlePlaybackStarted}
          onReportBad={reportBad}
        />
      </Suspense>,
      document.body
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] overflow-hidden bg-[#070809] text-white" onClick={onClose}>
      {(artwork?.backdrop || artwork?.poster) && (
        <img
          src={cachedImage(artwork.backdrop || artwork.poster)}
          alt=""
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-55 blur-lg"
        />
      )}
      <div className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.55)_45%,rgba(0,0,0,0.72)_100%),linear-gradient(0deg,rgba(0,0,0,0.78)_0%,transparent_45%,rgba(0,0,0,0.35)_100%)]" />

      <div
        className="relative mx-auto flex h-full w-full max-w-[1320px] px-5 pb-5 pt-10 sm:px-7 sm:pb-7 lg:px-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex items-center justify-between gap-5 overflow-hidden rounded-3xl border border-white/[0.08] bg-black/45 px-4 py-3 shadow-2xl backdrop-blur-2xl sm:px-5">
            <div className="flex min-w-0 items-center gap-4">
              {artwork?.poster ? (
                <img src={cachedImage(artwork.poster)} alt="" className="hidden h-[72px] w-12 flex-shrink-0 rounded-xl object-cover shadow-xl ring-1 ring-white/10 sm:block" />
              ) : (
                <div className="hidden h-[72px] w-12 flex-shrink-0 rounded-xl bg-white/[0.05] sm:block" />
              )}
              <div className="min-w-0">
              <p className="mb-1 text-meta font-bold uppercase tracking-[0.26em] text-accent">Select source</p>
              <h2 className="truncate text-2xl font-black tracking-tight text-white sm:text-3xl">{displayTitle}</h2>
                <p className="mt-1 text-xs text-white/60">{filteredStreams.length ? `${filteredStreams.length} playable sources` : loading ? 'Searching your addons...' : 'No playable sources found'}</p>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center">
              <button onClick={onClose} aria-label="Close source selector" className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.06] text-white/65 transition-colors hover:bg-white/[0.12] hover:text-white">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          <div className="mb-3 flex min-h-12 flex-wrap items-center gap-2 rounded-2xl border border-white/[0.07] bg-[#111315]/90 p-2 shadow-xl">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              <button onClick={() => setSelectedProvider('all')} className={`flex-shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition-colors ${selectedProvider === 'all' ? 'bg-white text-black' : 'text-white/50 hover:bg-white/[0.06] hover:text-white'}`}>All ({filteredStreams.length})</button>
              {providerOptions.map(([id, name]) => (
                <button key={id} onClick={() => setSelectedProvider(id)} className={`flex-shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition-colors ${selectedProvider === id ? 'bg-white text-black' : 'text-white/50 hover:bg-white/[0.06] hover:text-white'}`}>{name} {sourceDiagnostics[id]?.failureReason ? '⚠' : '✓'} ({streams.filter((stream) => stream.addonId === id).length})</button>
              ))}
            </div>
            <div className="hidden h-6 w-px bg-white/[0.08] lg:block" />
            <button onClick={startSmartPlay} disabled={loading || providerStreams.length === 0} className="focus-ring rounded-xl bg-accent px-4 py-2 text-xs font-black text-black transition-transform active:scale-95 disabled:opacity-40">Smart Play</button>
            <button onClick={retryFailedSources} disabled={loading || !Object.values(sourceDiagnostics).some((diagnostic) => diagnostic.failureReason)} className="rounded-xl px-3 py-2 text-xs font-semibold text-white/60 hover:bg-white/[.06] hover:text-white disabled:opacity-40">Retry failed</button>
            <button onClick={() => { setSmartStatus('Refreshing sources…'); void cacheClearCategory(CACHE_CATEGORIES.STREAM_PRELOAD).finally(() => setRefreshRevision((value) => value + 1)) }} disabled={loading} className="rounded-xl px-3 py-2 text-xs font-semibold text-white/60 hover:bg-white/[.06] hover:text-white disabled:opacity-40">Refresh sources</button>
            {([['best', 'Best'], ['fastest', 'Fastest'], ['highest-quality', 'Quality'], ['smallest-file', 'Smallest']] as const).map(([mode, label]) => (
              <button key={mode} onClick={() => { setSmartMode(mode); localStorage.setItem('aurales_smart_play_mode', mode) }} className={`rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${smartMode === mode ? 'bg-white/[0.12] text-white' : 'text-white/60 hover:bg-white/[0.05] hover:text-white/70'}`}>{label}</button>
            ))}
            <div className="hidden h-6 w-px bg-white/[0.08] xl:block" />
            <span className="px-1 text-tag font-bold uppercase tracking-[0.18em] text-white/25">Show</span>
            {([
              ['Title', showStreamName, toggleStreamName],
              ['Description', showStreamDesc, toggleStreamDesc],
              ['Tags', showStreamTags, toggleStreamTags],
            ] as const).map(([label, visible, toggle]) => (
              <button
                key={label}
                type="button"
                onClick={toggle}
                aria-pressed={visible}
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-label font-semibold transition-colors ${
                  visible ? 'bg-white/[0.09] text-white/80' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/60'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${visible ? 'bg-accent' : 'bg-white/20'}`} />
                {label}
              </button>
            ))}
            {smartStatus && <span className="w-full px-2 pb-1 text-xs text-white/50">{smartStatus}</span>}
            {Object.values(sourceDiagnostics).filter((diagnostic): diagnostic is SourceDiagnostic & { failureReason: NonNullable<SourceDiagnostic['failureReason']> } => Boolean(diagnostic.failureReason)).map((diagnostic) => (
              <span key={diagnostic.sourceFingerprint} className="w-full px-2 pb-1 text-xs text-amber-200/70">{diagnostic.addonId}: {diagnostic.failureReason.replaceAll('_', ' ').toLowerCase()} {diagnostic.retryable ? '· retryable' : '· skipped for this session'}</span>
            ))}
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto pr-1" style={{ scrollbarWidth: 'none' }}>
          {autoPlayFirstStream && !manualSelectionRequestedRef.current && !playback && (
            <p className="px-2 pt-1 text-xs text-white/50">Smart Play is preparing a source. You can choose one manually below.</p>
          )}
          {loading && (
            <div className="col-span-full flex flex-col items-center justify-center gap-3 py-12">
              <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted">Fetching streams from addons...</p>
            </div>
          )}

          {!loading && filteredStreams.length === 0 && (
            <div className="col-span-full py-12 text-center">
              <p className="text-sm text-muted mb-1">No playable sources found</p>
              <p className="text-xs text-muted">
                {addons.length === 0
                  ? 'Install stream addons in Settings first'
                  : 'None of your addons returned streams for this title'}
              </p>
            </div>
          )}

          {playError && (
            <div className="col-span-full rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
              {playError}
            </div>
          )}

          {!loading && visibleStreams.map((stream, i) => {
            const playable = Boolean(getPlayableUrl(stream) || isTorBoxCachedStream(stream))
            const description = getStreamDescription(stream)
            const filterBadges = matchedFilterLabels(stream)
            return (
            <button
              key={`${stream.addonId}-${i}`}
              onMouseEnter={() => warmManualStream(stream)}
              onFocus={() => warmManualStream(stream)}
              onClick={() => {
                // A user choice must win over a background Smart Play probe.
                // Without this, the picker was hidden while automatic playback
                // was enabled, leaving no way to select a stream by hand.
                manualSelectionRequestedRef.current = true
                smartActiveRef.current = false
                recordReliabilityEvent(stream, 'preferred')
                handlePlay(stream, streams.indexOf(stream))
              }}
              aria-label={`Play ${getStreamHeading(stream, i)}`}
              className="group flex min-h-[82px] w-full items-start gap-4 rounded-2xl border border-white/[0.07] bg-[#151719]/90 px-4 py-3.5 text-left shadow-[0_10px_30px_rgba(0,0,0,0.22)] transition-all hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-[#1d2023] focus-visible:border-accent/50 focus-visible:outline-none"
            >
              <div className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border transition-colors ${
                playable ? 'border-white/[0.08] bg-white/[0.07] group-hover:border-accent/30 group-hover:bg-accent group-hover:text-black' : 'border-white/[0.04] bg-white/[0.03]'
              }`}>
                <svg className={`h-4 w-4 ${playable ? 'text-current' : 'text-muted'}`} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                {showStreamName && (
                  <div className="truncate text-lg font-extrabold tracking-tight text-white">
                    {getStreamHeading(stream, i)}
                  </div>
                )}
                {showStreamDesc && description && (
                  <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-white/60">
                    {description}
                  </p>
                )}
                {showStreamTags && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-white/60">
                    {filterBadges.map((badge) => (
                      <span key={`filter-${badge}`} className="rounded-md border border-white/[0.12] bg-white/[0.06] px-2 py-0.5 text-meta font-bold text-white/80">
                        {badge}
                      </span>
                    ))}
                    {getStreamBadges(stream).map((badge) => (
                      <span key={badge} className="rounded-md bg-white/[0.05] px-2 py-0.5 text-meta text-white/50">{badge}</span>
                    ))}
                  </div>
                )}
              </div>
              {playingIndex === i ? (
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <svg className={`w-4 h-4 transition-colors flex-shrink-0 ${
                  playable ? 'text-muted group-hover:text-accent' : 'text-muted/40'
                }`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </button>
          )})}
          </div>
        </div>

        {artwork?.poster && (
          <div className="hidden">
            <div className="overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.035] p-3 shadow-2xl backdrop-blur-2xl">
              <img src={cachedImage(artwork.poster)} alt="" className="aspect-[2/3] w-full rounded-2xl object-cover shadow-2xl" />
              <div className="px-1 pb-1 pt-4">
                <p className="text-meta font-bold uppercase tracking-[0.2em] text-white/50">{seasonEpisode ? `Season ${seasonEpisode.season} Â· Episode ${seasonEpisode.episode}` : 'Movie'}</p>
                <h3 className="mt-1.5 text-xl font-black leading-tight text-white">{title}</h3>
              </div>
            </div>
          </div>
        )}
      </div>

    </div>,
    document.body
  )
}
