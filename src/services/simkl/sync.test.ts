import { beforeEach, describe, expect, it, vi } from 'vitest'

const { simklRequest, normalizeSimklHistoryItems } = vi.hoisted(() => ({
  simklRequest: vi.fn(),
  normalizeSimklHistoryItems: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
}))

vi.mock('./auth', () => ({ isSimklMockMode: () => false }))
vi.mock('./client', () => ({ simklRequest }))
vi.mock('./history', () => ({ normalizeSimklHistoryItems }))
vi.mock('./lists', () => ({ addToSimklWatchlist: vi.fn() }))

import { pullSimklLists } from './sync'

function storage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  }
}

describe('SIMKL v2 sync migration', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    simklRequest.mockReset()
    normalizeSimklHistoryItems.mockClear()
  })

  it('bootstraps shows, movies, and anime sequentially before saving activities', async () => {
    simklRequest
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ all: '2026-09-19T10:00:00Z' })

    await expect(pullSimklLists()).resolves.toEqual({ pulled: 0, errors: [] })
    expect(simklRequest.mock.calls.map(([path]) => path)).toEqual([
      '/sync/all-items/shows?extended=full&episode_watched_at=yes&include_all_episodes=yes',
      '/sync/all-items/movies?extended=full&episode_watched_at=yes&include_all_episodes=yes',
      '/sync/all-items/anime?extended=full&episode_watched_at=yes&include_all_episodes=yes',
      '/sync/activities',
    ])
    expect(JSON.parse(localStorage.getItem('simkl_sync_state_v2')!)).toEqual({ activitiesAll: '2026-09-19T10:00:00Z' })
  })

  it('uses activities as the delta gate and preserves the opaque cursor exactly', async () => {
    localStorage.setItem('simkl_sync_state_v2', JSON.stringify({ activitiesAll: '2026-09-19T10:00:00Z' }))
    simklRequest.mockResolvedValueOnce({ all: '2026-09-19T10:00:00Z' })

    await expect(pullSimklLists()).resolves.toEqual({ pulled: 0, errors: [] })
    expect(simklRequest).toHaveBeenCalledTimes(1)

    simklRequest.mockReset()
    simklRequest.mockResolvedValueOnce({ all: '2026-09-19T10:05:00Z' }).mockResolvedValueOnce([])
    await pullSimklLists()
    expect(simklRequest.mock.calls.map(([path]) => path)).toEqual([
      '/sync/activities',
      '/sync/all-items?date_from=2026-09-19T10%3A00%3A00Z&extended=full&episode_watched_at=yes&include_all_episodes=yes',
    ])
  })
})
