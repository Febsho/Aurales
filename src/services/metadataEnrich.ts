import type { MovieDetails, ShowDetails } from '../types'
import { tmdbProvider } from './tmdb'
import { tvdbProvider } from './tvdb'
import { resolveAnimeIds, lookupByTvdbId, lookupByAniListId, lookupByMalId, lookupByImdbId } from './animeLists'
import { useAppStore } from '../stores/appStore'

const TMDB_BASE = 'https://api.themoviedb.org/3'

function getTmdbApiKey(): string {
  return localStorage.getItem('tmdb_api_key') || import.meta.env.VITE_TMDB_API_KEY || ''
}

async function tmdbApiFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const apiKey = getTmdbApiKey()
  if (!apiKey) throw new Error('TMDB API key not configured')
  const url = new URL(`${TMDB_BASE}${path}`)
  url.searchParams.set('api_key', apiKey)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`TMDB error: ${res.status}`)
  return res.json()
}

export async function tmdbFindByExternalId(
  externalId: string,
  source: string
): Promise<{ tmdbId?: number; imdbId?: string; mediaType?: 'movie' | 'tv' }> {
  try {
    const data = (await tmdbApiFetch(`/find/${externalId}`, {
      external_source: source,
    })) as Record<string, unknown>

    const movieResults = (data.movie_results as Record<string, unknown>[]) || []
    if (movieResults.length > 0) {
      return {
        tmdbId: movieResults[0].id as number,
        imdbId: externalId.startsWith('tt') ? externalId : undefined,
        mediaType: 'movie',
      }
    }

    const tvResults = (data.tv_results as Record<string, unknown>[]) || []
    if (tvResults.length > 0) {
      return {
        tmdbId: tvResults[0].id as number,
        imdbId: externalId.startsWith('tt') ? externalId : undefined,
        mediaType: 'tv',
      }
    }

    return {}
  } catch {
    return {}
  }
}

export async function resolveImdbId(
  ids: {
    imdbId?: string
    tmdbId?: string | number
    tvdbId?: string | number
    anilistId?: string | number
    malId?: string | number
  },
  mediaType: 'movie' | 'series'
): Promise<string | undefined> {
  if (ids.imdbId) return ids.imdbId

  try {
    const anilistId = ids.anilistId != null ? Number(ids.anilistId) : undefined
    const malId = ids.malId != null ? Number(ids.malId) : undefined
    if (anilistId || malId) {
      const resolved = await resolveAnimeIds({
        anilistId,
        malId,
        tvdbId: ids.tvdbId != null ? Number(ids.tvdbId) : undefined,
        tmdbId: ids.tmdbId != null ? Number(ids.tmdbId) : undefined,
        imdbId: ids.imdbId,
      })
      if (resolved?.imdbId) return resolved.imdbId
    }
  } catch { /* continue */ }

  if (ids.tmdbId != null) {
    try {
      const tmdbId = String(ids.tmdbId).replace('tmdb-', '')
      const endpoint = mediaType === 'movie' ? 'movie' : 'tv'
      const data = (await tmdbApiFetch(`/${endpoint}/${tmdbId}/external_ids`)) as Record<string, unknown>
      if (data.imdb_id && typeof data.imdb_id === 'string') return data.imdb_id as string
    } catch { /* continue */ }
  }

  if (ids.tvdbId != null) {
    try {
      const found = await tmdbFindByExternalId(String(ids.tvdbId), 'tvdb_id')
      if (found.tmdbId) {
        const endpoint = mediaType === 'movie' ? 'movie' : 'tv'
        const data = (await tmdbApiFetch(`/${endpoint}/${found.tmdbId}/external_ids`)) as Record<string, unknown>
        if (data.imdb_id && typeof data.imdb_id === 'string') return data.imdb_id as string
      }
    } catch { /* continue */ }
  }

  return undefined
}

function mergeMovieDetails(original: MovieDetails, provider: MovieDetails): MovieDetails {
  return {
    ...original,
    title: provider.title || original.title,
    originalTitle: provider.originalTitle || original.originalTitle,
    overview: provider.overview || original.overview,
    tagline: provider.tagline || original.tagline,
    genres: provider.genres.length > 0 ? provider.genres : original.genres,
    cast: provider.cast.length > 0 ? provider.cast : original.cast,
    crew: provider.crew.length > 0 ? provider.crew : original.crew,
    rating: provider.rating ?? original.rating,
    voteCount: provider.voteCount ?? original.voteCount,
    runtime: provider.runtime ?? original.runtime,
    certification: provider.certification || original.certification,
    trailers: provider.trailers.length > 0 ? provider.trailers : original.trailers,
    recommendations: provider.recommendations.length > 0 ? provider.recommendations : original.recommendations,
    year: provider.year ?? original.year,
    releaseDate: provider.releaseDate || original.releaseDate,
    poster: provider.poster || original.poster,
    backdrop: provider.backdrop || original.backdrop,
    logo: provider.logo || original.logo,
    imdbId: original.imdbId || provider.imdbId,
    tmdbId: original.tmdbId || provider.tmdbId,
    tvdbId: original.tvdbId || provider.tvdbId,
    malId: original.malId || provider.malId,
    anilistId: original.anilistId || provider.anilistId,
  }
}

