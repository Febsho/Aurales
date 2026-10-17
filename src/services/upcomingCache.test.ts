import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseEvent } from './upcoming'

const { cacheSet, preferences } = vi.hoisted(() => ({
  cacheSet: vi.fn(async () => undefined),
  preferences: {
    includeLocalWatchlist: true,
    includeContinueWatching: true,
    includeConnectedWatchlists: true,
    includeConnectedWatching: true,
  },
}))

vi.mock('./cache/sqliteCache', () => ({ cacheGet: vi.fn(), cacheSet }))
vi.mock('./profiles', () => ({ getActiveProfileId: () => 'profile-1' }))
vi.mock('./upcoming', () => ({ getUpcomingPreferences: () => preferences }))

import { readUpcomingEventsStartupSnapshot, writeUpcomingEventsCache } from './upcomingCache'

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
}

const release = (id: string): ReleaseEvent => ({
  id,
  media: { id, title: `Title ${id}`, type: 'movie', provider: 'local' },
  type: 'movie', releaseDate: '2099-01-01', relevanceScore: 1,
  relevanceReasons: [], source: 'local', status: 'upcoming',
})

describe('Upcoming startup snapshot', () => {
  beforeEach(() => {
    values.clear()
    cacheSet.mockClear()
    Object.assign(preferences, {
      includeLocalWatchlist: true,
      includeContinueWatching: true,
      includeConnectedWatchlists: true,
      includeConnectedWatching: true,
    })
    vi.stubGlobal('localStorage', storage)
  })

  it('is available synchronously before the durable cache write resolves', () => {
    void writeUpcomingEventsCache([release('one')])
    expect(readUpcomingEventsStartupSnapshot()).toEqual([release('one')])
    expect(cacheSet).toHaveBeenCalledOnce()
  })

  it('caps the Home snapshot and scopes it to source preferences', () => {
    void writeUpcomingEventsCache(Array.from({ length: 20 }, (_, index) => release(String(index))))
    expect(readUpcomingEventsStartupSnapshot()).toHaveLength(12)
    preferences.includeConnectedWatching = false
    expect(readUpcomingEventsStartupSnapshot()).toBeNull()
  })

  it('ignores malformed startup storage', () => {
    values.set('aurales_upcoming_startup_snapshots_v1', '{broken')
    expect(readUpcomingEventsStartupSnapshot()).toBeNull()
  })
})
