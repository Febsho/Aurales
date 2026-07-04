import type { MetadataProvider, SearchResult, MovieDetails, ShowDetails, SeasonDetails, EpisodeDetails, CastMember, Video, DiscoverConfig } from '../types'
import { getTmdbApiKey } from './apiKeys'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'

const BASE_URL = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p'

async function tmdbFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const apiKey = getTmdbApiKey()
  const url = new URL(`${BASE_URL}${path}`)
  url.searchParams.set('api_key', apiKey)
  if (!('language' in params)) url.searchParams.set('language', 'en-US')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`TMDB error: ${res.status}`)
  return res.json()
}

export async function getTvdbIdFromTmdb(tmdbId: string | number): Promise<number | undefined> {
  if (!tmdbId || typeof tmdbId === 'object' || String(tmdbId).trim() === '[object Object]') return undefined
  const id = String(tmdbId).replace('tmdb-', '')
  if (!id) return undefined

  const result = await cachedFetch<number | null>(`tmdb_tvdb_id:${id}`, async () => {
    try {
      const data = await tmdbFetch(`/tv/${id}/external_ids`) as Record<string, unknown>
      return Number(data.tvdb_id) || null
    } catch (_) {
      return null
    }
  }, { category: CACHE_CATEGORIES.TMDB_TVDB_ID, ttlSeconds: CACHE_TTLS.TMDB_TVDB_ID })
  return result ?? undefined
}

function pickBestBackdrop(images: Record<string, unknown>): string | undefined {
  const backdrops = ((images.backdrops as Record<string, unknown>[]) || [])
    .filter((image) => typeof image.file_path === 'string')
    .sort((a, b) => {
      const aVotes = Number(a.vote_count || 0)
      const bVotes = Number(b.vote_count || 0)
      if (aVotes !== bVotes) return bVotes - aVotes
      return Number(b.vote_average || 0) - Number(a.vote_average || 0)
    })
  const selected = backdrops[0]
  return selected ? `${IMG_BASE}/original${selected.file_path}` : undefined
}

function pickBestPoster(images: Record<string, unknown>, defaultPosterPath?: string): string | undefined {
  const posters = ((images.posters as Record<string, unknown>[]) || [])
    .filter((image) => typeof image.file_path === 'string')
    .sort((a, b) => {
      const aVotes = Number(a.vote_count || 0)
      const bVotes = Number(b.vote_count || 0)
      if (aVotes !== bVotes) return bVotes - aVotes
      return Number(b.vote_average || 0) - Number(a.vote_average || 0)
    })
  const selected = posters[0]
  if (selected) return `${IMG_BASE}/w780${selected.file_path}`
  return defaultPosterPath ? `${IMG_BASE}/w780${defaultPosterPath}` : undefined
}

export async function getTmdbLandscapeBackdrop(type: 'movie' | 'series' | 'show' | 'anime', tmdbId: string | number): Promise<string | undefined> {
  if (!tmdbId || typeof tmdbId === 'object' || String(tmdbId).trim() === '[object Object]') return undefined
  const mediaType = type === 'movie' ? 'movie' : 'tv'
  const id = String(tmdbId).replace('tmdb-', '')
  if (!id) return undefined

  const result = await cachedFetch<string | null>(`tmdb_backdrop_v2:${mediaType}:${id}`, async () => {
    try {
      const images = await tmdbFetch(`/${mediaType}/${id}/images`, { include_image_language: 'en,ja,xx,null' }) as Record<string, unknown>
      return pickBestBackdrop(images) || null
    } catch (_) {
      return null
    }
  }, { category: CACHE_CATEGORIES.ARTWORK, ttlSeconds: CACHE_TTLS.ARTWORK })
  return result ?? undefined
}

