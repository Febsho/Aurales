import type { SeasonDetails } from '../../types'
import { cacheGet, cacheSet } from '../cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../cache/constants'

// Separate from the detail shell: resolved TVDB seasons stay useful when the
// shell is enriched later, and make return visits and season changes instant.
const memory = new Map<string, SeasonDetails>()
const pending = new Map<string, Promise<SeasonDetails | null>>()

export function animeSeasonCacheKey(tvdbId: string | number, season: number, settingsKey: string): string {
  return `anime-tvdb-season:v1:${settingsKey}:${String(tvdbId).replace(/^[a-z_]+[-:]/i, '')}:${season}`
}

export async function getCachedAnimeSeason(key: string): Promise<SeasonDetails | null> {
  const hot = memory.get(key)
  if (hot) return hot
  const cached = await cacheGet<SeasonDetails>(key)
  if (!cached?.data) return null
  memory.set(key, cached.data)
  return cached.data
}

export async function getOrLoadAnimeSeason(key: string, load: () => Promise<SeasonDetails | null>): Promise<SeasonDetails | null> {
  const cached = await getCachedAnimeSeason(key)
  if (cached) return cached
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const request = load().then(async (season) => {
    if (!season || season.episodes.length === 0) return season
    memory.set(key, season)
    await cacheSet(key, season, { category: CACHE_CATEGORIES.ANIME_MAPPING, ttlSeconds: CACHE_TTLS.ANIME_MAPPING_FINISHED })
    return season
  }).finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

export function clearAnimeSeasonMemoryCache(): void {
  memory.clear()
  pending.clear()
}
