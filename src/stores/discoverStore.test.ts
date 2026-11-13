import { describe, expect, it } from 'vitest'
import { toggleDiscoverContentType } from './discoverStore'

describe('Discovery content filters', () => {
  it('allows every non-empty Movies, Shows, and Anime combination', () => {
    expect(toggleDiscoverContentType(['movies', 'shows'], 'anime')).toEqual(['movies', 'shows', 'anime'])
    expect(toggleDiscoverContentType(['movies', 'shows'], 'shows')).toEqual(['movies'])
    expect(toggleDiscoverContentType(['movies', 'anime'], 'movies')).toEqual(['anime'])
    expect(toggleDiscoverContentType(['movies'], 'shows')).toEqual(['movies', 'shows'])
  })

  it('keeps at least one content type selected', () => {
    const onlyMovies: Array<'movies' | 'shows' | 'anime'> = ['movies']
    expect(toggleDiscoverContentType(onlyMovies, 'movies')).toBe(onlyMovies)
  })
})