export async function getTmdbCardMetadata(
  type: 'movie' | 'series' | 'show' | 'anime',
  tmdbId: string | number,
): Promise<{ poster?: string; backdrop?: string; logo?: string; genre?: string }> {
  if (!tmdbId || typeof tmdbId === 'object' || String(tmdbId).trim() === '[object Object]') return {}
  const mediaType = type === 'movie' ? 'movie' : 'tv'
  const id = String(tmdbId).replace('tmdb-', '')
  if (!id) return {}

  return cachedFetch<{ poster?: string; backdrop?: string; logo?: string; genre?: string }>(`tmdb_card_v2:${mediaType}:${id}`, async () => {
    const [details, images] = await Promise.all([
      tmdbFetch(`/${mediaType}/${id}`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/${mediaType}/${id}/images`, { include_image_language: 'en,ja,xx,null' }) as Promise<Record<string, unknown>>,
    ])
    const genres = Array.isArray(details.genres) ? details.genres as Array<Record<string, unknown>> : []
    const logos = (images.logos as Record<string, unknown>[]) || []
    const enLogo = logos.find((logo) => logo.iso_639_1 === 'en') || logos.find((logo) => logo.iso_639_1 === null) || logos[0]
    return {
      poster: pickBestPoster(images, details.poster_path as string),
      backdrop: pickBestBackdrop(images) || (details.backdrop_path ? `${IMG_BASE}/original${details.backdrop_path}` : undefined),
      logo: enLogo ? `${IMG_BASE}/w500${enLogo.file_path as string}` : undefined,
      genre: typeof genres[0]?.name === 'string' ? genres[0].name : undefined,
    }
  }, { category: CACHE_CATEGORIES.TMDB_CARD, ttlSeconds: CACHE_TTLS.TMDB_CARD })
}

export async function getTmdbHeroCast(
  type: 'movie' | 'series' | 'show' | 'anime',
  tmdbId: string | number,
): Promise<{ name: string; photo?: string }[]> {
  if (!tmdbId || typeof tmdbId === 'object' || String(tmdbId).trim() === '[object Object]') return []
  const mediaType = type === 'movie' ? 'movie' : 'tv'
  const id = String(tmdbId).replace('tmdb-', '')
  if (!id) return []

  return cachedFetch<{ name: string; photo?: string }[]>(`tmdb_hero_cast:${mediaType}:${id}`, async () => {
    const credits = await tmdbFetch(`/${mediaType}/${id}/credits`) as Record<string, unknown>
    return ((credits.cast as Record<string, unknown>[]) || []).slice(0, 3).map((c) => ({
      name: c.name as string,
      photo: c.profile_path ? `${IMG_BASE}/w185${c.profile_path}` : undefined,
    }))
  }, { category: CACHE_CATEGORIES.TMDB_CARD, ttlSeconds: CACHE_TTLS.TMDB_CARD })
}

function mapSearchResult(item: Record<string, unknown>, type: 'movie' | 'series'): SearchResult {
  return {
    id: `tmdb-${item.id}`,
    title: (item.title || item.name) as string,
    type,
    year: ((item.release_date || item.first_air_date) as string)?.slice(0, 4) ? parseInt(((item.release_date || item.first_air_date) as string).slice(0, 4)) : undefined,
    poster: item.poster_path ? `${IMG_BASE}/w342${item.poster_path}` : undefined,
    backdrop: item.backdrop_path ? `${IMG_BASE}/original${item.backdrop_path}` : undefined,
    overview: item.overview as string,
    rating: item.vote_average as number,
    provider: 'tmdb',
    tmdbId: item.id as string | number,
    genreIds: Array.isArray(item.genre_ids) ? item.genre_ids as number[] : undefined,
  }
}

export const tmdbProvider: MetadataProvider = {
  id: 'tmdb',
  name: 'TMDB',

  async search(query: string): Promise<SearchResult[]> {
    const params = { query, include_adult: 'false' }
    const [movies, shows] = await Promise.all([
      tmdbFetch('/search/movie', params) as Promise<Record<string, unknown>>,
      tmdbFetch('/search/tv', params) as Promise<Record<string, unknown>>,
    ])
    return [
      ...(((movies.results as Record<string, unknown>[]) || []).map((item) => mapSearchResult(item, 'movie'))),
      ...(((shows.results as Record<string, unknown>[]) || []).map((item) => mapSearchResult(item, 'series'))),
    ]
  },

  async recommendationsForText(query: string, type: 'movie' | 'series'): Promise<SearchResult[]> {
    const data = await tmdbFetch('/search/multi', { query }) as Record<string, unknown>
    const results = (data.results as Record<string, unknown>[]) || []
    return results
      .filter((r) => type === 'movie' ? r.media_type === 'movie' : r.media_type === 'tv')
      .slice(0, 12)
      .map((r) => mapSearchResult(r, type))
  },

  async getMovie(id: string): Promise<MovieDetails> {
    const tmdbId = id.replace('tmdb-', '')
    const [details, credits, videos, recs, images] = await Promise.all([
      tmdbFetch(`/movie/${tmdbId}`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/credits`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/videos`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/recommendations`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/images`, { include_image_language: 'en,ja,xx,null' }) as Promise<Record<string, unknown>>,
    ])

    const cast = ((credits.cast as Record<string, unknown>[]) || []).slice(0, 20).map((c): CastMember => ({
      id: String(c.id),
      name: c.name as string,
      character: c.character as string,
      profilePath: c.profile_path ? `${IMG_BASE}/w185${c.profile_path}` : undefined,
    }))

    const crew = ((credits.crew as Record<string, unknown>[]) || [])
      .filter((c) => ['Director', 'Writer', 'Screenplay', 'Original Music Composer'].includes(c.job as string))
      .map((c) => ({
        id: String(c.id),
        name: c.name as string,
        job: c.job as string,
        department: c.department as string,
        profilePath: c.profile_path ? `${IMG_BASE}/w185${c.profile_path}` : undefined,
      }))

    const trailers = ((videos.results as Record<string, unknown>[]) || [])
      .filter((v) => v.site === 'YouTube')
      .map((v): Video => ({
        id: v.id as string,
        name: v.name as string,
        key: v.key as string,
        site: v.site as string,
        type: v.type as string,
        thumbnail: `https://img.youtube.com/vi/${v.key}/hqdefault.jpg`,
      }))

    const logos = (images.logos as Record<string, unknown>[]) || []
    const enLogo = logos.find((l) => l.iso_639_1 === 'en') || logos[0]
    const bestBackdrop = pickBestBackdrop(images)

    const genres = ((details.genres as Record<string, unknown>[]) || []).map((g) => g.name as string)
    const recResults = ((recs.results as Record<string, unknown>[]) || []).slice(0, 10).map((r) => mapSearchResult(r, 'movie'))

    return {
      id,
      title: details.title as string,
      originalTitle: details.original_title as string,
      year: (details.release_date as string)?.slice(0, 4) ? parseInt((details.release_date as string).slice(0, 4)) : undefined,
      releaseDate: details.release_date as string,
      overview: details.overview as string,
      tagline: details.tagline as string,
      runtime: details.runtime as number,
      rating: details.vote_average as number,
      voteCount: details.vote_count as number,
      genres,
      poster: pickBestPoster(images, details.poster_path as string),
      backdrop: bestBackdrop || (details.backdrop_path ? `${IMG_BASE}/original${details.backdrop_path}` : undefined),
      logo: enLogo ? `${IMG_BASE}/w300${(enLogo as Record<string, unknown>).file_path}` : undefined,
      certification: undefined,
      cast,
      crew,
      recommendations: recResults,
      trailers,
      imdbId: details.imdb_id as string,
      tmdbId,
      provider: 'tmdb',
    }
  },

  async getShow(id: string): Promise<ShowDetails> {
    const tmdbId = id.replace('tmdb-', '')
    const [details, credits, videos, recs, images, externalIds] = await Promise.all([
      tmdbFetch(`/tv/${tmdbId}`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/credits`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/videos`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/recommendations`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/images`, { include_image_language: 'en,ja,xx,null' }) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/external_ids`) as Promise<Record<string, unknown>>,
    ])

    const cast = ((credits.cast as Record<string, unknown>[]) || []).slice(0, 20).map((c): CastMember => ({
      id: String(c.id),
      name: c.name as string,
      character: c.character as string,
      profilePath: c.profile_path ? `${IMG_BASE}/w185${c.profile_path}` : undefined,
    }))

    const trailers = ((videos.results as Record<string, unknown>[]) || [])
      .filter((v) => v.site === 'YouTube')
      .map((v): Video => ({
        id: v.id as string,
        name: v.name as string,
        key: v.key as string,
        site: v.site as string,
        type: v.type as string,
        thumbnail: `https://img.youtube.com/vi/${v.key}/hqdefault.jpg`,
      }))

    const logos = (images.logos as Record<string, unknown>[]) || []
    const enLogo = logos.find((l) => l.iso_639_1 === 'en') || logos[0]
    const bestBackdrop = pickBestBackdrop(images)

    const seasons = ((details.seasons as Record<string, unknown>[]) || [])
      .filter((s) => (s.season_number as number) > 0)
      .map((s) => ({
        seasonNumber: s.season_number as number,
        name: s.name as string,
        episodeCount: s.episode_count as number,
        poster: s.poster_path ? `${IMG_BASE}/w342${s.poster_path}` : undefined,
        airDate: s.air_date as string,
      }))

    const genres = ((details.genres as Record<string, unknown>[]) || []).map((g) => g.name as string)
    const recResults = ((recs.results as Record<string, unknown>[]) || []).slice(0, 10).map((r) => mapSearchResult(r, 'series'))

    return {
      id,
      title: details.name as string,
      originalTitle: details.original_name as string,
      year: (details.first_air_date as string)?.slice(0, 4) ? parseInt((details.first_air_date as string).slice(0, 4)) : undefined,
      firstAirDate: details.first_air_date as string,
      overview: details.overview as string,
      tagline: details.tagline as string,
      rating: details.vote_average as number,
      voteCount: details.vote_count as number,
      genres,
      poster: pickBestPoster(images, details.poster_path as string),
      backdrop: bestBackdrop || (details.backdrop_path ? `${IMG_BASE}/original${details.backdrop_path}` : undefined),
      logo: enLogo ? `${IMG_BASE}/w300${(enLogo as Record<string, unknown>).file_path}` : undefined,
      certification: undefined,
      status: details.status as string,
      numberOfSeasons: details.number_of_seasons as number,
      numberOfEpisodes: details.number_of_episodes as number,
      seasons,
      cast,
      crew: [],
      recommendations: recResults,
      trailers,
      imdbId: externalIds.imdb_id as string,
      tvdbId: externalIds.tvdb_id ? Number(externalIds.tvdb_id) : undefined,
      tmdbId,
      provider: 'tmdb',
    }
  },

  async getSeason(showId: string, season: number): Promise<SeasonDetails> {
    const tmdbId = showId.replace('tmdb-', '')

    return cachedFetch<SeasonDetails>(`tmdb_season:${tmdbId}:${season}`, async () => {
      const data = await tmdbFetch(`/tv/${tmdbId}/season/${season}`) as Record<string, unknown>
      const episodes = ((data.episodes as Record<string, unknown>[]) || []).map((e) => ({
        id: String(e.id),
        episodeNumber: e.episode_number as number,
        seasonNumber: e.season_number as number,
        name: e.name as string,
        overview: e.overview as string,
        airDate: e.air_date as string,
        runtime: e.runtime as number,
        still: e.still_path ? `${IMG_BASE}/w780${e.still_path}` : undefined,
        rating: e.vote_average as number,
        voteCount: e.vote_count as number,
      }))

      return {
        seasonNumber: data.season_number as number,
        name: data.name as string,
        overview: data.overview as string,
        poster: (data.poster_path as string) ? `${IMG_BASE}/w342${data.poster_path}` : undefined,
        episodes,
      }
    }, { category: CACHE_CATEGORIES.TVDB_SEASON, ttlSeconds: CACHE_TTLS.TVDB_SEASON })
  },

  async getEpisode(showId: string, season: number, episode: number): Promise<EpisodeDetails> {
    const tmdbId = showId.replace('tmdb-', '')
    const data = await tmdbFetch(`/tv/${tmdbId}/season/${season}/episode/${episode}`) as Record<string, unknown>
    return {
      id: String(data.id),
      episodeNumber: data.episode_number as number,
      seasonNumber: data.season_number as number,
      name: data.name as string,
      overview: data.overview as string,
      airDate: data.air_date as string,
      runtime: data.runtime as number,
      still: data.still_path ? `${IMG_BASE}/w780${data.still_path}` : undefined,
      rating: data.vote_average as number,
      voteCount: data.vote_count as number,
    }
  },
}