function mergeShowDetails(original: ShowDetails, provider: ShowDetails): ShowDetails {
  return {
    ...original,
    title: provider.title || original.title,
    originalTitle: provider.originalTitle || original.originalTitle,
    overview: provider.overview || original.overview,
    tagline: provider.tagline || original.tagline,
    genres: provider.genres.length > 0 ? provider.genres : original.genres,
    cast: provider.cast.length > 0 ? provider.cast : original.cast,
    crew: provider.crew.length > 0 ? provider.crew : original.crew,
    rating: provider.rating ?? original.rating,
    voteCount: provider.voteCount ?? original.voteCount,
    certification: provider.certification || original.certification,
    status: provider.status || original.status,
    numberOfSeasons: provider.numberOfSeasons ?? original.numberOfSeasons,
    numberOfEpisodes: provider.numberOfEpisodes ?? original.numberOfEpisodes,
    seasons: provider.seasons.length > 0 ? provider.seasons : original.seasons,
    trailers: provider.trailers.length > 0 ? provider.trailers : original.trailers,
    recommendations: provider.recommendations.length > 0 ? provider.recommendations : original.recommendations,
    year: provider.year ?? original.year,
    firstAirDate: provider.firstAirDate || original.firstAirDate,
    poster: provider.poster || original.poster,
    backdrop: provider.backdrop || original.backdrop,
    logo: provider.logo || original.logo,
    imdbId: original.imdbId || provider.imdbId,
    tmdbId: original.tmdbId || provider.tmdbId,
    tvdbId: original.tvdbId || provider.tvdbId,
    malId: original.malId || provider.malId,
    anilistId: original.anilistId || provider.anilistId,
  }
}

async function resolveTmdbIdForMovie(movie: MovieDetails): Promise<string | undefined> {
  if (movie.tmdbId) return String(movie.tmdbId).replace('tmdb-', '')

  if (movie.imdbId) {
    const found = await tmdbFindByExternalId(movie.imdbId, 'imdb_id')
    if (found.tmdbId) return String(found.tmdbId)
  }

  if (movie.tvdbId) {
    const found = await tmdbFindByExternalId(String(movie.tvdbId), 'tvdb_id')
    if (found.tmdbId) return String(found.tmdbId)
  }

  return undefined
}

async function resolveTmdbIdForShow(show: ShowDetails): Promise<string | undefined> {
  if (show.tmdbId) return String(show.tmdbId).replace('tmdb-', '')

  if (show.imdbId) {
    const found = await tmdbFindByExternalId(show.imdbId, 'imdb_id')
    if (found.tmdbId) return String(found.tmdbId)
  }

  if (show.tvdbId) {
    const found = await tmdbFindByExternalId(String(show.tvdbId), 'tvdb_id')
    if (found.tmdbId) return String(found.tmdbId)
  }

  const anilistId = show.anilistId != null ? Number(show.anilistId) : undefined
  const malId = show.malId != null ? Number(show.malId) : undefined
  if (anilistId || malId) {
    const resolved = await resolveAnimeIds({ anilistId, malId })
    if (resolved?.tmdbId) return String(resolved.tmdbId)
  }

  return undefined
}

async function resolveTvdbIdForShow(show: ShowDetails): Promise<string | undefined> {
  if (show.tvdbId) return String(show.tvdbId).replace('tvdb-', '')

  const anilistId = show.anilistId != null ? Number(show.anilistId) : undefined
  const malId = show.malId != null ? Number(show.malId) : undefined
  if (anilistId || malId) {
    const resolved = await resolveAnimeIds({ anilistId, malId })
    if (resolved?.tvdbId) return String(resolved.tvdbId)
  }

  return undefined
}

async function fetchFromTmdbMovie(movie: MovieDetails): Promise<MovieDetails | null> {
  const tmdbId = await resolveTmdbIdForMovie(movie)
  if (!tmdbId) return null
  try {
    return await tmdbProvider.getMovie(`tmdb-${tmdbId}`)
  } catch {
    return null
  }
}

async function fetchFromTmdbShow(show: ShowDetails): Promise<ShowDetails | null> {
  const tmdbId = await resolveTmdbIdForShow(show)
  if (!tmdbId) return null
  try {
    return await tmdbProvider.getShow(`tmdb-${tmdbId}`)
  } catch {
    return null
  }
}

async function fetchFromTvdbShow(show: ShowDetails): Promise<ShowDetails | null> {
  const tvdbId = await resolveTvdbIdForShow(show)
  if (!tvdbId) return null
  try {
    return await tvdbProvider.getShow(`tvdb-${tvdbId}`)
  } catch {
    return null
  }
}

