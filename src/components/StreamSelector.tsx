import { lazy, Suspense, useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { StreamResult, SubtitleResult } from '../types'
import { useAppStore, getLanguageCodeFromTrack } from '../stores/appStore'
import { getAddonSubtitles, getStreamAddons, getSubtitleAddons } from '../services/addons'
import { streamPreloadManager, StreamPreloadPriority } from '../services/streams/preloadManager'
import NativeMpvPlayer from './NativeMpvPlayer'

// Lazy: keeps the heavy player stack out of page chunks â€” it only loads once
// the user actually starts playback.
const InAppPlayer = lazy(() => import('./InAppPlayer'))
import type { PlaybackItem } from '../services/simkl/playback'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import { selectStream as wtSelectStream, play as wtPlay } from '../services/watch-together/wsClient'
import { createStreamFingerprint } from '../services/watch-together/streamMatcher'
import type { RoomStream } from '../services/watch-together/types'
import { getPlayableStreamUrl } from '../services/streams/playableUrl'
import { stopEmbeddedPlayer, nativePlayerSupported } from '../services/player'
import { rankStreams, type SmartPlayMode, type SmartStream } from '../services/streams/smartScoring'
import { SmartFallbackQueue } from '../services/streams/smartFallback'
import { loadReliabilityHistory, recordReliabilityEvent } from '../services/streams/reliabilityHistory'
import { cachedImage } from '../services/imageCache'

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
  const [streams, setStreams] = useState<AddonStream[]>([])
  const [loading, setLoading] = useState(true)
  const [playError, setPlayError] = useState('')
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [playback, setPlayback] = useState<{ url: string; stream: AddonStream } | null>(null)
  const [smartMode, setSmartMode] = useState<SmartPlayMode>(() => (localStorage.getItem('aurales_smart_play_mode') as SmartPlayMode) || 'best')
  const [smartStatus, setSmartStatus] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('all')
  const smartQueueRef = useRef<SmartFallbackQueue<AddonStream> | null>(null)
  const smartActiveRef = useRef(false)
  const autoSmartStartedRef = useRef(false)
  const manualSelectionRequestedRef = useRef(false)
  const startSmartPlayRef = useRef<() => void>(() => {})
  const hadPlaybackRef = useRef(false)
  const [subtitles, setSubtitles] = useState<SubtitleResult[]>([])
  const addons = useAppStore((s) => s.addons)
  const autoPlayFirstStream = useAppStore((s) => s.autoPlayFirstStream)

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

    const cleanMediaId = String(mediaId).trim().replace(/:(\d+):(\d+)$/, '')
    if (!cleanMediaId) {
      setPlayError('This Continue Watching item has no valid media ID. Open its detail page and play it once to refresh progress data.')
      setLoading(false)
      return
    }
    const makeStreamId = (baseId: string) => seasonEpisode
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

    Promise.all(allSubAddons.map(async (addon) => {
      try {
        const baseId = addon.manifest.id === sourceAddonId && sourceAddonItemId ? sourceAddonItemId : cleanMediaId
        const streamId = makeStreamId(baseId)
        const tracks = await getAddonSubtitles(addon.url, mediaType, streamId)
        return tracks.map((track) => ({
          ...track,
          source: 'addon' as const,
          addonName: addon.manifest.name,
        }))
      } catch (_) {
        return []
      }
    })).then((results) => {
      const unique = results.flat().filter((subtitle, index, all) =>
        all.findIndex((candidate) => candidate.url === subtitle.url && candidate.lang === subtitle.lang) === index
      )
      setSubtitles(unique)
    })
  }, [open, mediaId, mediaType, seasonEpisode, addons, sourceAddonId, sourceAddonItemId, playback])

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
      .map((subtitle, index) => ({
        id: subtitle.id || `stream-sub-${index}`,
        url: subtitle.url,
        lang: subtitle.lang || 'und',
        label: subtitle.label || subtitle.lang || `Stream subtitle ${index + 1}`,
        source: 'stream' as const,
      }))
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
    () => streams.filter((stream) => Boolean(getPlayableStreamUrl(stream)) && !isDiagnosticStream(stream)),
    [streams],
  )

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

  useEffect(() => {
    if (!open || loading || playback || !autoPlayFirstStream || manualSelectionRequestedRef.current || filteredStreams.length === 0 || autoSmartStartedRef.current) return
    autoSmartStartedRef.current = true
    startSmartPlayRef.current()
  }, [open, loading, playback, autoPlayFirstStream, filteredStreams.length])

  useEffect(() => {
    const resolving = open && autoPlayFirstStream && !manualSelectionRequestedRef.current && !playback && (loading || streams.length > 0)
    onResolvingChange?.(resolving)
    return () => onResolvingChange?.(false)
  }, [open, autoPlayFirstStream, playback, loading, streams.length, onResolvingChange])

  useEffect(() => {
    if (!open) return
    autoSmartStartedRef.current = false
    manualSelectionRequestedRef.current = false
  }, [open, mediaId, seasonEpisode?.season, seasonEpisode?.episode])

  if (!open) return null


  const handlePlay = async (stream: AddonStream, index: number) => {
    const url = getPlayableUrl(stream)
    if (!url) {
      setPlayError('This stream is not a direct playable video URL. Pick a direct HTTP/HLS/DASH stream instead.')
      return
    }

    setPlayingIndex(index)
    setPlayError('')
    setPlayback({ url, stream })
    setPlayingIndex(null)

    const wtState = useWatchTogetherStore.getState()
    if (wtState.isHost && wtState.currentRoom) {
      const quality = stream.name?.match(/\b(4k|2160p|1080p|720p|480p)\b/i)?.[0] ?? undefined
      const roomStream: RoomStream = {
        addonId: stream.addonId,
        name: stream.addonName,
        title: stream.title,
        quality,
        infoHash: stream.infoHash,
        fileIdx: stream.fileIdx,
        streamFingerprint: createStreamFingerprint(stream),
      }
      wtSelectStream(roomStream)
      wtPlay(startTime ?? 0)
    }
  }

  const startSmartPlay = () => {
    const store = useAppStore.getState()
    const ranked = rankStreams(providerStreams as SmartStream[], {
      title, season: seasonEpisode?.season, episode: seasonEpisode?.episode,
      preferredAudio: store.preferredAudio, preferredSubtitles: store.preferredSubtitles,
      subtitles, mode: smartMode, player: (window as any).__TAURI_INTERNALS__ ? 'mpv' : 'web',
      maxSizeGb: store.cacheBufferSize === 'default' ? 20 : store.cacheBufferSize === 'large' ? 45 : 80,
      history: loadReliabilityHistory(),
    }).filter((candidate) => candidate.score > -500).map((candidate) => candidate.stream as AddonStream)
    smartQueueRef.current = new SmartFallbackQueue(ranked)
    smartActiveRef.current = true
    const first = smartQueueRef.current.next()
    if (!first) { setPlayError('No playable streams were found.'); return }
    setSmartStatus(`Smart Play selected ${first.addonName}`)
    handlePlay(first, streams.indexOf(first))
  }
  startSmartPlayRef.current = startSmartPlay

  const handlePlaybackError = () => {
    if (!playback) return
    recordReliabilityEvent(playback.stream, 'failed_start')
    if (!smartActiveRef.current) return
    const next = smartQueueRef.current?.next()
    if (!next) { smartActiveRef.current = false; setSmartStatus('No more working streams were found.'); return }
    setSmartStatus(`Stream failed â€” trying ${next.addonName}`)
    handlePlay(next, streams.indexOf(next))
  }

  const handlePlaybackStarted = () => {
    if (playback) recordReliabilityEvent(playback.stream, 'success')
    if (smartActiveRef.current) setSmartStatus(`Playing from ${playback?.stream.addonName || 'the best source'}`)
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

  if (autoPlayFirstStream && !manualSelectionRequestedRef.current && !playback && (loading || streams.length > 0)) return null

  if (playback) {
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

    if (nativePlayerSupported()) {
      return createPortal(
        <NativeMpvPlayer
          url={playback.url}
          title={title}
          subtitle={seasonEpisode ? `From S${seasonEpisode.season} E${seasonEpisode.episode}` : undefined}
          subtitles={mergedSubtitles}
          playbackItem={playbackItem}
          startTime={startTime}
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
          url={playback.url}
          title={title}
          subtitle={seasonEpisode ? `From S${seasonEpisode.season} E${seasonEpisode.episode}` : undefined}
          subtitles={mergedSubtitles}
          playbackItem={playbackItem}
          startTime={startTime}
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
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.26em] text-accent">Select source</p>
              <h2 className="truncate text-2xl font-black tracking-tight text-white sm:text-3xl">{displayTitle}</h2>
                <p className="mt-1 text-xs text-white/35">{filteredStreams.length ? `${filteredStreams.length} playable sources` : loading ? 'Searching your addons...' : 'No playable sources found'}</p>
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
                <button key={id} onClick={() => setSelectedProvider(id)} className={`flex-shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition-colors ${selectedProvider === id ? 'bg-white text-black' : 'text-white/50 hover:bg-white/[0.06] hover:text-white'}`}>{name} ({streams.filter((stream) => stream.addonId === id).length})</button>
              ))}
            </div>
            <div className="hidden h-6 w-px bg-white/[0.08] lg:block" />
            <button onClick={startSmartPlay} disabled={loading || providerStreams.length === 0} className="focus-ring rounded-xl bg-accent px-4 py-2 text-xs font-black text-black transition-transform active:scale-95 disabled:opacity-40">Smart Play</button>
            {([['best', 'Best'], ['fastest', 'Fastest'], ['highest-quality', 'Quality'], ['smallest-file', 'Smallest']] as const).map(([mode, label]) => (
              <button key={mode} onClick={() => { setSmartMode(mode); localStorage.setItem('aurales_smart_play_mode', mode) }} className={`rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${smartMode === mode ? 'bg-white/[0.12] text-white' : 'text-white/40 hover:bg-white/[0.05] hover:text-white/70'}`}>{label}</button>
            ))}
            <div className="hidden h-6 w-px bg-white/[0.08] xl:block" />
            <span className="px-1 text-[9px] font-bold uppercase tracking-[0.18em] text-white/25">Show</span>
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
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-[11px] font-semibold transition-colors ${
                  visible ? 'bg-white/[0.09] text-white/80' : 'text-white/30 hover:bg-white/[0.04] hover:text-white/55'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${visible ? 'bg-accent' : 'bg-white/20'}`} />
                {label}
              </button>
            ))}
            {smartStatus && <span className="w-full px-2 pb-1 text-xs text-white/50">{smartStatus}</span>}
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto pr-1" style={{ scrollbarWidth: 'none' }}>
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
            const playable = !!getPlayableUrl(stream)
            const description = getStreamDescription(stream)
            const filterBadges = matchedFilterLabels(stream)
            return (
            <button
              key={`${stream.addonId}-${i}`}
              onClick={() => { smartActiveRef.current = false; recordReliabilityEvent(stream, 'preferred'); handlePlay(stream, streams.indexOf(stream)) }}
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
                  <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-white/60">
                    {description}
                  </p>
                )}
                {showStreamTags && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-white/60">
                    {filterBadges.map((badge) => (
                      <span key={`filter-${badge}`} className="rounded-md border border-white/[0.12] bg-white/[0.06] px-2 py-0.5 text-[10px] font-bold text-white/80">
                        {badge}
                      </span>
                    ))}
                    {getStreamBadges(stream).map((badge) => (
                      <span key={badge} className="rounded-md bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/50">{badge}</span>
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
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/30">{seasonEpisode ? `Season ${seasonEpisode.season} Â· Episode ${seasonEpisode.episode}` : 'Movie'}</p>
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