// ─── Discover Catalog APIs ───────────────────────────────────────────────────

export async function getTmdbGenres(type: 'movie' | 'tv'): Promise<{ id: number; name: string }[]> {
  try {
    const data = await tmdbFetch(`/genre/${type}/list`) as { genres: { id: number; name: string }[] }
    return data.genres || []
  } catch (_) {
    return []
  }
}

export async function getTmdbLanguages(): Promise<{ iso_639_1: string; english_name: string }[]> {
  try {
    const data = await tmdbFetch('/configuration/languages') as { iso_639_1: string; english_name: string }[]
    return (data || []).sort((a, b) => a.english_name.localeCompare(b.english_name))
  } catch (_) {
    return []
  }
}

export async function getTmdbCountries(): Promise<{ iso_3166_1: string; english_name: string }[]> {
  try {
    const data = await tmdbFetch('/configuration/countries') as { iso_3166_1: string; english_name: string }[]
    return (data || []).sort((a, b) => a.english_name.localeCompare(b.english_name))
  } catch (_) {
    return []
  }
}

export interface TmdbWatchProvider {
  provider_id: number
  provider_name: string
  logo_path: string
  display_priority: number
}

export async function getTmdbWatchProviders(type: 'movie' | 'tv', region: string = 'US'): Promise<TmdbWatchProvider[]> {
  try {
    const data = await tmdbFetch(`/watch/providers/${type === 'movie' ? 'movie' : 'tv'}`, {
      watch_region: region,
    }) as { results: TmdbWatchProvider[] }
    return data.results || []
  } catch (_) {
    return []
  }
}

