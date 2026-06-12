import type { SearchResult } from '../types'
import { tmdbProvider } from './tmdb'
import { tvdbProvider } from './tvdb'

export type SearchEngineId = 'tmdb' | 'tvdb' | 'trakt' | 'mdblist' | 'tvmaze' | 'mal' | 'cinemeta'

export interface SearchEngine {
  id: SearchEngineId
  name: string
  supportsMovies: boolean
  supportsSeries: boolean
  supportsAnime: boolean
  search: (query: string, type?: 'movie' | 'series') => Promise<SearchResult[]>
}

const CINEMETA_URL = 'https://v3-cinemeta.strem.io'

async function cinemetaSearch(query: string, type?: 'movie' | 'series'): Promise<SearchResult[]> {
  if (!type) {
    const [movies, series] = await Promise.all([cinemetaSearch(query, 'movie'), cinemetaSearch(query, 'series')])
    return [...movies, ...series]
  }
  const res = await fetch(`${CINEMETA_URL}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`)
  if (!res.ok) return []
  const data = await res.json()
  const metas = (data.metas || []) as Record<string, unknown>[]
  return metas.map((m) => ({
    id: (m.imdb_id || m.id) as string,
    title: m.name as string,
    type,
    year: m.releaseInfo ? parseInt(String(m.releaseInfo)) : undefined,
    poster: m.poster as string | undefined,
    overview: (m.description || m.overview) as string | undefined,
    imdbId: (m.imdb_id || (typeof m.id === 'string' && (m.id as string).startsWith('tt') ? m.id : undefined)) as string | undefined,
    provider: 'cinemeta',
  }))
}

async function traktSearch(query: string, type?: 'movie' | 'series'): Promise<SearchResult[]> {
  const { getClientId } = await import('./trakt/auth')
  const clientId = getClientId()
  if (!clientId) return []
  const traktType = type === 'series' ? 'show' : type === 'movie' ? 'movie' : 'movie,show'
  const res = await fetch(`https://api.trakt.tv/search/text?query=${encodeURIComponent(query)}&type=${traktType}&limit=20`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
  })
  if (!res.ok) return []
  const data = await res.json() as Record<string, unknown>[]
  const results: SearchResult[] = []
  for (const item of data) {
    const mediaType = item.type as string
    const media = item[mediaType] as Record<string, unknown> | undefined
    if (!media) continue
    const ids = media.ids as Record<string, unknown> | undefined
    results.push({
      id: ids?.imdb ? String(ids.imdb) : ids?.tmdb ? `tmdb-${ids.tmdb}` : `trakt-${ids?.trakt || ids?.slug}`,
      title: media.title as string,
      type: (mediaType === 'show' ? 'series' : 'movie') as 'movie' | 'series',
      year: media.year as number | undefined,
      overview: media.overview as string | undefined,
      imdbId: ids?.imdb as string | undefined,
      tmdbId: ids?.tmdb as number | undefined,
      tvdbId: ids?.tvdb as number | undefined,
      provider: 'trakt',
    })
  }
  return results
}

async function mdblistSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://mdblist.com/api/?apikey=${localStorage.getItem('mdblist_api_key') || ''}&s=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = await res.json()
  const results = (data.search || []) as Record<string, unknown>[]
  return results.map((m) => ({
    id: m.imdbid ? String(m.imdbid) : `mdblist-${m.id}`,
    title: m.title as string,
    type: (m.type === 'show' ? 'series' : 'movie') as 'movie' | 'series',
    year: m.year as number | undefined,
    poster: m.poster as string | undefined,
    overview: m.description as string | undefined,
    imdbId: m.imdbid as string | undefined,
    tmdbId: m.tmdbid as number | undefined,
    provider: 'mdblist',
  }))
}

async function tvmazeSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = await res.json() as { show: Record<string, unknown>; score: number }[]
  return data.map((item) => {
    const show = item.show
    const externals = show.externals as Record<string, unknown> | undefined
    return {
      id: externals?.imdb ? String(externals.imdb) : externals?.thetvdb ? `tvdb-${externals.thetvdb}` : `tvmaze-${show.id}`,
      title: show.name as string,
      type: 'series' as const,
      year: show.premiered ? parseInt(String(show.premiered).slice(0, 4)) : undefined,
      poster: (show.image as Record<string, string> | undefined)?.original || (show.image as Record<string, string> | undefined)?.medium,
      overview: show.summary ? String(show.summary).replace(/<[^>]*>/g, '') : undefined,
      imdbId: externals?.imdb as string | undefined,
      tvdbId: externals?.thetvdb as number | undefined,
      provider: 'tvmaze',
    }
  })
}

