import { describe, expect, it } from 'vitest'
import { buildUpcomingEvents, isReleaseInHorizon, releaseTiming, type ReleaseEvent } from './upcoming'

const event = (releaseDate?: string): ReleaseEvent => ({ id: 'x', media: { id: 'x', title: 'X', type: 'movie', provider: 'local' }, type: 'movie', releaseDate, relevanceScore: 1, relevanceReasons: [], source: 'local', status: 'upcoming' })
describe('Upcoming date policy', () => {
  it('keeps provider date-only releases timezone-safe', () => {
    const now = new Date('2026-08-30T23:30:00-07:00')
    expect(isReleaseInHorizon(event('2026-08-31'), 1, now)).toBe(true)
    expect(releaseTiming('2026-08-31', now)).toBe('In 1 day')
  })
  it('does not place unknown dates in the compact horizon', () => expect(isReleaseInHorizon(event(), 14)).toBe(false))
  it('ranks dated episodes for actively watched series above a season announcement', async () => {
    const events = await buildUpcomingEvents({
      watchlist: [],
      progress: [{ id: 'x', mediaId: 'tmdb-9', mediaType: 'series', progressSeconds: 300, durationSeconds: 1200, completed: false, title: 'Show', tmdbId: 9 }],
      getShow: async () => ({ title: 'Show', tmdbId: 9, seasons: [{ seasonNumber: 2, airDate: '2099-01-01' }] }),
      getSeason: async () => ({ episodes: [{ seasonNumber: 2, episodeNumber: 3, name: 'Next', airDate: '2026-09-02' }] }),
    })
    expect(events[0]).toMatchObject({ type: 'episode', seasonNumber: 2, episodeNumber: 3, relevanceScore: 120 })
  })
})
