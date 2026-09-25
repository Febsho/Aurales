import { lazy, Suspense, useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react'
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
import { rankStreamCandidates } from '../services/streams/nativeScoring'
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
import { getServerStreams } from '../services/serverIntegrations'
import { markPerformance, measurePerformance } from '../services/performanceMetrics'

interface AddonStream extends StreamResult {
  addonName: string
  addonId: string
}

function isDiagnosticStream(stream: AddonStream): boolean {
  const text = [stream.name, stream.title, stream.description].filter(Boolean).join(' ')
  return /scrape summary|removal reasons|status\s*:\s*success|successfully fetched streams/i.test(text)
}

function sourceIdentity(stream: AddonStream): string | null {
  if (stream.infoHash) return `torrent:${stream.infoHash}:${stream.fileIdx ?? 0}`
  const url = getPlayableStreamUrl(stream) ?? stream.externalUrl
  if (url) return `url:${url}`
  if (stream.ytId) return `youtube:${stream.ytId}`
  return null
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
  sourceConnectionId?: string
  sourceItemId?: string
  forceManualSelection?: boolean
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

export default function StreamSelector({ open, onClose, mediaType, mediaId, title, artwork, seasonEpisode, startTime, tmdbId, tvdbId, malId, anilistId, sourceAddonId, sourceAddonItemId, sourceConnectionId, sourceItemId, forceManualSelection = false, onResolvingChange }: StreamSelectorProps) {
  const nativePlayerAvailable = useNativePlayerSupported()
  const [streams, setStreams] = useState<AddonStream[]>([])
  const [loading, setLoading] = useState(true)
  const [playError, setPlayError] = useState('')
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [playback, setPlayback] = useState<{ url: string; stream: AddonStream; startTime?: number } | null>(null)
  const [smartMode, setSmartMode] = useState<SmartPlayMode>(() => (localStorage.getItem('aurales_smart_play_mode') as SmartPlayMode) || 'best')
  const [smartStatus, setSmartStatus] = useState('')
  const [sourceDiagnostics, setSourceDiagnostics] = useState<Record<string, SourceDiagnostic>>({})
  // Opening a mixed list makes identical releases from several addons look
  // like duplicates. Start with one provider; "All sources" remains an
  // explicit option for users who want to compare every result.
  const [selectedProvider, setSelectedProvider] = useState<string>('auto')
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
  const rankingGenerationRef = useRef(0)
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

  // A manual open must win before passive Smart Play effects get a chance to
  // consume a prepared source or start ranking. Layout effects run first.
  useLayoutEffect(() => {
    if (open) manualSelectionRequestedRef.current = forceManualSelection
  }, [open, forceManualSelection, mediaId, seasonEpisode?.season, seasonEpisode?.episode])

  const [showStreamName, setShowStreamName] = useState(() => localStorage.getItem('orynt_stream_show_name') !== 'false')
  const [showStreamDesc, setShowStreamDesc] = useState(() => localStorage.getItem('orynt_stream_show_desc') !== 'false')
  const [showStreamTags, setShowStreamTags] = useState(() => localStorage.getItem('orynt_stream_show_tags') !== 'false')
  const [showDisplaySettings, setShowDisplaySettings] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [selectedFilters, setSelectedFilters] = useState<string[]>([])
  const [expandedStream, setExpandedStream] = useState<string | null>(null)
  const selectorPanelRef = useRef<HTMLElement | null>(null)

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

    let cancelled = false
    let addonResults: AddonStream[] = []
    let serverResults: AddonStream[] = []
    let addonComplete = allAddons.length === 0
    let serverComplete = false
    const publish = () => {
      if (cancelled) return
      setStreams([...serverResults, ...addonResults])
      if (addonComplete && serverComplete) setLoading(false)
    }

    // Server failures are intentionally isolated from addons. The backend
    // returns direct-play/direct-stream candidates in the same shape as addon
    // streams, so selection, scoring, mpv, tracks, subtitles and chapters keep
    // using the established playback path.
    getServerStreams({
      mediaType,
      mediaId: cleanMediaId,
      tmdbId,
      tvdbId,
      malId,
      anilistId,
      season: seasonEpisode?.season,
      episode: seasonEpisode?.episode,
      sourceConnectionId,
      sourceItemId,
    }).then((results) => {
      serverResults = results
    }).catch(() => {}).finally(() => {
      serverComplete = true
      publish()
    })

    if (allAddons.length > 0) {
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
          addonResults = results
          if (status.complete) addonComplete = true
          publish()
        },
      }).then((results) => {
        addonResults = results
      }).catch(() => {}).finally(() => {
        addonComplete = true
        publish()
      })
    }

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
    return () => { cancelled = true }
  }, [open, mediaId, mediaType, seasonEpisode, addons, sourceAddonId, sourceAddonItemId, sourceConnectionId, sourceItemId, playback, refreshRevision, tmdbId, tvdbId, malId, anilistId])

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
      [
        stream.directPlay ? 'Direct Play' : stream.directStream ? 'Direct Stream' : stream.transcode ? 'Transcode' : undefined,
        stream.resolution,
        stream.videoCodec?.toUpperCase(),
        stream.audioCodec?.toUpperCase(),
        stream.container?.toUpperCase(),
        stream.hdr,
        stream.bitrate ? `${(stream.bitrate / 1_000_000).toFixed(1)} Mbps` : undefined,
      ].filter(Boolean).join(' · '),
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
      stream.resolution,
      stream.videoCodec,
      stream.audioCodec,
      stream.container,
      stream.hdr,
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
    () => streams.filter((stream) => (Boolean(getPlayableStreamUrl(stream)) || isTorBoxCachedStream(stream)) && !isDiagnosticStream(stream))
      // Addons occasionally return the same source more than once. Preserve
      // sources from different addons for comparison, but never render an
      // identical source twice from the same provider.
      .filter((stream, _index, candidates) => {
        const identity = sourceIdentity(stream)
        return !identity || candidates.findIndex((candidate) => candidate.addonId === stream.addonId && sourceIdentity(candidate) === identity) === _index
      }),
    [streams],
  )
  const torBoxChecking = isTorBoxConnected() && streams.some((stream) => stream.infoHash && stream.behaviorHints?.torboxChecked !== true)

  const providerOptions = useMemo(() => Array.from(new Map(
    filteredStreams.map((stream) => [stream.addonId, stream.addonName] as const)
  ).entries()), [filteredStreams])

  const activeProvider = selectedProvider === 'auto'
    ? providerOptions[0]?.[0] ?? 'all'
    : selectedProvider

  const providerStreams = useMemo(() => activeProvider === 'all'
    ? filteredStreams
    : filteredStreams.filter((stream) => stream.addonId === activeProvider), [filteredStreams, activeProvider])

  const visibleStreams = useMemo(() => providerStreams.filter((stream) => STREAM_FILTER_GROUPS.every((group) => {
    const selected = group.options.filter((option) => selectedFilters.includes(option.id))
    return selected.length === 0 || selected.some((option) => option.token.test(getFilterText(stream)))
  // getFilterText only reads the stream; the list and filter selection own this memo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [providerStreams, selectedFilters])

  const scoredStreams = useMemo(() => {
    const ranked = rankStreams(visibleStreams, buildSmartContext({
    title, season: seasonEpisode?.season, episode: seasonEpisode?.episode,
    subtitles, mode: smartMode,
    })).filter((candidate) => candidate.score > -500)
    // Best preserves the addon's own ordering; the other modes apply Aurales' sort.
    return smartMode === 'best'
      ? ranked.sort((a, b) => visibleStreams.indexOf(a.stream) - visibleStreams.indexOf(b.stream))
      : ranked
  }, [visibleStreams, title, seasonEpisode?.season, seasonEpisode?.episode, subtitles, smartMode])

  useEffect(() => {
    if (!open || loading || !scoredStreams.length) return
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body) selectorPanelRef.current?.querySelector<HTMLButtonElement>('[data-stream-choice]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, loading, scoredStreams.length])

  useEffect(() => {
    if (!open || playback) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === 'Escape' || event.key.toLowerCase() === 'b') && !selectorPanelRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, playback, onClose])

  useEffect(() => {
    if (selectedProvider !== 'auto' && selectedProvider !== 'all' && !providerOptions.some(([id]) => id === selectedProvider)) {
      setSelectedProvider('auto')
    }
  }, [providerOptions, selectedProvider])

  useEffect(() => {
    if (open) { setSelectedProvider('auto'); setSelectedFilters([]); setExpandedStream(null) }
  }, [open, mediaId, seasonEpisode?.season, seasonEpisode?.episode])

  useEffect(() => {
    if (!open || playback || !navigator.getGamepads) return
    let frame = 0
    let previous = -1
    const poll = () => {
      const pad = Array.from(navigator.getGamepads()).find(Boolean)
      const pressed = pad?.buttons.findIndex((button, index) => [0, 1, 12, 13].includes(index) && button.pressed) ?? -1
      if (pressed !== -1 && previous === -1) {
        const choices = Array.from(selectorPanelRef.current?.querySelectorAll<HTMLButtonElement>('[data-stream-choice]') ?? [])
        const current = choices.indexOf(document.activeElement as HTMLButtonElement)
        if (pressed === 12 || pressed === 13) choices[pressed === 13 ? Math.min(current + 1, choices.length - 1) : Math.max(current - 1, 0)]?.focus()
        if (pressed === 0) (document.activeElement instanceof HTMLButtonElement && selectorPanelRef.current?.contains(document.activeElement) ? document.activeElement : choices[0])?.click()
        if (pressed === 1) onClose()
      }
      previous = pressed
      frame = requestAnimationFrame(poll)
    }
    frame = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(frame)
  }, [open, playback, onClose])

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
    manualSelectionRequestedRef.current = forceManualSelection
    fastPathTriedRef.current = false
    pendingSmartFallbackRef.current = null
    rankingGenerationRef.current += 1
  }, [open, mediaId, seasonEpisode?.season, seasonEpisode?.episode, refreshRevision, forceManualSelection])

  if (!open) return null


  const handlePlay = async (stream: AddonStream, index: number, urlOverride?: string, recoveryStartTime?: number) => {
    if (!smartActiveRef.current && recoveryStartTime == null) markPerformance('player-play-request')
    markPerformance('stream-url-resolution-start')
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
    markPerformance('stream-url-ready')
    measurePerformance('stream-url-resolution', 'stream-url-resolution-start', 'stream-url-ready')

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

  const rankSelectorStreams = async (candidates: AddonStream[]): Promise<AddonStream[]> =>
    (await rankStreamCandidates(candidates as SmartStream[], buildSmartContext({
      title, season: seasonEpisode?.season, episode: seasonEpisode?.episode, subtitles, mode: smartMode,
      playbackMemories: (() => {
        const memory = loadPlaybackMemory()
        const exact = playbackMemoryKey(mediaType, String(tmdbId || mediaId), seasonEpisode?.season, seasonEpisode?.episode)
        const series = mediaType === 'series' ? seriesPlaybackMemoryKey(String(tmdbId || mediaId)) : undefined
        return [memory[exact], series ? memory[series] : undefined].filter((value): value is NonNullable<typeof value> => Boolean(value))
      })(),
    }), { cancelGroup: 'streams:selector', priority: 'playback' }))
      .filter((candidate) => candidate.score > -500)
      .map((candidate) => candidate.stream as AddonStream)

  const selectorMediaKey = (): string => canonicalStreamKey({
    mediaType, mediaId: String(mediaId).trim().replace(/:(\d+):(\d+)$/, ''), tmdbId, seasonEpisode,
  })

  const startSmartPlay = async () => {
    markPerformance('player-play-request')
    markPerformance('stream-ranking-start')
    const generation = ++rankingGenerationRef.current
    let ranked: AddonStream[]
    try {
      ranked = await rankSelectorStreams(visibleStreams)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      throw error
    }
    markPerformance('stream-ranking-ready')
    measurePerformance('stream-ranking', 'stream-ranking-start', 'stream-ranking-ready')
    if (generation !== rankingGenerationRef.current || manualSelectionRequestedRef.current || hadPlaybackRef.current) return
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

  const resumeSmartFallback = async (_failed: AddonStream) => {
    if (!smartActiveRef.current) return
    const generation = ++rankingGenerationRef.current
    let rankedStreams: AddonStream[]
    try {
      rankedStreams = await rankSelectorStreams(providerStreams)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      throw error
    }
    if (generation !== rankingGenerationRef.current || !smartActiveRef.current) return
    const ranked = recoveryCandidates(rankedStreams, sessionFailedSourcesRef.current, sessionFailedAddonsRef.current)
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
      void resumeSmartFallback(playback.stream)
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

  // The selector remains mounted by its detail page while it is closed. Clear
  // the in-memory playback source before notifying that page, otherwise a
  // subsequent open of the same episode immediately renders this old player.
  const closeSelector = () => {
    setPlayback(null)
    onClose()
  }

  const selectStream = (stream: AddonStream) => {
    manualSelectionRequestedRef.current = true
    smartActiveRef.current = false
    recordReliabilityEvent(stream, 'preferred')
    handlePlay(stream, streams.indexOf(stream))
  }

  const streamSummary = (stream: AddonStream) => {
    const raw = streamText(stream)
    const resolution = stream.resolution || raw.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1] || 'Unknown quality'
    const release = raw.match(/\b(remux|blu[- .]?ray|web[- .]?dl|web[- .]?rip|hdtv|bdrip|dvdrip)\b/i)?.[1]?.replace(/[ .]/g, '-') || stream.container?.toUpperCase() || 'Stream'
    const audio = [raw.match(/\b(atmos|truehd|dts[- ]?hd|dd\+|eac3|ac3|aac)\b/i)?.[1] || stream.audioCodec, raw.match(/\b(7\.1|5\.1|2\.0)\b/)?.[1]].filter(Boolean).join(' · ')
    const size = raw.match(/\b\d+(?:\.\d+)?\s*(?:TB|GB|GiB|MB|MiB)\b/i)?.[0]
    const bitrate = stream.bitrate ? `${(stream.bitrate / 1_000_000).toFixed(2)} Mbps` : raw.match(/\b\d+(?:\.\d+)?\s*Mbps\b/i)?.[0]
    const language = raw.match(/\b(EN|ENG|English|DE|GER|German|FR|French|JA|JPN|Japanese|ES|Spanish)\b/i)?.[1]?.toUpperCase()
    const source = stream.directPlay ? 'Direct Play' : stream.directStream ? 'Direct Stream' : stream.transcode ? 'Transcode' : isTorBoxCachedStream(stream) ? 'Debrid' : stream.infoHash ? 'Torrent' : ''
    const visual = [(/\b(dv|dolby vision)\b/i.test(raw) ? 'DV' : null), (/\bhdr10\+?\b/i.test(raw) ? 'HDR10' : stream.hdr || null)].filter((value): value is string => Boolean(value))
    const description = [stream.description, stream.title].find((value) => typeof value === 'string' && value.trim() && value.trim() !== stream.name?.trim()) || ''
    return { resolution: resolution.toUpperCase(), release: release.toUpperCase(), audio, size, bitrate, language, source, visual, description }
  }

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
          onClose={closeSelector}
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
          onClose={closeSelector}
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
    <div className="fixed inset-0 z-[10000] flex items-center justify-center overflow-hidden bg-[#07090c] p-3 text-white sm:p-6" onClick={closeSelector}>
      {(artwork?.backdrop || artwork?.poster) && <img src={cachedImage(artwork.backdrop || artwork.poster)} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-xl" />}
      <div className="absolute inset-0 bg-[#07090c]/65" />
      <section ref={selectorPanelRef} aria-label="Select source" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key.toLowerCase() === 'b') { event.preventDefault(); closeSelector(); return }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-stream-choice]'))
        if (!choices.length) return
        const current = choices.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? Math.min(current + 1, choices.length - 1) : Math.max(current - 1, 0)
        choices[next]?.focus()
        event.preventDefault()
      }} className="relative flex max-h-[min(860px,94vh)] w-full max-w-[1160px] flex-col overflow-hidden rounded-[24px] border border-white/[0.12] bg-[#171b20]/85 shadow-[0_35px_100px_rgba(0,0,0,0.65)] backdrop-blur-3xl">
        <header className="flex items-center gap-4 px-5 pb-5 pt-5 sm:px-7 sm:pt-6">
          {artwork?.poster ? <img src={cachedImage(artwork.poster)} alt="" className="h-[72px] w-12 shrink-0 rounded-lg object-cover shadow-lg" /> : <div className="h-[72px] w-12 shrink-0 rounded-lg bg-white/[0.07]" />}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">Select source</p>
            <h2 className="mt-0.5 truncate text-[27px] font-semibold leading-tight tracking-tight">{title}</h2>
            <p className="mt-1 text-[13px] text-white/50">{seasonEpisode ? `S${seasonEpisode.season} E${seasonEpisode.episode} · ` : ''}{filteredStreams.length} playable {filteredStreams.length === 1 ? 'source' : 'sources'}</p>
          </div>
          <button onClick={closeSelector} aria-label="Close source selector" className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-white/65 transition hover:bg-white/[0.14] hover:text-white">×</button>
        </header>

        <div className="mx-5 flex flex-wrap items-center gap-2 border-b border-white/[0.09] pb-4 sm:mx-7">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" aria-label="Source providers">
            <button onClick={() => setSelectedProvider('all')} aria-pressed={activeProvider === 'all'} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition ${activeProvider === 'all' ? 'bg-white/[0.16] text-white' : 'text-white/55 hover:bg-white/[0.07]'}`}>All {filteredStreams.length}</button>
            {providerOptions.map(([id, name]) => <button key={id} onClick={() => setSelectedProvider(id)} aria-pressed={activeProvider === id} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition ${activeProvider === id ? 'bg-white/[0.16] text-white' : 'text-white/55 hover:bg-white/[0.07]'}`}>{name} {filteredStreams.filter((stream) => stream.addonId === id).length}</button>)}
          </div>
          <div className="flex items-center gap-1 rounded-full bg-white/[0.055] p-1" aria-label="Sort sources">
            {([['best', 'Best'], ['fastest', 'Fastest'], ['highest-quality', 'Quality'], ['smallest-file', 'Size']] as const).map(([mode, label]) => <button key={mode} onClick={() => { setSmartMode(mode); localStorage.setItem('aurales_smart_play_mode', mode) }} aria-pressed={smartMode === mode} className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${smartMode === mode ? 'bg-white/[0.16] text-white' : 'text-white/50 hover:text-white'}`}>{label}</button>)}
          </div>
          <div className="relative">
            <button onClick={() => { setShowFilters((value) => !value); setShowDisplaySettings(false) }} aria-expanded={showFilters} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${selectedFilters.length ? 'bg-white/[0.16] text-white' : 'text-white/60 hover:bg-white/[0.08]'}`}>Filters{selectedFilters.length ? ` ${selectedFilters.length}` : ''}</button>
            {showFilters && <div className="absolute right-0 top-10 z-10 max-h-80 w-56 overflow-y-auto rounded-xl border border-white/[0.12] bg-[#252a30] p-3 shadow-2xl">
              {STREAM_FILTER_GROUPS.map((group) => <div key={group.id} className="mb-2"><p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">{group.title}</p>{group.options.map((option) => <button key={option.id} onClick={() => setSelectedFilters((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id])} aria-pressed={selectedFilters.includes(option.id)} className="flex w-full justify-between rounded-lg px-2 py-1.5 text-left text-xs text-white/75 hover:bg-white/[0.08]">{option.label}<span>{selectedFilters.includes(option.id) ? '✓' : ''}</span></button>)}</div>)}
              {selectedFilters.length > 0 && <button onClick={() => setSelectedFilters([])} className="w-full border-t border-white/10 px-2 pt-2 text-left text-xs text-white/50">Clear filters</button>}
            </div>}
          </div>
          <div className="relative">
            <button onClick={() => { setShowDisplaySettings((value) => !value); setShowFilters(false) }} aria-label="Source options" aria-expanded={showDisplaySettings} className="focus-ring flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/[0.08] hover:text-white">⚙</button>
            {showDisplaySettings && <div className="absolute right-0 top-10 z-10 w-48 space-y-1 rounded-xl border border-white/[0.12] bg-[#252a30] p-2 shadow-2xl">
              {([['Title', showStreamName, toggleStreamName], ['Description', showStreamDesc, toggleStreamDesc], ['Tags', showStreamTags, toggleStreamTags]] as const).map(([label, enabled, toggle]) => <button key={label} onClick={toggle} aria-pressed={enabled} className="flex w-full justify-between rounded-lg px-3 py-2 text-left text-xs hover:bg-white/[0.08]">{label}<span>{enabled ? '✓' : ''}</span></button>)}
              <div className="border-t border-white/10 pt-1"><button onClick={retryFailedSources} disabled={loading || !Object.values(sourceDiagnostics).some((diagnostic) => diagnostic.failureReason)} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-white/[0.08] disabled:opacity-40">Retry failed sources</button><button onClick={() => { setSmartStatus('Refreshing sources…'); void cacheClearCategory(CACHE_CATEGORIES.STREAM_PRELOAD).finally(() => setRefreshRevision((value) => value + 1)) }} disabled={loading} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-white/[0.08] disabled:opacity-40">Refresh sources</button></div>
            </div>}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 sm:px-7" style={{ scrollbarWidth: 'thin' }}>
          {Object.values(sourceDiagnostics).filter((diagnostic) => diagnostic.failureReason).map((diagnostic) => <p key={diagnostic.sourceFingerprint} className="mb-2 text-xs text-amber-200/70">{diagnostic.addonId}: {diagnostic.failureReason?.replaceAll('_', ' ').toLowerCase()}</p>)}
          {loading && <p className="py-10 text-center text-sm text-white/50">Fetching sources…</p>}
          {!loading && filteredStreams.length === 0 && <p className="py-10 text-center text-sm text-white/50">No playable sources found</p>}
          {!loading && filteredStreams.length > 0 && scoredStreams.length === 0 && <p className="py-10 text-center text-sm text-white/50">No sources match these filters.</p>}
          {playError && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 p-3 text-xs text-red-300">{playError}</p>}
          <div className="space-y-2">
            {!loading && scoredStreams.map(({ stream: candidate, score }, index) => {
              const stream = candidate as AddonStream
              const summary = streamSummary(stream)
              const key = `${stream.addonId}:${sourceIdentity(stream) || index}`
              const expanded = expandedStream === key
              const percentage = Math.max(1, Math.min(100, Math.round(100 - (scoredStreams[0].score - score) / 4)))
              return <div key={key} className={`rounded-2xl border transition-colors ${index === 0 ? 'border-white/[0.14] bg-white/[0.085]' : 'border-white/[0.07] bg-white/[0.045]'} focus-within:border-white/[0.25] hover:bg-white/[0.09]`}>
                <div className="flex min-h-[88px] items-center gap-3 px-3 py-3 sm:gap-5 sm:px-5">
                  <button data-stream-choice onMouseEnter={() => warmManualStream(stream)} onFocus={() => warmManualStream(stream)} onClick={() => selectStream(stream)} aria-label={`Play ${getStreamHeading(stream, index)}`} className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left sm:gap-5">
                    <span className={`w-[58px] shrink-0 text-center text-[17px] font-semibold tabular-nums sm:w-[68px] ${index === 0 ? 'text-white' : 'text-white/80'}`}>{index === 0 && <span className="mr-1 text-[#e6d5a9]" aria-label="Highest ranked">★</span>}{percentage}%</span>
                    <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[16px] font-semibold tracking-tight"><span>{summary.resolution}</span><span className="text-white/75">{summary.release}</span>{showStreamTags && summary.visual.map((item) => <span key={item} className="rounded-md border border-white/[0.12] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white/70">{item}</span>)}</span>
                      <span className="mt-1.5 flex flex-wrap gap-x-3 text-[13px] text-white/55"><span>{summary.audio || 'Audio unspecified'}</span>{(summary.size || summary.bitrate) && <span>{[summary.size, summary.bitrate].filter(Boolean).join(' · ')}</span>}</span>
                      <span className="mt-1 block truncate text-[12px] text-white/40">{[summary.language, summary.source].filter(Boolean).join(' · ')}</span>
                      {showStreamDesc && summary.description && <span className="mt-1 block whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/55">{summary.description}</span>}
                    </span>
                  </button>
                  {playingIndex === streams.indexOf(stream) ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-transparent" /> : <button onClick={() => setExpandedStream(expanded ? null : key)} aria-label={expanded ? 'Hide source details' : 'Show source details'} aria-expanded={expanded} className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl text-white/45 hover:bg-white/[0.08] hover:text-white">{expanded ? '⌄' : '›'}</button>}
                </div>
                {expanded && <div className="grid gap-x-6 gap-y-2 border-t border-white/[0.07] px-5 py-4 text-xs text-white/55 sm:grid-cols-2">
                  {showStreamName && <p><span className="text-white/35">Title · </span>{getStreamHeading(stream, index)}</p>}
                  {stream.videoCodec && <p><span className="text-white/35">Video codec · </span>{stream.videoCodec}</p>}
                  {stream.audioCodec && <p><span className="text-white/35">Audio codec · </span>{stream.audioCodec}</p>}
                  {stream.filename && <p className="break-all"><span className="text-white/35">Filename · </span>{stream.filename}</p>}
                  {Boolean(stream.behaviorHints?.filename) && <p className="break-all"><span className="text-white/35">Release · </span>{String(stream.behaviorHints?.filename)}</p>}
                  <p><span className="text-white/35">Source addon · </span>{stream.addonName}</p>
                  <p><span className="text-white/35">Status · </span>{isTorBoxCachedStream(stream) ? 'Cached' : summary.source}</p>
                  {showStreamTags && <p><span className="text-white/35">Attributes · </span>{[...matchedFilterLabels(stream), ...getStreamBadges(stream)].join(' · ') || 'None reported'}</p>}
                  {showStreamDesc && getStreamDescription(stream) && <p className="break-words sm:col-span-2"><span className="text-white/35">Provider response · </span>{getStreamDescription(stream)}</p>}
                </div>}
              </div>
            })}
          </div>
        </div>
      </section>
    </div>, document.body
  )
}
