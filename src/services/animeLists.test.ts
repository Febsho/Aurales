import { afterEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  lookupByAniListId,
  lookupByImdbId,
  resolveAnimeIds,
  resolveAnimeEpisodeMappingWithNativeFallback,
  type AnimeEpisodeResolutionEntry,
} from './animeLists'

const entries: AnimeEpisodeResolutionEntry[] = [
  {
    anilistId: 101,
    malId: 201,
    tvdbId: 900,
    tmdbId: 800,
    tvdbSeason: 1,
    tvdbEpisodeOffset: 0,
    tmdbEpisodeOffset: 1,
    traktSeason: 1,
    tmdbSeason: 1,
  },
  {
    anilistId: 102,
    malId: 202,
    tvdbId: 900,
    tmdbId: 800,
    tvdbSeason: 1,
    tvdbEpisodeOffset: 12,
    tmdbEpisodeOffset: 13,
    traktSeason: 2,
    tmdbSeason: 1,
  },
]

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('native anime-list episode mapping compatibility', () => {
  it('uses the native indexed dataset lookup without changing raw mappings', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const mapping = { anilist_id: 101, mal_id: 201, tvdb_id: 900, imdb_id: ['tt1', 'tt2'] }
    invoke.mockResolvedValueOnce({ entries: [mapping], count: 1, stale: false })
    await expect(lookupByAniListId(101)).resolves.toEqual([mapping])
    expect(invoke).toHaveBeenCalledWith('lookup_anime_mappings', {
      request: expect.objectContaining({ platform: 'anilist', key: '101' }),
    })
  })

  it('preserves the worker-compatible first match behavior for IMDb arrays', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const first = { anilist_id: 101, imdb_id: ['tt1', 'tt2'] }
    invoke.mockResolvedValueOnce({ entries: [first, { anilist_id: 102, imdb_id: 'tt1' }], count: 2, stale: false })
    await expect(lookupByImdbId('tt1')).resolves.toEqual(first)
  })

  it('resolves known IDs through one coarse native ranking operation', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invoke.mockResolvedValueOnce({
      mapping: {
        anilist_id: 101,
        mal_id: 201,
        tvdb_id: 900,
        themoviedb_id: { tv: 800 },
        imdb_id: ['tt1', 'tt2'],
        season: { tvdb: 2 },
        tvdb_epoffset: 12,
      },
      stale: false,
    })
    await expect(resolveAnimeIds({ anilistId: 101, contentType: 'series' })).resolves.toMatchObject({
      anilistId: 101,
      malId: 201,
      tvdbId: 900,
      tmdbId: 800,
      imdbId: 'tt1',
      tvdbSeason: 2,
      tvdbEpOffset: 12,
      mediaKind: 'series',
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('resolve_anime_ids', {
      request: expect.objectContaining({ anilistId: '101', contentType: 'series' }),
    })
  })

  it('keeps the legacy strict cour boundary as the fallback authority', async () => {
    invoke.mockRejectedValueOnce(new Error('older application binary'))
    await expect(resolveAnimeEpisodeMappingWithNativeFallback({
      operation: 'tvdbToAnilist', entries, season: 1, episode: 12,
    })).resolves.toEqual({ anilistId: 101, absoluteEpisode: 12 })

    invoke.mockRejectedValueOnce(new Error('older application binary'))
    await expect(resolveAnimeEpisodeMappingWithNativeFallback({
      operation: 'tvdbToProviders', entries, season: 1, episode: 13,
    })).resolves.toMatchObject({
      anilistId: 102,
      episode: 1,
      season: 2,
      tmdbSeason: 1,
      tmdbEpisode: 14,
    })
  })

  it('uses the coarse native operation when it returns a parity result', async () => {
    const expected = { tvdbId: 900, season: 1, episode: 1 }
    invoke.mockResolvedValueOnce(expected)

    await expect(resolveAnimeEpisodeMappingWithNativeFallback({
      operation: 'anilistToTvdb', entries, season: 0, episode: 13,
    })).resolves.toEqual(expected)
    expect(invoke).toHaveBeenCalledWith('resolve_anime_episode_mapping', {
      request: expect.objectContaining({ operation: 'anilistToTvdb', episode: 13 }),
    })
  })

  it('only maps specials when the selected entries explicitly contain season zero', async () => {
    invoke.mockRejectedValueOnce(new Error('older application binary'))
    await expect(resolveAnimeEpisodeMappingWithNativeFallback({
      operation: 'tvdbToProviders',
      entries: [{ ...entries[0], tvdbSeason: 0 }],
      season: 0,
      episode: 1,
    })).resolves.toMatchObject({ anilistId: 101, episode: 1 })
  })
})
