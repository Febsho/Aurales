import type { MetadataProvider, SearchResult, MovieDetails, ShowDetails, SeasonDetails, EpisodeDetails } from '../types'
import { getTvdbApiKey } from './apiKeys'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { coordinatedJson, type RequestPriority } from './network/requestCoordinator'

const BASE_URL = 'https://api4.thetvdb.com/v4'

let cachedToken: string | null = null
let cachedTokenApiKey = ''
let tokenPromise: Promise<string> | null = null

const seriesDataCache = new Map<string, { data: Record<string, unknown>; timestamp: number }>()
const movieDataCache = new Map<string, { data: Record<string, unknown>; timestamp: number }>()
const seriesDataPending = new Map<string, Promise<Record<string, unknown>>>()
const movieDataPending = new Map<string, Promise<Record<string, unknown>>>()
const SERIES_CACHE_TTL = 30 * 60 * 1000

export interface TvdbCardMetadata {
  title: string
  year?: number
  overview?: string
  poster?: string
  backdrop?: string
  genres?: string[]
}

async function getToken(): Promise<string> {
  const apiKey = getTvdbApiKey()
  if (cachedToken && cachedTokenApiKey === apiKey) return cachedToken
  cachedToken = null
  if (tokenPromise) return tokenPromise
  tokenPromise = coordinatedJson<{ data: { token: string } }>(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: apiKey }),
    }, {
      label: 'TVDB',
      kind: 'metadata',
      dedupeKey: 'auth',
      priority: 'interactive',
      timeoutMs: 12_000,
      retry: 'interactive-once',
    })
    .then((data) => {
      cachedToken = data.data.token
      cachedTokenApiKey = apiKey
      return cachedToken
    })
    .finally(() => { tokenPromise = null })
  return tokenPromise
}

