import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSeason } from './types'

// Mock the tvdbProvider.getSeason so we don't need a real TVDB API call
vi.mock('../tvdb', () => ({
  tvdbProvider: {
    getSeason: vi.fn(),
  },
}))

import { mapTvdbSeasons } from './tvdbSeasonMapper'
import { tvdbProvider } from '../tvdb'

const mockedGetSeason = vi.mocked(tvdbProvider.getSeason)

// Test fixture: multi-season anime with season 3 unreleased
const SEASON_1_EPISODES = [
  { id: '101', seasonNumber: 1, episodeNumber: 1, name: 'S1E1', overview: 'First episode', airDate: '2023-01-01', runtime: 24 },
  { id: '102', seasonNumber: 1, episodeNumber: 2, name: 'S1E2', overview: 'Second episode', airDate: '2023-01-08', runtime: 24 },
]

const SEASON_2_EPISODES = [
  { id: '201', seasonNumber: 2, episodeNumber: 1, name: 'S2E1', overview: 'Season 2 start', airDate: '2024-01-01', runtime: 24 },
  { id: '202', seasonNumber: 2, episodeNumber: 2, name: 'S2E2', overview: 'Season 2 ep 2', airDate: '2024-01-08', runtime: 24 },
]

const SEASON_3_EPISODES = [
  { id: '301', seasonNumber: 3, episodeNumber: 1, name: 'S3E1', overview: 'Future episode', airDate: '2099-01-01', runtime: 24 },
]

const SPECIALS_EPISODES = [
  { id: '001', seasonNumber: 0, episodeNumber: 1, name: 'OVA 1', overview: 'Special OVA', airDate: '2023-06-01', runtime: 24 },
]

