import type { SeasonDetails } from '../../types'
import { cacheGet, cacheSet } from '../cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../cache/constants'

// Separate from the detail shell: resolved TVDB seasons stay useful when the
// shell is enriched later, and make return visits and season changes instant.
const memory = new Map<string, SeasonDetails>()
const pending = new Map<string, Promise<SeasonDetails | null>>()
const MAX_MEMORY_SEASONS = 120
let seasonGeneration = 0
let seasonCacheClearBarrier: Promise<unknown> | undefined

function rememberSeason(key: string, season: SeasonDetails): void {
  memory.delete(key)
  memory.set(key, season)
  while (memory.size > MAX_MEMORY_SEASONS) {
    const oldest = memory.keys().next().value
    if (!oldest) break
    memory.delete(oldest)
  }
}

export function animeSeasonCacheKey(tvdbId: string | number, season: number, settingsKey: string): string {
  return `anime-tvdb-season:v1:${settingsKey}:${String(tvdbId).replace(/^[a-z_]+[-:]/i, '')}:${season}`
}

export async function getCachedAnimeSeason(key: string): Promise<SeasonDetails | null> {
  while (seasonCacheClearBarrier) {
    const barrier = seasonCacheClearBarrier
    await barrier.catch(() => undefined)
    if (seasonCacheClearBarrier === barrier) seasonCacheClearBarrier = undefined
  }
  const hot = memory.get(key)
  if (hot) {
    rememberSeason(key, hot)
    return hot
  }
  const cached = await cacheGet<SeasonDetails>(key)
  if (!cached?.data) return null
  rememberSeason(key, cached.data)
  return cached.data
}

export async function getOrLoadAnimeSeason(key: string, load: () => Promise<SeasonDetails | null>): Promise<SeasonDetails | null> {
  const generation = seasonGeneration
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const cached = await getCachedAnimeSeason(key)
  if (generation !== seasonGeneration) return getOrLoadAnimeSeason(key, load)
  if (cached) return cached
  const pendingAfterRead = pending.get(key)
  if (pendingAfterRead) return pendingAfterRead
  const request = load().then(async (season) => {
    if (generation !== seasonGeneration) {
      if (pending.get(key) === request) pending.delete(key)
      return getOrLoadAnimeSeason(key, load)
    }
    if (!season || season.episodes.length === 0) return season
    rememberSeason(key, season)
    void cacheSet(key, season, { category: CACHE_CATEGORIES.ANIME_MAPPING, ttlSeconds: CACHE_TTLS.ANIME_MAPPING_FINISHED })
    return season
  }).finally(() => {
    if (pending.get(key) === request) pending.delete(key)
  })
  pending.set(key, request)
  return request
}

export function clearAnimeSeasonMemoryCache(cacheClearing?: Promise<unknown>): void {
  seasonGeneration += 1
  memory.clear()
  pending.clear()
  seasonCacheClearBarrier = cacheClearing
}
