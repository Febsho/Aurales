import { cacheGet, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { getActiveProfileId } from './profiles'
import { getUpcomingPreferences, type ReleaseEvent } from './upcoming'

function cacheKey() {
  const prefs = getUpcomingPreferences()
  return `upcoming:events:v1:${getActiveProfileId()}:${prefs.includeLocalWatchlist ? 1 : 0}${prefs.includeContinueWatching ? 1 : 0}${prefs.includeConnectedWatchlists ? 1 : 0}${prefs.includeConnectedWatching ? 1 : 0}`
}

/** Durable, profile-scoped cache. Callers still refresh in the background so local progress is never stale for long. */
export async function readUpcomingEventsCache(): Promise<ReleaseEvent[] | null> {
  return (await cacheGet<ReleaseEvent[]>(cacheKey()))?.data ?? null
}

export function writeUpcomingEventsCache(events: ReleaseEvent[]): Promise<void> {
  return cacheSet(cacheKey(), events, { category: CACHE_CATEGORIES.HOME_ROW, ttlSeconds: CACHE_TTLS.HOME_ROW })
}