export async function enrichMovieDetails(movie: MovieDetails): Promise<MovieDetails> {
  try {
    const state = useAppStore?.getState?.()
    const source = state?.movieMetadataSource ?? 'tmdb'
    const fallback = state?.movieMetadataFallback ?? true

    let providerData: MovieDetails | null = null

    if (source === 'tmdb') {
      providerData = await fetchFromTmdbMovie(movie)
    }
    // tvdb doesn't support movies, so skip directly to fallback

    if (!providerData && fallback) {
      providerData = await fetchFromTmdbMovie(movie)
    }

    let result = providerData ? mergeMovieDetails(movie, providerData) : { ...movie }

    if (!result.imdbId) {
      result.imdbId = await resolveImdbId(
        { imdbId: result.imdbId, tmdbId: result.tmdbId, tvdbId: result.tvdbId, anilistId: result.anilistId, malId: result.malId },
        'movie'
      )
    }

    return result
  } catch (e) {
    console.warn('[enrich] enrichMovieDetails failed:', e)
    return movie
  }
}

export async function enrichShowDetails(show: ShowDetails, isAnime?: boolean): Promise<ShowDetails> {
  try {
    console.log('[enrich] enrichShowDetails start:', { id: show.id, title: show.title, isAnime, imdbId: show.imdbId, tmdbId: show.tmdbId, tvdbId: show.tvdbId, anilistId: show.anilistId, malId: show.malId, provider: show.provider })

    // Auto-detect anime via anime-lists if not explicitly flagged
    if (!isAnime) {
      try {
        const anilistId = show.anilistId != null ? Number(show.anilistId) : undefined
        const malId = show.malId != null ? Number(show.malId) : undefined
        if (anilistId) {
          const entries = await lookupByAniListId(anilistId)
          if (entries.length > 0) isAnime = true
        } else if (malId) {
          const entries = await lookupByMalId(malId)
          if (entries.length > 0) isAnime = true
        } else if (show.tvdbId) {
          const entries = await lookupByTvdbId(Number(String(show.tvdbId).replace('tvdb-', '')))
          if (entries.length > 0) isAnime = true
        } else if (show.imdbId) {
          const entry = await lookupByImdbId(show.imdbId)
          if (entry) isAnime = true
        }
      } catch (e) { console.warn('[enrich] anime detection failed:', e) }
    }

    // Resolve all anime IDs upfront
    const anilistId = show.anilistId != null ? Number(show.anilistId) : undefined
    const malId = show.malId != null ? Number(show.malId) : undefined
    if (isAnime) {
      try {
        const resolved = await resolveAnimeIds({
          anilistId, malId,
          tvdbId: show.tvdbId ? Number(String(show.tvdbId).replace('tvdb-', '')) : undefined,
          tmdbId: show.tmdbId ? Number(String(show.tmdbId).replace('tmdb-', '')) : undefined,
          imdbId: show.imdbId,
        })
        if (resolved) {
          console.log('[enrich] anime IDs resolved:', resolved)
          if (resolved.tvdbId) show = { ...show, tvdbId: show.tvdbId || resolved.tvdbId }
          if (resolved.tmdbId) show = { ...show, tmdbId: show.tmdbId || resolved.tmdbId }
          if (resolved.imdbId) show = { ...show, imdbId: show.imdbId || resolved.imdbId }
          if (resolved.anilistId) show = { ...show, anilistId: show.anilistId || resolved.anilistId }
          if (resolved.malId) show = { ...show, malId: show.malId || resolved.malId }
        }
      } catch (e) { console.warn('[enrich] anime ID resolution failed:', e) }
    }

    const state = useAppStore?.getState?.()
    const source = isAnime
      ? (state?.animeMetadataSource ?? 'tvdb')
      : (state?.seriesMetadataSource ?? 'tmdb')
    const fallback = isAnime
      ? (state?.animeMetadataFallback ?? true)
      : (state?.seriesMetadataFallback ?? true)

    let providerData: ShowDetails | null = null

    console.log('[enrich] fetching from source:', source, 'isAnime:', isAnime, 'tvdbId:', show.tvdbId, 'tmdbId:', show.tmdbId)

    if (isAnime && (source === 'anilist' || source === 'mal' || source === 'kitsu' || source === 'tvdb')) {
      providerData = await fetchFromTvdbShow(show)
      if (!providerData) providerData = await fetchFromTmdbShow(show)
    } else if (source === 'tvdb') {
      providerData = await fetchFromTvdbShow(show)
    } else {
      providerData = await fetchFromTmdbShow(show)
    }

    if (!providerData && fallback) {
      console.log('[enrich] primary failed, trying fallback')
      if (source === 'tvdb' || source === 'anilist' || source === 'mal' || source === 'kitsu') {
        providerData = await fetchFromTmdbShow(show)
      } else {
        providerData = await fetchFromTvdbShow(show)
      }
    }

    console.log('[enrich] provider result:', providerData ? { seasons: providerData.seasons.length, cast: providerData.cast.length, title: providerData.title } : 'null')

    let result = providerData ? mergeShowDetails(show, providerData) : { ...show }

    if (!result.imdbId) {
      result.imdbId = await resolveImdbId(
        { imdbId: result.imdbId, tmdbId: result.tmdbId, tvdbId: result.tvdbId, anilistId: result.anilistId, malId: result.malId },
        'series'
      )
    }

    return result
  } catch (e) {
    console.warn('[enrich] enrichShowDetails failed:', e)
    return show
  }
}
