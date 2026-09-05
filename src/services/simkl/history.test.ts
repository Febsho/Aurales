import { describe, expect, it } from 'vitest'
import { extractWatchedEpisodes } from './history'

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
})