export async function searchTmdbPeople(query: string): Promise<{ id: number; name: string; profile_path?: string }[]> {
  if (!query.trim()) return []
  try {
    const data = await tmdbFetch('/search/person', { query }) as { results: { id: number; name: string; profile_path?: string }[] }
    return data.results || []
  } catch (_) {
    return []
  }
}

export interface TmdbPersonCredit extends SearchResult {
  character?: string
  job?: string
  releaseDate?: string
  mediaType: 'movie' | 'tv'
  creditTypes: ('acting' | 'directing' | 'voice')[]
}

export interface TmdbPersonDetails {
  id: number
  name: string
  biography?: string
  birthday?: string
  deathday?: string
  placeOfBirth?: string
  profile?: string
  knownForDepartment?: string
  homepage?: string
  imdbId?: string
  credits: TmdbPersonCredit[]
}

function creditDate(item: Record<string, unknown>): string | undefined {
  const raw = (item.release_date || item.first_air_date) as string | undefined
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}

function mapPersonCredit(item: Record<string, unknown>, creditType: 'acting' | 'directing' | 'voice'): TmdbPersonCredit | null {
  const mediaType = item.media_type
  if (mediaType !== 'movie' && mediaType !== 'tv') return null
  const title = (mediaType === 'movie' ? item.title : item.name) as string | undefined
  const id = Number(item.id)
  if (!title || !Number.isFinite(id)) return null

  const date = creditDate(item)
  return {
    id: `tmdb-${id}`,
    title,
    type: mediaType === 'movie' ? 'movie' : 'series',
    year: date ? Number(date.slice(0, 4)) : undefined,
    poster: item.poster_path ? `${IMG_BASE}/w342${item.poster_path}` : undefined,
    backdrop: item.backdrop_path ? `${IMG_BASE}/original${item.backdrop_path}` : undefined,
    overview: item.overview as string | undefined,
    rating: item.vote_average as number | undefined,
    provider: 'tmdb',
    tmdbId: id,
    genreIds: Array.isArray(item.genre_ids) ? item.genre_ids as number[] : undefined,
    character: creditType === 'acting' || creditType === 'voice' ? item.character as string | undefined : undefined,
    job: creditType === 'directing' ? item.job as string | undefined : undefined,
    releaseDate: date,
    mediaType,
    creditTypes: [creditType],
  }
}

