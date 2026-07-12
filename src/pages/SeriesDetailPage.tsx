import { useMemo, useState, useEffect, useRef } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import type { ShowDetails, SeasonDetails } from '../types'
import { MOCK_SHOW, MOCK_SEASON, MOCK_POPULAR_SHOWS } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { tvdbProvider } from '../services/tvdb'
import { getAddonMeta, getMetaAddons } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'
import StreamSelector from '../components/StreamSelector'
import WatchlistButton from '../components/WatchlistButton'
import RatingsStrip from '../components/RatingsStrip'
import DetailHero from '../components/media/DetailHero'
import { cacheGet, cacheSet } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../services/cache/constants'
import DetailContentShell from '../components/media/DetailContentShell'
import { Button } from '../components/ui'
import MarkWatchedButton from '../components/MarkWatchedButton'
import StartInRoomButton from '../components/watch-together/StartInRoomButton'
import { applyEpisodeArt, applySearchResultArt, applyShowArt, resolveArtFromProviders } from '../services/artwork'
import { getSimklPlaybackProgress } from '../services/simkl/playback'
import { getPlaybackProgress as getTraktPlaybackProgress } from '../services/trakt/sync'
import { getPMDBPlaybackProgress } from '../services/pmdb'
import { getMdblistPlaybackProgress, hasMdblistOAuth } from '../services/mdblist'
import { isWatchedFromProviders, batchIsWatchedFromProviders, type WatchedLookupItem } from '../services/watchedStatus'
import { useContextMenu } from '../hooks/useContextMenu'
import { resolveAppMetadata, type AppMediaItem } from '../services/metadata'
import { debugAnimeMapping, validateAnimeTvdbStructure } from '../services/metadata/animeStructureValidator'
import { saveAnimeMapping } from '../services/anime-mapping/animeMappingCache'
import type { AnimeMappingResult } from '../services/anime-mapping/types'
import { isLikelyJapaneseOnly } from '../services/metadata/animeTitleResolver'
import { useGlobalBackdrop } from '../hooks/useGlobalBackdrop'
import { setDiscordBrowsingActivity } from '../services/discord'
import { streamPreloadManager, StreamPreloadPriority } from '../services/streams/preloadManager'

function fuzzyIdsMatch(idA?: string | number | null, idB?: string | number | null): boolean {
  if (idA == null || idB == null) return false
  const clean = (val: string | number) => {
    const s = String(val).toLowerCase().trim()
    return s
      .replace(/^app_tmdb_movie_/, '')
      .replace(/^app_movie_/, '')
      .replace(/^app_tmdb_/, '')
      .replace(/^app_tvdb_/, '')
      .replace(/^tmdb[-:]/, '')
      .replace(/^imdb[-:]/, '')
      .replace(/^tvdb[-:]/, '')
      .replace(/^mal[-:]/, '')
      .replace(/^anilist[-:]/, '')
  }
  const cleanA = clean(idA)
  const cleanB = clean(idB)
  return cleanA !== '' && cleanA === cleanB
}

function formatRemainingTime(seconds: number): string {
  if (seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} left`
  }
  return `${m}:${s.toString().padStart(2, '0')} left`
}

interface LocationState {
  poster?: string
  backdrop?: string
  title?: string
  year?: number
  rating?: number
  overview?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  addonUrl?: string
  provider?: string
  sourceAddonId?: string
  sourceAddonItemId?: string
  autoPlay?: boolean
}

interface SeriesDetailCacheEntry {
  show: ShowDetails
  selectedSeason: number | null
  episodeMap: Record<number, SeasonDetails['episodes']>
  metadataStatus: 'resolved' | 'fallback' | 'error'
}
const seriesDetailMemCache = new Map<string, { entry: SeriesDetailCacheEntry; timestamp: number }>()

function animeStructureSettingsKey(): string {
  const settings = useAppStore.getState()
  return [
    settings.hideUnairedAnimeSeasons,
    settings.hideUnairedAnimeEpisodes,
    settings.includeAnimeSpecials,
    settings.useGenericAnimeSeasonLabels,
    settings.avoidJapaneseSeasonNames,
    settings.preferTvdbAnimeSeasons,
  ].map(Number).join('')
}

function artworkSettingsKey(): string {
  const settings = useAppStore.getState()
  return JSON.stringify({
    providers: settings.artProviders,
    fanart: Boolean(settings.fanartApiKey),
    custom: settings.customArtUrls,
    // Metadata source affects the resolved title/overview/artwork, so it must be
    // part of the cache key — otherwise switching sources returns a stale detail page
    meta: [settings.seriesMetadataSource, settings.seriesMetadataFallback, settings.animeMetadataSource, settings.animeMetadataFallback, settings.animeTitleLanguage],
  })
}

function seriesDetailCacheKeys(id: string | undefined, state: LocationState): string[] {
  const settingsKey = `${animeStructureSettingsKey()}:${artworkSettingsKey()}`
  const cleanStateImdb = cleanId(state.imdbId)
  const cleanStateTmdb = cleanId(state.tmdbId)
  const cleanStateTvdb = cleanId(state.tvdbId)
  const cleanStateAnilist = cleanId(state.anilistId)
  const cleanStateMal = cleanId(state.malId)
  const cleanIdVal = cleanId(id)

  return [
    cleanIdVal,
    cleanStateImdb,
    cleanStateTmdb != null ? `tmdb:${cleanStateTmdb}` : undefined,
    cleanStateTvdb != null ? `tvdb:${cleanStateTvdb}` : undefined,
    cleanStateAnilist != null ? `anilist:${cleanStateAnilist}` : undefined,
    cleanStateMal != null ? `mal:${cleanStateMal}` : undefined,
  ].filter((key): key is string => !!key).map((key) => `${settingsKey}:${key}`)
}

async function readSeriesDetailCache(id: string | undefined, state: LocationState): Promise<SeriesDetailCacheEntry | null> {
  const keys = seriesDetailCacheKeys(id, state)
  for (const key of keys) {
    const mem = seriesDetailMemCache.get(`detail:series:${key}`)
    if (mem) return mem.entry
  }
  for (const key of keys) {
    const result = await cacheGet<SeriesDetailCacheEntry>(`detail:series:${key}`)
    if (result) {
      for (const k of keys) seriesDetailMemCache.set(`detail:series:${k}`, { entry: result.data, timestamp: Date.now() })
      return result.data
    }
  }
  return null
}

function writeSeriesDetailCache(id: string | undefined, state: LocationState, entry: SeriesDetailCacheEntry): void {
  const settingsKey = `${animeStructureSettingsKey()}:${artworkSettingsKey()}`
  const cleanShowId = cleanId(entry.show.id)
  const cleanShowImdb = cleanId(entry.show.imdbId)
  const cleanShowTmdb = cleanId(entry.show.tmdbId)
  const cleanShowTvdb = cleanId(entry.show.tvdbId)
  const cleanShowAnilist = cleanId(entry.show.anilistId)
  const cleanShowMal = cleanId(entry.show.malId)

  const keys = new Set([
    ...seriesDetailCacheKeys(id, state),
    ...[
      cleanShowId,
      cleanShowImdb,
      cleanShowTmdb != null ? `tmdb:${cleanShowTmdb}` : undefined,
      cleanShowTvdb != null ? `tvdb:${cleanShowTvdb}` : undefined,
      cleanShowAnilist != null ? `anilist:${cleanShowAnilist}` : undefined,
      cleanShowMal != null ? `mal:${cleanShowMal}` : undefined,
    ].filter((key): key is string => !!key).map((key) => `${settingsKey}:${key}`),
  ])
  const opts = { category: CACHE_CATEGORIES.DETAIL_PAGE, ttlSeconds: CACHE_TTLS.DETAIL_PAGE }
  for (const key of keys) {
    seriesDetailMemCache.set(`detail:series:${key}`, { entry, timestamp: Date.now() })
    void cacheSet(`detail:series:${key}`, entry, opts)
  }
}

function cleanId(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    const nested = obj.id ?? obj.value ?? obj.tmdbId ?? obj.tvdbId ?? obj.anilistId ?? obj.malId
    return nested !== undefined ? cleanId(nested) : undefined
  }
  const str = String(val).trim()
  if (str === '[object Object]' || str === '' || str.toLowerCase() === 'undefined' || str.toLowerCase() === 'null') {
    return undefined
  }
  return str
}


function addonMetaToShow(meta: Record<string, unknown>, id: string): ShowDetails {
  const rawGenres = Array.isArray(meta.genres) ? meta.genres :
    (typeof meta.genre === 'string' ? (meta.genre as string).split(',').map(g => g.trim()) :
    (Array.isArray(meta.genre) ? meta.genre : []))

  const genres = rawGenres.map((g) => {
    if (typeof g === 'string') return g
    if (g && typeof g === 'object') {
      const obj = g as Record<string, unknown>
      return String(obj.name || obj.title || obj.genre || JSON.stringify(obj))
    }
    return String(g)
  }).filter(Boolean)

  const videos = Array.isArray(meta.videos) ? meta.videos as Record<string, unknown>[] : []
  const seasons: { seasonNumber: number; name: string; episodeCount: number }[] = []

  if (Array.isArray(meta.videos)) {
    const seasonNums = new Set<number>()
    for (const v of videos) {
      const s = Number(v.season)
      if (!isNaN(s) && s > 0) seasonNums.add(s)
    }
    for (const num of Array.from(seasonNums).sort((a, b) => a - b)) {
      const eps = videos.filter(v => Number(v.season) === num)
      seasons.push({ seasonNumber: num, name: `Season ${num}`, episodeCount: eps.length })
    }
  }

  if (seasons.length === 0) {
    const numSeasons = meta.seasons ? Number(meta.seasons) : (meta.numberOfSeasons ? Number(meta.numberOfSeasons) : 1)
    for (let i = 1; i <= numSeasons; i++) {
      seasons.push({ seasonNumber: i, name: `Season ${i}`, episodeCount: 0 })
    }
  }

  return {
    id,
    title: (meta.name || meta.title || 'Unknown') as string,
    year: meta.releaseInfo ? parseInt(String(meta.releaseInfo)) : (meta.year ? Number(meta.year) : undefined),
    overview: (meta.description || meta.overview) as string | undefined,
    rating: meta.imdbRating ? parseFloat(String(meta.imdbRating)) : undefined,
    voteCount: meta.imdbVotes ? parseInt(String(meta.imdbVotes).replace(/,/g, '')) : undefined,
    genres,
    poster: meta.poster as string | undefined,
    backdrop: (meta.background || meta.banner) as string | undefined,
    logo: meta.logo as string | undefined,
    certification: typeof meta.certification === 'string' ? meta.certification : undefined,
    status: meta.status as string | undefined,
    numberOfSeasons: seasons.length,
    numberOfEpisodes: meta.episodes ? Number(meta.episodes) : undefined,
    seasons,
    cast: Array.isArray(meta.cast) ? (meta.cast as string[]).map((name, i) => ({
      id: `cast-${i}`, name, character: '', profilePath: undefined,
    })) : [],
    crew: [],
    recommendations: [],
    trailers: Array.isArray(meta.trailers) ? (meta.trailers as Record<string, string>[]).map((t, i) => ({
      id: `trailer-${i}`,
      name: t.title || t.name || `Trailer ${i + 1}`,
      key: t.source || t.key || '',
      site: t.site || 'YouTube',
      type: t.type || 'Trailer',
      thumbnail: (t.source || t.key) ? `https://img.youtube.com/vi/${t.source || t.key}/hqdefault.jpg` : undefined,
    })) : [],
    imdbId: (meta.imdb_id || meta.imdbId || (typeof meta.id === 'string' && (meta.id as string).startsWith('tt') ? meta.id : undefined)) as string | undefined,
    tmdbId: getMetaId(meta, 'tmdb', 'tmdb_id', 'tmdbId'),
    tvdbId: getMetaId(meta, 'tvdb', 'tvdb_id', 'tvdbId'),
    malId: getMetaId(meta, 'mal', 'mal_id', 'malId'),
    anilistId: getMetaId(meta, 'anilist', 'anilist_id', 'anilistId'),
    provider: 'addon',
  }
}

