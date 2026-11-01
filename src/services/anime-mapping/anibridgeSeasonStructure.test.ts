import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAniBridgeTvdbSeasonScopes, mergeAniBridgeTvdbSeasons } from './anibridgeSeasonStructure'
import type { ShowDetails } from '../../types'

const show: ShowDetails = {
  id: 'tvdb-42', title: 'Example Anime', year: 2020, genres: [], seasons: [
    { seasonNumber: 1, name: 'Season One', episodeCount: 0 },
  ], cast: [], crew: [], recommendations: [], trailers: [], provider: 'tvdb',
}

afterEach(() => vi.unstubAllGlobals())

describe('AniBridge TVDB season scopes', () => {
  it('loads TVDB season numbers and episode counts from AniBridge scopes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ metadata: {
      id: { provider: 'tvdb_show', provider_id: '42', descriptor: 'tvdb_show:42' },
      scopes: {
        s1: { id: { descriptor: 'tvdb_show:42:s1' }, titles: { display: 'First Cour' }, units: 12, release: { start_date: '2020-01-01' } },
        s2: { id: { descriptor: 'tvdb_show:42:s2' }, units: 13, release: { start_date: '2021-01-01' } },
        s3: { id: { descriptor: 'tvdb_show:99:s3' }, units: 24 },
      },
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const seasons = await getAniBridgeTvdbSeasonScopes(42)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://metadata.anibridge.eliasbenb.dev/api/metadata/tvdb_show%3A42',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(seasons.map(({ seasonNumber, episodeCount }) => [seasonNumber, episodeCount])).toEqual([[1, 12], [2, 13]])
  })

  it('adds bridge seasons while preserving TVDB names and artwork', () => {
    const bridged = [
      { seasonNumber: 1, name: 'Bridge title', episodeCount: 12 },
      { seasonNumber: 2, name: 'Season 2', episodeCount: 13 },
    ]

    const merged = mergeAniBridgeTvdbSeasons(show, bridged)

    expect(merged.seasons).toEqual([
      expect.objectContaining({ seasonNumber: 1, name: 'Season One', episodeCount: 12 }),
      expect.objectContaining({ seasonNumber: 2, name: 'Season 2', episodeCount: 13 }),
    ])
  })
})
