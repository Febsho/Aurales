import { useMemo, useState, useEffect, useRef } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import type { MovieDetails } from '../types'
import { MOCK_HERO_MOVIE, MOCK_TRENDING } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { getAddonMeta, getMetaAddons } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'
import StreamSelector from '../components/StreamSelector'
import WatchlistButton from '../components/WatchlistButton'
import RatingsStrip from '../components/RatingsStrip'
import DetailHero from '../components/media/DetailHero'
import DetailContentShell from '../components/media/DetailContentShell'
import DetailLoadingState from '../components/media/DetailLoadingState'
import { Button } from '../components/ui'
import MarkWatchedButton from '../components/MarkWatchedButton'
import StartInRoomButton from '../components/watch-together/StartInRoomButton'
import { applyInitialArtworkPreference, applyMovieArt, applySearchResultArt, resolveArtFromProviders } from '../services/artwork'
import { getSimklPlaybackProgress } from '../services/simkl/playback'
import { getPlaybackProgress as getTraktPlaybackProgress } from '../services/trakt/sync'
import { getPMDBPlaybackProgress } from '../services/pmdb'
import { getMdblistPlaybackProgress, hasMdblistOAuth } from '../services/mdblist'
import { resolveAppMetadata, type AppMediaItem } from '../services/metadata'
import { isWatchedFromProviders } from '../services/watchedStatus'
import { cacheGet, cacheSet } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../services/cache/constants'
import { useGlobalBackdrop } from '../hooks/useGlobalBackdrop'
import { usePreparedStream } from '../hooks/usePreparedStream'
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
  logo?: string
  title?: string
  year?: number
  rating?: number
  overview?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  isAnime?: boolean
  addonUrl?: string
  provider?: string
  sourceAddonId?: string
  sourceAddonItemId?: string
  addonMeta?: Record<string, unknown>
  autoPlay?: boolean
}