function appMediaToShow(item: AppMediaItem): ShowDetails {
  return {
    id: item.id, title: item.title, originalTitle: item.originalTitle, year: item.year,
    overview: item.overview, rating: item.rating, genres: item.genres, poster: item.poster,
    backdrop: item.backdrop, logo: item.logo, certification: item.ageRating,
    numberOfSeasons: item.seasons?.filter((season) => season.seasonNumber > 0).length,
    numberOfEpisodes: item.seasons?.reduce((sum, season) => sum + season.episodeCount, 0),
    seasons: (item.seasons || []).map((season) => ({ seasonNumber: season.seasonNumber,
      name: season.title || (season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`),
      episodeCount: season.episodeCount, poster: season.poster, overview: season.overview })),
    cast: [], crew: [], recommendations: [], trailers: [], imdbId: item.imdbId,
    tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId, anilistId: item.anilistId,
    provider: item.sourceMetadataProvider,
  }
}

function getMetaId(meta: Record<string, unknown>, ...keys: string[]): string | number | undefined {
  const ids = meta.ids && typeof meta.ids === 'object' ? meta.ids as Record<string, unknown> : {}
  for (const key of keys) {
    const value = meta[key] ?? ids[key]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return undefined
}

function addonVideosToSeason(meta: Record<string, unknown>, seasonNum: number, isAnime?: boolean): SeasonDetails {
  if (isAnime) {
    console.warn("Blocked Stremio addon episode metadata for anime display");
    return { seasonNumber: seasonNum, name: `Season ${seasonNum}`, episodes: [] }
  }
  const videos = Array.isArray(meta.videos) ? meta.videos as Record<string, unknown>[] : []
  const seasonEps = videos
    .filter(v => Number(v.season) === seasonNum)
    .sort((a, b) => Number(a.episode) - Number(b.episode))

  return {
    seasonNumber: seasonNum,
    name: `Season ${seasonNum}`,
    episodes: seasonEps.map((ep) => ({
      id: `${seasonNum}-${ep.episode}`,
      episodeNumber: Number(ep.episode) || 0,
      seasonNumber: seasonNum,
      name: (ep.name || ep.title || `Episode ${ep.episode}`) as string,
      overview: (ep.description || ep.overview) as string | undefined,
      airDate: ep.released as string | undefined,
      runtime: ep.runtime ? parseInt(String(ep.runtime)) : undefined,
      still: (ep.thumbnail || ep.still) as string | undefined,
    })),
  }
}

function processSeasons(seasons: ShowDetails['seasons'], isAnime = false): ShowDetails['seasons'] {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const cutoff = new Date(now.getFullYear(), now.getMonth() + 3, now.getDate())
  const settings = useAppStore.getState()

  const hasEpisodeCounts = seasons.some((s) => s.episodeCount > 0)

  return seasons
    .filter((s) => {
      if (isAnime && !settings.includeAnimeSpecials && s.seasonNumber === 0) return false
      if (isAnime && settings.hideUnairedAnimeSeasons) {
        if (s.airDate && s.airDate.slice(0, 10) > today) return false
      }
      if ((!isAnime || settings.hideUnairedAnimeSeasons) && hasEpisodeCounts && s.episodeCount === 0) return false
      if (s.airDate && (!isAnime || settings.hideUnairedAnimeSeasons)) {
        const airDate = new Date(s.airDate)
        if (airDate > cutoff) return false
        if (s.airDate.slice(0, 10) > today && s.episodeCount === 0) return false
      }
      return true
    })
    .map((s) => {
      if (s.seasonNumber === 0) return { ...s, name: 'Specials' }
      return s
    })
    .sort((a, b) => {
      // Season 0 (Specials) goes to the end
      if (a.seasonNumber === 0) return 1
      if (b.seasonNumber === 0) return -1
      return a.seasonNumber - b.seasonNumber
    })
}

function rotateFallback<T>(items: T[], seed: string): T[] {
  if (items.length === 0) return []
  const offset = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function formatEpisodeAirDate(dateStr?: string): string {
  if (!dateStr) return ''
  try {
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr
    const parts = cleanDate.split('-')
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10)
      const month = parseInt(parts[1], 10) - 1
      const day = parseInt(parts[2], 10)
      const d = new Date(year, month, day)
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      }
    }
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    }
    return dateStr
  } catch (_) {
    return dateStr
  }
}

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const state = (location.state || {}) as LocationState
  const [show, setShow] = useState<ShowDetails | null>(null)
  const [malRating, setMalRating] = useState<number | null>(null)
  const [fallbackRecommendations, setFallbackRecommendations] = useState(MOCK_POPULAR_SHOWS)
  const [addonMeta, setAddonMeta] = useState<Record<string, unknown> | null>(null)
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const [seasonCache, setSeasonCache] = useState<Record<number, SeasonDetails>>({})
  const seasonData = selectedSeason !== null ? (seasonCache[selectedSeason] || null) : null
  const [loading, setLoading] = useState(true)
  const [metadataStatus, setMetadataStatus] = useState<'idle' | 'resolving' | 'resolved' | 'fallback' | 'error'>('idle')
  const [suspiciousStructure, setSuspiciousStructure] = useState(false)
  const tvdbMappedEpisodesRef = useRef<Record<number, SeasonDetails['episodes']>>({})
  const [streamOpen, setStreamOpen] = useState(false)
  const [streamEpisode, setStreamEpisode] = useState<{ season: number; episode: number } | null>(null)
  const [streamResolving, setStreamResolving] = useState(false)
  const autoPlayHandledRef = useRef(false)
  const [watchedEpisodes, setWatchedEpisodes] = useState<Set<string>>(new Set())
  const fetchedSeasonRef = useRef<string | null>(null)
  const episodeScrollRef = useRef<HTMLDivElement>(null)
  const seasonScrollRef = useRef<HTMLDivElement>(null)
  const [showSeasonArrows, setShowSeasonArrows] = useState(false)

  useEffect(() => {
    const episode = seasonData?.episodes[0]
    if (!show || !state.autoPlay || autoPlayHandledRef.current || !episode) return
    autoPlayHandledRef.current = true
    setStreamEpisode({ season: episode.seasonNumber, episode: episode.episodeNumber })
    setStreamOpen(true)
  }, [show, seasonData, state.autoPlay])
  const addons = useAppStore((s) => s.addons)
  const watchedProgress = useAppStore((s) => s.watchProgress)
  const resumePriorityOrder = useAppStore((s) => s.resumePriorityOrder)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey)
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)

  const getEpisodeProgress = (seasonNum: number, episodeNum: number) => {
    if (!show) return null
    return [...watchedProgress.values()].find((p) => {
      if (p.completed || p.progressSeconds <= 0 || p.season !== seasonNum || p.episode !== episodeNum) return false
      return (
        fuzzyIdsMatch(p.mediaId, show.id) ||
        fuzzyIdsMatch(p.mediaId, show.imdbId) ||
        fuzzyIdsMatch(p.mediaId, show.tmdbId) ||
        fuzzyIdsMatch(p.mediaId, show.tvdbId) ||
        fuzzyIdsMatch(p.imdbId, show.imdbId) ||
        fuzzyIdsMatch(p.tmdbId, show.tmdbId)
      )
    }) || null
  }

  const resumeProgress = useMemo(() => {
    if (!show) return null
    return [...watchedProgress.values()]
      .filter((progress) => !progress.completed && progress.season != null && progress.episode != null)
      .filter((progress) => 
        fuzzyIdsMatch(progress.mediaId, show.id) ||
        fuzzyIdsMatch(progress.mediaId, show.imdbId) ||
        fuzzyIdsMatch(progress.mediaId, show.tmdbId) ||
        fuzzyIdsMatch(progress.mediaId, show.tvdbId) ||
        fuzzyIdsMatch(progress.imdbId, show.imdbId) ||
        fuzzyIdsMatch(progress.tmdbId, show.tmdbId)
      )
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0] || null
  }, [show, watchedProgress])

  const [liveResumePoint, setLiveResumePoint] = useState<{
    provider: string
    season: number
    episode: number
    progressSeconds: number
    durationSeconds: number
  } | null>(null)

  useEffect(() => {
    if (!show) return

    let active = true

    async function fetchPoints() {
      const candidates: {
        provider: 'local' | 'simkl' | 'trakt' | 'pmdb' | 'mdblist'
        season: number
        episode: number
        progressSeconds: number
        durationSeconds: number
        updatedAt?: string
      }[] = []

      // 1. Local
      if (resumeProgress) {
        candidates.push({
          provider: 'local',
          season: resumeProgress.season!,
          episode: resumeProgress.episode!,
          progressSeconds: resumeProgress.progressSeconds,
          durationSeconds: resumeProgress.durationSeconds,
          updatedAt: resumeProgress.updatedAt,
        })
      }

      const fetchPromises: Promise<void>[] = []

      if (resumePriorityOrder.includes('simkl') && simklConnected) {
        fetchPromises.push((async () => {
          try {
            const raw = await getSimklPlaybackProgress()
            const matches = raw
              .filter((item) => {
                const showObj = item.show || item.anime
                if (!showObj || !item.episode) return false
                return (
                  fuzzyIdsMatch(showObj.ids.simkl, show!.id) ||
                  fuzzyIdsMatch(showObj.ids.imdb, show!.imdbId) ||
                  fuzzyIdsMatch(showObj.ids.tmdb, show!.tmdbId) ||
                  fuzzyIdsMatch(showObj.ids.tvdb, show!.tvdbId)
                )
              })
              .map((item) => {
                const epProg = getEpisodeProgress(item.episode!.season ?? 1, item.episode!.number)
                const dur = epProg && epProg.durationSeconds > 0 ? epProg.durationSeconds : 2700
                return {
                  provider: 'simkl' as const,
                  season: item.episode!.season ?? 1,
                  episode: item.episode!.number,
                  progressSeconds: Math.floor((item.progress / 100) * dur),
                  durationSeconds: dur,
                  updatedAt: item.paused_at,
                }
              })
            
            if (matches.length > 0 && active) {
              matches.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
              candidates.push(matches[0])
            }
          } catch (_) {}
        })())
      }

      if (resumePriorityOrder.includes('trakt') && traktConnected) {
        fetchPromises.push((async () => {
          try {
            const raw = await getTraktPlaybackProgress()
            const matches = raw
              .filter((item: any) => {
                if (item.type !== 'episode' || !item.show || !item.episode) return false
                return (
                  fuzzyIdsMatch(item.show.ids.imdb, show!.imdbId) ||
                  fuzzyIdsMatch(item.show.ids.tmdb, show!.tmdbId)
                )
              })
              .map((item: any) => {
                const epProg = getEpisodeProgress(item.episode.season, item.episode.number)
                const dur = epProg && epProg.durationSeconds > 0 ? epProg.durationSeconds : 2700
                return {
                  provider: 'trakt' as const,
                  season: item.episode.season,
                  episode: item.episode.number,
                  progressSeconds: Math.floor((item.progress / 100) * dur),
                  durationSeconds: dur,
                  updatedAt: item.paused_at,
                }
              })
            
            if (matches.length > 0 && active) {
              matches.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
              candidates.push(matches[0])
            }
          } catch (_) {}
        })())
      }

      if (resumePriorityOrder.includes('pmdb') && pmdbApiKey) {
        fetchPromises.push((async () => {
          try {
            const raw = await getPMDBPlaybackProgress()
            const matches = raw
              .filter((item) => {
                if (item.media_type !== 'tv') return false
                return fuzzyIdsMatch(item.tmdb_id, show!.tmdbId)
              })
              .map((item) => {
                return {
                  provider: 'pmdb' as const,
                  season: item.season ?? 1,
                  episode: item.episode ?? 1,
                  progressSeconds: Math.floor((item.position_ms ?? 0) / 1000),
                  durationSeconds: Math.floor((item.runtime_ms ?? 2700000) / 1000),
                  updatedAt: item.updated_at,
                }
              })
            
            if (matches.length > 0 && active) {
              matches.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
              candidates.push(matches[0])
            }
          } catch (_) {}
        })())
      }

      if (resumePriorityOrder.includes('mdblist') && (mdblistApiKey || hasMdblistOAuth())) {
        fetchPromises.push((async () => {
          try {
            const raw = await getMdblistPlaybackProgress()
            const matches = raw
              .filter((item) => {
                if (item.type !== 'show') return false
                return (
                  fuzzyIdsMatch(item.show?.ids?.tmdb, show!.tmdbId) ||
                  fuzzyIdsMatch(item.show?.ids?.imdb, show!.imdbId)
                )
              })
              .map((item) => {
                const epSeason = item.episode?.season ?? 1
                const epNumber = item.episode?.number ?? item.episode?.episode ?? 1
                const epProg = getEpisodeProgress(epSeason, epNumber)
                const dur = epProg && epProg.durationSeconds > 0 ? epProg.durationSeconds : 2700
                return {
                  provider: 'mdblist' as const,
                  season: epSeason,
                  episode: epNumber,
                  progressSeconds: Math.floor(((item.progress ?? 0) / 100) * dur),
                  durationSeconds: dur,
                  updatedAt: item.updated_at,
                }
              })
            
            if (matches.length > 0 && active) {
              matches.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
              candidates.push(matches[0])
            }
          } catch (_) {}
        })())
      }

      if (fetchPromises.length > 0) {
        await Promise.allSettled(fetchPromises)
      }

      if (!active) return

      // Select candidate according to priority order
      for (const provider of resumePriorityOrder) {
        const found = candidates.find((c) => c.provider === provider)
        if (found) {
          setLiveResumePoint(found)
          return
        }
      }

      if (candidates.length > 0) {
        setLiveResumePoint(candidates[0])
      } else {
        setLiveResumePoint(null)
      }
    }

    fetchPoints()

    return () => {
      active = false
    }
  }, [show, resumeProgress, resumePriorityOrder, pmdbApiKey, mdblistApiKey, simklConnected, traktConnected])
  const completedIds = useAppStore((s) => s.completedIds)
  const watchProgressRef = useRef(watchedProgress)
  watchProgressRef.current = watchedProgress
  const completedIdsRef = useRef(completedIds)
  completedIdsRef.current = completedIds
  const setWatchProgress = useAppStore((s) => s.setWatchProgress)
  const removeWatchProgress = useAppStore((s) => s.removeWatchProgress)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const animeTrackingProvider = useAppStore((s) => s.animeTrackingProvider)
  const showCtxMenu = useContextMenu((s) => s.show)
  const blurSpoilers = useAppStore((s) => s.blurSpoilers)
  const blurThumbnails = useAppStore((s) => s.blurThumbnails)
  const blurTitles = useAppStore((s) => s.blurTitles)
  const blurDescriptions = useAppStore((s) => s.blurDescriptions)
  const keepNextEpisodeVisible = useAppStore((s) => s.keepNextEpisodeVisible)
  const artProviders = useAppStore((s) => s.artProviders)
  const fanartApiKey = useAppStore((s) => s.fanartApiKey)
  const customArtUrls = useAppStore((s) => s.customArtUrls)
  const seriesMetadataSource = useAppStore((s) => s.seriesMetadataSource)
  const seriesMetadataFallback = useAppStore((s) => s.seriesMetadataFallback)
  const animeMetadataSource = useAppStore((s) => s.animeMetadataSource)
  const animeMetadataFallback = useAppStore((s) => s.animeMetadataFallback)
  const animeTitleLanguage = useAppStore((s) => s.animeTitleLanguage)
  const discordRichPresence = useAppStore((s) => s.discordRichPresence)
  const artSettingsSignature = useMemo(() => JSON.stringify({
    providers: artProviders,
    fanart: Boolean(fanartApiKey),
    custom: customArtUrls,
    meta: [seriesMetadataSource, seriesMetadataFallback, animeMetadataSource, animeMetadataFallback, animeTitleLanguage],
  }), [artProviders, fanartApiKey, customArtUrls, seriesMetadataSource, seriesMetadataFallback, animeMetadataSource, animeMetadataFallback, animeTitleLanguage])

  const isAnime = show?.isAnime ?? !!(id && /^(mal|anilist)[-:]/i.test(id))

  useEffect(() => {
    if (!show || !discordRichPresence) return
    const image = show.poster?.startsWith('http') ? show.poster : undefined
    setDiscordBrowsingActivity({
      details: `Browsing ${show.title}`,
      state: isAnime ? 'Anime Series' : 'Series',
      largeImage: image || 'aurales_logo',
      largeText: show.title,
      activityType: 3,
    }).catch(() => {})
    return () => { setDiscordBrowsingActivity().catch(() => {}) }
  }, [show?.title, show?.poster, isAnime, discordRichPresence])

  useEffect(() => {
    async function load() {
      const cached = await readSeriesDetailCache(id, state)
      if (cached && cached.show.seasons.length > 0) {
        setAddonMeta(null)
        setSeasonCache({})
        setMalRating(null)
        fetchedSeasonRef.current = null
        setShow(cached.show)
        setSelectedSeason(cached.selectedSeason)
        tvdbMappedEpisodesRef.current = cached.episodeMap
        setMetadataStatus(cached.metadataStatus)
        setLoading(false)
        return
      }

      setLoading(true)
      setMetadataStatus('resolving')
      setAddonMeta(null)
      setSeasonCache({})
      setSelectedSeason(null)
      setMalRating(null)
      fetchedSeasonRef.current = null
      tvdbMappedEpisodesRef.current = {}
      let result: ShowDetails | null = null
      let appResult: ShowDetails | null = null

      const parseId = (val: unknown, prefix: string): string | undefined => {
        let cleaned = cleanId(val)
        if (!cleaned) return undefined
        if (cleaned.startsWith('app_tvdb_')) cleaned = cleaned.replace('app_tvdb_', '')
        else if (cleaned.startsWith('app_tmdb_tv_')) cleaned = cleaned.replace('app_tmdb_tv_', '')
        else if (cleaned.startsWith('app_show_')) cleaned = cleaned.replace('app_show_', '')
        const hasAnyPrefix = /^[a-z_]+[-:]/i.test(cleaned)
        if (hasAnyPrefix) {
          const lower = cleaned.toLowerCase()
          if (lower.startsWith(`${prefix}-`) || lower.startsWith(`${prefix}:`)) {
            return cleaned.replace(/^[a-z_]+[-:]/i, '')
          }
          return undefined
        }
        if (prefix === 'imdb') {
          return cleaned.startsWith('tt') ? cleaned : undefined
        }
        if (cleaned.startsWith('tt')) return undefined
        return cleaned
      }

      // Collect all known IDs from route state
      const knownIds = {
        imdbId: parseId(state.imdbId, 'imdb') || parseId(id, 'imdb'),
        tmdbId: parseId(state.tmdbId, 'tmdb') || parseId(id, 'tmdb'),
        tvdbId: parseId(state.tvdbId, 'tvdb') || parseId(id, 'tvdb'),
        malId: parseId(state.malId, 'mal') || parseId(id, 'mal'),
        anilistId: parseId(state.anilistId, 'anilist') || parseId(id, 'anilist'),
      }

      // Early resolve anime IDs via IDS.moe (fast, cached) to get all cross-service IDs
      if ((knownIds.anilistId || knownIds.malId) && !knownIds.tvdbId) {
        try {
          const { resolveAnimeIds } = await import('../services/animeLists')
          const resolved = await resolveAnimeIds({
            anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
            malId: knownIds.malId ? Number(knownIds.malId) : undefined,
            tmdbId: knownIds.tmdbId ? Number(String(knownIds.tmdbId).replace(/^[a-z_]+[-:]/i, '')) : undefined,
            imdbId: knownIds.imdbId,
          })
          if (resolved) {
            if (resolved.tvdbId) knownIds.tvdbId = String(resolved.tvdbId)
            if (resolved.tmdbId && !knownIds.tmdbId) knownIds.tmdbId = String(resolved.tmdbId)
            if (resolved.imdbId && !knownIds.imdbId) knownIds.imdbId = resolved.imdbId
            if (resolved.anilistId && !knownIds.anilistId) knownIds.anilistId = String(resolved.anilistId)
            if (resolved.malId && !knownIds.malId) knownIds.malId = String(resolved.malId)
          }
        } catch (e) {
          console.error('[SeriesDetailPage] Failed early anime resolution:', e)
        }
      }

      let isAnimeLocal = !!(
        (id && /^(mal|anilist)[-:]/i.test(id)) ||
        state.provider === 'anilist'
      )

      // Detect anime from non-anime IDs using IDS.moe (fast) then anime-lists fallback
      if (!isAnimeLocal && (knownIds.tmdbId || knownIds.imdbId)) {
        try {
          const { resolveAnimeIds } = await import('../services/animeLists')
          const resolved = await resolveAnimeIds({
            tmdbId: knownIds.tmdbId ? Number(String(knownIds.tmdbId).replace(/^[a-z_]+[-:]/i, '')) : undefined,
            imdbId: knownIds.imdbId,
          })
          if (resolved && (resolved.anilistId || resolved.malId)) {
            isAnimeLocal = true
            if (resolved.tvdbId) knownIds.tvdbId = String(resolved.tvdbId)
            if (resolved.tmdbId && !knownIds.tmdbId) knownIds.tmdbId = String(resolved.tmdbId)
            if (resolved.anilistId) knownIds.anilistId = String(resolved.anilistId)
            if (resolved.malId) knownIds.malId = String(resolved.malId)
            if (resolved.imdbId && !knownIds.imdbId) knownIds.imdbId = resolved.imdbId
          }
        } catch (_) { /* ignore */ }
      }

      if (!isAnimeLocal && knownIds.tvdbId) {
        try {
          const { lookupByTvdbId } = await import('../services/animeLists')
          const matches = await lookupByTvdbId(Number(String(knownIds.tvdbId).replace(/^[a-z_]+[-:]/i, '')))
          if (matches && matches.length > 0) {
            isAnimeLocal = true
            const first = matches[0]
            if (first.anilist_id) knownIds.anilistId = String(first.anilist_id)
            if (first.mal_id) knownIds.malId = String(first.mal_id)
            if (first.themoviedb_id) {
              const tmdbVal = typeof first.themoviedb_id === 'object'
                ? (first.themoviedb_id.tv || first.themoviedb_id.movie)
                : first.themoviedb_id
              if (tmdbVal) knownIds.tmdbId = String(tmdbVal)
            }
            if (first.imdb_id) knownIds.imdbId = Array.isArray(first.imdb_id) ? first.imdb_id[0] : first.imdb_id
          }
        } catch (_) { /* ignore */ }
      }

      if (state.sourceAddonId && state.sourceAddonItemId) {
        const normalized = await resolveAppMetadata({
          addonId: state.sourceAddonId, addonUrl: state.addonUrl, addonType: 'series', id: state.sourceAddonItemId,
          title: state.title, year: state.year, imdbId: knownIds.imdbId, tmdbId: Number(knownIds.tmdbId) || undefined,
          tvdbId: Number(knownIds.tvdbId) || undefined, anilistId: Number(knownIds.anilistId) || undefined,
          malId: Number(knownIds.malId) || undefined,
        }).catch(() => null)
        if (normalized && normalized.sourceMetadataProvider !== 'fallback_addon') {
          result = appMediaToShow(normalized)
          knownIds.imdbId ||= normalized.imdbId
          if (normalized.tmdbId != null) knownIds.tmdbId ||= String(normalized.tmdbId)
          if (normalized.tvdbId != null) knownIds.tvdbId ||= String(normalized.tvdbId)
          if (normalized.anilistId != null) knownIds.anilistId ||= String(normalized.anilistId)
          if (normalized.malId != null) knownIds.malId ||= String(normalized.malId)
        }
      }

      // If addon item, get IDs from addon meta first
      if (state.addonUrl || state.provider === 'addon' || (id?.startsWith('tt') && !knownIds.tmdbId)) {
        const tryAddonMeta = async (addonUrl: string) => {
          try {
            const meta = await getAddonMeta(addonUrl, 'series', id || '')
            if (meta) {
              setAddonMeta(meta)
              const parsed = addonMetaToShow(meta, id || '')
              if (parsed.imdbId) knownIds.imdbId = knownIds.imdbId || parsed.imdbId
              if (parsed.tmdbId) knownIds.tmdbId = knownIds.tmdbId || String(parsed.tmdbId)
              if (parsed.tvdbId) knownIds.tvdbId = knownIds.tvdbId || String(parsed.tvdbId)
              if (parsed.malId) knownIds.malId = knownIds.malId || String(parsed.malId)
              if (parsed.anilistId) knownIds.anilistId = knownIds.anilistId || String(parsed.anilistId)
              return parsed
            }
          } catch (_) { /* continue */ }
          return null
        }

        let addonResult: ShowDetails | null = null
        if (state.addonUrl) {
          addonResult = await tryAddonMeta(state.addonUrl)
        }
        if (!addonResult) {
          const metaAddons = getMetaAddons('series')
          const storeAddons = addons.filter((a) => a.enabled)
          for (const addon of metaAddons.length > 0 ? metaAddons : storeAddons) {
            addonResult = await tryAddonMeta(addon.url)
            if (addonResult) break
          }
        }
        // Keep addon result only as fallback — prefer app metadata below
        // For anime, skip addon metadata for display (addons often have wrong season structure)
        const isLikelyAnime = !!(knownIds.anilistId || knownIds.malId)
        const skipAddonDisplay = isLikelyAnime && useAppStore.getState().ignoreAddonMetadataForAnime
        if (skipAddonDisplay) {
          console.log('[SeriesDetailPage] Skipping addon metadata for anime display — addon only provides IDs')
          // Keep addon IDs but don't use addon for display
        } else if (addonResult && !result && useAppStore.getState().useAddonMetadataFallback) {
          result = addonResult
        }
      }

      // Show quick placeholder from route state while fetching real metadata
      const placeholder: ShowDetails | null = (state.title || result) ? {
        id: id || 'unknown',
        title: state.title || result?.title || '',
        year: state.year || result?.year,
        overview: state.overview || result?.overview,
        rating: state.rating || result?.rating,
        poster: state.poster || result?.poster,
        backdrop: state.backdrop || result?.backdrop,
        imdbId: knownIds.imdbId as string | undefined,
        tmdbId: knownIds.tmdbId,
        tvdbId: knownIds.tvdbId,
        malId: knownIds.malId,
        anilistId: knownIds.anilistId,
        genres: result?.genres || [],
        seasons: isAnimeLocal ? [] : (result?.seasons || []),
        cast: result?.cast || [],
        crew: result?.crew || [],
        recommendations: result?.recommendations || [],
        trailers: result?.trailers || [],
        provider: result?.provider,
      } : null

      if (placeholder) {
        const art = applyShowArt({ ...placeholder, seasons: processSeasons(placeholder.seasons, isAnimeLocal) })
        setShow(art)
        if (!isAnimeLocal) {
          if (art.seasons.length > 0) setSelectedSeason(art.seasons[0].seasonNumber)
          setLoading(false)
        }
      }

      // Early anime detection — route to TVDB first for anime
      const isAnimeEarly = isAnimeLocal
      let isAnimeLate = false

      if (isAnimeEarly) {
        console.log('[SeriesDetailPage] Anime detected, using TVDB-first flow')

        // IDs already resolved by early resolve above — use knownIds directly
        let tvdbId = knownIds.tvdbId ? String(knownIds.tvdbId).replace(/^[a-z_]+[-:]/i, '') : undefined
        let tmdbId = knownIds.tmdbId ? String(knownIds.tmdbId).replace(/^[a-z_]+[-:]/i, '') : undefined

        // Resolve TMDB ID if missing (needed for artwork)
        if (!tmdbId && knownIds.imdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
            if (found.tmdbId) tmdbId = String(found.tmdbId)
          } catch (_) { /* continue */ }
        }
        if (!tmdbId && tvdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(tvdbId, 'tvdb_id')
            if (found.tmdbId) tmdbId = String(found.tmdbId)
          } catch (_) { /* continue */ }
        }

        // TVDB is source of truth for anime season/episode structure
        if (tvdbId) {
          try {
            const tvdbData = await tvdbProvider.getShow(`tvdb-${tvdbId}`)
            console.log('[SeriesDetailPage] TVDB anime data:', {
              title: tvdbData.title,
              seasons: tvdbData.seasons.map(s => ({ num: s.seasonNumber, eps: s.episodeCount })),
            })

            if (tvdbData.seasons.length > 0) {
              const { mapTvdbSeasons } = await import('../services/metadata/tvdbSeasonMapper')
              const animeSettings = useAppStore.getState()
              const normalizedSeasons = tvdbData.seasons.map((s) => ({
                id: `tvdb_${tvdbId}_s${s.seasonNumber}`,
                seasonNumber: s.seasonNumber,
                title: s.name,
                overview: s.overview,
                poster: s.poster,
                episodeCount: s.episodeCount || 0,
                episodes: [],
                airDate: s.airDate,
              }))
              const mappedSeasons = await mapTvdbSeasons(Number(tvdbId), normalizedSeasons, {
                hideUnairedSeasons: animeSettings.hideUnairedAnimeSeasons,
                hideUnairedEpisodes: animeSettings.hideUnairedAnimeEpisodes,
                includeSpecials: animeSettings.includeAnimeSpecials,
              })

              console.log('[SeriesDetailPage] Mapped TVDB anime seasons:', mappedSeasons.map(s => ({
                seasonNumber: s.seasonNumber, episodeCount: s.episodeCount, title: s.title,
              })))

              // Validate structure
              const validation = validateAnimeTvdbStructure(mappedSeasons)
              if (validation.suspiciousSingleSeasonFlattening) {
                console.warn('[SeriesDetailPage] Suspicious anime structure:', validation.reason)
                setSuspiciousStructure(true)
              }

              // Debug logging
              debugAnimeMapping({
                localMediaId: id,
                title: tvdbData.title,
                year: tvdbData.year,
                anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
                malId: knownIds.malId ? Number(knownIds.malId) : undefined,
                tvdbId: Number(tvdbId),
                tmdbId: tmdbId ? Number(tmdbId) : undefined,
                imdbId: knownIds.imdbId,
                matchedTvdbSeriesId: Number(tvdbId),
                matchedTvdbSeriesName: tvdbData.title,
                seasons: mappedSeasons,
              })

              // Cache the mapper's deduplicated episodes so fetchSeason uses them
              // instead of re-fetching raw (inflated) data from TVDB
              const episodeMap: Record<number, SeasonDetails['episodes']> = {}
              for (const s of mappedSeasons) {
                if (s.episodes && s.episodes.length > 0) {
                  episodeMap[s.seasonNumber] = s.episodes.map((ep) => ({
                    id: ep.id,
                    episodeNumber: ep.episodeNumber,
                    seasonNumber: ep.seasonNumber,
                    name: ep.title || `Episode ${ep.episodeNumber}`,
                    overview: ep.overview,
                    airDate: ep.airDate,
                    runtime: ep.runtime,
                    still: ep.still,
                    rating: undefined,
                    voteCount: undefined,
                    debugSource: ep.debugSource || 'tvdb',
                    debugResolverStep: ep.debugResolverStep || 'tvdbSeasonMapper.mapTvdbSeasons',
                    absoluteEpisodeNumber: ep.absoluteEpisodeNumber,
                  }))
                }
              }
              tvdbMappedEpisodesRef.current = episodeMap

              appResult = {
                ...tvdbData,
                id: id || tvdbData.id,
                seasons: mappedSeasons.map((s) => {
                  const rawName = s.title || (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`)
                  const displayName = (rawName && isLikelyJapaneseOnly(rawName) && animeSettings.avoidJapaneseSeasonNames)
                    ? `Season ${s.seasonNumber}`
                    : rawName
                  return {
                    seasonNumber: s.seasonNumber,
                    name: s.seasonNumber === 0 ? 'Specials' : displayName,
                    episodeCount: s.episodeCount,
                    poster: s.poster,
                    overview: s.overview,
                    airDate: s.airDate,
                  }
                }),
                numberOfSeasons: mappedSeasons.filter(s => s.seasonNumber > 0).length,
                numberOfEpisodes: tvdbData.numberOfEpisodes,
                tvdbId: tvdbId,
                malId: knownIds.malId,
                anilistId: knownIds.anilistId,
              }
            }
          } catch (e) {
            console.warn('[SeriesDetailPage] TVDB fetch failed for anime:', e)
          }
        }

        // Enrich with TMDB artwork (poster, backdrop, logo) — never for seasons
        if (tmdbId) {
          try {
            const tmdbData = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
            if (appResult) {
              // Only take artwork and supplementary data from TMDB, never seasons
              appResult = {
                ...appResult,
                poster: appResult.poster || tmdbData.poster,
                backdrop: appResult.backdrop || tmdbData.backdrop,
                logo: tmdbData.logo || appResult.logo,
                overview: appResult.overview || tmdbData.overview,
                rating: tmdbData.rating || appResult.rating,
                cast: appResult.cast.length > 0 ? appResult.cast : tmdbData.cast,
                recommendations: tmdbData.recommendations.length > 0 ? tmdbData.recommendations : appResult.recommendations,
                trailers: tmdbData.trailers.length > 0 ? tmdbData.trailers : appResult.trailers,
                imdbId: appResult.imdbId || tmdbData.imdbId,
              }
            } else {
              // No TVDB data at all — use TMDB as fallback but log warning
              console.warn('[SeriesDetailPage] No TVDB data for anime, falling back to TMDB (seasons may be wrong)')
              appResult = {
                ...tmdbData,
                id: id || tmdbData.id,
                malId: knownIds.malId,
                anilistId: knownIds.anilistId,
              }
            }
          } catch (_) { /* continue */ }
        }

        // Preserve IDs
        if (appResult) {
          appResult = {
            ...appResult,
            id: id || appResult.id,
            malId: appResult.malId || knownIds.malId,
            anilistId: appResult.anilistId || knownIds.anilistId,
          }
        }

        // Persist anime mapping so future loads skip re-resolution
        const localMediaId = appResult?.id || id || ''
        if (localMediaId) {
          const mapping: AnimeMappingResult = {
            localMediaId,
            tvdbId: tvdbId ? Number(tvdbId) : undefined,
            tmdbId: tmdbId ? Number(tmdbId) : undefined,
            anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
            malId: knownIds.malId ? Number(knownIds.malId) : undefined,
            seasons: (appResult?.seasons || []).map((s, idx) => ({
              localMediaId,
              seasonNumber: s.seasonNumber,
              anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
              malId: knownIds.malId ? Number(knownIds.malId) : undefined,
              tvdbSeriesId: tvdbId ? Number(tvdbId) : undefined,
              tvdbSeasonNumber: s.seasonNumber,
              tmdbId: tmdbId ? Number(tmdbId) : undefined,
              title: s.name,
              episodeCount: s.episodeCount,
            })),
            confidence: 0.9,
            source: 'animeApi',
            updatedAt: new Date().toISOString(),
          }
          saveAnimeMapping(mapping).catch(() => {})
        }
      } else {
        // Non-anime: Respect settings metadata source configuration
        const primarySource = useAppStore.getState().seriesMetadataSource ?? 'tmdb'
        const useFallback = useAppStore.getState().seriesMetadataFallback ?? true

        let tmdbId = knownIds.tmdbId ? String(knownIds.tmdbId).replace(/^[a-z_]+[-:]/i, '') : undefined
        let tvdbId = knownIds.tvdbId ? String(knownIds.tvdbId).replace(/^[a-z_]+[-:]/i, '') : undefined

        // Resolve TMDB ID if needed
        if (!tmdbId && knownIds.imdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
            if (found.tmdbId) tmdbId = String(found.tmdbId)
          } catch (_) { /* continue */ }
        }
        if (!tmdbId && tvdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(tvdbId, 'tvdb_id')
            if (found.tmdbId) tmdbId = String(found.tmdbId)
          } catch (_) { /* continue */ }
        }

        // Resolve TVDB ID if needed
        if (!tvdbId && tmdbId) {
          try {
            const data = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
            if (data.tvdbId) tvdbId = String(data.tvdbId).replace(/^[a-z_]+[-:]/i, '')
          } catch (_) { /* continue */ }
        }
        if (!tvdbId && knownIds.imdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
            if (found.tmdbId) {
              const data = await tmdbProvider.getShow(`tmdb-${found.tmdbId}`)
              if (data.tvdbId) tvdbId = String(data.tvdbId).replace(/^[a-z_]+[-:]/i, '')
            }
          } catch (_) { /* continue */ }
        }

        // Fetch using configuration priority
        if (primarySource === 'tvdb') {
          if (tvdbId) {
            try {
              appResult = await tvdbProvider.getShow(`tvdb-${tvdbId}`)
            } catch (_) { /* continue */ }
          }
          if (!appResult && useFallback && tmdbId) {
            try {
              appResult = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
            } catch (_) { /* continue */ }
          }
        } else {
          if (tmdbId) {
            try {
              appResult = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
            } catch (_) { /* continue */ }
          }
          if (!appResult && useFallback && tvdbId) {
            try {
              appResult = await tvdbProvider.getShow(`tvdb-${tvdbId}`)
            } catch (_) { /* continue */ }
          }
        }

        // Enrich TVDB series with TMDB artwork and supplementary metadata (logos, cast, trailers, etc.)
        if (appResult && appResult.provider === 'tvdb' && tmdbId) {
          try {
            const tmdbData = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
            appResult = {
              ...appResult,
              tmdbId: appResult.tmdbId || tmdbId,
              poster: appResult.poster || tmdbData.poster,
              backdrop: appResult.backdrop || tmdbData.backdrop,
              logo: tmdbData.logo || appResult.logo,
              overview: appResult.overview || tmdbData.overview,
              rating: tmdbData.rating || appResult.rating,
              cast: appResult.cast.length > 0 ? appResult.cast : tmdbData.cast,
              recommendations: tmdbData.recommendations.length > 0 ? tmdbData.recommendations : appResult.recommendations,
              trailers: tmdbData.trailers.length > 0 ? tmdbData.trailers : appResult.trailers,
              imdbId: appResult.imdbId || tmdbData.imdbId,
            }
          } catch (_) { /* ignore fallback errors */ }
        }

        // Detect anime late (via anime-lists) and apply TVDB override
        if (appResult) {
          isAnimeLate = !!(
            (appResult.imdbId && await import('../services/animeLists').then(m => m.lookupByImdbId(appResult!.imdbId!)).then(e => !!e).catch(() => false)) ||
             (appResult.tvdbId && await import('../services/animeLists').then(m => m.lookupByTvdbId(Number(String(appResult!.tvdbId).replace(/^[a-z_]+[-:]/i, '')))).then(e => e.length > 0).catch(() => false))
          )

          if (isAnimeLate) {
            console.log('[SeriesDetailPage] Late anime detection — applying TVDB season override')
            // Always resolve via anime-lists for anime — its TVDB mapping is
            // curated and more reliable than TMDB's external-ID linkage.
            let tvdbId: string | undefined
            try {
              const { resolveAnimeIds } = await import('../services/animeLists')
              const resolved = await resolveAnimeIds({
                imdbId: appResult.imdbId,
                tmdbId: tmdbId ? Number(tmdbId) : undefined,
                tvdbId: appResult.tvdbId ? Number(String(appResult.tvdbId).replace(/^[a-z_]+[-:]/i, '')) : undefined,
              })
              if (resolved?.tvdbId) tvdbId = String(resolved.tvdbId)
              if (resolved?.tmdbId) appResult = { ...appResult, tmdbId: appResult.tmdbId || resolved.tmdbId }
              if (resolved?.anilistId) appResult = { ...appResult, anilistId: appResult.anilistId || resolved.anilistId }
              if (resolved?.malId) appResult = { ...appResult, malId: appResult.malId || resolved.malId }
            } catch (_) { /* continue */ }
            if (!tvdbId) {
               tvdbId = appResult.tvdbId ? String(appResult.tvdbId).replace(/^[a-z_]+[-:]/i, '') : undefined
            }
            if (tvdbId) {
              try {
                const tvdbData = await tvdbProvider.getShow(`tvdb-${tvdbId}`)
                if (tvdbData.seasons.length > 0) {
                  const { mapTvdbSeasons } = await import('../services/metadata/tvdbSeasonMapper')
                  const animeSettings = useAppStore.getState()
                  const normalizedSeasons = tvdbData.seasons.map((s) => ({
                    id: `tvdb_${tvdbId}_s${s.seasonNumber}`,
                    seasonNumber: s.seasonNumber,
                    title: s.name,
                    overview: s.overview,
                    poster: s.poster,
                    episodeCount: s.episodeCount || 0,
                    episodes: [],
                    airDate: s.airDate,
                  }))
                  const mappedSeasons = await mapTvdbSeasons(Number(tvdbId), normalizedSeasons, {
                    hideUnairedSeasons: animeSettings.hideUnairedAnimeSeasons,
                    hideUnairedEpisodes: animeSettings.hideUnairedAnimeEpisodes,
                    includeSpecials: animeSettings.includeAnimeSpecials,
                  })
                  const lateValidation = validateAnimeTvdbStructure(mappedSeasons)
                  if (lateValidation.suspiciousSingleSeasonFlattening) {
                    console.warn('[SeriesDetailPage] Late anime — suspicious structure:', lateValidation.reason)
                    setSuspiciousStructure(true)
                  }

                  // Cache mapper's deduplicated episodes for late anime detection
                  const lateEpisodeMap: Record<number, SeasonDetails['episodes']> = {}
                  for (const s of mappedSeasons) {
                    if (s.episodes && s.episodes.length > 0) {
                      lateEpisodeMap[s.seasonNumber] = s.episodes.map((ep) => ({
                        id: ep.id,
                        episodeNumber: ep.episodeNumber,
                        seasonNumber: ep.seasonNumber,
                        name: ep.title || `Episode ${ep.episodeNumber}`,
                        overview: ep.overview,
                        airDate: ep.airDate,
                        runtime: ep.runtime,
                        still: ep.still,
                        rating: undefined,
                        voteCount: undefined,
                        debugSource: ep.debugSource || 'tvdb',
                        debugResolverStep: ep.debugResolverStep || 'tvdbSeasonMapper.mapTvdbSeasons',
                        absoluteEpisodeNumber: ep.absoluteEpisodeNumber,
                      }))
                    }
                  }
                  tvdbMappedEpisodesRef.current = lateEpisodeMap

                  appResult = {
                    ...appResult,
                    seasons: mappedSeasons.map((s) => {
                      const rawName = s.title || (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`)
                      const displayName = (rawName && isLikelyJapaneseOnly(rawName) && animeSettings.avoidJapaneseSeasonNames)
                        ? `Season ${s.seasonNumber}`
                        : rawName
                      return {
                        seasonNumber: s.seasonNumber,
                        name: s.seasonNumber === 0 ? 'Specials' : displayName,
                        episodeCount: s.episodeCount,
                        poster: s.poster,
                        overview: s.overview,
                        airDate: s.airDate,
                      }
                    }),
                    numberOfSeasons: mappedSeasons.filter(s => s.seasonNumber > 0).length,
                    numberOfEpisodes: tvdbData.numberOfEpisodes || appResult.numberOfEpisodes,
                    tvdbId: tvdbId,
                    cast: appResult.cast.length > 0 ? appResult.cast : tvdbData.cast,
                    poster: tvdbData.poster || appResult.poster,
                    backdrop: tvdbData.backdrop || appResult.backdrop,
                  }
                }
              } catch (_) { /* continue */ }
            }
          }

          // Preserve original ID and merge any extra addon IDs
          appResult = {
            ...appResult,
            id: id || appResult.id,
            malId: appResult.malId || knownIds.malId,
            anilistId: appResult.anilistId || knownIds.anilistId,
            tmdbId: appResult.tmdbId || knownIds.tmdbId,
          }

          // Persist late-detected anime mapping
          if (isAnimeLate) {
            const lateTvdb = appResult.tvdbId ? Number(String(appResult.tvdbId).replace(/^[a-z_]+[-:]/i, '')) : undefined
            const lateTmdb = tmdbId ? Number(tmdbId) : undefined
            const lateLocalId = appResult.id || id || ''
            if (lateLocalId) {
              const lateMapping: AnimeMappingResult = {
                localMediaId: lateLocalId,
                tvdbId: lateTvdb,
                tmdbId: lateTmdb,
                anilistId: appResult.anilistId ? Number(appResult.anilistId) : undefined,
                malId: appResult.malId ? Number(appResult.malId) : undefined,
                seasons: (appResult.seasons || []).map((s) => ({
                  localMediaId: lateLocalId,
                  seasonNumber: s.seasonNumber,
                  tvdbSeriesId: lateTvdb,
                  tvdbSeasonNumber: s.seasonNumber,
                  tmdbId: lateTmdb,
                  anilistId: appResult!.anilistId ? Number(appResult!.anilistId) : undefined,
                  malId: appResult!.malId ? Number(appResult!.malId) : undefined,
                  title: s.name,
                  episodeCount: s.episodeCount,
                })),
                confidence: 0.8,
                source: 'animeApi',
                updatedAt: new Date().toISOString(),
              }
              saveAnimeMapping(lateMapping).catch(() => {})
            }
          }
        }

        // If no TMDB data, try TVDB directly
        if (!appResult && knownIds.tvdbId) {
          try {
             appResult = await tvdbProvider.getShow(`tvdb-${String(knownIds.tvdbId).replace(/^[a-z_]+[-:]/i, '')}`)
            appResult = { ...appResult, id: id || appResult.id, malId: knownIds.malId, anilistId: knownIds.anilistId }
          } catch (_) { /* continue */ }
        }
      }

      // Use app result if available, otherwise keep addon/placeholder
      const finalResult = appResult || result || (placeholder ? placeholder : { ...MOCK_SHOW, id: id || 'mock-show-1' })

      const cleanTvdb = cleanId(finalResult.tvdbId)
      const cleanTmdb = cleanId(finalResult.tmdbId)
       const finalTvdbId = cleanTvdb ? String(cleanTvdb).replace(/^[a-z_]+[-:]/i, '') : undefined
      const finalTmdbId = cleanTmdb ? String(cleanTmdb).replace(/^[a-z_]+[-:]/i, '') : undefined
      const finalImdbId = finalResult.imdbId
      const isAnime = isAnimeEarly || isAnimeLate

      // Preserving AniList artwork if it exists in route state
      if (finalResult && (finalResult.anilistId || finalResult.malId || isAnime)) {
        if (state.poster) finalResult.poster = state.poster
        if (state.backdrop) finalResult.backdrop = state.backdrop
      }

      // Anime uses TVDB as canonical ID; regular shows use TMDB
      const targetId = isAnime
        ? (finalTvdbId ? `app_tvdb_${finalTvdbId}` : finalTmdbId ? `app_tmdb_tv_${finalTmdbId}` : finalImdbId ? `app_show_${finalImdbId}` : finalResult.id || id || 'unknown')
        : (finalTmdbId ? `app_tmdb_tv_${finalTmdbId}` : finalTvdbId ? `app_tvdb_${finalTvdbId}` : finalImdbId ? `app_show_${finalImdbId}` : finalResult.id || id || 'unknown')

      finalResult.id = targetId
      finalResult.isAnime = isAnime
      finalResult.seasons = processSeasons(finalResult.seasons, isAnime)
      const artApplied = finalResult

      // Resolve IMDb ID if still missing (needed for posters/ratings)
      if (!artApplied.imdbId && (artApplied.tmdbId || artApplied.tvdbId)) {
        try {
          const { resolveImdbId } = await import('../services/metadataEnrich')
          const imdbId = await resolveImdbId(artApplied, 'series')
          if (imdbId) artApplied.imdbId = imdbId
        } catch (_) { /* continue */ }
      }

      let finalArt = artApplied

      const providerArt = await resolveArtFromProviders('series', {
        tmdbId: finalArt.tmdbId, tvdbId: finalArt.tvdbId, imdbId: finalArt.imdbId,
      }, finalArt.isAnime)
      if (providerArt.poster || providerArt.backdrop || providerArt.logo) {
        finalArt = { ...finalArt, ...(providerArt.poster && { poster: providerArt.poster }), ...(providerArt.backdrop && { backdrop: providerArt.backdrop }), ...(providerArt.logo && { logo: providerArt.logo }) }
      }
      finalArt = applyShowArt(finalArt)

      if (isAnimeLocal) {
        console.log("[AnimeDetail] setting seasons", {
          source: appResult ? 'app_metadata' : (result ? 'addon_metadata' : 'fallback'),
          seasonNumbers: finalArt.seasons.map(s => s.seasonNumber),
          episodeCounts: finalArt.seasons.map(s => ({
            seasonNumber: s.seasonNumber,
            count: s.episodeCount,
          })),
        });
      }

      setSeasonCache({})
      setShow(finalArt)
      const firstNormalSeason = finalArt.seasons.find(s => s.seasonNumber > 0)
      const nextSelectedSeason = firstNormalSeason?.seasonNumber ?? finalArt.seasons[0]?.seasonNumber ?? null
      if (finalArt.seasons.length > 0) {
        setSelectedSeason(nextSelectedSeason)
      } else {
        setSelectedSeason(null)
      }

      let status: 'resolved' | 'fallback' | 'error' = 'resolved'
      if (appResult) {
        status = 'resolved'
      } else if (result) {
        status = 'fallback'
      } else {
        status = 'error'
      }
      setMetadataStatus(status)
      setLoading(false)

      writeSeriesDetailCache(id, state, {
        show: finalArt,
        selectedSeason: nextSelectedSeason,
        episodeMap: tvdbMappedEpisodesRef.current,
        metadataStatus: status,
      })

      if (id && finalArt.id && finalArt.id !== id) {
        console.log('[SeriesDetailPage] Normalizing URL route ID to:', finalArt.id)
        navigate(`/series/${finalArt.id}`, { replace: true, state })
      }
    }
    load()
  }, [id, state.addonUrl, state.provider, state.title, addons, artSettingsSignature])

  useEffect(() => {
    if (!show) return
    const isAnime = !!show.isAnime
    if (!isAnime) return

    let cancelled = false
    import('../services/mdblist').then(({ getMdblistRatings }) => {
      return getMdblistRatings({
        mediaType: 'series',
        imdbId: show.imdbId,
        tmdbId: show.tmdbId,
        tvdbId: show.tvdbId,
      })
    }).then((ratings) => {
      if (cancelled || !ratings) return
      const mal = ratings.find((r) => r.source === 'myanimelist')
      if (mal) {
        const val = parseFloat(mal.value)
        if (!isNaN(val)) setMalRating(val)
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [show])

  const fetchSeason = async (seasonNum: number): Promise<SeasonDetails | null> => {
    if (!show || !id) return null

    const applyArt = (data: SeasonDetails) => ({
      ...data,
      episodes: data.episodes.map((episode) => applyEpisodeArt(episode, { ...show, season: seasonNum })),
    })

    const tmdbId = show.tmdbId ? String(show.tmdbId).replace(/^[a-z_]+[-:]/i, '') : (id && /^(?:tmdb)[-:]/i.test(id) ? id.replace(/^[a-z_]+[-:]/i, '') : null)
    const tvdbId = show.tvdbId ? String(show.tvdbId).replace(/^[a-z_]+[-:]/i, '') : (id && /^(?:tvdb)[-:]/i.test(id) ? id.replace(/^[a-z_]+[-:]/i, '') : null)

    const tryTmdb = async (): Promise<SeasonDetails | null> => {
      if (!tmdbId) return null
      try {
        const data = await tmdbProvider.getSeason(`tmdb-${tmdbId}`, seasonNum)
        if (data.episodes.length > 0) {
          const tagged = {
            ...data,
            debugSource: 'tmdb',
            debugResolverStep: 'fetchSeason.tryTmdb',
            episodes: data.episodes.map(e => ({
              ...e,
              debugSource: e.debugSource || 'tmdb',
              debugResolverStep: e.debugResolverStep || 'fetchSeason.tryTmdb',
            }))
          }
          return applyArt(tagged)
        }
      } catch (_) { /* fall through */ }
      return null
    }

    const isAnimeShow = isAnime

    const tryTvdb = async (): Promise<SeasonDetails | null> => {
      if (!tvdbId) return null

      // Use mapper-cached episodes if available — they're already deduplicated
      const cachedEpisodes = tvdbMappedEpisodesRef.current[seasonNum]
      if (isAnimeShow && cachedEpisodes && cachedEpisodes.length > 0) {
        console.log('[fetchSeason] Using mapper-cached episodes for season', seasonNum, ':', cachedEpisodes.length, 'episodes')
        const seasonInfo = show?.seasons.find((s) => s.seasonNumber === seasonNum)
        return applyArt({
          seasonNumber: seasonNum,
          name: seasonInfo?.name || `Season ${seasonNum}`,
          episodes: cachedEpisodes,
        })
      }

      try {
        const data = await tvdbProvider.getSeason(`tvdb-${tvdbId}`, seasonNum)
        if (data.episodes.length === 0) return null
        if (isAnimeShow) {
          const today = new Date().toISOString().slice(0, 10)
          const settings = useAppStore.getState()

          // Filter episodes that don't belong to this season (TVDB sometimes
          // returns all episodes in the Season 1 response)
          data.episodes = data.episodes.filter((ep) => {
            if (ep.seasonNumber != null && ep.seasonNumber !== seasonNum) return false
            return true
          })

          if (settings.hideUnairedAnimeEpisodes) {
            data.episodes = data.episodes.filter((ep) => {
              if (!ep.airDate) return !!(ep.name || ep.overview)
              return ep.airDate.slice(0, 10) <= today
            })
          }

          // If Season 1 has way more episodes than the summary says, trim to
          // match the episode count from the initial mapping (which already
          // de-duplicated via tvdbSeasonMapper).
          if (seasonNum === 1 && show) {
            const seasonSummary = show.seasons.find((s) => s.seasonNumber === 1)
            if (seasonSummary && seasonSummary.episodeCount > 0 && data.episodes.length > seasonSummary.episodeCount * 1.3) {
              console.log('[fetchSeason] Trimming S1 episodes from', data.episodes.length, 'to', seasonSummary.episodeCount)
              data.episodes = data.episodes.slice(0, seasonSummary.episodeCount)
            }
          }
        }
        if (data.episodes.length > 0) {
          const tagged = {
            ...data,
            debugSource: 'tvdb',
            debugResolverStep: 'fetchSeason.tryTvdb',
            episodes: data.episodes.map(e => ({
              ...e,
              debugSource: e.debugSource || 'tvdb',
              debugResolverStep: e.debugResolverStep || 'fetchSeason.tryTvdb',
            }))
          }
          return applyArt(tagged)
        }
      } catch (_) { /* fall through */ }
      return null
    }

    // Anime: TVDB first (correct per-season episode mapping — TMDB lumps all eps into season 1)
    // Regular: TMDB first (better English titles/images)
    if (isAnimeShow) {
      const tvdbResult = await tryTvdb()
      if (tvdbResult) return tvdbResult
      const tmdbResult = await tryTmdb()
      if (tmdbResult) return tmdbResult
    } else {
      const tmdbResult = await tryTmdb()
      if (tmdbResult) return tmdbResult
      const tvdbResult = await tryTvdb()
      if (tvdbResult) return tvdbResult
    }

    if (isAnimeShow) {
      console.warn("Blocked anime fallback Season 1 generation");
      return null;
    }

    if (addonMeta && Array.isArray(addonMeta.videos) && !isAnimeShow) {
      return applyArt(addonVideosToSeason(addonMeta, seasonNum, isAnimeShow))
    }

    const seasonInfo = show.seasons.find(s => s.seasonNumber === seasonNum)
    if (seasonInfo && seasonInfo.episodeCount > 0) {
      const episodes = Array.from({ length: seasonInfo.episodeCount }, (_, i) => ({
        id: `${seasonNum}-${i + 1}`,
        episodeNumber: i + 1,
        seasonNumber: seasonNum,
        name: `Episode ${i + 1}`,
        debugSource: 'ui-generated',
        debugResolverStep: 'fetchSeason.seasonInfoFallback',
      }))
      return applyArt({ seasonNumber: seasonNum, name: seasonInfo.name, episodes })
    }

    return applyArt(MOCK_SEASON)
  }

  const isCached = selectedSeason !== null && seasonCache[selectedSeason] !== undefined
  useEffect(() => {
    if (!show || !id || selectedSeason === null || isCached) return

    let cancelled = false
    fetchSeason(selectedSeason).then((data) => {
      if (cancelled || !data) return
      setSeasonCache(prev => ({ ...prev, [selectedSeason]: data }))
    })

    return () => { cancelled = true }
  }, [show, id, selectedSeason, addonMeta, isCached])

  // Prefetch other seasons in the background
  useEffect(() => {
    if (!show || !id || selectedSeason === null || !seasonCache[selectedSeason]) return

    const uncachedSeasons = show.seasons
      .map(s => s.seasonNumber)
      .filter(num => seasonCache[num] === undefined)

    if (uncachedSeasons.length === 0) return

    let cancelled = false
    const prefetch = async () => {
      for (const num of uncachedSeasons) {
        if (cancelled) break
        const data = await fetchSeason(num)
        if (data && !cancelled) {
          setSeasonCache(prev => ({ ...prev, [num]: data }))
        }
      }
    }
    prefetch()

    return () => { cancelled = true }
  }, [show, id, seasonCache, selectedSeason, addonMeta])

  useEffect(() => {
    if (!show || !seasonData || seasonData.seasonNumber !== selectedSeason) return

    const cacheKey = `${show.id}:${selectedSeason}`
    if (fetchedSeasonRef.current === cacheKey) return

    const hasImdbRatings = seasonData.episodes.some(ep => ep.imdbRating !== undefined)
    if (hasImdbRatings) {
      fetchedSeasonRef.current = cacheKey
      return
    }

    fetchedSeasonRef.current = cacheKey
    let cancelled = false

    const fetchOMDb = (url: string) => {
      fetch(url)
        .then(res => res.json())
        .then(omdbData => {
          if (cancelled) return
          if (omdbData.Response === 'True' && Array.isArray(omdbData.Episodes)) {
            const ratingsMap = new Map()
            for (const ep of omdbData.Episodes) {
              const epNum = parseInt(ep.Episode)
              const ratingVal = ep.imdbRating
              const imdbIdVal = ep.imdbID
              if (!isNaN(epNum)) {
                ratingsMap.set(epNum, {
                  rating: (ratingVal && ratingVal !== 'N/A') ? ratingVal : undefined,
                  imdbId: (imdbIdVal && imdbIdVal !== 'N/A') ? imdbIdVal : undefined
                })
              }
            }

            setSeasonCache(prev => {
              const cached = prev[selectedSeason]
              if (!cached) return prev
              const updatedEpisodes = cached.episodes.map(ep => {
                const info = ratingsMap.get(ep.episodeNumber)
                if (info) {
                  return {
                    ...ep,
                    imdbRating: info.rating || ep.imdbRating,
                    imdbId: info.imdbId || ep.imdbId
                  }
                }
                return ep
              })
              return {
                ...prev,
                [selectedSeason]: {
                  ...cached,
                  episodes: updatedEpisodes
                }
              }
            })
          } else if (omdbData.Response === 'False' && url.includes('?i=')) {
            const fallbackUrl = `https://www.omdbapi.com/?t=${encodeURIComponent(show.title)}&Season=${selectedSeason}&apikey=thewdb`
            fetchOMDb(fallbackUrl)
          }
        })
        .catch(() => {})
    }

    if (show.imdbId) {
      fetchOMDb(`https://www.omdbapi.com/?i=${show.imdbId}&Season=${selectedSeason}&apikey=thewdb`)
    } else {
      fetchOMDb(`https://www.omdbapi.com/?t=${encodeURIComponent(show.title)}&Season=${selectedSeason}&apikey=thewdb`)
    }

    return () => { cancelled = true }
  }, [show, selectedSeason, seasonData])

  // Check watched status — uses refs for watchProgress/completedIds to avoid re-triggering on every progress update
  useEffect(() => {
    if (!show || selectedSeason === null) {
      setWatchedEpisodes(new Set())
      return
    }
    const visibleSeason = seasonCache[selectedSeason]
    if (!visibleSeason) return
    let cancelled = false

    const appSeasonEpCounts = isAnime ? show.seasons
      .filter((s) => s.seasonNumber > 0)
      .map((s) => ({ season: s.seasonNumber, count: s.episodeCount }))
      .sort((a, b) => a.season - b.season) : undefined

    const toLookup = (episode: { seasonNumber: number; episodeNumber: number; absoluteEpisodeNumber?: number; debugOriginalAbsoluteNumber?: number; tmdbId?: string | number; tvdbId?: string | number }): WatchedLookupItem => ({
      id: show.id,
      type: 'series',
      title: show.title,
      year: show.year,
      imdbId: show.imdbId,
      tmdbId: show.tmdbId ?? episode.tmdbId,
      tvdbId: show.tvdbId ?? episode.tvdbId,
      // Pass the show's AniList/MAL ids so AniList resolution can use the strongest
      // identifier directly instead of relying only on TVDB→AniList episode mapping.
      malId: show.malId,
      anilistId: show.anilistId,
      season: episode.seasonNumber,
      episode: episode.episodeNumber,
      absoluteEpisode: episode.absoluteEpisodeNumber ?? episode.debugOriginalAbsoluteNumber,
      isAnime,
      appSeasonEpCounts,
    })

    // For anime, honour the "Anime Tracking Provider: AniList" setting by consulting
    // AniList even when the user hasn't toggled it into the global watched sources.
    const effectiveSources = isAnime && anilistConnected && animeTrackingProvider === 'anilist' && !watchedCheckmarkSources.includes('anilist')
      ? [...watchedCheckmarkSources, 'anilist' as const]
      : watchedCheckmarkSources

    // Check visible season first via batch
    const visibleLookups = visibleSeason.episodes.map(toLookup)
    batchIsWatchedFromProviders(visibleLookups, effectiveSources, completedIdsRef.current).then((watchedKeys) => {
      if (cancelled) return
      setWatchedEpisodes((prev) => {
        const next = new Set(prev)
        for (const ep of visibleSeason.episodes) {
          const k = `${ep.seasonNumber}:${ep.episodeNumber}`
          if (watchedKeys.has(k)) next.add(k)
          else next.delete(k)
        }
        return next
      })

      // Then check other seasons in background
      const otherEpisodes = Object.entries(seasonCache)
        .filter(([num]) => Number(num) !== selectedSeason)
        .flatMap(([, season]) => season.episodes)
      if (otherEpisodes.length === 0 || cancelled) return
      const otherLookups = otherEpisodes.map(toLookup)
      batchIsWatchedFromProviders(otherLookups, effectiveSources, completedIdsRef.current).then((otherKeys) => {
        if (cancelled) return
        setWatchedEpisodes((prev) => {
          const next = new Set(prev)
          for (const ep of otherEpisodes) {
            const k = `${ep.seasonNumber}:${ep.episodeNumber}`
            if (otherKeys.has(k)) next.add(k)
            else next.delete(k)
          }
          return next
        })
      }).catch(() => {})
    }).catch(() => {
      if (!cancelled) setWatchedEpisodes(new Set())
    })
    return () => { cancelled = true }
  }, [show, selectedSeason, seasonCache, watchedCheckmarkSources, isAnime, anilistConnected, animeTrackingProvider])

  useEffect(() => {
    if (!show || show.recommendations.length > 0) return
    const query = show.genres[0] || show.title
    tmdbProvider.recommendationsForText?.(query, 'series')
      .then((results) => {
        const filtered = results.filter((item) => item.id !== show.id && item.title !== show.title)
        setFallbackRecommendations((filtered.length ? filtered : rotateFallback(MOCK_POPULAR_SHOWS, show.id)).map(applySearchResultArt))
      })
      .catch(() => setFallbackRecommendations(rotateFallback(MOCK_POPULAR_SHOWS, show.id).map(applySearchResultArt)))
  }, [show])

  useEffect(() => {
    const container = seasonScrollRef.current
    if (!container) {
      setShowSeasonArrows(false)
      return
    }

    const updateOverflow = () => {
      setShowSeasonArrows(container.scrollWidth > container.clientWidth + 1)
    }

    updateOverflow()
    window.addEventListener('resize', updateOverflow)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateOverflow) : null
    observer?.observe(container)
    return () => {
      window.removeEventListener('resize', updateOverflow)
      observer?.disconnect()
    }
  }, [show?.seasons.length])

  if (isAnime) {
    console.log("[AnimeDetail] initial render", {
      mediaId: id,
      mediaType: 'series',
      metadataStatus,
      seasonsCount: show?.seasons?.length,
      seasonNumbers: show?.seasons?.map(s => s.seasonNumber),
    });
  }


  useGlobalBackdrop(show?.backdrop || show?.poster)

  useEffect(() => {
    if (!show) return
    const resume = liveResumePoint || resumeProgress
    if (!resume?.season || !resume?.episode) return
    const mediaId = show.imdbId || state.sourceAddonItemId || id || ''
    if (!mediaId) return
    streamPreloadManager.request({
      mediaType: 'series',
      mediaId,
      imdbId: show.imdbId,
      tmdbId: show.tmdbId,
      seasonEpisode: { season: resume.season, episode: resume.episode },
      sourceAddonId: state.sourceAddonId,
      sourceAddonItemId: state.sourceAddonItemId,
    }, { priority: StreamPreloadPriority.DETAILS_OPEN }).catch(() => undefined)
  }, [show?.id, show?.imdbId, show?.tmdbId, liveResumePoint?.season, liveResumePoint?.episode, resumeProgress?.season, resumeProgress?.episode, id, state.sourceAddonId, state.sourceAddonItemId])

  if (isAnime && metadataStatus === 'resolving') {
    return (
      <div className="pb-12 animate-pulse">
        {/* Hero Skeleton / Image */}
        <div className="relative w-full overflow-hidden bg-surface-elevated/40" style={{ height: 'clamp(550px, 70vh, 850px)' }}>
          {show?.backdrop ? (
            <img
              src={show.backdrop}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-25"
              style={{ objectPosition: 'center 15%' }}
              draggable={false}
            />
          ) : show?.poster ? (
            <img
              src={show.poster}
              alt=""
              className="absolute inset-0 w-full h-full object-cover blur-3xl scale-125 opacity-25"
              draggable={false}
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent z-10" />
          <div className="absolute inset-x-8 bottom-12 z-20 max-w-4xl flex gap-8 items-end">
            {/* Poster Skeleton */}
            {show?.poster ? (
              <img
                src={show.poster}
                alt=""
                className="w-48 aspect-[2/3] rounded-2xl object-cover shadow-2xl ring-1 ring-white/10 hidden md:block"
                draggable={false}
              />
            ) : (
              <div className="w-48 aspect-[2/3] rounded-2xl bg-white/[0.04] hidden md:block" />
            )}
            <div className="flex-1 flex flex-col gap-4">
              {/* Title Skeleton */}
              {show?.title ? (
                <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white/90">{show.title}</h1>
              ) : (
                <div className="h-10 w-3/4 bg-white/[0.06] rounded-xl" />
              )}
              <div className="flex gap-2">
                <div className="h-4 w-16 bg-white/[0.04] rounded-md" />
                <div className="h-4 w-12 bg-white/[0.04] rounded-md" />
                <div className="h-4 w-24 bg-white/[0.04] rounded-md" />
              </div>
              {/* Overview Skeleton */}
              <div className="space-y-2.5 mt-2">
                <div className="h-4 w-full bg-white/[0.04] rounded-md" />
                <div className="h-4 w-5/6 bg-white/[0.04] rounded-md" />
                <div className="h-4 w-2/3 bg-white/[0.04] rounded-md" />
              </div>
              <div className="h-12 w-48 bg-white/[0.06] rounded-xl mt-4" />
            </div>
          </div>
        </div>

        {/* Season & Episode Skeleton */}
        <div className="px-8 mt-8">
          <div className="flex gap-3 mb-6">
            <div className="h-10 w-28 bg-white/[0.06] rounded-xl" />
            <div className="h-10 w-28 bg-white/[0.04] rounded-xl" />
            <div className="h-10 w-28 bg-white/[0.04] rounded-xl" />
          </div>
          <div className="flex gap-6 overflow-x-hidden pb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[320px] flex flex-col gap-3">
                <div className="aspect-video rounded-2xl bg-white/[0.06]" />
                <div className="h-4 w-16 bg-white/[0.04] rounded-md" />
                <div className="h-5 w-48 bg-white/[0.06] rounded-md" />
                <div className="h-4 w-full bg-white/[0.04] rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (loading || !show) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }



  const handlePlayEpisode = (seasonNum: number, episodeNum: number) => {
    setStreamEpisode({ season: seasonNum, episode: episodeNum })
    setStreamOpen(true)
  }

  const selectSeason = (seasonNumber: number) => {
    setSelectedSeason(seasonNumber)
    episodeScrollRef.current?.scrollTo({ left: 0, behavior: 'auto' })
    window.requestAnimationFrame(() => {
      const selected = seasonScrollRef.current?.querySelector<HTMLElement>(`[data-season="${seasonNumber}"]`)
      selected?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    })
  }

  const scrollSeasons = (direction: 'left' | 'right') => {
    const container = seasonScrollRef.current
    if (!container) return
    const amount = Math.max(320, container.clientWidth * 0.7)
    container.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' })
  }

  const handleSeasonWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    const amount = Math.abs(event.deltaY) >= 1 ? event.deltaY : event.deltaX
    if (Math.abs(amount) < 1) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: amount, behavior: 'smooth' })
  }

  const handleEpisodeWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    const amount = Math.abs(event.deltaY) >= 1 ? event.deltaY : event.deltaX
    if (Math.abs(amount) < 1) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: amount, behavior: 'smooth' })
  }

  const highQualityEpisodeStill = (url?: string) => {
    if (!url) return undefined
    return url.replace(/\/t\/p\/(w300|w500|w780|w1280)\//, '/t/p/original/')
  }

  const streamId = show.imdbId || state.sourceAddonItemId || id || ''
  const streamTmdbId = show.tmdbId ? Number(show.tmdbId) : (id && /^(?:tmdb)[-:]/i.test(id) ? Number(id.replace(/^[a-z_]+[-:]/i, '')) : undefined)

  const activeResume = liveResumePoint || (resumeProgress ? {
    season: resumeProgress.season!,
    episode: resumeProgress.episode!,
    progressSeconds: resumeProgress.progressSeconds,
    durationSeconds: resumeProgress.durationSeconds,
    provider: 'local'
  } : null)

  const defaultEpisode = activeResume
    ? { season: activeResume.season, episode: activeResume.episode }
    : seasonData?.episodes[0]
      ? { season: seasonData.episodes[0].seasonNumber, episode: seasonData.episodes[0].episodeNumber }
      : null
  const allEpisodes = Object.values(seasonCache).flatMap((season) => season.episodes)
  const allEpisodesWatched = allEpisodes.length > 0
    && show.seasons.every((season) => seasonCache[season.seasonNumber] !== undefined)
    && allEpisodes.every((episode) => watchedEpisodes.has(`${episode.seasonNumber}:${episode.episodeNumber}`))

  return (
    <div className="min-h-screen bg-black pb-12">
      <DetailHero
        title={show.title}
        year={show.year}
        overview={show.overview}
        rating={malRating ?? show.rating}
        genres={show.genres}
        certification={show.certification}
        poster={show.poster}
        backdrop={show.backdrop}
        logo={show.logo}
        imdbId={show.imdbId}
        type="series"
        status={show.status}
        numberOfSeasons={show.numberOfSeasons}
        cast={show.cast}
        crew={show.crew}
        ratingsStrip={
          <div className="flex flex-col gap-3">
            <RatingsStrip
              mediaType="series"
              imdbId={show.imdbId}
              tmdbId={show.tmdbId}
              tvdbId={show.tvdbId}
              className="mb-3"
              compact
            />
            {metadataStatus === 'fallback' && (
              <div className="inline-flex items-center self-start px-2.5 py-1 bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold rounded-lg uppercase tracking-wider mb-2">
                Addon metadata fallback
              </div>
            )}
            {isAnime && suspiciousStructure && (
              <div className="inline-flex items-center self-start px-2.5 py-1 bg-orange-500/15 border border-orange-500/30 text-orange-400 text-xs font-bold rounded-lg mb-2">
                Anime season structure looks suspicious. Manual mapping may be required.
              </div>
            )}
          </div>
        }
        actions={
          <div className="flex items-center gap-3 flex-wrap">
            {defaultEpisode && (
              <Button
                variant="white"
                size="xl"
                loading={streamResolving && streamEpisode?.season === defaultEpisode.season && streamEpisode?.episode === defaultEpisode.episode}
                icon={
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                }
                onClick={() => handlePlayEpisode(defaultEpisode.season, defaultEpisode.episode)}
              >
                {allEpisodesWatched
                  ? 'Rewatch'
                  : activeResume
                    ? `Resume S${activeResume.season} E${activeResume.episode} (${formatRemainingTime(activeResume.durationSeconds - activeResume.progressSeconds)})`
                    : 'Play'}
              </Button>
            )}
            <WatchlistButton
              mediaRef={{
                localId: show.id,
                title: show.title,
                year: show.year,
                type: isAnime ? 'anime' : 'show',
                imdbId: show.imdbId,
                tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
                tvdbId: show.tvdbId ? Number(show.tvdbId) : undefined,
                malId: show.malId ? Number(show.malId) : undefined,
                anilistId: show.anilistId ? Number(show.anilistId) : undefined,
              }}
              mediaType="series"
              anilistId={show.anilistId}
              malId={show.malId}
              tvdbId={show.tvdbId}
              className="!h-13 !min-w-13"
            />
            <MarkWatchedButton
              mediaRef={{
                localId: show.id,
                title: show.title,
                year: show.year,
                type: 'show',
                imdbId: show.imdbId,
                tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
              }}
              mediaType="series"
              imdbId={show.imdbId}
              anilistId={show.anilistId}
              malId={show.malId}
              isAnime={isAnime}
              episodes={allEpisodes.map((episode) => ({ season: episode.seasonNumber, episode: episode.episodeNumber, absoluteEpisode: episode.absoluteEpisodeNumber ?? episode.debugOriginalAbsoluteNumber }))}
              watched={allEpisodesWatched}
              appSeasonCounts={isAnime ? show.seasons.filter((s) => s.seasonNumber > 0).map((s) => ({ season: s.seasonNumber, count: s.episodeCount })).sort((a, b) => a.season - b.season) : undefined}
              onMarked={() => {
                setWatchedEpisodes(new Set(allEpisodes.map((episode) => `${episode.seasonNumber}:${episode.episodeNumber}`)))
                allEpisodes.forEach((episode) => setWatchProgress(`${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`, {
                  id: `${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`,
                  mediaType: 'series',
                  mediaId: show.id,
                  season: episode.seasonNumber,
                  episode: episode.episodeNumber,
                  progressSeconds: episode.runtime ? episode.runtime * 60 : 1,
                  durationSeconds: episode.runtime ? episode.runtime * 60 : 1,
                  completed: true,
                  title: show.title,
                  poster: show.poster,
                  backdrop: episode.still || show.backdrop,
                  imdbId: show.imdbId,
                  tmdbId: show.tmdbId,
                  updatedAt: new Date().toISOString(),
                }))
              }}
              onUnmarked={() => {
                setWatchedEpisodes(new Set())
                removeWatchProgress([show.id, show.imdbId || '', String(show.tmdbId || ''), show.tmdbId ? `tmdb-${show.tmdbId}` : ''])
              }}
            />
            <StartInRoomButton
              media={{
                id: show.id,
                type: 'series',
                title: show.title,
                year: show.year,
                poster: show.poster,
                backdrop: show.backdrop,
                overview: show.overview,
                imdbId: show.imdbId,
                tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
                tvdbId: show.tvdbId ? Number(show.tvdbId) : undefined,
                anilistId: show.anilistId ? Number(show.anilistId) : undefined,
              }}
            />
          </div>
        }
      />

      <DetailContentShell
        title={show.title}
        logo={show.logo}
        imdbId={show.imdbId}
        backdrop={show.backdrop}
      >
      <div className="px-8 relative z-10">
        <div className={`relative mb-7 ${showSeasonArrows ? 'px-12' : ''}`}>
          {showSeasonArrows && (
            <button
              type="button"
              onClick={() => scrollSeasons('left')}
              className="absolute left-0 top-[25px] -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/55 border border-white/15 text-white/70 hover:text-white hover:bg-black/80 flex items-center justify-center"
              aria-label="Previous seasons"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
          <div
            ref={seasonScrollRef}
            onWheel={handleSeasonWheel}
            className="season-scroll flex items-center justify-start gap-3 overflow-x-auto pb-4"
          >
            {show.seasons.map((season) => (
              <button
                key={season.seasonNumber}
                data-season={season.seasonNumber}
                onClick={() => selectSeason(season.seasonNumber)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const searchResult = { id: show.id, title: show.title, type: 'series' as const, year: show.year, poster: show.poster, backdrop: show.backdrop, imdbId: show.imdbId, tmdbId: show.tmdbId, tvdbId: show.tvdbId, malId: show.malId, anilistId: show.anilistId, isAnime, provider: 'tmdb' }
                  const appSeasonCounts = isAnime ? show.seasons.filter((s) => s.seasonNumber > 0).map((s) => ({ season: s.seasonNumber, count: s.episodeCount })).sort((a, b) => a.season - b.season) : undefined
                  showCtxMenu(e.clientX, e.clientY, { kind: 'season', item: searchResult, seasonNumber: season.seasonNumber, episodeCount: season.episodeCount, showImdbId: show.imdbId, appSeasonCounts })
                }}
                className={[
                  'flex-shrink-0 px-6 py-3 rounded-xl text-base font-semibold transition-all duration-300 cursor-pointer focus-ring',
                  selectedSeason === season.seasonNumber
                    ? 'bg-white/15 text-white border border-white/25'
                    : 'text-white/55 hover:text-white hover:bg-white/[0.08] border border-transparent',
                ].join(' ')}
              >
                {season.name}
              </button>
            ))}
          </div>
          {showSeasonArrows && (
            <button
              type="button"
              onClick={() => scrollSeasons('right')}
              className="absolute right-0 top-[25px] -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/55 border border-white/15 text-white/70 hover:text-white hover:bg-black/80 flex items-center justify-center"
              aria-label="Next seasons"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>

        {seasonData && (
          <div
            ref={episodeScrollRef}
            onWheel={handleEpisodeWheel}
            className="episode-scroll flex items-stretch gap-7 overflow-x-auto pb-6"
          >
            {(() => {
              const nextUnwatchedEpisode = keepNextEpisodeVisible
                ? seasonData.episodes.find((ep) => !watchedEpisodes.has(`${ep.seasonNumber}:${ep.episodeNumber}`))
                : null;
              return seasonData.episodes.map((ep) => {
                const isWatched = watchedEpisodes.has(`${ep.seasonNumber}:${ep.episodeNumber}`);
                const episodeProgress = getEpisodeProgress(ep.seasonNumber, ep.episodeNumber)
                const progressPercent = episodeProgress && episodeProgress.durationSeconds > 0
                  ? Math.min(100, (episodeProgress.progressSeconds / episodeProgress.durationSeconds) * 100)
                  : 0
                const isNextEpisode = nextUnwatchedEpisode && nextUnwatchedEpisode.id === ep.id;
                const shouldBlur = blurSpoilers && !isWatched && !episodeProgress && (!keepNextEpisodeVisible || !isNextEpisode);
                const blurThumb = shouldBlur && blurThumbnails;
                const blurTitle = shouldBlur && blurTitles;
                const blurDesc = shouldBlur && blurDescriptions;
                return (
                  <div
                    key={ep.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handlePlayEpisode(ep.seasonNumber, ep.episodeNumber)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePlayEpisode(ep.seasonNumber, ep.episodeNumber) } }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      if (!show) return
                      const searchResult = { id: show.id, title: show.title, type: 'series' as const, year: show.year, poster: show.poster, backdrop: show.backdrop, imdbId: show.imdbId, tmdbId: show.tmdbId, tvdbId: show.tvdbId, malId: show.malId, anilistId: show.anilistId, isAnime, provider: 'tmdb' }
                      const appSeasonCounts = isAnime ? show.seasons.filter((s) => s.seasonNumber > 0).map((s) => ({ season: s.seasonNumber, count: s.episodeCount })).sort((a, b) => a.season - b.season) : undefined
                      showCtxMenu(e.clientX, e.clientY, { kind: 'episode', item: searchResult, episode: ep, seasonNumber: ep.seasonNumber, showImdbId: show.imdbId, appSeasonCounts })
                    }}
                    className="episode-showcase-card flex-shrink-0 text-left group flex flex-col cursor-pointer"
                  >
                    <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated shadow-xl mb-3 ring-1 ring-white/10 group-hover:ring-accent/50 transition-all">
                      {streamResolving && streamEpisode?.season === ep.seasonNumber && streamEpisode?.episode === ep.episodeNumber && (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 backdrop-blur-sm">
                          <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                        </div>
                      )}
                      {ep.still ? (
                        <img
                          src={highQualityEpisodeStill(ep.still)}
                          alt=""
                          className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${
                            blurThumb ? 'blur-lg group-hover:blur-none' : ''
                          }`}
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-surface-elevated to-surface flex items-center justify-center">
                          <span className="text-5xl font-bold text-white/10">{ep.episodeNumber}</span>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent opacity-80" />
                      <div className="absolute top-3 left-3 w-9 h-9 rounded-full bg-white/90 text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                      {ep.runtime && (
                        <div className="absolute bottom-3 right-3 text-xs font-semibold text-white/90">{ep.runtime}m</div>
                      )}
                      {isWatched && (
                        <div className="absolute top-3 right-3 w-7 h-7 rounded-full bg-accent flex items-center justify-center shadow-lg z-10">
                          <svg className="w-4 h-4 text-black" fill="none" stroke="currentColor" strokeWidth="2.8" viewBox="0 0 24 24">
                            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                      {!isWatched && episodeProgress && progressPercent > 0 && (
                        <>
                          <div className="absolute bottom-0 inset-x-0 h-1.5 bg-black/55 z-10">
                            <div className="h-full bg-accent" style={{ width: `${progressPercent}%` }} />
                          </div>
                          <div className="absolute top-3 right-3 rounded-full bg-black/75 border border-white/10 px-2.5 py-1 text-[11px] font-bold text-white z-10">
                            Resume {Math.round(progressPercent)}%
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex-1 flex flex-col">
                      <p className="text-sm text-white/60">Episode {ep.episodeNumber}</p>
                      <h3 className={`text-lg font-bold text-white truncate group-hover:text-accent transition-colors ${
                        blurTitle ? 'blur-sm group-hover:blur-none select-none group-hover:select-text' : ''
                      }`}>
                        {ep.name}
                      </h3>
                      {ep.overview && (
                        <p className={`text-sm text-white/65 line-clamp-2 mt-1 ${
                          blurDesc ? 'blur-sm group-hover:blur-none select-none group-hover:select-text' : ''
                        }`}>
                          {ep.overview}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-2">
                        <RatingsStrip
                          mediaType="series"
                          imdbId={ep.imdbId || show.imdbId}
                          tmdbId={show.tmdbId ?? ep.tmdbId}
                          tvdbId={show.tvdbId ?? ep.tvdbId}
                          malId={show.malId}
                          season={ep.seasonNumber}
                          episode={ep.episodeNumber}
                          episodeRating={ep.imdbRating}
                          isAnime={isAnime}
                          compact
                        />
                        <div className="overflow-visible relative z-20" onClick={(e) => e.stopPropagation()}>
                          <MarkWatchedButton
                            mediaRef={{
                              localId: show.id,
                              title: show.title,
                              year: show.year,
                              type: isAnime ? 'anime' : 'show',
                              imdbId: show.imdbId,
                              tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
                              tvdbId: show.tvdbId ? Number(show.tvdbId) : undefined,
                              malId: show.malId ? Number(show.malId) : undefined,
                              anilistId: show.anilistId ? Number(show.anilistId) : undefined,
                            }}
                            mediaType="series"
                            episode={{ season: ep.seasonNumber, episode: ep.episodeNumber, absoluteEpisode: ep.absoluteEpisodeNumber ?? ep.debugOriginalAbsoluteNumber }}
                            imdbId={show.imdbId}
                            anilistId={show.anilistId}
                            malId={show.malId}
                            isAnime={isAnime}
                            appSeasonCounts={isAnime ? show.seasons.filter((s) => s.seasonNumber > 0).map((s) => ({ season: s.seasonNumber, count: s.episodeCount })).sort((a, b) => a.season - b.season) : undefined}
                            compact
                            watched={isWatched}
                            onMarked={() => {
                              setWatchedEpisodes((prev) => new Set([...prev, `${ep.seasonNumber}:${ep.episodeNumber}`]))
                              setWatchProgress(`${show.id}:${ep.seasonNumber}:${ep.episodeNumber}`, {
                                id: `${show.id}:${ep.seasonNumber}:${ep.episodeNumber}`,
                                mediaType: 'series',
                                mediaId: show.id,
                                season: ep.seasonNumber,
                                episode: ep.episodeNumber,
                                progressSeconds: ep.runtime ? ep.runtime * 60 : 1,
                                durationSeconds: ep.runtime ? ep.runtime * 60 : 1,
                                completed: true,
                                title: show.title,
                                poster: show.poster,
                                backdrop: ep.still || show.backdrop,
                                imdbId: show.imdbId,
                                tmdbId: show.tmdbId,
                                updatedAt: new Date().toISOString(),
                              })
                            }}
                            onUnmarked={() => setWatchedEpisodes((prev) => {
                              const next = new Set(prev)
                              next.delete(`${ep.seasonNumber}:${ep.episodeNumber}`)
                              removeWatchProgress(
                                [show.id, show.imdbId || '', String(show.tmdbId || ''), show.tmdbId ? `tmdb-${show.tmdbId}` : ''],
                                ep.seasonNumber,
                                ep.episodeNumber,
                              )
                              return next
                            })}
                          />
                        </div>
                      </div>
                      {ep.airDate && <p className="text-sm text-white/45 mt-2">{formatEpisodeAirDate(ep.airDate)}</p>}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
        {!seasonData && show && (
          <div className="flex gap-6 overflow-x-hidden pb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="episode-showcase-card flex-shrink-0 flex flex-col gap-3 animate-pulse">
                <div className="aspect-video rounded-2xl bg-white/[0.06]" />
                <div className="h-4 w-16 bg-white/[0.04] rounded-md" />
                <div className="h-5 w-48 bg-white/[0.06] rounded-md" />
                <div className="h-4 w-full bg-white/[0.04] rounded-md" />
              </div>
            ))}
          </div>
        )}
      </div>

      <StreamSelector
        open={streamOpen}
        onClose={() => { setStreamOpen(false); setStreamEpisode(null) }}
        mediaType="series"
        mediaId={streamId}
        title={show.title}
        artwork={{ poster: show.poster, backdrop: show.backdrop }}
        seasonEpisode={streamEpisode || undefined}
        startTime={streamEpisode ? getEpisodeProgress(streamEpisode.season, streamEpisode.episode)?.progressSeconds : undefined}
        tmdbId={Number.isFinite(streamTmdbId) ? streamTmdbId : undefined}
        tvdbId={show.tvdbId ?? undefined}
        malId={show.malId != null ? Number(show.malId) : state.malId != null ? Number(state.malId) : undefined}
        anilistId={show.anilistId != null ? Number(show.anilistId) : state.anilistId != null ? Number(state.anilistId) : undefined}
        sourceAddonId={state.sourceAddonId}
        sourceAddonItemId={state.sourceAddonItemId}
        onResolvingChange={setStreamResolving}
      />

      {show.trailers.length > 0 && <TrailerRow title="Videos & Trailers" videos={show.trailers} />}
      {show.cast.length > 0 && <CastRow cast={show.cast} crew={show.crew} />}

      {show.recommendations.length > 0 ? (
        <MediaRow title="More Like This" items={show.recommendations} layout="poster" disableArtOverride={false} />
      ) : (
        <MediaRow title="You May Also Like" items={fallbackRecommendations.filter((s) => s.id !== show.id)} layout="poster" disableArtOverride={false} />
      )}
      </DetailContentShell>
    </div>
  )
}
