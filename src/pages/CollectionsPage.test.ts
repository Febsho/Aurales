import { describe, expect, it } from 'vitest'
import { getPosterStackItems, inferCatalogContentType, isCatalogUsedByHomeShelf, normalizeShelfDraft, shelfDraftKey, type ShelfDraft } from '../services/homeShelves'

const draft = (updates: Partial<ShelfDraft> = {}): ShelfDraft => ({
  title: 'Example',
  layout: 'landscape',
  enabled: false,
  ...updates,
})

describe('home shelf catalog selection', () => {
  it('uses stable provider identities for deduplication', () => {
    expect(shelfDraftKey(draft({ sourceType: 'trakt', providerListId: 'watchlist-movies' }))).toBe('trakt:watchlist-movies')
  })

  it('uses addon, type, and catalog identifiers together', () => {
    expect(shelfDraftKey(draft({ addonId: 'cinemeta', catalogType: 'movie', catalogId: 'popular' }))).toBe('addon:cinemeta:movie:popular')
  })

  it('defaults selected catalogs to poster layout and visible', () => {
    expect(normalizeShelfDraft(draft())).toMatchObject({ layout: 'poster', enabled: true })
  })

  it('preserves the special continue-watching layout', () => {
    expect(normalizeShelfDraft(draft({ layout: 'continue', sourceType: 'local' }))).toMatchObject({ layout: 'continue', enabled: true })
  })

  it('keeps poster order and limits stacks to five cards', () => {
    const posters = ['one', 'two', 'three', 'four', 'five', 'six']
    expect(getPosterStackItems(posters)).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  it('removes empty artwork entries without changing valid order', () => {
    expect(getPosterStackItems(['', 'one', '', 'two'])).toEqual(['one', 'two'])
  })

  it('classifies catalog content for picker filters', () => {
    expect(inferCatalogContentType('movies-watchlist', 'Plan to Watch')).toBe('movie')
    expect(inferCatalogContentType('watching', 'AniList Watching')).toBe('anime')
    expect(inferCatalogContentType('popular', 'Popular TV Shows')).toBe('series')
    expect(inferCatalogContentType('favorites', 'My Favorites')).toBe('unknown')
  })

  it('does not treat a hero catalog as an existing Home shelf', () => {
    const hero = { id: 'hero', order: 0, title: 'Hero', enabled: true, layout: 'hero' as const, addonId: 'addon', catalogType: 'movie', catalogId: 'popular' }
    const shelf = { ...hero, id: 'shelf', order: 1, layout: 'poster' as const }
    expect(isCatalogUsedByHomeShelf([hero], 'addon::movie::popular')).toBe(false)
    expect(isCatalogUsedByHomeShelf([hero, shelf], 'addon::movie::popular')).toBe(true)
  })
})
