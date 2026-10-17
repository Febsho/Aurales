import { describe, expect, it, vi } from 'vitest'
import { dedupeConnectedHistory, type ConnectedHistoryItem } from './connectedActivity'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
})

const item = (overrides: Partial<ConnectedHistoryItem>): ConnectedHistoryItem => ({
  id: '', title: 'Silo', year: 2023, mediaType: 'series', watchedCount: 1, sources: ['trakt'], ...overrides,
})

describe('connected history deduplication', () => {
  it('merges matching provider IDs and keeps all source badges', () => {
    const results = dedupeConnectedHistory([
      item({ tmdbId: 125988, imdbId: 'tt14688458', watchedCount: 3, sources: ['trakt'], watchedAt: '2026-01-01T00:00:00Z' }),
      item({ imdbId: 'tt14688458', watchedCount: 2, sources: ['simkl'], watchedAt: '2026-02-01T00:00:00Z' }),
      item({ tmdbId: 125988, watchedCount: 4, sources: ['mdblist'] }),
    ])
    expect(results).toHaveLength(1)
    expect(results[0].sources.sort()).toEqual(['mdblist', 'simkl', 'trakt'])
    expect(results[0].watchedCount).toBe(4)
    expect(results[0].watchedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('does not merge movies and shows that share a title', () => {
    const results = dedupeConnectedHistory([item({ mediaType: 'movie' }), item({ mediaType: 'series' })])
    expect(results).toHaveLength(2)
  })

  it('does not collapse untitled PMDB rows with different TMDB IDs', () => {
    const results = dedupeConnectedHistory([
      item({ title: '', mediaType: 'movie', tmdbId: 550, sources: ['pmdb'] }),
      item({ title: '', mediaType: 'movie', tmdbId: 27205, sources: ['pmdb'] }),
    ])
    expect(results).toHaveLength(2)
  })

  it('keeps distinct watch dates while merging services for streaks', () => {
    const results = dedupeConnectedHistory([
      item({ tmdbId: 125988, watchedDates: ['2026-07-10T20:00:00Z'], sources: ['trakt'] }),
      item({ tmdbId: 125988, watchedDates: ['2026-07-11T20:00:00Z'], sources: ['stremio'] }),
    ])
    expect(results[0].watchedDates).toEqual(['2026-07-10T20:00:00Z', '2026-07-11T20:00:00Z'])
  })
})
