import { describe, expect, it } from 'vitest'
import { extractWatchedEpisodes, normalizeSimklHistoryItems } from './history'

describe('extractWatchedEpisodes', () => {
  it('keeps Simkl anime episode TVDB mappings for watched-status checks', () => {
    expect(extractWatchedEpisodes({
      last_watched_at: '2026-09-05T10:00:00Z',
      seasons: [{
        number: 3,
        episodes: [{
          number: 14,
          watched_at: '2026-09-05T10:00:00Z',
          tvdb: { season: 1, episode: 6 },
        }],
      }],
    })).toEqual([{
      season: 3,
      episode: 14,
      watchedAt: '2026-09-05T10:00:00Z',
      tvdbSeason: 1,
      tvdbEpisode: 6,
    }])
  })

  it('normalizes the object-wrapped show history returned by Simkl', () => {
    expect(normalizeSimklHistoryItems({
      shows: [{
        title: 'Lanterns',
        year: 2026,
        ids: { simkl: 123, imdb: 'tt31038430', tmdb: 124331, tvdb: 436048 },
        seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2026-09-10T12:00:00Z' }] }],
      }],
    }, 'watching')).toEqual([expect.objectContaining({
      type: 'show',
      title: 'Lanterns',
      simklId: 123,
      status: 'watching',
      watchedEpisodes: [expect.objectContaining({ season: 1, episode: 1 })],
    })])
  })
})
