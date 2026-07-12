import { describe, expect, it } from 'vitest'
import { mapTvdbEpisodeToProviders } from './animeProgressMapper'
import type { AnimeMappingResult, TvdbEpisodeMappingInput } from './types'

const input: TvdbEpisodeMappingInput = {
  localMediaId: 'tvdb-100',
  tvdbSeriesId: 100,
  tvdbSeasonNumber: 2,
  tvdbEpisodeNumber: 3,
}

const mapping: AnimeMappingResult = {
  localMediaId: 'tvdb-100',
  tvdbId: 100,
  anilistId: 10,
  simklId: 20,
  seasons: [
    { localMediaId: 'tvdb-100', seasonNumber: 1, tvdbSeasonNumber: 1, anilistId: 11, simklId: 21, episodeCount: 12 },
    { localMediaId: 'tvdb-100', seasonNumber: 2, tvdbSeasonNumber: 2, anilistId: 12, simklId: 22, episodeCount: 12 },
  ],
  confidence: 0.9,
  source: 'animeLists',
  updatedAt: new Date(0).toISOString(),
}

describe('anime episode mapping', () => {
  it('uses the selected cour ids and cour-relative episode', () => {
    const result = mapTvdbEpisodeToProviders(input, mapping, [])
    expect(result.anilist).toEqual({ mediaId: 12, episodeNumber: 3 })
    expect(result.simkl).toEqual({ id: 22, episodeNumber: 3 })
  })

  it('honors an exact provider override over inferred cour data', () => {
    const result = mapTvdbEpisodeToProviders(input, mapping, [{
      id: 'override-1',
      localMediaId: 'tvdb-100',
      seasonNumber: 2,
      episodeNumber: 3,
      provider: 'simkl',
      providerId: '999',
      providerSeasonNumber: 1,
      providerEpisodeNumber: 4,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }])
    expect(result.simkl).toEqual({ id: 999, seasonNumber: 1, episodeNumber: 4 })
    expect(result.source).toBe('override')
  })
})
