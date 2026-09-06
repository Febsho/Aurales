import { describe, expect, it } from 'vitest'
import { parseDetailId } from './detailIds'

describe('detail ID namespaces', () => {
  it.each([
    ['app_tmdb_tv_123', 'tmdb', '123'],
    ['app_tmdb_movie_456', 'tmdb', '456'],
    ['app_tvdb_789', 'tvdb', '789'],
    ['app_show_tt123', 'imdb', 'tt123'],
    ['app_movie_tt456', 'imdb', 'tt456'],
  ])('extracts %s without leaking into other providers', (id, owner, expected) => {
    expect(parseDetailId(id, owner)).toBe(expected)
    for (const other of ['tmdb', 'tvdb', 'imdb', 'anilist', 'mal'].filter(p => p !== owner)) {
      expect(parseDetailId(id, other)).toBeUndefined()
    }
  })
  it('handles provider fields and rejects malformed values', () => {
    expect(parseDetailId(123, 'tvdb')).toBe('123')
    expect(parseDetailId('anilist:123', 'tmdb')).toBeUndefined()
    expect(parseDetailId('tt123', 'tmdb')).toBeUndefined()
    expect(parseDetailId('[object Object]', 'tvdb')).toBeUndefined()
  })
})
