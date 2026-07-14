import { describe, expect, it } from 'vitest'
import { retainDiscoverySnapshot } from './discoverySnapshot'

describe('Discovery startup snapshot', () => {
  it('retains old rows and rankings across day boundaries', () => {
    const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000
    const cachedRows = { movies: { timestamp: oldTimestamp, items: [{ id: '1', title: 'Cached', type: 'movie' as const, provider: 'tmdb' }] } }
    const rankedSnapshots = { 'movies:for-you:scope': [] }
    expect(retainDiscoverySnapshot({ version: 2, cachedRows, rankedSnapshots })).toEqual({ cachedRows, rankedSnapshots })
  })

  it('normalizes missing or malformed persisted fields to empty maps', () => {
    expect(retainDiscoverySnapshot(null)).toEqual({ cachedRows: {}, rankedSnapshots: {} })
  })
})
