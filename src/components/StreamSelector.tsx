import { lazy, Suspense, useMemo, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { StreamResult, SubtitleResult } from '../types'
import { useAppStore, getLanguageCodeFromTrack } from '../stores/appStore'
import { getAddonStreams, getAddonSubtitles, getStreamAddons, getSubtitleAddons } from '../services/addons'

// Lazy: keeps the heavy player stack out of page chunks — it only loads once
// the user actually starts playback.
const NativeMpvPlayer = lazy(() => import('./NativeMpvPlayer'))
const InAppPlayer = lazy(() => import('./InAppPlayer'))
import type { PlaybackItem } from '../services/simkl/playback'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import { selectStream as wtSelectStream, play as wtPlay } from '../services/watch-together/wsClient'
import { createStreamFingerprint } from '../services/watch-together/streamMatcher'
import type { RoomStream } from '../services/watch-together/types'
import { getPlayableStreamUrl } from '../services/streams/playableUrl'

interface AddonStream extends StreamResult {
  addonName: string
  addonId: string
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

const FILTER_STORAGE_KEY = 'orynt_stream_filters_v1'

type StreamFilterState = Record<FilterGroupId, string[]>

function defaultStreamFilters(): StreamFilterState {
  return STREAM_FILTER_GROUPS.reduce((acc, group) => {
    acc[group.id] = group.options.map((option) => option.id)
    return acc
  }, {} as StreamFilterState)
}

function loadStreamFilters(): StreamFilterState {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    return raw ? { ...defaultStreamFilters(), ...JSON.parse(raw) } : defaultStreamFilters()
  } catch (_) {
    return defaultStreamFilters()
  }
}

export default function StreamSelector({ open, onClose, mediaType, mediaId, title, artwork, seasonEpisode, startTime, tmdbId, tvdbId, malId, anilistId, sourceAddonId, sourceAddonItemId }: StreamSelectorProps) {
  const [streams, setStreams] = useState<AddonStream[]>([])
  const [loading, setLoading] = useState(true)
  const [playError, setPlayError] = useState('')
  const [playingIndex, setPlayingIndex] = useState<number | null>(null)
  const [playback, setPlayback] = useState<{ url: string; stream: AddonStream } | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleResult[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [streamFilters, setStreamFilters] = useState<StreamFilterState>(loadStreamFilters)
  const addons = useAppStore((s) => s.addons)

  // Stream card display toggles — persisted in localStorage
  const [showStreamName, setShowStreamName] = useState(() => localStorage.getItem('orynt_stream_show_name') !== 'false')
  const [showStreamDesc, setShowStreamDesc] = useState(() => localStorage.getItem('orynt_stream_show_desc') === 'true')
  const [showStreamTags, setShowStreamTags] = useState(() => localStorage.getItem('orynt_stream_show_tags') !== 'false')

  const toggleStreamName = () => setShowStreamName((v) => { localStorage.setItem('orynt_stream_show_name', String(!v)); return !v })
  const toggleStreamDesc = () => setShowStreamDesc((v) => { localStorage.setItem('orynt_stream_show_desc', String(!v)); return !v })
  const toggleStreamTags = () => setShowStreamTags((v) => { localStorage.setItem('orynt_stream_show_tags', String(!v)); return !v })

  useEffect(() => {
    if (!open || !mediaId) return
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

    const fetches = allAddons.map(async (addon) => {
      try {
        const baseId = addon.manifest.id === sourceAddonId && sourceAddonItemId ? sourceAddonItemId : cleanMediaId
        const streamId = makeStreamId(baseId)
        const results = await getAddonStreams(addon.url, mediaType, streamId)
        return results.map((s) => ({
          ...s,
          addonName: addon.manifest.name,
          addonId: addon.manifest.id,
        }))
      } catch (_) {
        return []
      }
    })

    Promise.all(fetches).then((results) => {
      setStreams(results.flat())
      setLoading(false)
    })

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
  }, [open, mediaId, mediaType, seasonEpisode, addons, sourceAddonId, sourceAddonItemId])

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
        values.push(`${parsed.hostname}${parsed.pathname.split('/').pop() ? ` · ${decodeURIComponent(parsed.pathname.split('/').pop() || '')}` : ''}`)
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

  const needsMpvForAudio = (stream: AddonStream): boolean => {
    return /\b(ddp|dd\+|eac3|ac-?3|truehd|dts|dtshd|atmos|flac)\b/i.test(streamText(stream))
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
    if (needsMpvForAudio(stream)) badges.push('MPV Audio')
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

  const filteredStreams = useMemo(() => {
    return streams.filter((stream) => {
      const text = getFilterText(stream)
      return STREAM_FILTER_GROUPS.every((group) => {
        const selected = streamFilters[group.id] || []
        if (selected.length === group.options.length) return true
        const matched = group.options.filter((option) => option.token.test(text)).map((option) => option.id)
        if (matched.length === 0) return true
        return matched.some((id) => selected.includes(id))
      })
    })
  }, [streams, streamFilters])

  const toggleFilter = (groupId: FilterGroupId, optionId: string) => {
    setStreamFilters((current) => {
      const selected = current[groupId] || []
      const nextSelected = selected.includes(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId]
      const next = { ...current, [groupId]: nextSelected }
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  const resetFilters = () => {
    const next = defaultStreamFilters()
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next))
    setStreamFilters(next)
  }

  // Memoize merged subtitles — must be before any early return (rules of hooks).
  // Keeps the array reference stable so NativeMpvPlayer's loadAddonSubtitles
  // useCallback isn't recreated on every StreamSelector re-render.
  const mergedSubtitles = useMemo(
    () => (playback ? mergeSubtitles(playback.stream) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playback?.stream, subtitles]
  )

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

  const displayTitle = seasonEpisode
    ? `${title} S${seasonEpisode.season}E${seasonEpisode.episode}`
    : title

  if (playback) {
    const simklMediaType: 'movie' | 'show' | 'anime' = anilistId || malId ? 'anime' : mediaType === 'series' ? 'show' : 'movie'
    const playbackItem: PlaybackItem = {
      localId: String(mediaId).trim().replace(/:(\d+):(\d+)$/, ''),
      title,
      type: simklMediaType,
      mediaType: simklMediaType,
      // imdbId derived from mediaId if it looks like an IMDB id
      imdbId: mediaId.startsWith('tt') ? mediaId : undefined,
      tmdbId: tmdbId || (mediaId.startsWith('tmdb-') ? Number(mediaId.replace('tmdb-', '')) : undefined),
      // tvdbId enables the TVDB→AniList/PMDB episode mapping during scrobbling
      tvdbId: tvdbId != null
        ? Number(String(tvdbId).replace('tvdb-', ''))
        : mediaId.startsWith('tvdb-') ? Number(mediaId.replace('tvdb-', '').split(':')[0]) : undefined,
      malId,
      anilistId,
      season: seasonEpisode?.season,
      episode: seasonEpisode?.episode,
    }

    const isTauri = !!(window as any).__TAURI_INTERNALS__
    const PlayerComponent = isTauri ? NativeMpvPlayer : InAppPlayer

    return createPortal(
      <Suspense fallback={null}>
        <PlayerComponent
          url={playback.url}
          title={title}
          subtitle={seasonEpisode ? `From S${seasonEpisode.season} · E${seasonEpisode.episode}` : undefined}
          subtitles={mergedSubtitles}
          playbackItem={playbackItem}
          startTime={startTime}
          poster={artwork?.poster}
          backdrop={artwork?.backdrop}
          onClose={onClose}
          onPickAnother={() => setPlayback(null)}
        />
      </Suspense>,
      document.body
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-hidden bg-black" onClick={onClose}>
      {artwork?.backdrop && (
        <img src={artwork.backdrop} alt="" className="absolute inset-0 w-full h-full object-cover opacity-45 blur-sm scale-105" />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/55 to-black/35" />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/30" />

      <div
        className="relative h-full w-full flex gap-8 p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between mb-6">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-white/45 mb-2">Select Stream</p>
              <h2 className="text-4xl font-bold text-white">{displayTitle}</h2>
              {mediaId && <p className="text-xs text-white/35 font-mono mt-1">{mediaId}</p>}
            </div>
            <div className="flex items-center gap-3">
              <button onClick={onClose} className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {/* Display toggles */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-[11px] text-white/35 uppercase tracking-widest mr-1">Show</span>
            {([
              { label: 'Name', active: showStreamName, toggle: toggleStreamName },
              { label: 'Description', active: showStreamDesc, toggle: toggleStreamDesc },
              { label: 'Tags', active: showStreamTags, toggle: toggleStreamTags },
            ] as const).map(({ label, active, toggle }) => (
              <button
                key={label}
                onClick={toggle}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                  active
                    ? 'bg-white/15 border-white/25 text-white'
                    : 'bg-transparent border-white/10 text-white/35 hover:border-white/20 hover:text-white/50'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-accent' : 'bg-white/20'}`} />
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-4" style={{ scrollbarWidth: 'none' }}>
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted">Fetching streams from addons...</p>
            </div>
          )}

          {!loading && streams.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-muted mb-1">No streams found</p>
              <p className="text-xs text-muted">
                {addons.length === 0
                  ? 'Install stream addons in Settings first'
                  : 'None of your addons returned streams for this title'}
              </p>
            </div>
          )}

          {!loading && streams.length > 0 && filteredStreams.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-muted mb-1">No streams match these filters</p>
              <button onClick={resetFilters} className="text-xs text-accent hover:underline">Reset filters</button>
            </div>
          )}

          {playError && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300">
              {playError}
            </div>
          )}

          {!loading && filteredStreams.map((stream, i) => {
            const playable = !!getPlayableUrl(stream)
            const description = getStreamDescription(stream)
            const filterBadges = matchedFilterLabels(stream)
            return (
            <button
              key={`${stream.addonId}-${i}`}
              onClick={() => handlePlay(stream, i)}
              className="w-full min-h-[90px] flex items-start gap-5 py-3.5 px-5 rounded-2xl bg-white/14 hover:bg-white/22 border border-white/10 backdrop-blur-xl shadow-2xl transition-all text-left group"
            >
              <div className={`flex-shrink-0 mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                playable ? 'bg-white/15 group-hover:bg-accent/20' : 'bg-white/5'
              }`}>
                <svg className={`w-5 h-5 ${playable ? 'text-white' : 'text-muted'}`} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                {showStreamName && (
                  <div className="text-2xl font-bold text-white truncate">
                    {getStreamHeading(stream, i)}
                  </div>
                )}
                {showStreamDesc && description && (
                  <p className="text-[15px] leading-snug text-white/82 whitespace-pre-line mt-1.5">
                    {description}
                  </p>
                )}
                {showStreamTags && (
                  <div className="flex items-center gap-2 text-xs text-white/70 flex-wrap mt-2">
                    {filterBadges.map((badge) => (
                      <span key={`filter-${badge}`} className="px-2.5 py-1 rounded-lg border-2 border-white/35 bg-white/10 text-[11px] font-black text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]">
                        {badge}
                      </span>
                    ))}
                    {getStreamBadges(stream).map((badge) => (
                      <span key={badge} className="px-2 py-1 bg-white/10 rounded-lg text-[11px]">{badge}</span>
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
          <div className="hidden lg:flex w-72 flex-shrink-0 items-end">
            <div>
              <img src={artwork.poster} alt="" className="w-72 rounded-3xl shadow-2xl ring-1 ring-white/15" />
              <h3 className="text-3xl font-bold text-white mt-5 leading-tight">{title}</h3>
            </div>
          </div>
        )}
      </div>

      {filtersOpen && (
        <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-xl" onClick={() => setFiltersOpen(false)}>
          <div
            className="h-full w-full max-w-3xl mx-auto overflow-y-auto px-8 py-10"
            style={{ scrollbarWidth: 'thin' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 -mx-8 px-8 pb-6 bg-gradient-to-b from-black via-black/95 to-transparent">
              <button
                onClick={() => setFiltersOpen(false)}
                className="w-16 h-16 rounded-full bg-white/15 hover:bg-white/25 border border-white/10 shadow-2xl flex items-center justify-center mb-8"
              >
                <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h2 className="text-6xl font-black tracking-tight">Filters</h2>
              <p className="text-xl text-white/45 mt-6 max-w-xl">Choose which stream tags are allowed in the results.</p>
              <div className="mt-6 flex items-center gap-3">
                <button onClick={resetFilters} className="px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm font-semibold">
                  Reset to Defaults
                </button>
                <span className="text-sm text-white/35">
                  Showing {filteredStreams.length} of {streams.length}
                </span>
              </div>
            </div>

            <div className="space-y-10 pb-16">
              {STREAM_FILTER_GROUPS.map((group) => (
                <section key={group.id}>
                  <h3 className="text-3xl font-black mb-5">{group.title}</h3>
                  <div className="rounded-[2rem] bg-white/[0.12] border border-white/10 overflow-hidden">
                    {group.options.map((option, index) => {
                      const enabled = (streamFilters[group.id] || []).includes(option.id)
                      return (
                        <button
                          key={option.id}
                          onClick={() => toggleFilter(group.id, option.id)}
                          className="w-full min-h-[86px] px-7 flex items-center gap-5 text-left hover:bg-white/8 transition-colors"
                        >
                          <span className={`w-7 h-7 rounded-full flex items-center justify-center border-2 ${
                            enabled ? 'bg-white text-black border-white' : 'border-white/35 text-transparent'
                          }`}>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          </span>
                          <span className="flex-1 text-2xl text-white/90">{option.label}</span>
                          <span className={`px-3 py-1 rounded-lg border-2 text-xl font-black ${
                            enabled ? 'border-white/45 text-white bg-white/10' : 'border-white/20 text-white/35'
                          }`}>
                            {option.badge || option.label}
                          </span>
                          {index < group.options.length - 1 && (
                            <span className="absolute left-32 right-12 mt-[86px] h-px bg-white/10" />
                          )}
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}
