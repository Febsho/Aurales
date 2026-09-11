import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), cacheGet: vi.fn(), cacheSet: vi.fn(), getSeason: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../apiKeys', () => ({ getTvdbApiKey: () => 'tvdb-key' }))
vi.mock('../cache/sqliteCache', () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }))
vi.mock('../tvdb', () => ({ tvdbProvider: { getSeason: mocks.getSeason } }))

import { loadAnimeSeason } from './animeSeasonLoader'

const season = { seasonNumber: 1, name: 'Season 1', episodes: [{ id: '1', episodeNumber: 1, seasonNumber: 1, name: 'One' }] }

describe('anime season native compatibility loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cacheGet.mockResolvedValue(null)
  })

  it('uses the coarse native season result with the existing cache key', async () => {
    mocks.invoke.mockResolvedValue({ data: season, stale: false, cacheStatus: 'miss' })
    await expect(loadAnimeSeason('tvdb-42', 1)).resolves.toEqual(season)
    expect(mocks.invoke).toHaveBeenCalledWith('load_anime_season', { request: expect.objectContaining({
      tvdbId: '42', season: 1, cacheKey: 'tvdb_season:english-v2:42:1', apiKey: 'tvdb-key',
    }) })
  })

  it('serves stale cache immediately and refreshes it in the background', async () => {
    mocks.cacheGet.mockResolvedValue({ data: season, stale: true, age: 1 })
    mocks.invoke.mockResolvedValue({ data: { ...season, name: 'Fresh' }, stale: false, cacheStatus: 'miss' })
    await expect(loadAnimeSeason(42, 1)).resolves.toEqual(season)
    await vi.waitFor(() => expect(mocks.cacheSet).toHaveBeenCalledWith(
      'tvdb_season:english-v2:42:1',
      expect.objectContaining({ name: 'Fresh' }),
      expect.objectContaining({ category: 'tvdb_season' }),
    ))
  })

  it('preserves the provider fallback on a native error', async () => {
    mocks.invoke.mockRejectedValue(new Error('native unavailable'))
    mocks.getSeason.mockResolvedValue(season)
    await expect(loadAnimeSeason(42, 1)).resolves.toEqual(season)
    expect(mocks.getSeason).toHaveBeenCalledWith('tvdb-42', 1, 'interactive')
  })

  it('rejects a superseded season without entering the fallback', async () => {
    let resolveFirst!: (value: unknown) => void
    mocks.invoke.mockImplementation((_command: string, args: { request: { season: number } }) => {
      if (args.request.season === 1) return new Promise(resolve => { resolveFirst = resolve })
      return Promise.resolve({ data: { ...season, seasonNumber: 2 }, stale: false, cacheStatus: 'miss' })
    })
    const first = loadAnimeSeason(42, 1, { cancelGroup: 'switch' })
    await loadAnimeSeason(42, 2, { cancelGroup: 'switch' })
    resolveFirst({ data: season, stale: false, cacheStatus: 'miss' })
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.getSeason).not.toHaveBeenCalled()
  })
})
