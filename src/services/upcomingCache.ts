import { cacheGet, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { getActiveProfileId } from './profiles'
import { getUpcomingPreferences, type ReleaseEvent } from './upcoming'

const STARTUP_STORAGE_KEY = 'aurales_upcoming_startup_snapshots_v1'
const STARTUP_LIMIT = 12

function cacheKey() {
  const prefs = getUpcomingPreferences()
  return `upcoming:events:v1:${getActiveProfileId()}:${prefs.includeLocalWatchlist ? 1 : 0}${prefs.includeContinueWatching ? 1 : 0}${prefs.includeConnectedWatchlists ? 1 : 0}${prefs.includeConnectedWatching ? 1 : 0}`
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
export function readUpcomingEventsStartupSnapshot(): ReleaseEvent[] | null {
  const events = readStartupState().entries[cacheKey()]?.events
  if (!Array.isArray(events)) return null
  return events.filter(validReleaseEvent).slice(0, STARTUP_LIMIT)
}

export function writeUpcomingEventsStartupSnapshot(events: ReleaseEvent[]): void {
  const state = readStartupState()
  state.entries[cacheKey()] = {
    savedAt: Date.now(),
    events: events.filter(validReleaseEvent).slice(0, STARTUP_LIMIT),
  }
  try { localStorage.setItem(STARTUP_STORAGE_KEY, JSON.stringify(state)) } catch { /* storage unavailable/full */ }
}

/** Durable, profile-scoped cache. Callers still refresh in the background so local progress is never stale for long. */
export async function readUpcomingEventsCache(): Promise<ReleaseEvent[] | null> {
  return (await cacheGet<ReleaseEvent[]>(cacheKey()))?.data ?? null
}

export function writeUpcomingEventsCache(events: ReleaseEvent[]): Promise<void> {
  // localStorage is intentionally written first. The Home shelf can consume
  // this synchronously next launch while the durable SQLite cache opens.
  writeUpcomingEventsStartupSnapshot(events)
  return cacheSet(cacheKey(), events, { category: CACHE_CATEGORIES.HOME_ROW, ttlSeconds: CACHE_TTLS.HOME_ROW })
}
