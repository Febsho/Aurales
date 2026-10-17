import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addToLocalWatchlist,
  getLocalWatchlist,
  isInLocalWatchlist,
  removeFromLocalWatchlist,
  resetLocalWatchlistCacheForTests,
  toggleLocalWatchlist,
} from './localWatchlist'
import type { SearchResult } from '../types'

const movie: SearchResult = { id: 'movie-1', title: 'A Movie', type: 'movie', provider: 'tmdb', tmdbId: 42 }
const show: SearchResult = { id: 'show-1', title: 'A Show', type: 'series', provider: 'tmdb', tmdbId: 42 }

describe('localWatchlist', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    resetLocalWatchlistCacheForTests()
  })

  it('stores movies and shows with the same provider id separately', () => {
    addToLocalWatchlist(movie)
    addToLocalWatchlist(show)
    expect(getLocalWatchlist()).toHaveLength(2)
    expect(isInLocalWatchlist(movie)).toBe(true)
    expect(isInLocalWatchlist(show)).toBe(true)
  })

  it('toggles and removes a saved title', () => {
    expect(toggleLocalWatchlist(movie)).toBe(true)
    expect(toggleLocalWatchlist(movie)).toBe(false)
    expect(getLocalWatchlist()).toEqual([])
    addToLocalWatchlist(movie)
    removeFromLocalWatchlist(movie)
    expect(isInLocalWatchlist(movie)).toBe(false)
  })
})
