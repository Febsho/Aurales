import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { cachedFetch } from './cache/sqliteCache'
import { readBoundedResponseJson } from './network/boundedResponse'

const MAX_JIKAN_EPISODE_PAGE_BYTES = 2 * 1024 * 1024

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

const episodePageRequests = new Map<string, Promise<JikanEpisode[]>>()

export async function getJikanEpisodeRating(malId: string | number | undefined, episodeNumber: number | undefined): Promise<number | null> {
  const animeId = Number(malId)
  const episode = Number(episodeNumber)
  if (!Number.isFinite(animeId) || animeId <= 0 || !Number.isFinite(episode) || episode <= 0) return null

  const page = Math.ceil(episode / 100)
  const episodes = await getJikanEpisodes(animeId, page)
  const match = episodes.find((item) => item.mal_id === episode)
  const score = Number(match?.score)
  return Number.isFinite(score) && score > 0 ? score : null
}

async function getJikanEpisodes(malId: number, page: number): Promise<JikanEpisode[]> {
  const requestKey = `${malId}:${page}`
  const pending = episodePageRequests.get(requestKey)
  if (pending) return pending

  const request = cachedFetch(
    `jikan:anime:${malId}:episodes:page:${page}:v2`,
    () => fetchEpisodePage(malId, page),
    {
      category: CACHE_CATEGORIES.ANIME_MAPPING,
      ttlSeconds: CACHE_TTLS.ANIME_MAPPING_AIRING,
    },
  ).finally(() => episodePageRequests.delete(requestKey))
  episodePageRequests.set(requestKey, request)
  return request
}

async function fetchEpisodePage(malId: number, page: number): Promise<JikanEpisode[]> {
  const url = `https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      await res.body?.cancel()
      return []
    }
    const data = await readBoundedResponseJson<JikanEpisodesPage>(res, MAX_JIKAN_EPISODE_PAGE_BYTES, 'Jikan episode response')
    return data.data ?? []
  } finally {
    clearTimeout(timeout)
  }
}
