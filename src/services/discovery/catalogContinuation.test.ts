import { describe, expect, it } from 'vitest'
import type { DiscoveryCatalogContinuation, SearchResult } from '../../types'
import { matchesDiscoveryContinuation } from './catalogContinuation'

function item(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'fixture', title: 'Fixture', type: 'movie', provider: 'tmdb', poster: '/poster.jpg',
    genreIds: [18], originalLanguage: 'en', ...overrides,
  }
}

const mixed: DiscoveryCatalogContinuation = {
  configs: [], tab: 'movies', tabs: ['movies', 'series', 'anime'],
}

describe('Discovery catalog continuation content types', () => {
  it('keeps movies, shows, and anime in a mixed catalog', () => {
    expect(matchesDiscoveryContinuation(item(), mixed)).toBe(true)
    expect(matchesDiscoveryContinuation(item({ type: 'series' }), mixed)).toBe(true)
    expect(matchesDiscoveryContinuation(item({ type: 'series', genreIds: [16], originalLanguage: 'ja' }), mixed)).toBe(true)
    expect(matchesDiscoveryContinuation(item({ type: 'movie', genreIds: [16], originalLanguage: 'ja' }), mixed)).toBe(true)
  })

  it('keeps anime out of ordinary movie and show catalogs', () => {
    expect(matchesDiscoveryContinuation(item({ type: 'movie', genreIds: [16], originalLanguage: 'ja' }), {
      configs: [], tab: 'movies', tabs: ['movies'],
    })).toBe(false)
    expect(matchesDiscoveryContinuation(item({ type: 'series', genreIds: [16], originalLanguage: 'ja' }), {
      configs: [], tab: 'series', tabs: ['series'],
    })).toBe(false)
  })

  it('preserves legacy single-tab continuation behavior', () => {
    expect(matchesDiscoveryContinuation(item({ type: 'series' }), { configs: [], tab: 'series' })).toBe(true)
    expect(matchesDiscoveryContinuation(item(), { configs: [], tab: 'series' })).toBe(false)
  })
})