export async function getTmdbPerson(personId: string | number): Promise<TmdbPersonDetails> {
  const id = String(personId).replace('tmdb-', '')
  return cachedFetch<TmdbPersonDetails>(`tmdb_person:${id}`, async () => {
    const data = await tmdbFetch(`/person/${id}`, {
      append_to_response: 'combined_credits,external_ids',
    }) as Record<string, unknown>

    const combinedCredits = (data.combined_credits as Record<string, unknown> | undefined) ?? {}
    const rawCredits = ((combinedCredits.cast as Record<string, unknown>[]) || []).map((credit) => {
      const char = (credit.character as string | undefined) ?? ''
      const isVoice = /\(voice\)/i.test(char)
      return { raw: credit, type: isVoice ? 'voice' as const : 'acting' as const }
    })
    const rawDirectorCredits = ((combinedCredits.crew as Record<string, unknown>[]) || [])
      .filter((credit) => credit.job === 'Director')
      .map((credit) => ({ raw: credit, type: 'directing' as const }))
    const seen = new Map<string, TmdbPersonCredit>()
    for (const { raw, type } of [...rawCredits, ...rawDirectorCredits]) {
      const credit = mapPersonCredit(raw, type)
      if (!credit) continue
      const key = `${credit.mediaType}:${credit.tmdbId}`
      const existing = seen.get(key)
      if (existing) {
        const roles = [existing.character, credit.character].filter(Boolean) as string[]
        const jobs = [existing.job, credit.job].filter(Boolean) as string[]
        seen.set(key, {
          ...existing,
          character: [...new Set(roles)].join(', ') || undefined,
          job: [...new Set(jobs)].join(', ') || undefined,
          creditTypes: [...new Set([...existing.creditTypes, ...credit.creditTypes])],
        })
      } else {
        seen.set(key, credit)
      }
    }

    const credits = [...seen.values()].sort((a, b) => {
      const left = a.releaseDate ? Date.parse(a.releaseDate) : 0
      const right = b.releaseDate ? Date.parse(b.releaseDate) : 0
      if (left !== right) return right - left
      return (b.rating ?? 0) - (a.rating ?? 0)
    })

    const externalIds = (data.external_ids as Record<string, unknown> | undefined) ?? {}
    return {
      id: Number(data.id),
      name: data.name as string,
      biography: data.biography as string | undefined,
      birthday: data.birthday as string | undefined,
      deathday: data.deathday as string | undefined,
      placeOfBirth: data.place_of_birth as string | undefined,
      profile: data.profile_path ? `${IMG_BASE}/h632${data.profile_path}` : undefined,
      knownForDepartment: data.known_for_department as string | undefined,
      homepage: data.homepage as string | undefined,
      imdbId: externalIds.imdb_id as string | undefined,
      credits,
    }
  }, { category: CACHE_CATEGORIES.TMDB_CARD, ttlSeconds: CACHE_TTLS.TMDB_CARD })
}

