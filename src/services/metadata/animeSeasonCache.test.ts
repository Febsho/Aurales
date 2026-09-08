import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeasonDetails } from '../../types'

const cache = vi.hoisted(() => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }))
vi.mock('../cache/sqliteCache', () => ({ cacheGet: cache.cacheGet, cacheSet: cache.cacheSet }))

import {
  animeSeasonCacheKey,
  clearAnimeSeasonMemoryCache,
  getOrLoadAnimeSeason,
} from './animeSeasonCache'

describe('anime season cache', () => {
  beforeEach(() => {
    clearAnimeSeasonMemoryCache()
    cache.cacheGet.mockReset().mockResolvedValue(null)
    cache.cacheSet.mockReset().mockResolvedValue(undefined)
  })

  it('uses a stable key scoped by TVDB season and structure settings', () => {
    expect(animeSeasonCacheKey('tvdb-42', 2, '101')).toBe('anime-tvdb-season:v1:101:42:2')
  })

  it('deduplicates concurrent loads and reuses the resolved season', async () => {
    let resolveSeason!: (value: SeasonDetails | null) => void
    const load = vi.fn(() => new Promise<SeasonDetails | null>(resolve => { resolveSeason = resolve }))
    const key = animeSeasonCacheKey(42, 1, '101')
    const first = getOrLoadAnimeSeason(key, load)
    const second = getOrLoadAnimeSeason(key, load)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    resolveSeason({ seasonNumber: 1, name: 'Season 1', episodes: [{ id: '1', seasonNumber: 1, episodeNumber: 1, name: 'One' }] })

    await expect(first).resolves.toMatchObject({ seasonNumber: 1 })
    await expect(second).resolves.toMatchObject({ seasonNumber: 1 })
    await expect(getOrLoadAnimeSeason(key, load)).resolves.toMatchObject({ seasonNumber: 1 })
    expect(load).toHaveBeenCalledTimes(1)
    expect(cache.cacheSet).toHaveBeenCalledTimes(1)
  })
})
