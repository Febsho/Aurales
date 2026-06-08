import type { MetadataProvider, SearchResult, MovieDetails, ShowDetails, SeasonDetails, EpisodeDetails } from '../types'

const BASE_URL = 'https://api4.thetvdb.com/v4'

let cachedToken: string | null = null

function getApiKey(): string {
  return localStorage.getItem('tvdb_api_key') || import.meta.env.VITE_TVDB_API_KEY || ''
}

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('TVDB API key not configured')
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: apiKey }),
  })
  if (!res.ok) throw new Error(`TVDB auth error: ${res.status}`)
  const data = await res.json()
  cachedToken = data.data.token
  return cachedToken!
}

async function tvdbFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await getToken()
  const url = new URL(`${BASE_URL}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    if (res.status === 401) {
      cachedToken = null
      return tvdbFetch(path, params)
    }
    throw new Error(`TVDB error: ${res.status}`)
  }
  return res.json()
}

export const tvdbProvider: MetadataProvider = {
  id: 'tvdb',
  name: 'TVDB',

  async search(query: string): Promise<SearchResult[]> {
    const data = await tvdbFetch('/search', { query, type: 'series' }) as Record<string, unknown>
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

  async getMovie(_id: string): Promise<MovieDetails> {
    throw new Error('TVDB does not provide movie details')
  },

  async getShow(id: string): Promise<ShowDetails> {
    const tvdbId = id.replace('tvdb-', '')
    const data = await tvdbFetch(`/series/${tvdbId}/extended`, { meta: 'episodes' }) as Record<string, unknown>
    const series = data.data as Record<string, unknown>

    const seasons = ((series.seasons as Record<string, unknown>[]) || [])
      .filter((s) => (s.type as Record<string, unknown>)?.type === 'official')
      .map((s) => ({
        seasonNumber: s.number as number,
        name: s.name as string || `Season ${s.number}`,
        episodeCount: (s.episodes as unknown[])?.length || 0,
        poster: s.image as string | undefined,
        airDate: undefined,
      }))

    const genres = ((series.genres as Record<string, unknown>[]) || []).map((g) => g.name as string)

    return {
      id,
      title: series.name as string,
      year: (series.firstAired as string)?.slice(0, 4) ? parseInt((series.firstAired as string).slice(0, 4)) : undefined,
      firstAirDate: series.firstAired as string,
      overview: series.overview as string,
      rating: undefined,
      voteCount: undefined,
      genres,
      poster: series.image as string | undefined,
      backdrop: series.artworks ? ((series.artworks as Record<string, unknown>[])[0]?.image as string) : undefined,
      certification: undefined,
      status: series.status?.toString(),
      numberOfSeasons: seasons.length,
      seasons,
      cast: [],
      crew: [],
      recommendations: [],
      trailers: [],
    }
  },

  async getSeason(showId: string, season: number): Promise<SeasonDetails> {
    const tvdbId = showId.replace('tvdb-', '')
    const data = await tvdbFetch(`/series/${tvdbId}/episodes/default`, { season: String(season) }) as Record<string, unknown>
    const episodes = ((data.data as Record<string, unknown>)?.episodes as Record<string, unknown>[]) || []

    return {
      seasonNumber: season,
      name: `Season ${season}`,
      episodes: episodes.map((e) => ({
        id: String(e.id),
        episodeNumber: e.number as number,
        seasonNumber: season,
        name: e.name as string,
        overview: e.overview as string,
        airDate: e.aired as string,
        runtime: e.runtime as number,
        still: e.image as string | undefined,
        rating: undefined,
        voteCount: undefined,
      })),
    }
  },

  async getEpisode(showId: string, season: number, episode: number): Promise<EpisodeDetails> {
    const seasonData = await this.getSeason(showId, season)
    const ep = seasonData.episodes.find((e) => e.episodeNumber === episode)
    if (!ep) throw new Error('Episode not found')
    return ep
  },
}
