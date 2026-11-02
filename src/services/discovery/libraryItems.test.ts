import { describe, expect, it } from 'vitest'
import { buildNewLibraryItems, parseLibraryAddedAt } from './libraryItems'

describe('Discovery library items', () => {
  it('accepts real provider timestamps and rejects missing or invalid dates', () => {
    expect(parseLibraryAddedAt('2026-10-31T12:00:00Z')).toBe(Date.parse('2026-10-31T12:00:00Z'))
    expect(parseLibraryAddedAt(undefined)).toBeUndefined()
    expect(parseLibraryAddedAt('not a date')).toBeUndefined()
  })

  it('merges local and connected watchlists by identity, keeps the newest date and respects the active tab', () => {
    const items = buildNewLibraryItems(
      [{ id: 'local-1', title: 'Shared title', type: 'movie', provider: 'local', tmdbId: 12, poster: '/local.jpg', addedAt: 100 }],
      [
        { id: 'trakt-1', title: 'Shared title', type: 'movie', provider: 'trakt', tmdbId: 12, libraryAddedAt: 200 },
        { id: 'trakt-2', title: 'Series', type: 'series', provider: 'trakt', tmdbId: 13, poster: '/series.jpg', libraryAddedAt: 300 },
        { id: 'trakt-3', title: 'No artwork', type: 'movie', provider: 'trakt', tmdbId: 14, libraryAddedAt: 400 },
      ],
      (item) => item.type === 'movie',
    )

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ title: 'Shared title', poster: '/local.jpg', addedAt: 200 })
  })
})
