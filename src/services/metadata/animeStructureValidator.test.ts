import { describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { validateAnimeTvdbStructure, validateAnimeTvdbStructureWithNativeFallback } from './animeStructureValidator'

const episode = (episodeNumber: number, overrides = {}) => ({
  id: `episode-${episodeNumber}`, seasonNumber: 1, episodeNumber, title: `Episode ${episodeNumber}`,
  isReleased: true, airDate: '2020-01-01', ...overrides,
})

describe('anime structure validation compatibility', () => {
  it('characterizes flattened multi-season scoring', () => {
    const seasons = [{ id: 's1', seasonNumber: 1, episodeCount: 14, episodes: Array.from({ length: 14 }, (_, i) => episode(i + 1, { absoluteEpisodeNumber: i + 1 })), airDate: '2020-01-01' }]
    expect(validateAnimeTvdbStructure(seasons, true)).toEqual({
      valid: false,
      reason: 'Single season with 13+ episodes where multi-season expected from relations',
      suspiciousSingleSeasonFlattening: true,
      hasMultipleRealSeasons: false,
      seasonCount: 1,
      totalEpisodeCount: 14,
      score: -60,
    })
  })

  it('uses native results but falls back without altering decisions', async () => {
    const seasons = [{ id: 's1', seasonNumber: 1, episodeCount: 1, episodes: [episode(1)], airDate: '2020-01-01' }]
    invoke.mockResolvedValueOnce({ valid: true, suspiciousSingleSeasonFlattening: false, hasMultipleRealSeasons: true, seasonCount: 2, totalEpisodeCount: 2, score: 70 })
    await expect(validateAnimeTvdbStructureWithNativeFallback(seasons)).resolves.toMatchObject({ hasMultipleRealSeasons: true })
    invoke.mockRejectedValueOnce(new Error('older binary'))
    await expect(validateAnimeTvdbStructureWithNativeFallback(seasons)).resolves.toEqual(validateAnimeTvdbStructure(seasons))
  })
})
