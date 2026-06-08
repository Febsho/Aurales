import type { MetadataProvider, SearchResult, MovieDetails, ShowDetails, SeasonDetails, EpisodeDetails, CastMember, Video } from '../types'

const BASE_URL = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p'

function getApiKey(): string {
  return localStorage.getItem('tmdb_api_key') || import.meta.env.VITE_TMDB_API_KEY || ''
}

async function tmdbFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('TMDB API key not configured')
  const url = new URL(`${BASE_URL}${path}`)
  url.searchParams.set('api_key', apiKey)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`TMDB error: ${res.status}`)
  return res.json()
}

function mapSearchResult(item: Record<string, unknown>, type: 'movie' | 'series'): SearchResult {
  return {
    id: `tmdb-${item.id}`,
    title: (item.title || item.name) as string,
    type,
    year: ((item.release_date || item.first_air_date) as string)?.slice(0, 4) ? parseInt(((item.release_date || item.first_air_date) as string).slice(0, 4)) : undefined,
    poster: item.poster_path ? `${IMG_BASE}/w342${item.poster_path}` : undefined,
    backdrop: item.backdrop_path ? `${IMG_BASE}/w780${item.backdrop_path}` : undefined,
    overview: item.overview as string,
    rating: item.vote_average as number,
    provider: 'tmdb',
  }
}

export const tmdbProvider: MetadataProvider = {
  id: 'tmdb',
  name: 'TMDB',

  async search(query: string): Promise<SearchResult[]> {
    const data = await tmdbFetch('/search/multi', { query }) as Record<string, unknown>
    const results = (data.results as Record<string, unknown>[]) || []
    return results
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .map((r) => mapSearchResult(r, r.media_type === 'movie' ? 'movie' : 'series'))
  },

  async getMovie(id: string): Promise<MovieDetails> {
    const tmdbId = id.replace('tmdb-', '')
    const [details, credits, videos, recs, images] = await Promise.all([
      tmdbFetch(`/movie/${tmdbId}`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/credits`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/videos`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/recommendations`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/movie/${tmdbId}/images`) as Promise<Record<string, unknown>>,
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
      poster: details.poster_path ? `${IMG_BASE}/w500${details.poster_path}` : undefined,
      backdrop: details.backdrop_path ? `${IMG_BASE}/original${details.backdrop_path}` : undefined,
      logo: enLogo ? `${IMG_BASE}/w300${(enLogo as Record<string, unknown>).file_path}` : undefined,
      certification: undefined,
      cast,
      crew,
      recommendations: recResults,
      trailers,
      imdbId: details.imdb_id as string,
    }
  },

  async getShow(id: string): Promise<ShowDetails> {
    const tmdbId = id.replace('tmdb-', '')
    const [details, credits, videos, recs, images] = await Promise.all([
      tmdbFetch(`/tv/${tmdbId}`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/credits`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/videos`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/recommendations`) as Promise<Record<string, unknown>>,
      tmdbFetch(`/tv/${tmdbId}/images`) as Promise<Record<string, unknown>>,
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
      poster: details.poster_path ? `${IMG_BASE}/w500${details.poster_path}` : undefined,
      backdrop: details.backdrop_path ? `${IMG_BASE}/original${details.backdrop_path}` : undefined,
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
      imdbId: (details.external_ids as Record<string, unknown>)?.imdb_id as string,
    }
  },

  async getSeason(showId: string, season: number): Promise<SeasonDetails> {
    const tmdbId = showId.replace('tmdb-', '')
    const data = await tmdbFetch(`/tv/${tmdbId}/season/${season}`) as Record<string, unknown>
    const episodes = ((data.episodes as Record<string, unknown>[]) || []).map((e) => ({
      id: String(e.id),
      episodeNumber: e.episode_number as number,
      seasonNumber: e.season_number as number,
      name: e.name as string,
      overview: e.overview as string,
      airDate: e.air_date as string,
      runtime: e.runtime as number,
      still: e.still_path ? `${IMG_BASE}/w300${e.still_path}` : undefined,
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
      still: data.still_path ? `${IMG_BASE}/w300${data.still_path}` : undefined,
      rating: data.vote_average as number,
      voteCount: data.vote_count as number,
    }
  },
}
