import { beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../types'
import { useHomeCatalogCache } from './homeCatalogCache'

const loadedItems: SearchResult[] = [{
  id: 'movie-1',
  type: 'movie',
  provider: 'addon',
  title: 'Already loaded',
  poster: 'https://example.test/poster.jpg',
}]

describe('Home catalog session cache', () => {
  beforeEach(() => useHomeCatalogCache.getState().clear())

  it('keeps loaded row data available across a visibility/remount boundary', () => {
    const key = 'home:addon:stable-row'
    useHomeCatalogCache.getState().set(key, loadedItems)

    // A row remount reads this same session cache instead of returning to its
    // loading state or starting its provider loader again.
    expect(useHomeCatalogCache.getState().get(key)).toBe(loadedItems)
    expect(useHomeCatalogCache.getState().get(key)?.[0].poster).toBe('https://example.test/poster.jpg')
  })

  it('bounds session rows without evicting recently refreshed shelves', () => {
    for (let index = 0; index < 170; index += 1) {
      useHomeCatalogCache.getState().set(`row-${index}`, loadedItems)
    }
    useHomeCatalogCache.getState().set('row-10', loadedItems)

    expect(Object.keys(useHomeCatalogCache.getState().rows)).toHaveLength(160)
    expect(useHomeCatalogCache.getState().get('row-0')).toBeNull()
    expect(useHomeCatalogCache.getState().get('row-10')).toBe(loadedItems)
    expect(useHomeCatalogCache.getState().get('row-169')).toBe(loadedItems)
  })
})
