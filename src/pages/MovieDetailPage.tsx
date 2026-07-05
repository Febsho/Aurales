import { useMemo, useState, useEffect } from 'react'
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
import { Button } from '../components/ui'
import MarkWatchedButton from '../components/MarkWatchedButton'
import StartInRoomButton from '../components/watch-together/StartInRoomButton'
import { applyMovieArt, applySearchResultArt, resolveArtFromProviders } from '../services/artwork'
import { getSimklPlaybackProgress } from '../services/simkl/playback'
import { getPlaybackProgress as getTraktPlaybackProgress } from '../services/trakt/sync'
import { getPMDBPlaybackProgress } from '../services/pmdb'
import { getMdblistPlaybackProgress, hasMdblistOAuth } from '../services/mdblist'
import { resolveAppMetadata, type AppMediaItem } from '../services/metadata'
import { isWatchedFromProviders } from '../services/watchedStatus'
import { cacheGet, cacheSet } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../services/cache/constants'
import { useGlobalBackdrop } from '../hooks/useGlobalBackdrop'

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
    providers: settings.artProviders,
    fanart: Boolean(settings.fanartApiKey),
    custom: settings.customArtUrls,
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
  const addons = useAppStore((s) => s.addons)
  const watchedProgress = useAppStore((s) => s.watchProgress)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)
  const setWatchProgress = useAppStore((s) => s.setWatchProgress)
  const removeWatchProgress = useAppStore((s) => s.removeWatchProgress)
  const artProviders = useAppStore((s) => s.artProviders)
  const fanartApiKey = useAppStore((s) => s.fanartApiKey)
  const customArtUrls = useAppStore((s) => s.customArtUrls)
  const artSettingsSignature = useMemo(() => JSON.stringify({
    providers: artProviders,
    fanart: Boolean(fanartApiKey),
    custom: customArtUrls,
  }), [artProviders, fanartApiKey, customArtUrls])
  const [movieWatched, setMovieWatched] = useState(false)

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
    if (!movie) return

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
                fuzzyIdsMatch(item.movie.ids.simkl, movie.id) ||
                fuzzyIdsMatch(item.movie.ids.imdb, movie.imdbId) ||
                fuzzyIdsMatch(item.movie.ids.tmdb, movie.tmdbId)
              )
            })
            if (match && active) {
              const dur = movie.runtime ? movie.runtime * 60 : 7200
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
                fuzzyIdsMatch(item.movie.ids.imdb, movie.imdbId) ||
                fuzzyIdsMatch(item.movie.ids.tmdb, movie.tmdbId)
              )
            })
            if (match && active) {
              const dur = movie.runtime ? movie.runtime * 60 : 7200
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
              if (item.mediaType !== 'movie') return false
              return (
                fuzzyIdsMatch(item.tmdbId, movie.tmdbId) ||
                fuzzyIdsMatch(item.imdbId, movie.imdbId)
              )
            })
            if (match && active) {
              candidates.push({
                provider: 'pmdb',
                progressSeconds: Math.floor((match.progressMs ?? 0) / 1000),
                durationSeconds: Math.floor((match.durationMs ?? 7200000) / 1000),
                updatedAt: match.updatedAt,
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
                fuzzyIdsMatch(item.tmdbId, movie.tmdbId) ||
                fuzzyIdsMatch(item.imdbId, movie.imdbId)
              )
            })
            if (match && active) {
              const dur = movie.runtime ? movie.runtime * 60 : 7200
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

      if (loading) setLoading(true)
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

      // Early resolve anime IDs if they are AniList / MAL but we don't have TMDB ID
      if ((knownIds.anilistId || knownIds.malId) && !knownIds.tmdbId) {
        try {
          const { resolveAnimeIds } = await import('../services/animeLists')
          const resolved = await resolveAnimeIds({
            anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
            malId: knownIds.malId ? Number(knownIds.malId) : undefined,
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

      if (state.sourceAddonId && state.sourceAddonItemId) {
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
      if (state.addonUrl || state.provider === 'addon' || (id?.startsWith('tt') && !knownIds.tmdbId)) {
        const tryAddonMeta = async (addonUrl: string) => {
          try {
            const meta = await getAddonMeta(addonUrl, 'movie', id || '')
            if (meta) {
              const parsed = addonMetaToMovie(meta, id || '')
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
        if (addonResult && !result && useAppStore.getState().useAddonMetadataFallback) result = addonResult
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
        setLoading(false)
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

      let artApplied = finalResult

      const providerArt = await resolveArtFromProviders('movie', {
        tmdbId: artApplied.tmdbId, tvdbId: artApplied.tvdbId, imdbId: artApplied.imdbId,
      }, artApplied.isAnime)
      if (providerArt.poster || providerArt.backdrop || providerArt.logo) {
        artApplied = { ...artApplied, ...(providerArt.poster && { poster: providerArt.poster }), ...(providerArt.backdrop && { backdrop: providerArt.backdrop }), ...(providerArt.logo && { logo: providerArt.logo }) }
      }
      artApplied = applyMovieArt(artApplied)

      setMovie(artApplied)
      setLoading(false)

      const cacheOpts = { category: CACHE_CATEGORIES.DETAIL_PAGE, ttlSeconds: CACHE_TTLS.DETAIL_PAGE }
      if (movieCacheKey) void cacheSet(movieCacheKey, artApplied, cacheOpts)
      if (artApplied.id && artApplied.id !== id) void cacheSet(`detail:movie:${artKey}:${artApplied.id}`, artApplied, cacheOpts)

      if (id && artApplied.id && artApplied.id !== id) {
        console.log('[MovieDetailPage] Normalizing URL route ID to:', artApplied.id)
        navigate(`/movie/${artApplied.id}`, { replace: true, state })
      }
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
    isWatchedFromProviders({
      id: movie.id,
      type: 'movie',
      imdbId: movie.imdbId,
      tmdbId: movie.tmdbId,
      tvdbId: movie.tvdbId,
      malId: movie.malId,
      anilistId: movie.anilistId,
    }, watchedCheckmarkSources, watchedProgress).then((watched) => {
      if (!cancelled) setMovieWatched(watched)
    }).catch(() => {
      if (!cancelled) setMovieWatched(false)
    })
    return () => { cancelled = true }
  }, [movie, watchedCheckmarkSources, watchedProgress])

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

  if (loading || !movie) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const streamId = movie.imdbId || state.sourceAddonItemId || id || ''
  const streamTmdbId = movie.tmdbId ? Number(movie.tmdbId) : (id && /^(?:tmdb)[-:]/i.test(id) ? Number(id.replace(/^[a-z_]+[-:]/i, '')) : undefined)
  const movieIsAnime = !!(movie.isAnime || (id && /^(mal|anilist)[-:]/i.test(id)) || state.provider === 'anilist')

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
              icon={
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              }
              onClick={() => setStreamOpen(true)}
            >
              {(() => {
                const activeResume = liveResumePoint || (hasProgress ? { progressSeconds: progressItem.progressSeconds, durationSeconds: progressItem.durationSeconds } : null)
                return activeResume
                  ? `Resume (${formatRemainingTime(activeResume.durationSeconds - activeResume.progressSeconds)})`
                  : movieWatched
                  ? 'Rewatch'
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
        startTime={liveResumePoint ? liveResumePoint.progressSeconds : (hasProgress ? progressItem.progressSeconds : undefined)}
        tmdbId={Number.isFinite(streamTmdbId) ? streamTmdbId : undefined}
        malId={movie.malId != null ? Number(movie.malId) : state.malId != null ? Number(state.malId) : undefined}
        anilistId={movie.anilistId != null ? Number(movie.anilistId) : state.anilistId != null ? Number(state.anilistId) : undefined}
        sourceAddonId={state.sourceAddonId}
        sourceAddonItemId={state.sourceAddonItemId}
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
