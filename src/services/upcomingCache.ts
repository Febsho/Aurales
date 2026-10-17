import { cacheGet, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { getActiveProfileId } from './profiles'
import { getUpcomingPreferences, type ReleaseEvent } from './upcoming'

const STARTUP_STORAGE_KEY = 'aurales_upcoming_startup_snapshots_v1'
const STARTUP_LIMIT = 12
const MAX_STARTUP_SNAPSHOTS = 24

function cacheKey(profileId = getActiveProfileId(), prefs = getUpcomingPreferences(profileId)) {
  const hiddenIds = Object.keys(prefs.hidden || {}).sort()
  let hiddenHash = 2166136261
  for (const id of hiddenIds) {
    for (let index = 0; index < id.length; index += 1) {
      hiddenHash ^= id.charCodeAt(index)
      hiddenHash = Math.imul(hiddenHash, 16777619)
    }
    hiddenHash ^= 0
    hiddenHash = Math.imul(hiddenHash, 16777619)
  }
  const hiddenScope = `${hiddenIds.length}:${hiddenHash >>> 0}`
  return `upcoming:events:v1:${profileId}:${prefs.includeLocalWatchlist ? 1 : 0}${prefs.includeContinueWatching ? 1 : 0}${prefs.includeConnectedWatchlists ? 1 : 0}${prefs.includeConnectedWatching ? 1 : 0}:${hiddenScope}`
}

interface UpcomingStartupState {
  version: 1
  entries: Record<string, { savedAt: number; events: ReleaseEvent[] }>
}

function validReleaseEvent(value: unknown): value is ReleaseEvent {
  const event = value as Partial<ReleaseEvent> | null
  return Boolean(event
    && typeof event.id === 'string'
    && typeof event.type === 'string'
    && event.media
    && typeof event.media.id === 'string'
    && typeof event.media.title === 'string')
}

function readStartupState(): UpcomingStartupState {
  try {
    const value = JSON.parse(localStorage.getItem(STARTUP_STORAGE_KEY) || 'null') as UpcomingStartupState | null
    return value?.version === 1 && value.entries && typeof value.entries === 'object'
      ? value
      : { version: 1, entries: {} }
  } catch {
    return { version: 1, entries: {} }
  }
}

/** Synchronous Home fallback: renders before IndexedDB and provider clients initialize. */
export function readUpcomingEventsStartupSnapshot(
  profileId = getActiveProfileId(),
  prefs = getUpcomingPreferences(profileId),
): ReleaseEvent[] | null {
  const events = readStartupState().entries[cacheKey(profileId, prefs)]?.events
  if (!Array.isArray(events)) return null
  return events.filter(validReleaseEvent).slice(0, STARTUP_LIMIT)
}

export function writeUpcomingEventsStartupSnapshot(
  events: ReleaseEvent[],
  profileId = getActiveProfileId(),
  prefs = getUpcomingPreferences(profileId),
): void {
  const state = readStartupState()
  state.entries[cacheKey(profileId, prefs)] = {
    savedAt: Date.now(),
    events: events.filter(validReleaseEvent).slice(0, STARTUP_LIMIT),
  }
  const oldestFirst = Object.entries(state.entries)
    .sort(([, a], [, b]) => (Number.isFinite(a?.savedAt) ? a.savedAt : 0) - (Number.isFinite(b?.savedAt) ? b.savedAt : 0))
  while (oldestFirst.length > MAX_STARTUP_SNAPSHOTS) {
    const [oldestKey] = oldestFirst.shift()!
    delete state.entries[oldestKey]
  }
  try { localStorage.setItem(STARTUP_STORAGE_KEY, JSON.stringify(state)) } catch { /* storage unavailable/full */ }
}

/** Durable, profile-scoped cache. Callers still refresh in the background so local progress is never stale for long. */
export async function readUpcomingEventsCache(
  profileId = getActiveProfileId(),
  prefs = getUpcomingPreferences(profileId),
): Promise<ReleaseEvent[] | null> {
  return (await cacheGet<ReleaseEvent[]>(cacheKey(profileId, prefs)))?.data ?? null
}

export function writeUpcomingEventsCache(
  events: ReleaseEvent[],
  profileId = getActiveProfileId(),
  prefs = getUpcomingPreferences(profileId),
): Promise<void> {
  // localStorage is intentionally written first. The Home shelf can consume
  // this synchronously next launch while the durable SQLite cache opens.
  const key = cacheKey(profileId, prefs)
  writeUpcomingEventsStartupSnapshot(events, profileId, prefs)
  return cacheSet(key, events, { category: CACHE_CATEGORIES.HOME_ROW, ttlSeconds: CACHE_TTLS.HOME_ROW })
}