function addonMetaToMovie(meta: Record<string, unknown>, id: string): MovieDetails {
  const genres = Array.isArray(meta.genres) ? meta.genres as string[] :
    (typeof meta.genre === 'string' ? (meta.genre as string).split(',').map(g => g.trim()) :
    (Array.isArray(meta.genre) ? meta.genre as string[] : []))

  return {
    id,
    title: (meta.name || meta.title || 'Unknown') as string,
    originalTitle: meta.originalTitle as string | undefined,
    year: meta.releaseInfo ? parseInt(String(meta.releaseInfo)) : (meta.year ? Number(meta.year) : undefined),
    releaseDate: meta.released as string | undefined,
    overview: (meta.description || meta.overview) as string | undefined,
    tagline: meta.tagline as string | undefined,
    runtime: parseRuntime(meta.runtime),
    rating: meta.imdbRating ? parseFloat(String(meta.imdbRating)) : undefined,
    voteCount: meta.imdbVotes ? parseInt(String(meta.imdbVotes).replace(/,/g, '')) : undefined,
    genres,
    poster: meta.poster as string | undefined,
    backdrop: (meta.background || meta.banner) as string | undefined,
    logo: meta.logo as string | undefined,
    certification: typeof meta.certification === 'string' ? meta.certification : undefined,
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
}function cleanId(val: unknown): string | undefined {
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


function appMediaToMovie(item: AppMediaItem): MovieDetails {
  return {
    id: item.id, title: item.title, originalTitle: item.originalTitle, year: item.year,
    overview: item.overview, runtime: item.runtime, rating: item.rating, genres: item.genres,
    poster: item.poster, backdrop: item.backdrop, logo: item.logo, certification: item.ageRating,
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

function parseRuntime(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 10 ? value : undefined
  if (typeof value !== 'string') return undefined
  const hourMatch = value.match(/(\d+)\s*h/i)
  const minuteMatch = value.match(/(\d+)\s*m/i)
  if (hourMatch || minuteMatch) {
    const minutes = (hourMatch ? Number(hourMatch[1]) * 60 : 0) + (minuteMatch ? Number(minuteMatch[1]) : 0)
    return minutes > 10 ? minutes : undefined
  }
  const numeric = parseInt(value, 10)
  return numeric > 10 ? numeric : undefined
}

function artworkSettingsKey(): string {
  const settings = useAppStore.getState()
  return JSON.stringify({
    managed: settings.appManagedMetadata,
    providers: settings.artProviders,
    fanart: Boolean(settings.fanartApiKey),
    custom: settings.customArtUrls,
    meta: [settings.movieMetadataSource, settings.movieMetadataFallback],
  })
}

function rotateFallback<T>(items: T[], seed: string): T[] {
  if (items.length === 0) return []
  const offset = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

export default function MovieDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const state = (location.state || {}) as LocationState
  const [movie, setMovie] = useState<MovieDetails | null>(null)
  const [malRating, setMalRating] = useState<number | null>(null)
  const [fallbackRecommendations, setFallbackRecommendations] = useState(MOCK_TRENDING)
  const [loading, setLoading] = useState(true)
  const [streamOpen, setStreamOpen] = useState(false)
  const [streamResolving, setStreamResolving] = useState(false)
  const autoPlayHandledRef = useRef(false)
  const addons = useAppStore((s) => s.addons)
  const watchedProgress = useAppStore((s) => s.watchProgress)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const animeTrackingProvider = useAppStore((s) => s.animeTrackingProvider)
  const setWatchProgress = useAppStore((s) => s.setWatchProgress)
  const removeWatchProgress = useAppStore((s) => s.removeWatchProgress)
  const artProviders = useAppStore((s) => s.artProviders)
  const fanartApiKey = useAppStore((s) => s.fanartApiKey)
  const customArtUrls = useAppStore((s) => s.customArtUrls)
  const movieMetadataSource = useAppStore((s) => s.movieMetadataSource)
  const movieMetadataFallback = useAppStore((s) => s.movieMetadataFallback)
  const discordRichPresence = useAppStore((s) => s.discordRichPresence)
  const preloadPlaybackSources = useAppStore((s) => s.preloadPlaybackSources)
  const artSettingsSignature = useMemo(() => JSON.stringify({
    providers: artProviders,
    fanart: Boolean(fanartApiKey),
    custom: customArtUrls,
    meta: [movieMetadataSource, movieMetadataFallback],
  }), [artProviders, fanartApiKey, customArtUrls, movieMetadataSource, movieMetadataFallback])
  const [movieWatched, setMovieWatched] = useState(false)

  useEffect(() => {
    if (!movie || !state.autoPlay || autoPlayHandledRef.current) return
    autoPlayHandledRef.current = true
    setStreamOpen(true)
  }, [movie, state.autoPlay])

  const progressItem = useMemo(() => {
    if (!movie) return null
    return Array.from(watchedProgress.values()).find((i) => {
      if (i.mediaType !== 'movie') return false
      return (
        fuzzyIdsMatch(i.mediaId, movie.id) ||
        fuzzyIdsMatch(i.imdbId, movie.imdbId) ||
        fuzzyIdsMatch(i.tmdbId, movie.tmdbId) ||
        fuzzyIdsMatch(i.id, movie.id)
      )
    })
  }, [movie, watchedProgress])

  const hasProgress = progressItem && !progressItem.completed && progressItem.progressSeconds > 5

  const resumePriorityOrder = useAppStore((s) => s.resumePriorityOrder)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey)
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)

  const [liveResumePoint, setLiveResumePoint] = useState<{
    provider: string
    progressSeconds: number
    durationSeconds: number
  } | null>(null)

  useEffect(() => {
    if (!movie || !preloadPlaybackSources) return

    let active = true

    async function fetchPoints() {
      const candidates: {
        provider: 'local' | 'simkl' | 'trakt' | 'pmdb' | 'mdblist'
        progressSeconds: number
        durationSeconds: number
        updatedAt?: string
      }[] = []

      // 1. Local
      if (progressItem && !progressItem.completed && progressItem.progressSeconds > 5) {
        candidates.push({
          provider: 'local',
          progressSeconds: progressItem.progressSeconds,
          durationSeconds: progressItem.durationSeconds,
          updatedAt: progressItem.updatedAt,
        })
      }

      const fetchPromises: Promise<void>[] = []

      if (resumePriorityOrder.includes('simkl') && simklConnected) {
        fetchPromises.push((async () => {
          try {
            const raw = await getSimklPlaybackProgress()
            const match = raw.find((item) => {
              if (item.type !== 'movie' || !item.movie) return false
              return (
                fuzzyIdsMatch(item.movie.ids.simkl, movie!.id) ||
                fuzzyIdsMatch(item.movie.ids.imdb, movie!.imdbId) ||
                fuzzyIdsMatch(item.movie.ids.tmdb, movie!.tmdbId)
              )
            })
            if (match && active) {
              const dur = movie!.runtime ? movie!.runtime * 60 : 7200
              candidates.push({
                provider: 'simkl',
                progressSeconds: Math.floor((match.progress / 100) * dur),
                durationSeconds: dur,
                updatedAt: match.paused_at,
              })
            }
          } catch (_) {}
        })())
      }

      if (resumePriorityOrder.includes('trakt') && traktConnected) {
        fetchPromises.push((async () => {
          try {
            const raw = await getTraktPlaybackProgress()
            const match = raw.find((item: any) => {
              if (item.type !== 'movie' || !item.movie) return false
              return (
                fuzzyIdsMatch(item.movie.ids.imdb, movie!.imdbId) ||
                fuzzyIdsMatch(item.movie.ids.tmdb, movie!.tmdbId)
              )
            }) as any
            if (match && active) {
              const dur = movie!.runtime ? movie!.runtime * 60 : 7200
              candidates.push({
                provider: 'trakt',
                progressSeconds: Math.floor((match.progress / 100) * dur),
                durationSeconds: dur,
                updatedAt: match.paused_at,
              })
            }
          } catch (_) {}
        })())
      }

      if (resumePriorityOrder.includes('pmdb') && pmdbApiKey) {
        fetchPromises.push((async () => {
          try {
            const raw = await getPMDBPlaybackProgress()
            const match = raw.find((item) => {
              if (item.media_type !== 'movie') return false
              return fuzzyIdsMatch(item.tmdb_id, movie!.tmdbId)
            })
            if (match && active) {
              candidates.push({
                provider: 'pmdb',
                progressSeconds: Math.floor((match.position_ms ?? 0) / 1000),
                durationSeconds: Math.floor((match.runtime_ms ?? 7200000) / 1000),
                updatedAt: match.updated_at,
              })
            }
          } catch (_) {}
        })())
      }

      if (resumePriorityOrder.includes('mdblist') && (mdblistApiKey || hasMdblistOAuth())) {
        fetchPromises.push((async () => {
          try {
            const raw = await getMdblistPlaybackProgress()
            const match = raw.find((item) => {
              if (item.type !== 'movie') return false
              return (
                fuzzyIdsMatch(item.movie?.ids?.tmdb, movie!.tmdbId) ||
                fuzzyIdsMatch(item.movie?.ids?.imdb, movie!.imdbId)
              )
            })
            if (match && active) {
              const dur = movie!.runtime ? movie!.runtime * 60 : 7200
              candidates.push({
                provider: 'mdblist',
                progressSeconds: Math.floor(((match.progress ?? 0) / 100) * dur),
                durationSeconds: dur,
                updatedAt: match.updated_at,
              })
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
  }, [movie, progressItem, resumePriorityOrder, pmdbApiKey, mdblistApiKey, simklConnected, traktConnected])


  useEffect(() => {
    async function load() {
      setMalRating(null)
      setLoading(true)

      // Mount the real detail structure from navigation/catalog data before
      // SQLite, addon metadata, ID mapping, or TMDB's multi-endpoint request.
      // Those sources refine this shell instead of hiding it behind a loader.
      const immediateMovie: MovieDetails | null = state.title ? applyMovieArt({
        id: id || 'unknown',
        title: state.title,
        year: state.year,
        overview: state.overview,
        rating: state.rating,
        poster: state.poster,
        backdrop: state.backdrop,
        logo: state.logo,
        imdbId: cleanId(state.imdbId),
        tmdbId: cleanId(state.tmdbId),
        malId: cleanId(state.malId),
        anilistId: cleanId(state.anilistId),
        genres: [],
        cast: [],
        crew: [],
        recommendations: [],
        trailers: [],
      }) : null
      setMovie(immediateMovie)

      const artKey = artworkSettingsKey()
      const movieCacheKey = id ? `detail:movie:${artKey}:${id}` : null
      if (movieCacheKey) {
        const cached = await cacheGet<MovieDetails>(movieCacheKey)
        if (cached) {
          setMovie(cached.data)
          setLoading(false)
          if (!cached.stale) return
        }
      }

      let result: MovieDetails | null = null

      const parseId = (val: unknown, prefix: string): string | undefined => {
        let cleaned = cleanId(val)
        if (!cleaned) return undefined
        if (cleaned.startsWith('app_tvdb_')) cleaned = cleaned.replace('app_tvdb_', '')
        else if (cleaned.startsWith('app_tmdb_movie_')) cleaned = cleaned.replace('app_tmdb_movie_', '')
        else if (cleaned.startsWith('app_tmdb_')) cleaned = cleaned.replace('app_tmdb_', '')
        else if (cleaned.startsWith('app_movie_')) cleaned = cleaned.replace('app_movie_', '')
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
      const appManagedMetadata = useAppStore.getState().appManagedMetadata

      // Early resolve anime IDs if they are AniList / MAL but we don't have TMDB ID
      if (appManagedMetadata && (knownIds.anilistId || knownIds.malId) && !knownIds.tmdbId) {
        try {
          const { resolveAnimeIds } = await import('../services/animeLists')
          const resolved = await resolveAnimeIds({
            anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
            malId: knownIds.malId ? Number(knownIds.malId) : undefined,
            contentType: 'movie',
          })
          if (resolved) {
            if (resolved.tvdbId) knownIds.tvdbId = String(resolved.tvdbId)
            if (resolved.tmdbId) knownIds.tmdbId = String(resolved.tmdbId)
            if (resolved.imdbId) knownIds.imdbId = resolved.imdbId
            if (resolved.anilistId) knownIds.anilistId = String(resolved.anilistId)
            if (resolved.malId) knownIds.malId = String(resolved.malId)
          }
        } catch (e) {
          console.error('[MovieDetailPage] Failed early anime resolution:', e)
        }
      }

      if (appManagedMetadata && state.sourceAddonId && state.sourceAddonItemId) {
        const normalized = await resolveAppMetadata({
          addonId: state.sourceAddonId, addonUrl: state.addonUrl, addonType: 'movie', id: state.sourceAddonItemId,
          title: state.title, year: state.year, imdbId: knownIds.imdbId, tmdbId: Number(knownIds.tmdbId) || undefined,
          tvdbId: Number(knownIds.tvdbId) || undefined, anilistId: Number(knownIds.anilistId) || undefined,
          malId: Number(knownIds.malId) || undefined,
        }).catch(() => null)
        if (normalized && normalized.sourceMetadataProvider !== 'fallback_addon') {
          result = appMediaToMovie(normalized)
          knownIds.imdbId ||= normalized.imdbId
          if (normalized.tmdbId != null) knownIds.tmdbId ||= String(normalized.tmdbId)
          if (normalized.tvdbId != null) knownIds.tvdbId ||= String(normalized.tvdbId)
        }
      }

      // If addon item, get IDs from addon meta
      const shouldRequestAddonMeta = !appManagedMetadata
        || (useAppStore.getState().useAddonMetadataFallback && !result)
      if (shouldRequestAddonMeta && (state.addonUrl || state.provider === 'addon' || (id?.startsWith('tt') && !knownIds.tmdbId))) {
        const tryAddonMeta = async (addonUrl: string) => {
          try {
            const addonItemId = state.sourceAddonItemId || id || ''
            const meta = await getAddonMeta(addonUrl, 'movie', addonItemId)
            if (meta) {
              const parsed = addonMetaToMovie(meta, addonItemId)
              if (parsed.imdbId) knownIds.imdbId = knownIds.imdbId || parsed.imdbId
              if (parsed.tmdbId) knownIds.tmdbId = knownIds.tmdbId || String(parsed.tmdbId)
              if (parsed.malId) knownIds.malId = knownIds.malId || String(parsed.malId)
              if (parsed.anilistId) knownIds.anilistId = knownIds.anilistId || String(parsed.anilistId)
              return parsed
            }
          } catch (_) { /* continue */ }
          return null
        }

        let addonResult: MovieDetails | null = null
        if (state.addonUrl) addonResult = await tryAddonMeta(state.addonUrl)
        if (!addonResult) {
          const metaAddons = getMetaAddons('movie')
          const storeMetaAddons = addons.filter((a) => a.enabled)
          for (const addon of metaAddons.length > 0 ? metaAddons : storeMetaAddons) {
            addonResult = await tryAddonMeta(addon.url)
            if (addonResult) break
          }
        }
        if (addonResult && !result && (!appManagedMetadata || useAppStore.getState().useAddonMetadataFallback)) result = addonResult
      }

      // Respect the metadata toggle on detail pages too. Addon metadata is
      // already complete enough to render; external provider work must not
      // delay or replace it when managed metadata is disabled.
      if (!appManagedMetadata && result) {
        const directMovie = applyMovieArt(applyInitialArtworkPreference({
          ...result,
          id: id || result.id,
        }, 'movie', Boolean(result.isAnime || knownIds.anilistId || knownIds.malId)))
        setMovie(directMovie)
        setLoading(false)
        const cacheOpts = { category: CACHE_CATEGORIES.DETAIL_PAGE, ttlSeconds: CACHE_TTLS.DETAIL_PAGE }
        if (movieCacheKey) void cacheSet(movieCacheKey, directMovie, cacheOpts)
        return
      }

      // Show placeholder immediately
      if (state.title || result) {
        const placeholder = applyMovieArt({
          id: id || 'unknown',
          title: state.title || result?.title || '',
          year: state.year || result?.year,
          overview: state.overview || result?.overview,
          rating: state.rating || result?.rating,
          poster: state.poster || result?.poster,
          backdrop: state.backdrop || result?.backdrop,
          logo: state.logo || result?.logo,
          imdbId: knownIds.imdbId as string | undefined,
          tmdbId: knownIds.tmdbId,
          malId: knownIds.malId,
          anilistId: knownIds.anilistId,
          genres: result?.genres || [],
          cast: result?.cast || [],
          crew: result?.crew || [],
          recommendations: result?.recommendations || [],
          trailers: result?.trailers || [],
        })
        setMovie(placeholder)
      }

      // Fetch REAL metadata from TMDB
      let tmdbId = knownIds.tmdbId ? String(knownIds.tmdbId).replace(/^[a-z_]+[-:]/i, '') : undefined
      if (!tmdbId && knownIds.imdbId) {
        try {
          const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
          const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
          if (found.tmdbId) tmdbId = String(found.tmdbId)
        } catch (_) { /* continue */ }
      }

      let appResult: MovieDetails | null = null
      if (tmdbId) {
        try {
          appResult = await tmdbProvider.getMovie(`tmdb-${tmdbId}`)
          appResult = {
            ...appResult,
            id: id || appResult.id,
            malId: appResult.malId || knownIds.malId,
            anilistId: appResult.anilistId || knownIds.anilistId,
          }
        } catch (_) { /* continue */ }
      }

      // Resolve IMDb if missing
      const finalResult = appResult || result || { ...MOCK_HERO_MOVIE, id: id || 'mock-1' }

      // Preserving AniList artwork if it exists in route state
      if (finalResult && (finalResult.anilistId || finalResult.malId || (id && /^(mal|anilist)[-:]/i.test(id)))) {
        if (state.poster) finalResult.poster = state.poster
        if (state.backdrop) finalResult.backdrop = state.backdrop
      }
      if (!finalResult.imdbId && finalResult.tmdbId) {
        try {
          const { resolveImdbId } = await import('../services/metadataEnrich')
          const imdbId = await resolveImdbId(finalResult, 'movie')
          if (imdbId) finalResult.imdbId = imdbId
        } catch (_) { /* continue */ }
      }

      const cleanTmdb = cleanId(finalResult.tmdbId)
      const finalTmdbId = cleanTmdb ? String(cleanTmdb).replace(/^[a-z_]+[-:]/i, '') : undefined
      const finalImdbId = finalResult.imdbId
      
      const targetId = finalTmdbId
        ? `app_tmdb_movie_${finalTmdbId}`
        : finalImdbId
        ? `app_movie_${finalImdbId}`
        : finalResult.id || id || 'unknown'

      finalResult.id = targetId

      const artApplied = applyMovieArt(applyInitialArtworkPreference(finalResult, 'movie', Boolean(finalResult.isAnime)))
      // Metadata arriving after the route shell must not erase artwork that is
      // already visible. Explicit provider-art enhancement below can still
      // replace these fields when it has a successful result.
      artApplied.poster ||= immediateMovie?.poster
      artApplied.backdrop ||= immediateMovie?.backdrop
      artApplied.logo ||= immediateMovie?.logo

      setMovie(artApplied)
      setLoading(false)

      const cacheOpts = { category: CACHE_CATEGORIES.DETAIL_PAGE, ttlSeconds: CACHE_TTLS.DETAIL_PAGE }
      if (movieCacheKey) void cacheSet(movieCacheKey, artApplied, cacheOpts)
      if (artApplied.id && artApplied.id !== id) void cacheSet(`detail:movie:${artKey}:${artApplied.id}`, artApplied, cacheOpts)

      if (id && artApplied.id && artApplied.id !== id) {
        console.log('[MovieDetailPage] Normalizing URL route ID to:', artApplied.id)
        navigate(`/movie/${artApplied.id}`, { replace: true, state })
      }

      // Artwork providers are optional enhancement requests. Do not delay the
      // complete details page while waiting for them; update it when available.
      void resolveArtFromProviders('movie', {
        tmdbId: artApplied.tmdbId, tvdbId: artApplied.tvdbId, imdbId: artApplied.imdbId,
      }, artApplied.isAnime).then((providerArt) => {
        if (!providerArt.poster && !providerArt.backdrop && !providerArt.logo) return
        const enhanced = applyMovieArt({
          ...artApplied,
          ...(providerArt.poster && { poster: providerArt.poster }),
          ...(providerArt.backdrop && { backdrop: providerArt.backdrop }),
          ...(providerArt.logo && { logo: providerArt.logo }),
        })
        setMovie((current) => current?.id === artApplied.id ? enhanced : current)
        if (movieCacheKey) void cacheSet(movieCacheKey, enhanced, cacheOpts)
        if (enhanced.id) void cacheSet(`detail:movie:${artKey}:${enhanced.id}`, enhanced, cacheOpts)
      }).catch(() => undefined)
    }
    load()
  }, [id, state.addonUrl, state.provider, state.title, addons, artSettingsSignature])

  useEffect(() => {
    if (!movie) return
    const isAnime = !!(movie.malId || movie.anilistId)
    if (!isAnime) return

    let cancelled = false
    import('../services/mdblist').then(({ getMdblistRatings }) => {
      return getMdblistRatings({
        mediaType: 'movie',
        imdbId: movie.imdbId,
        tmdbId: movie.tmdbId,
        tvdbId: movie.tvdbId,
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
  }, [movie])

  useEffect(() => {
    if (!movie) return
    let cancelled = false
    const isAnimeMovie = Boolean(movie.isAnime || movie.anilistId || movie.malId)
    const effectiveSources = isAnimeMovie && anilistConnected && animeTrackingProvider === 'anilist' && !watchedCheckmarkSources.includes('anilist')
      ? [...watchedCheckmarkSources, 'anilist' as const]
      : watchedCheckmarkSources
    isWatchedFromProviders({
      id: movie.id,
      type: 'movie',
      title: movie.title,
      year: movie.year,
      imdbId: movie.imdbId,
      tmdbId: movie.tmdbId,
      tvdbId: movie.tvdbId,
      malId: movie.malId,
      anilistId: movie.anilistId,
      isAnime: isAnimeMovie,
    }, effectiveSources, watchedProgress).then((watched) => {
      if (!cancelled) setMovieWatched(watched)
    }).catch(() => {
      if (!cancelled) setMovieWatched(false)
    })
    return () => { cancelled = true }
  }, [movie, watchedCheckmarkSources, watchedProgress, anilistConnected, animeTrackingProvider])

  useEffect(() => {
    if (!movie || movie.recommendations.length > 0) return
    const query = movie.genres[0] || movie.title
    tmdbProvider.recommendationsForText?.(query, 'movie')
      .then((results) => {
        const filtered = results.filter((item) => item.id !== movie.id && item.title !== movie.title)
        setFallbackRecommendations((filtered.length ? filtered : rotateFallback(MOCK_TRENDING, movie.id)).map(applySearchResultArt))
      })
      .catch(() => setFallbackRecommendations(rotateFallback(MOCK_TRENDING, movie.id).map(applySearchResultArt)))
  }, [movie])

  useGlobalBackdrop(movie?.backdrop || movie?.poster)

  const movieIsAnime = !!(movie?.isAnime || (id && /^(mal|anilist)[-:]/i.test(id)) || state.provider === 'anilist')

  useEffect(() => {
    if (!movie || !discordRichPresence) return
    const image = movie.poster?.startsWith('http') ? movie.poster : undefined
    setDiscordBrowsingActivity({
      details: `Browsing ${movie.title}`,
      state: movieIsAnime ? 'Anime Movie' : 'Movie',
      largeImage: image || 'aurales_logo',
      largeText: movie.title,
      activityType: 3,
    }).catch(() => {})
    return () => { setDiscordBrowsingActivity().catch(() => {}) }
  }, [movie?.title, movie?.poster, movieIsAnime, discordRichPresence])

  useEffect(() => {
    if (!movie) return
    const mediaId = movie.imdbId || state.sourceAddonItemId || id || ''
    if (!mediaId) return
    streamPreloadManager.request({
      mediaType: 'movie',
      mediaId,
      imdbId: movie.imdbId,
      tmdbId: movie.tmdbId,
      sourceAddonId: state.sourceAddonId,
      sourceAddonItemId: state.sourceAddonItemId,
    }, { priority: StreamPreloadPriority.DETAILS_OPEN }).catch(() => undefined)
  }, [movie?.id, movie?.imdbId, movie?.tmdbId, id, state.sourceAddonId, state.sourceAddonItemId, preloadPlaybackSources])

  // After a short dwell, rank + probe the best direct stream so Play is instant.
  const preparedMediaId = movie ? (movie.imdbId || state.sourceAddonItemId || id || '') : ''
  usePreparedStream(movie && preparedMediaId ? {
    mediaType: 'movie',
    mediaId: preparedMediaId,
    imdbId: movie.imdbId,
    tmdbId: movie.tmdbId,
    sourceAddonId: state.sourceAddonId,
    sourceAddonItemId: state.sourceAddonItemId,
  } : null, movie?.title)

  const initialRouteArt = applyInitialArtworkPreference({
    poster: state.poster,
    backdrop: state.backdrop,
    logo: state.logo,
    provider: state.provider,
  }, 'movie', Boolean(state.anilistId || state.malId || (id && /^(mal|anilist)[-:]/i.test(id))))

  if (loading || !movie) {
    return <DetailLoadingState
      logo={initialRouteArt.logo}
      title={state.title}
      backdrop={initialRouteArt.backdrop}
      poster={initialRouteArt.poster}
    />
  }

  const streamId = movie.imdbId || state.sourceAddonItemId || id || ''
  const streamTmdbId = movie.tmdbId ? Number(movie.tmdbId) : (id && /^(?:tmdb)[-:]/i.test(id) ? Number(id.replace(/^[a-z_]+[-:]/i, '')) : undefined)
  return (
    <div className="min-h-screen bg-black pb-12">
      <DetailHero
        title={movie.title}
        originalTitle={movie.originalTitle}
        year={movie.year}
        overview={movie.overview}
        tagline={movie.tagline}
        runtime={movie.runtime}
        rating={malRating ?? movie.rating}
        genres={movie.genres}
        certification={movie.certification}
        poster={movie.poster}
        backdrop={movie.backdrop}
        logo={movie.logo}
        imdbId={movie.imdbId}
        type="movie"
        cast={movie.cast}
        crew={movie.crew}
        ratingsStrip={
          <RatingsStrip
            mediaType="movie"
            imdbId={movie.imdbId}
            tmdbId={movie.tmdbId}
            tvdbId={movie.tvdbId}
            className="mb-3"
            compact
          />
        }
        actions={
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="white"
              size="xl"
              loading={streamResolving}
              icon={
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              }
              onClick={() => setStreamOpen(true)}
            >
              {(() => {
                if (movieWatched) return 'Rewatch'
                const activeResume = liveResumePoint || (hasProgress ? { progressSeconds: progressItem.progressSeconds, durationSeconds: progressItem.durationSeconds } : null)
                return activeResume
                  ? `Resume (${formatRemainingTime(activeResume.durationSeconds - activeResume.progressSeconds)})`
                  : 'Play'
              })()}
            </Button>
            <WatchlistButton
              mediaRef={{
                localId: movie.id,
                title: movie.title,
                year: movie.year,
                type: 'movie',
                imdbId: movie.imdbId,
                tmdbId: movie.tmdbId ? Number(movie.tmdbId) : undefined,
              }}
              mediaType="movie"
              anilistId={movie.anilistId}
              malId={movie.malId}
              className="!h-13 !min-w-13"
            />
            <MarkWatchedButton
              mediaRef={{
                localId: movie.id,
                title: movie.title,
                year: movie.year,
                type: 'movie',
                imdbId: movie.imdbId,
                tmdbId: movie.tmdbId ? Number(movie.tmdbId) : undefined,
              }}
              mediaType="movie"
              imdbId={movie.imdbId}
              anilistId={movie.anilistId}
              malId={movie.malId}
              isAnime={movieIsAnime}
              watched={movieWatched}
              onMarked={() => {
                setMovieWatched(true)
                setWatchProgress(movie.id, {
                  id: movie.id,
                  mediaType: 'movie',
                  mediaId: movie.id,
                  progressSeconds: movie.runtime ? movie.runtime * 60 : 1,
                  durationSeconds: movie.runtime ? movie.runtime * 60 : 1,
                  completed: true,
                  title: movie.title,
                  poster: movie.poster,
                  backdrop: movie.backdrop,
                  imdbId: movie.imdbId,
                  tmdbId: movie.tmdbId,
                  updatedAt: new Date().toISOString(),
                })
              }}
              onUnmarked={() => {
                setMovieWatched(false)
                removeWatchProgress([movie.id, movie.imdbId || '', String(movie.tmdbId || ''), movie.tmdbId ? `tmdb-${movie.tmdbId}` : ''])
              }}
            />
            <StartInRoomButton
              media={{
                id: movie.id,
                type: 'movie',
                title: movie.title,
                year: movie.year,
                poster: movie.poster,
                backdrop: movie.backdrop,
                overview: movie.overview,
                imdbId: movie.imdbId,
                tmdbId: movie.tmdbId ? Number(movie.tmdbId) : undefined,
                tvdbId: movie.tvdbId ? Number(movie.tvdbId) : undefined,
                anilistId: movie.anilistId ? Number(movie.anilistId) : undefined,
              }}
            />
          </div>
        }
      />

      <StreamSelector
        open={streamOpen}
        onClose={() => setStreamOpen(false)}
        mediaType="movie"
        mediaId={streamId}
        title={movie.title}
        artwork={{ poster: movie.poster, backdrop: movie.backdrop }}
        startTime={movieWatched ? undefined : liveResumePoint ? liveResumePoint.progressSeconds : (hasProgress ? progressItem.progressSeconds : undefined)}
        tmdbId={Number.isFinite(streamTmdbId) ? streamTmdbId : undefined}
        malId={movie.malId != null ? Number(movie.malId) : state.malId != null ? Number(state.malId) : undefined}
        anilistId={movie.anilistId != null ? Number(movie.anilistId) : state.anilistId != null ? Number(state.anilistId) : undefined}
        sourceAddonId={state.sourceAddonId}
        sourceAddonItemId={state.sourceAddonItemId}
        onResolvingChange={setStreamResolving}
      />

      <DetailContentShell
        title={movie.title}
        logo={movie.logo}
        imdbId={movie.imdbId}
        backdrop={movie.backdrop}
      >
        {movie.trailers.length > 0 && <TrailerRow title="Videos & Trailers" videos={movie.trailers} />}
        {movie.cast.length > 0 && <CastRow cast={movie.cast} crew={movie.crew} />}

        {movie.recommendations.length > 0 && (
          <MediaRow title="More Like This" items={movie.recommendations} layout="poster" disableArtOverride={false} />
        )}

        {movie.recommendations.length === 0 && (
          <MediaRow title="You May Also Like" items={fallbackRecommendations.filter((m) => m.id !== movie.id)} layout="poster" disableArtOverride={false} />
        )}
      </DetailContentShell>
    </div>
  )
}
