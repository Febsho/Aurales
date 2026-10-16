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
  if (!apiKey || !Number.isFinite(tmdbId) || tmdbId <= 0 || !Number.isFinite(season) || season < 0 || !Number.isFinite(episode) || episode <= 0) return null
  const tryFetch = async (s: number, e: number): Promise<NextEpInfo | null> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${s}/episode/${e}?api_key=${apiKey}`, { signal: controller.signal })
      if (!res.ok) {
        await res.body?.cancel()
        return null
      }
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
    } finally {
      clearTimeout(timeout)
    }
  }

  return await tryFetch(season, episode) || await tryFetch(season + 1, 1)
}
