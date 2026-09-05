import { describe, expect, it } from 'vitest'
import { buildUpcomingEvents, isReleaseInHorizon, keepNextReleasePerTitle, releaseTiming, type ReleaseEvent } from './upcoming'

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
      getSeason: async () => ({ episodes: [{ seasonNumber: 2, episodeNumber: 3, name: 'Next', airDate: '2099-01-02' }] }),
    })
    expect(events[0]).toMatchObject({ type: 'episode', seasonNumber: 2, episodeNumber: 3, relevanceScore: 120 })
    expect(events).toHaveLength(1)
  })
  it('keeps only the nearest upcoming episode for a show', () => {
    const show = { id: 'tmdb-9', tmdbId: 9, title: 'Show', type: 'series' as const, provider: 'local' as const }
    const releases: ReleaseEvent[] = [
      { id: 'episode-2', media: show, type: 'episode', seasonNumber: 2, episodeNumber: 2, releaseDate: '2026-09-12', relevanceScore: 120, relevanceReasons: [], source: 'tmdb', status: 'upcoming' },
      { id: 'episode-1', media: show, type: 'episode', seasonNumber: 2, episodeNumber: 1, releaseDate: '2026-09-05', relevanceScore: 120, relevanceReasons: [], source: 'tmdb', status: 'upcoming' },
      { id: 'season', media: show, type: 'season', seasonNumber: 2, releaseDate: '2026-09-01', relevanceScore: 100, relevanceReasons: [], source: 'tmdb', status: 'available' },
    ]
    expect(keepNextReleasePerTitle(releases, new Date('2026-09-04T12:00:00')).map((event) => event.id)).toEqual(['episode-1'])
  })
})
