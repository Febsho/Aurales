import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { cachedFetch } from './cache/sqliteCache'

interface JikanEpisode {
  mal_id?: number
  score?: number | null
}

interface JikanEpisodesPage {
  data?: JikanEpisode[]
  pagination?: {
    has_next_page?: boolean
    last_visible_page?: number
  }
}

export async function getJikanEpisodeRating(malId: string | number | undefined, episodeNumber: number | undefined): Promise<number | null> {
  const animeId = Number(malId)
  const episode = Number(episodeNumber)
  if (!Number.isFinite(animeId) || animeId <= 0 || !Number.isFinite(episode) || episode <= 0) return null

  const episodes = await getJikanEpisodes(animeId)
  const match = episodes.find((item) => item.mal_id === episode)
  const score = Number(match?.score)
  return Number.isFinite(score) && score > 0 ? score : null
}

async function getJikanEpisodes(malId: number): Promise<JikanEpisode[]> {
  return cachedFetch(
    `jikan:anime:${malId}:episodes`,
    () => fetchAllEpisodePages(malId),
    {
      category: CACHE_CATEGORIES.ANIME_MAPPING,
      ttlSeconds: CACHE_TTLS.ANIME_MAPPING_AIRING,
    },
  )
}

async function fetchAllEpisodePages(malId: number): Promise<JikanEpisode[]> {
  const episodes: JikanEpisode[] = []
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`
    const res = await fetch(url)
    if (!res.ok) break
    const data = await res.json() as JikanEpisodesPage
    episodes.push(...(data.data ?? []))
    if (!data.pagination?.has_next_page) break
  }
  return episodes
}
