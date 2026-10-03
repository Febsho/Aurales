import { getTmdbApiKey } from './apiKeys'

export interface NextEpInfo {
  season: number
  episode: number
  title: string
  overview?: string
  runtime?: number
  stillPath?: string
}

export async function fetchNextEpisodeFromTmdb(tmdbId: number, season: number, episode: number): Promise<NextEpInfo | null> {
  const apiKey = getTmdbApiKey()
  const tryFetch = async (s: number, e: number): Promise<NextEpInfo | null> => {
    try {
      const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${s}/episode/${e}?api_key=${apiKey}`)
      if (!res.ok) return null
      const data = await res.json()
      if (!data.name) return null
      return {
        season: s,
        episode: e,
        title: data.name,
        overview: data.overview || undefined,
        runtime: data.runtime || undefined,
        stillPath: data.still_path ? `https://image.tmdb.org/t/p/original${data.still_path}` : undefined,
      }
    } catch (_) {
      return null
    }
  }

  return await tryFetch(season, episode) || await tryFetch(season + 1, 1)
}