async function malSearch(query: string): Promise<SearchResult[]> {
  const mediaType = 'anime'
  const res = await fetch(`https://api.jikan.moe/v4/${mediaType}?q=${encodeURIComponent(query)}&limit=20`)
  if (!res.ok) return []
  const data = await res.json()
  const results = (data.data || []) as Record<string, unknown>[]
  const { resolveAnimeIds } = await import('./animeLists')
  return Promise.all(results.map(async (m) => {
    const malId = m.mal_id as number
    const titles = m.titles as { type: string; title: string }[] | undefined
    const englishTitle = titles?.find((t) => t.type === 'English')?.title
    const defaultTitle = titles?.find((t) => t.type === 'Default')?.title

    let imdbId: string | undefined
    let tmdbId: number | undefined
    let tvdbId: number | undefined
    let anilistId: number | undefined
    try {
      const mapped = await resolveAnimeIds({ malId })
      if (mapped) {
        imdbId = mapped.imdbId
        tmdbId = mapped.tmdbId
        tvdbId = mapped.tvdbId
        anilistId = mapped.anilistId
      }
    } catch { /* ignore */ }

    const isMovie = (m.type as string) === 'Movie'
    const id = tvdbId ? `tvdb-${tvdbId}` : tmdbId ? `tmdb-${tmdbId}` : imdbId || `mal-${malId}`

    return {
      id,
      title: englishTitle || defaultTitle || m.title as string,
      type: (isMovie ? 'movie' : 'series') as 'movie' | 'series',
      year: m.year as number | undefined,
      poster: (m.images as Record<string, Record<string, string>>)?.jpg?.large_image_url || (m.images as Record<string, Record<string, string>>)?.jpg?.image_url,
      overview: m.synopsis as string | undefined,
      rating: m.score as number | undefined,
      imdbId,
      tmdbId,
      tvdbId,
      malId,
      anilistId,
      provider: 'mal',
    }
  }))
}

function filterByType(results: SearchResult[], type?: 'movie' | 'series'): SearchResult[] {
  if (!type) return results
  return results.filter((r) => r.type === type)
}

export const searchEngines: Record<SearchEngineId, SearchEngine> = {
  tmdb: {
    id: 'tmdb', name: 'TMDB Search', supportsMovies: true, supportsSeries: true, supportsAnime: false,
    search: async (query, type) => filterByType(await tmdbProvider.search(query), type),
  },
  tvdb: {
    id: 'tvdb', name: 'TheTVDB Search', supportsMovies: false, supportsSeries: true, supportsAnime: false,
    search: async (query) => tvdbProvider.search(query),
  },
  trakt: {
    id: 'trakt', name: 'Trakt Search', supportsMovies: true, supportsSeries: true, supportsAnime: false,
    search: traktSearch,
  },
  mdblist: {
    id: 'mdblist', name: 'MDBList Search', supportsMovies: true, supportsSeries: true, supportsAnime: false,
    search: async (query, type) => filterByType(await mdblistSearch(query), type),
  },
  tvmaze: {
    id: 'tvmaze', name: 'TVmaze Search', supportsMovies: false, supportsSeries: true, supportsAnime: false,
    search: tvmazeSearch,
  },
  mal: {
    id: 'mal', name: 'MAL (Jikan)', supportsMovies: true, supportsSeries: true, supportsAnime: true,
    search: async (query, type) => filterByType(await malSearch(query), type),
  },
  cinemeta: {
    id: 'cinemeta', name: 'Cinemeta', supportsMovies: true, supportsSeries: true, supportsAnime: false,
    search: (query, type) => cinemetaSearch(query, type),
  },
}

export function getMovieEngineOptions(): { id: SearchEngineId; name: string }[] {
  return Object.values(searchEngines).filter((e) => e.supportsMovies).map((e) => ({ id: e.id, name: e.name }))
}

export function getSeriesEngineOptions(): { id: SearchEngineId; name: string }[] {
  return Object.values(searchEngines).filter((e) => e.supportsSeries).map((e) => ({ id: e.id, name: e.name }))
}

export function getAnimeSeriesEngineOptions(): { id: SearchEngineId; name: string }[] {
  return [
    { id: 'mal', name: 'MAL (Series)' },
    { id: 'tvdb', name: 'TheTVDB Search' },
    { id: 'tmdb', name: 'TMDB Search' },
    { id: 'trakt', name: 'Trakt Search' },
  ]
}

export function getAnimeMovieEngineOptions(): { id: SearchEngineId; name: string }[] {
  return [
    { id: 'mal', name: 'MAL (Movies)' },
    { id: 'tmdb', name: 'TMDB Search' },
    { id: 'trakt', name: 'Trakt Search' },
  ]
}

export async function executeSearch(
  query: string,
  config: {
    movieEngine: SearchEngineId
    seriesEngine: SearchEngineId
    animeSeriesEngine: SearchEngineId
    animeMovieEngine: SearchEngineId
    movieEngineEnabled: boolean
    seriesEngineEnabled: boolean
    animeSeriesEngineEnabled: boolean
    animeMovieEngineEnabled: boolean
  },
  addonSearches: Promise<SearchResult[]>[],
): Promise<SearchResult[]> {
  const searches: Promise<SearchResult[]>[] = []

  if (config.movieEngineEnabled) {
    const engine = searchEngines[config.movieEngine]
    if (engine) searches.push(engine.search(query, 'movie').catch(() => []))
  }

  if (config.seriesEngineEnabled) {
    const engine = searchEngines[config.seriesEngine]
    if (engine) searches.push(engine.search(query, 'series').catch(() => []))
  }

  if (config.animeSeriesEngineEnabled) {
    const engine = searchEngines[config.animeSeriesEngine]
    if (engine && config.animeSeriesEngine !== config.seriesEngine) {
      searches.push(engine.search(query, 'series').catch(() => []))
    }
  }

  if (config.animeMovieEngineEnabled) {
    const engine = searchEngines[config.animeMovieEngine]
    if (engine && config.animeMovieEngine !== config.movieEngine) {
      searches.push(engine.search(query, 'movie').catch(() => []))
    }
  }

  searches.push(...addonSearches.map((p) => p.catch(() => [])))

  const settled = await Promise.allSettled(searches)
  return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
}
