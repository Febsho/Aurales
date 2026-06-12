import { useState, useEffect } from 'react'
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
import { applyMovieArt, applySearchResultArt } from '../services/artwork'
import { resolveAppMetadata, type AppMediaItem } from '../services/metadata'
import { isWatchedFromProviders } from '../services/watchedStatus'

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
    certification: meta.certification as string | undefined,
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
  const [movieWatched, setMovieWatched] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setMalRating(null)
      let result: MovieDetails | null = null

      // Collect known IDs
      const knownIds = {
        imdbId: state.imdbId || (id?.startsWith('tt') ? id : id?.startsWith('app_movie_') ? id.replace('app_movie_', '') : undefined),
        tmdbId: state.tmdbId || (id?.startsWith('tmdb-') ? id.replace('tmdb-', '') : id?.startsWith('app_tmdb_movie_') ? id.replace('app_tmdb_movie_', '') : id?.startsWith('app_tmdb_') ? id.replace('app_tmdb_', '') : undefined),
        tvdbId: state.tvdbId || (id?.startsWith('tvdb-') ? id.replace('tvdb-', '') : id?.startsWith('app_tvdb_') ? id.replace('app_tvdb_', '') : undefined),
        malId: state.malId || (id?.startsWith('mal-') ? id.replace('mal-', '') : undefined),
        anilistId: state.anilistId || (id?.startsWith('anilist-') ? id.replace('anilist-', '') : undefined),
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
          knownIds.tmdbId ||= normalized.tmdbId
          knownIds.tvdbId ||= normalized.tvdbId
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
              if (parsed.tmdbId) knownIds.tmdbId = knownIds.tmdbId || parsed.tmdbId
              if (parsed.malId) knownIds.malId = knownIds.malId || parsed.malId
              if (parsed.anilistId) knownIds.anilistId = knownIds.anilistId || parsed.anilistId
              return parsed
            }
          } catch { /* continue */ }
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
      let tmdbId = knownIds.tmdbId ? String(knownIds.tmdbId).replace('tmdb-', '') : undefined
      if (!tmdbId && knownIds.imdbId) {
        try {
          const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
          const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
          if (found.tmdbId) tmdbId = String(found.tmdbId)
        } catch { /* continue */ }
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
        } catch { /* continue */ }
      }

      // Resolve IMDb if missing
      const finalResult = appResult || result || { ...MOCK_HERO_MOVIE, id: id || 'mock-1' }
      if (!finalResult.imdbId && finalResult.tmdbId) {
        try {
          const { resolveImdbId } = await import('../services/metadataEnrich')
          const imdbId = await resolveImdbId(finalResult, 'movie')
          if (imdbId) finalResult.imdbId = imdbId
        } catch { /* continue */ }
      }

      const finalTmdbId = finalResult.tmdbId ? String(finalResult.tmdbId).replace('tmdb-', '') : undefined
      const finalImdbId = finalResult.imdbId
      
      const targetId = finalTmdbId
        ? `app_tmdb_movie_${finalTmdbId}`
        : finalImdbId
        ? `app_movie_${finalImdbId}`
        : finalResult.id || id || 'unknown'

      finalResult.id = targetId

      const artApplied = applyMovieArt(finalResult)
      setMovie(artApplied)
      setLoading(false)

      if (id && (id.startsWith('anilist-') || id.startsWith('mal-')) && artApplied.id && artApplied.id !== id) {
        console.log('[MovieDetailPage] Normalizing URL route ID to:', artApplied.id)
        navigate(`/movie/${artApplied.id}`, { replace: true, state })
      }
    }
    load()
  }, [id, state.addonUrl, state.provider, state.title, addons])

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

  if (loading || !movie) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const streamId = movie.imdbId || state.sourceAddonItemId || id || ''
  const streamTmdbId = movie.tmdbId ? Number(movie.tmdbId) : (id?.startsWith('tmdb-') ? Number(id.replace('tmdb-', '')) : undefined)

  return (
    <div className="pb-12">
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
            className="mb-4"
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
              {movieWatched ? 'Rewatch' : 'Play'}
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