function makeSeasonSummary(seasonNumber: number, title?: string): AppSeason {
  return {
    id: `season-${seasonNumber}`,
    seasonNumber,
    title: title || (seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`),
    episodeCount: 0,
    episodes: [],
  }
}

describe('mapTvdbSeasons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves TVDB season numbers for multi-season anime', async () => {
    mockedGetSeason.mockImplementation(async (_showId: string, season: number) => {
      if (season === 1) return { seasonNumber: 1, name: 'Season 1', episodes: SEASON_1_EPISODES }
      if (season === 2) return { seasonNumber: 2, name: 'Season 2', episodes: SEASON_2_EPISODES }
      if (season === 3) return { seasonNumber: 3, name: 'Season 3', episodes: SEASON_3_EPISODES }
      return { seasonNumber: season, name: `Season ${season}`, episodes: [] }
    })

    const summaries = [makeSeasonSummary(1), makeSeasonSummary(2), makeSeasonSummary(3)]
    const seasons = await mapTvdbSeasons(12345, summaries, {
      hideUnairedSeasons: true,
      hideUnairedEpisodes: true,
      includeSpecials: false,
      today: '2025-06-01',
    })

    // Season 1 should have 2 episodes
    expect(seasons[0].seasonNumber).toBe(1)
    expect(seasons[0].episodes.length).toBe(2)
    expect(seasons[0].episodes[0].episodeNumber).toBe(1)
    expect(seasons[0].episodes[0].seasonNumber).toBe(1)
    expect(seasons[0].episodes[1].episodeNumber).toBe(2)

    // Season 2 should have 2 episodes
    expect(seasons[1].seasonNumber).toBe(2)
    expect(seasons[1].episodes.length).toBe(2)
    expect(seasons[1].episodes[0].episodeNumber).toBe(1)
    expect(seasons[1].episodes[0].seasonNumber).toBe(2)

    // Season 3 should be hidden (unreleased — airDate 2099-01-01)
    expect(seasons.find(s => s.seasonNumber === 3)).toBeUndefined()

    // Only 2 seasons total
    expect(seasons.length).toBe(2)
  })

  it('stores absoluteEpisodeNumber separately from display numbers', async () => {
    mockedGetSeason.mockImplementation(async (_showId: string, season: number) => {
      if (season === 1) return { seasonNumber: 1, name: 'Season 1', episodes: SEASON_1_EPISODES }
      if (season === 2) return { seasonNumber: 2, name: 'Season 2', episodes: SEASON_2_EPISODES }
      return { seasonNumber: season, name: `Season ${season}`, episodes: [] }
    })

    const summaries = [makeSeasonSummary(1), makeSeasonSummary(2)]
    const seasons = await mapTvdbSeasons(12345, summaries, {
      hideUnairedSeasons: false,
      hideUnairedEpisodes: false,
      includeSpecials: false,
      today: '2025-06-01',
    })

    // Season 1 episode numbers are 1, 2 (not absolute)
    expect(seasons[0].episodes[0].episodeNumber).toBe(1)
    expect(seasons[0].episodes[1].episodeNumber).toBe(2)

    // Season 2 episode numbers restart at 1 (not 13, 14)
    expect(seasons[1].episodes[0].episodeNumber).toBe(1)
    expect(seasons[1].episodes[0].seasonNumber).toBe(2)

    // absoluteEpisodeNumber should be computed across seasons
    expect(seasons[0].episodes[0].absoluteEpisodeNumber).toBe(1)
    expect(seasons[0].episodes[1].absoluteEpisodeNumber).toBe(2)
    expect(seasons[1].episodes[0].absoluteEpisodeNumber).toBe(3) // continues from season 1
    expect(seasons[1].episodes[1].absoluteEpisodeNumber).toBe(4)
  })

  it('does not put all episodes into Season 1', async () => {
    mockedGetSeason.mockImplementation(async (_showId: string, season: number) => {
      if (season === 1) return { seasonNumber: 1, name: 'Season 1', episodes: SEASON_1_EPISODES }
      if (season === 2) return { seasonNumber: 2, name: 'Season 2', episodes: SEASON_2_EPISODES }
      return { seasonNumber: season, name: `Season ${season}`, episodes: [] }
    })

    const summaries = [makeSeasonSummary(1), makeSeasonSummary(2)]
    const seasons = await mapTvdbSeasons(12345, summaries, {
      today: '2025-06-01',
    })

    // Season 1 should NOT contain Season 2 episodes
    const s1EpNums = seasons[0].episodes.map(e => e.episodeNumber)
    expect(s1EpNums).toEqual([1, 2])
    expect(seasons[0].episodes.length).toBe(2)

    // Season 2 episodes should be in Season 2, not Season 1
    expect(seasons[1].episodes.length).toBe(2)
    expect(seasons[1].episodes.every(e => e.seasonNumber === 2)).toBe(true)

    // No episode 13 or 14 in Season 1
    expect(seasons[0].episodes.find(e => e.episodeNumber === 13)).toBeUndefined()
    expect(seasons[0].episodes.find(e => e.episodeNumber === 14)).toBeUndefined()
  })

  it('includes specials (season 0) when enabled', async () => {
    mockedGetSeason.mockImplementation(async (_showId: string, season: number) => {
      if (season === 0) return { seasonNumber: 0, name: 'Specials', episodes: SPECIALS_EPISODES }
      if (season === 1) return { seasonNumber: 1, name: 'Season 1', episodes: SEASON_1_EPISODES }
      return { seasonNumber: season, name: `Season ${season}`, episodes: [] }
    })

    const summaries = [makeSeasonSummary(0, 'Specials'), makeSeasonSummary(1)]
    const seasons = await mapTvdbSeasons(12345, summaries, {
      includeSpecials: true,
      today: '2025-06-01',
    })

    expect(seasons.some(s => s.seasonNumber === 0)).toBe(true)
    expect(seasons.some(s => s.seasonNumber === 1)).toBe(true)
  })

  it('excludes specials when disabled', async () => {
    mockedGetSeason.mockImplementation(async (_showId: string, season: number) => {
      if (season === 0) return { seasonNumber: 0, name: 'Specials', episodes: SPECIALS_EPISODES }
      if (season === 1) return { seasonNumber: 1, name: 'Season 1', episodes: SEASON_1_EPISODES }
      return { seasonNumber: season, name: `Season ${season}`, episodes: [] }
    })

    const summaries = [makeSeasonSummary(0, 'Specials'), makeSeasonSummary(1)]
    const seasons = await mapTvdbSeasons(12345, summaries, {
      includeSpecials: false,
      today: '2025-06-01',
    })

    expect(seasons.every(s => s.seasonNumber !== 0)).toBe(true)
    expect(seasons.length).toBe(1)
    expect(seasons[0].seasonNumber).toBe(1)
  })

  it('handles episodes without airDate (treats as released)', async () => {
    const noDateEpisodes = [
      { id: '101', seasonNumber: 1, episodeNumber: 1, name: 'Episode 1', overview: 'Test', runtime: 24 },
      { id: '102', seasonNumber: 1, episodeNumber: 2, name: 'Episode 2', overview: 'Test', runtime: 24 },
    ]

    mockedGetSeason.mockResolvedValue({ seasonNumber: 1, name: 'Season 1', episodes: noDateEpisodes })

    const summaries = [makeSeasonSummary(1)]
    const seasons = await mapTvdbSeasons(12345, summaries, {
      hideUnairedEpisodes: true,
      today: '2025-06-01',
    })

    // Episodes without airDate should still appear (isAired returns true for no date)
    expect(seasons[0].episodes.length).toBe(2)
  })
})