async function tvdbFetch(
  path: string,
  params: Record<string, string> = {},
  request: { priority?: RequestPriority; cancelGroup?: string } = {},
): Promise<unknown> {
  const token = await getToken()
  const url = new URL(`${BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  try {
    return await coordinatedJson<unknown>(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'eng' },
    }, {
      label: 'TVDB',
      kind: 'metadata',
      dedupeKey: `${path}:${new URLSearchParams(params).toString()}`,
      priority: request.priority || 'visible',
      cancelGroup: request.cancelGroup,
      timeoutMs: 12_000,
      retry: request.priority === 'background' ? 'none' : 'interactive-once',
    })
  } catch (error) {
    if (error instanceof Error && /HTTP 401/.test(error.message)) {
      cachedToken = null
      cachedTokenApiKey = ''
    }
    throw error
  }
}

async function getSeriesExtended(tvdbId: string): Promise<Record<string, unknown>> {
  const cached = seriesDataCache.get(tvdbId)
  if (cached && Date.now() - cached.timestamp < SERIES_CACHE_TTL) {
    return cached.data
  }
  const pending = seriesDataPending.get(tvdbId)
  if (pending) return pending
  const request = (async () => {
    const data = await tvdbFetch(`/series/${tvdbId}/extended`) as Record<string, unknown>
    const series = data.data as Record<string, unknown>
    seriesDataCache.set(tvdbId, { data: series, timestamp: Date.now() })
    return series
  })().finally(() => seriesDataPending.delete(tvdbId))
  seriesDataPending.set(tvdbId, request)
  return request
}

async function getMovieExtended(tvdbId: string): Promise<Record<string, unknown>> {
  const cleanId = tvdbId.replace('movie-', '')
  const cached = movieDataCache.get(cleanId)
  if (cached && Date.now() - cached.timestamp < SERIES_CACHE_TTL) {
    return cached.data
  }
  const pending = movieDataPending.get(cleanId)
  if (pending) return pending
  const request = (async () => {
    const data = await tvdbFetch(`/movies/${cleanId}/extended`) as Record<string, unknown>
    const movie = data.data as Record<string, unknown>
    movieDataCache.set(cleanId, { data: movie, timestamp: Date.now() })
    return movie
  })().finally(() => movieDataPending.delete(cleanId))
  movieDataPending.set(cleanId, request)
  return request
}

async function getSeasonEpisodes(seasonTvdbId: number, priority: RequestPriority): Promise<Record<string, unknown>[]> {
  const data = await tvdbFetch(`/seasons/${seasonTvdbId}/extended`, {}, { priority }) as Record<string, unknown>
  const season = data.data as Record<string, unknown>
  return (season.episodes as Record<string, unknown>[]) || []
}

function getOfficialSeasons(series: Record<string, unknown>): Record<string, unknown>[] {
  return ((series.seasons as Record<string, unknown>[]) || [])
    .filter((s) => (s.type as Record<string, unknown>)?.type === 'official')
}

export async function getTvdbSeason(
  showId: string,
  season: number,
  priority: RequestPriority = 'visible',
): Promise<SeasonDetails> {
  const tvdbId = showId.replace('tvdb-', '')
  const cacheVariant = priority === 'background' ? 'raw-v2' : 'english-v2'

  return cachedFetch<SeasonDetails>(`tvdb_season:${cacheVariant}:${tvdbId}:${season}`, async () => {
    const series = await getSeriesExtended(tvdbId)
    const officialSeasons = getOfficialSeasons(series)
    const targetSeason = officialSeasons.find((s) => (s.number as number) === season)
    if (!targetSeason) throw new Error(`TVDB season ${season} not found for series ${tvdbId}`)

    const seasonTvdbId = Number(targetSeason.id)
    const episodes = await getSeasonEpisodes(seasonTvdbId, priority)
    const hasJapaneseText = (value: unknown) => typeof value === 'string' && /[぀-ヿ㐀-鿿]/.test(value)
    // Interactive requests are the selected season and need complete English
    // metadata. Only true background warming may skip translation requests.
    const localizedEpisodes = priority !== 'background'
      ? await Promise.all(episodes.map(async (episode) => {
        if (!hasJapaneseText(episode.name) && !hasJapaneseText(episode.overview)) return episode
        const episodeId = Number(episode.id)
        if (!episodeId) return episode
        const translation = await tvdbFetch(`/episodes/${episodeId}/translations/eng`).catch(() => null) as Record<string, unknown> | null
        const english = translation?.data as Record<string, unknown> | undefined
        return english ? { ...episode, name: english.name || episode.name, overview: english.overview || episode.overview } : episode
      }))
      : episodes

    return {
      seasonNumber: season,
      name: (targetSeason.name as string) || `Season ${season}`,
      episodes: localizedEpisodes
        .filter((e) => {
          const origSeason = typeof e.seasonNumber === 'number' ? e.seasonNumber : undefined
          if (origSeason != null && origSeason !== season) {
            console.log('[tvdb.getSeason] Filtering cross-season ep:', {
              id: e.id, name: e.name, origSeason, requestedSeason: season,
            })
            return false
          }
          return true
        })
        .map((e) => ({
          id: String(e.id),
          episodeNumber: Number(e.number ?? e.airedEpisodeNumber),
          seasonNumber: season,
          name: e.name as string,
          overview: e.overview as string,
          airDate: e.aired as string,
          runtime: e.runtime as number,
          still: e.image as string | undefined,
          rating: undefined,
          voteCount: undefined,
          debugSource: 'tvdb',
          debugResolverStep: 'tvdbProvider.getSeason',
          debugOriginalSeasonNumber: typeof e.seasonNumber === 'number' ? e.seasonNumber : undefined,
          debugOriginalEpisodeNumber: typeof (e.number ?? e.airedEpisodeNumber) === 'number' ? (e.number ?? e.airedEpisodeNumber) as number : undefined,
          debugOriginalAbsoluteNumber: typeof e.absoluteNumber === 'number' ? e.absoluteNumber : undefined,
        }))
        .sort((a, b) => a.episodeNumber - b.episodeNumber),
    }
  }, { category: CACHE_CATEGORIES.TVDB_SEASON, ttlSeconds: CACHE_TTLS.TVDB_SEASON })
}

export const tvdbProvider: MetadataProvider = {
  id: 'tvdb',
  name: 'TVDB',

  async search(query: string, _type?: 'movie' | 'series', context?: { cancelGroup?: string }): Promise<SearchResult[]> {
    const data = await tvdbFetch('/search', { query, type: 'series' }, { priority: 'interactive', cancelGroup: context?.cancelGroup }) as Record<string, unknown>
    const results = (data.data as Record<string, unknown>[]) || []
    return results.map((r) => ({
      id: `tvdb-${r.tvdb_id || r.id}`,
      title: r.name as string,
      type: 'series' as const,
      year: (r.first_air_time as string)?.slice(0, 4) ? parseInt((r.first_air_time as string).slice(0, 4)) : undefined,
      poster: r.image_url as string | undefined,
      overview: r.overview as string,
      provider: 'tvdb',
    }))
  },

  async getMovie(id: string): Promise<MovieDetails> {
    const tvdbId = id.replace('tvdb-', '')
    const movie = await getMovieExtended(tvdbId)

    const artworks = (movie.artworks as Record<string, unknown>[]) || []
    const isLandscape = (art: Record<string, unknown>) => {
      const width = Number(art.width || art.thumbnailWidth || 0)
      const height = Number(art.height || art.thumbnailHeight || 0)
      return width > 0 && height > 0 && width / height >= 1.35
    }
    const backdropArt = artworks.find((a) => (a.type === 3 || a.type === 'background') && isLandscape(a))
      || artworks.find(isLandscape)
    const logoArt = artworks.find((a) => {
      const type = String(a.type || a.artworkType || '').toLowerCase()
      return type === '5' || type === '6' || type.includes('logo') || type.includes('clearlogo')
    })
    const backdrop = backdropArt?.image as string | undefined
    const logo = logoArt?.image as string | undefined

    return {
      id,
      title: movie.name as string,
      originalTitle: movie.name as string,
      year: movie.year ? parseInt(movie.year as string) : undefined,
      releaseDate: undefined,
      overview: movie.overview as string,
      tagline: undefined,
      runtime: movie.runtime as number,
      rating: undefined,
      voteCount: undefined,
      genres: ((movie.genres as Record<string, unknown>[]) || []).map((g) => g.name as string),
      poster: movie.image as string | undefined,
      backdrop,
      logo,
      certification: undefined,
      cast: [],
      crew: [],
      recommendations: [],
      trailers: [],
      imdbId: undefined,
      tmdbId: undefined,
      provider: 'tvdb',
    }
  },

  async getShow(id: string): Promise<ShowDetails> {
    const tvdbId = id.replace('tvdb-', '')
    const series = await getSeriesExtended(tvdbId)

    const officialSeasons = getOfficialSeasons(series)
    const currentYear = new Date().getFullYear()
    const hasJapanese = (value: unknown) => typeof value === 'string' && /[぀-ヿ㐀-鿿]/.test(value)
    const seasonRecords = officialSeasons
      .filter((s) => {
        const year = s.year as number | undefined
        if (!year) return true
        return year <= currentYear + 1
      })
    const seasons = await Promise.all(seasonRecords.map(async (s) => {
      let name = s.name as string || `Season ${s.number}`
      if (hasJapanese(name)) {
        const seasonId = Number(s.id)
        if (seasonId) {
          const translation = await tvdbFetch(`/seasons/${seasonId}/translations/eng`).catch(() => null) as Record<string, unknown> | null
          const english = translation?.data as Record<string, unknown> | undefined
          if (english?.name && typeof english.name === 'string') name = english.name
        }
      }
      return {
        seasonNumber: s.number as number,
        name,
        episodeCount: 0,
        poster: s.image as string | undefined,
        airDate: s.year ? `${s.year}-01-01` : undefined,
      }
    }))

    const genres = ((series.genres as Record<string, unknown>[]) || []).map((g) => g.name as string)

    const characters = (series.characters as Record<string, unknown>[]) || []
    const cast = characters
      .filter((c) => c.type === 3 || c.peopleType === 'Actor' || (c.personName && c.name))
      .slice(0, 20)
      .map((c) => ({
        id: String(c.peopleId || c.id || ''),
        personProvider: 'tvdb' as const,
        name: (c.personName || c.name) as string,
        character: (c.name || c.personName) as string,
        profilePath: (c.personImgURL || c.image) as string | undefined,
      }))

    const artworks = (series.artworks as Record<string, unknown>[]) || []
    const isLandscape = (art: Record<string, unknown>) => {
      const width = Number(art.width || art.thumbnailWidth || 0)
      const height = Number(art.height || art.thumbnailHeight || 0)
      return width > 0 && height > 0 && width / height >= 1.35
    }
    const backdropArt = artworks.find((a) => (a.type === 3 || a.type === 'background') && isLandscape(a))
      || artworks.find(isLandscape)
    const logoArt = artworks.find((a) => {
      const type = String(a.type || a.artworkType || '').toLowerCase()
      return type === '5' || type === '6' || type.includes('logo') || type.includes('clearlogo')
    })
    const backdrop = backdropArt?.image as string | undefined
    const logo = logoArt?.image as string | undefined

    let seriesTitle = series.name as string
    let seriesOverview = series.overview as string
    if (hasJapanese(seriesTitle) || hasJapanese(seriesOverview)) {
      const translation = await tvdbFetch(`/series/${tvdbId}/translations/eng`).catch(() => null) as Record<string, unknown> | null
      const english = translation?.data as Record<string, unknown> | undefined
      if (english?.name && typeof english.name === 'string') seriesTitle = english.name
      if (english?.overview && typeof english.overview === 'string') seriesOverview = english.overview
    }

    return {
      id,
      title: seriesTitle,
      originalTitle: seriesTitle !== (series.name as string) ? (series.name as string) : undefined,
      year: (series.firstAired as string)?.slice(0, 4) ? parseInt((series.firstAired as string).slice(0, 4)) : undefined,
      firstAirDate: series.firstAired as string,
      overview: seriesOverview,
      rating: undefined,
      voteCount: undefined,
      genres,
      poster: series.image as string | undefined,
      backdrop,
      logo,
      certification: undefined,
      status: series.status?.toString(),
      numberOfSeasons: seasons.length,
      seasons,
      cast,
      crew: [],
      recommendations: [],
      trailers: [],
      provider: 'tvdb',
    }
  },

  async getSeason(showId: string, season: number, priority: RequestPriority = 'visible'): Promise<SeasonDetails> {
    return getTvdbSeason(showId, season, priority)
  },

  async getEpisode(showId: string, season: number, episode: number): Promise<EpisodeDetails> {
    const seasonData = await this.getSeason(showId, season)
    const ep = seasonData.episodes.find((e) => e.episodeNumber === episode)
    if (!ep) throw new Error('Episode not found')
    return ep
  },
}

export async function getTvdbBanner(tvdbId: string | number): Promise<string | undefined> {
  const id = String(tvdbId).replace('tvdb-', '')
  if (!id) return undefined

  const result = await cachedFetch<string | null>(`tvdb_banner:${id}`, async () => {
    try {
      const series = await getSeriesExtended(id)
      const artworks = (series.artworks as Record<string, unknown>[]) || []
      const banners = artworks.filter((a) => {
        const typeVal = typeof a.type === 'object' && a.type !== null ? (a.type as Record<string, unknown>).id : a.type
        return Number(typeVal) === 1 && typeof a.image === 'string'
      })
      return (banners[0]?.image as string) || null
    } catch (_) {
      return null
    }
  }, { category: CACHE_CATEGORIES.ARTWORK, ttlSeconds: CACHE_TTLS.ARTWORK })
  return result ?? undefined
}

export async function getTvdbCardMetadata(tvdbId: string | number): Promise<TvdbCardMetadata | null> {
  const id = String(tvdbId).replace('tvdb-', '')
  if (!id) return null

  try {
    return await cachedFetch<TvdbCardMetadata>(`tvdb_card:${id}`, async () => {
      const show = await tvdbProvider.getShow(`tvdb-${id}`)
      return {
        title: show.title,
        year: show.year,
        overview: show.overview,
        poster: show.poster,
        backdrop: show.backdrop,
        genres: show.genres,
      }
    }, { category: CACHE_CATEGORIES.TVDB_CARD, ttlSeconds: CACHE_TTLS.TVDB_CARD })
  } catch (_) {
    return null
  }
}

export async function getTvdbIdByRemoteId(remoteId: string): Promise<number | string | undefined> {
  const result = await cachedFetch<string | number | null>(`tvdb_remote_id:${remoteId}`, async () => {
    try {
      const data = await tvdbFetch(`/search/remoteid/${remoteId}`) as Record<string, unknown>
      const results = (data.data as Record<string, unknown>[]) || []
      if (results.length === 0) return null
      const match = results[0]
      const idVal = match.tvdb_id || match.id
      if (match.type === 'movie') {
        return `movie-${idVal}`
      }
      return Number(idVal) || null
    } catch (_) {
      return null
    }
  }, { category: CACHE_CATEGORIES.ARTWORK, ttlSeconds: CACHE_TTLS.ARTWORK })
  return result ?? undefined
}