export async function searchTmdbCompanies(query: string): Promise<{ id: number; name: string }[]> {
  if (!query.trim()) return []
  try {
    const data = await tmdbFetch('/search/company', { query }) as { results: { id: number; name: string }[] }
    return data.results || []
  } catch (_) {
    return []
  }
}

export async function searchTmdbKeywords(query: string): Promise<{ id: number; name: string }[]> {
  if (!query.trim()) return []
  try {
    const data = await tmdbFetch('/search/keyword', { query }) as { results: { id: number; name: string }[] }
    return data.results || []
  } catch (_) {
    return []
  }
}

export async function getTmdbCertifications(type: 'movie' | 'tv'): Promise<Record<string, { certification: string; order: number }[]>> {
  try {
    const data = await tmdbFetch(`/certification/${type === 'movie' ? 'movie' : 'tv'}/list`) as { certifications: Record<string, { certification: string; order: number }[]> }
    return data.certifications || {}
  } catch (_) {
    return {}
  }
}

export async function discoverTmdb(config: DiscoverConfig, page = 1): Promise<SearchResult[]> {
  const params: Record<string, string> = {
    page: String(page),
  }

  // Sort
  params.sort_by = config.sortBy

  // Include Adult
  params.include_adult = String(config.includeAdult)

  // Genres
  if (config.includeGenres.length > 0) {
    params.with_genres = config.includeGenres.join(config.genreMatchMode === 'AND' ? ',' : '|')
  }
  if (config.excludeGenres.length > 0) {
    params.without_genres = config.excludeGenres.join(',')
  }

  // Language & Country
  if (config.originalLanguage && config.originalLanguage !== 'Any') {
    params.with_original_language = config.originalLanguage
  }
  if (config.originCountry && config.originCountry !== 'Any') {
    params.with_origin_country = config.originCountry
  }

  // Release Region
  if (config.releaseRegion && config.releaseRegion !== 'Any' && config.contentType === 'movie') {
    params.region = config.releaseRegion
  }

  // Certifications
  if (config.certificationCountry && config.certificationCountry !== 'None') {
    params.certification_country = config.certificationCountry
    if (config.certification && config.certification !== 'None') {
      params.certification = config.certification
    }
  }

  // People
  if (config.people.length > 0) {
    params.with_people = config.people.map((p) => p.id).join(config.peopleMatchMode === 'AND' ? ',' : '|')
  }

  // Companies
  if (config.includeCompanies.length > 0) {
    params.with_companies = config.includeCompanies.map((c) => c.id).join(config.companyMatchMode === 'AND' ? ',' : '|')
  }
  if (config.excludeCompanies.length > 0) {
    params.without_companies = config.excludeCompanies.map((c) => c.id).join(',')
  }

  // Keywords
  if (config.includeKeywords.length > 0) {
    params.with_keywords = config.includeKeywords.map((k) => k.id).join(config.keywordMatchMode === 'AND' ? ',' : '|')
  }
  if (config.excludeKeywords.length > 0) {
    params.without_keywords = config.excludeKeywords.map((k) => k.id).join(',')
  }

  // Watch Region & Providers
  if (config.watchRegion) {
    params.watch_region = config.watchRegion
    if (config.selectedProviders.length > 0) {
      params.with_watch_providers = config.selectedProviders.map((p) => p.id).join(config.providerMatchMode === 'AND' ? ',' : '|')
    }
  }

  // Numeric ranges
  params['vote_average.gte'] = String(config.voteAverageMin)
  params['vote_average.lte'] = String(config.voteAverageMax)
  if (config.voteCountMin !== undefined && config.voteCountMin > 0) {
    params['vote_count.gte'] = String(config.voteCountMin)
  }
  if (config.runtimeMin !== undefined && config.runtimeMin > 0) {
    params['with_runtime.gte'] = String(config.runtimeMin)
  }
  if (config.runtimeMax !== undefined && config.runtimeMax > 0) {
    params['with_runtime.lte'] = String(config.runtimeMax)
  }

  // Dates
  const dateFromKey = config.contentType === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'
  const dateToKey = config.contentType === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte'

  if (config.releaseDateFrom) {
    params[dateFromKey] = config.releaseDateFrom
  }
  if (config.releaseDateTo) {
    params[dateToKey] = config.releaseDateTo
  }

  if (config.releasedOnly) {
    const today = new Date().toISOString().split('T')[0]
    if (params[dateToKey]) {
      if (params[dateToKey] > today) {
        params[dateToKey] = today
      }
    } else {
      params[dateToKey] = today
    }

    if (config.contentType === 'movie') {
      params.with_release_type = '2|3|4|5|6'
    }
  }

  params.language = 'en-US'

  const endpoint = config.contentType === 'movie' ? '/discover/movie' : '/discover/tv'

  const data = await tmdbFetch(endpoint, params) as { results: Record<string, unknown>[] }
  const results = data.results || []
  const items = results.map((r) => mapSearchResult(r, config.contentType === 'movie' ? 'movie' : 'series'))

  // If the source is TVDB, Simkl, or AniList, we keep the TMDB results (filters are TMDB-specific)
  // but we can label the item's provider.
  if (config.source !== 'TMDB') {
    return items.map(item => ({
      ...item,
      provider: config.source.toLowerCase()
    }))
  }

  return items
}

export async function discoverTmdbWithCache(config: DiscoverConfig, rowId?: string, forceRefresh = false): Promise<SearchResult[]> {
  const cacheKey = `discover:${rowId || JSON.stringify(config)}`
  const ttlSeconds = config.cacheTtl || CACHE_TTLS.DISCOVER

  if (forceRefresh) {
    return discoverTmdb(config)
  }

  return cachedFetch<SearchResult[]>(cacheKey, () => discoverTmdb(config), {
    category: CACHE_CATEGORIES.DISCOVER,
    ttlSeconds,
  })
}
