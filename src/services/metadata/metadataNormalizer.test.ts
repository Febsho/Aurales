import { describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { normalizeMovie, normalizeMovieWithNativeFallback, normalizeShow, selectAnimeTitleWithNativeFallback } from './metadataNormalizer'

const input = { addonId: 'catalog', id: 'source-item', tmdbId: 12, tvdbId: 34 }

describe('provider metadata normalization compatibility', () => {
  it('keeps legacy movie identity and ignores malformed IDs', () => {
    const item = normalizeMovie({
      id: 'movie', title: 'Example', genres: [], cast: [], crew: [], recommendations: [], trailers: [],
      tmdbId: 'invalid', tvdbId: 'tvdb-44',
    }, input)
    expect(item).toMatchObject({ id: 'app_movie_source-item', tmdbId: undefined, tvdbId: 44, sourceMetadataProvider: 'tmdb' })
  })

  it('keeps TVDB precedence and empty season shape for shows', () => {
    const item = normalizeShow({
      id: 'show', title: 'Example', genres: [], seasons: [{ seasonNumber: 2, name: 'Second', episodeCount: 8 }],
      cast: [], crew: [], recommendations: [], trailers: [], tmdbId: 'tmdb-7', tvdbId: 'tvdb-42', provider: 'tvdb',
    }, input, 'show')
    expect(item).toMatchObject({ id: 'app_tvdb_42', sourceMetadataProvider: 'tvdb' })
    expect(item.seasons).toEqual([expect.objectContaining({ id: 'tvdb_42_s2', episodes: [] })])
  })

  it('falls back to the existing implementation when native normalization fails', async () => {
    invoke.mockRejectedValueOnce(new Error('older application binary'))
    const details = { id: 'movie', title: 'Example', genres: [], cast: [], crew: [], recommendations: [], trailers: [], tmdbId: 99 }
    await expect(normalizeMovieWithNativeFallback(details, input)).resolves.toMatchObject({ id: 'app_tmdb_movie_99' })
    expect(invoke).toHaveBeenCalledWith('normalize_provider_metadata', expect.objectContaining({ request: expect.objectContaining({ kind: 'movie' }) }))
  })

  it('uses the native result only for the characterized ID subset', async () => {
    invoke.mockResolvedValueOnce({ id: 'native', type: 'movie', genres: [], title: 'Native', sourceMetadataProvider: 'tmdb', updatedAt: 'now' })
    await expect(normalizeMovieWithNativeFallback({ id: 'movie', title: 'Example', genres: [], cast: [], crew: [], recommendations: [], trailers: [], tmdbId: 99 }, input))
      .resolves.toMatchObject({ id: 'native' })

    invoke.mockClear()
    await expect(normalizeMovieWithNativeFallback({ id: 'movie', title: 'Example', genres: [], cast: [], crew: [], recommendations: [], trailers: [], tmdbId: '0x63' }, input))
      .resolves.toMatchObject({ id: 'app_tmdb_movie_99' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('uses native anime title selection and falls back without changing title preference', async () => {
    invoke.mockResolvedValueOnce({ title: 'Romaji', originalTitle: 'Native', localizedTitle: 'English' })
    await expect(selectAnimeTitleWithNativeFallback({ english: 'English', romaji: 'Romaji', native: 'Native' }, 'romaji'))
      .resolves.toEqual({ title: 'Romaji', originalTitle: 'Native', localizedTitle: 'English' })
    expect(invoke).toHaveBeenCalledWith('select_anime_title', expect.anything())

    invoke.mockRejectedValueOnce(new Error('older application binary'))
    await expect(selectAnimeTitleWithNativeFallback({ english: '', romaji: 'Romaji' }, 'english'))
      .resolves.toEqual({ title: 'Romaji', originalTitle: undefined, localizedTitle: 'Romaji' })
  })
})
