import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})

import {
  mdblistPlaybackAction,
  scrobblePayload,
  normalizeMdblistPlayback,
  normalizeMdblistUpNext,
  normalizeMdblistWatched,
} from './mdblist'

describe('MDBList API normalization', () => {
  it('normalizes the current nested movie and episode playback response', () => {
    const items = normalizeMdblistPlayback([
      { id: 1, type: 'movie', progress: 41.5, movie: { title: 'Arrival', ids: { tmdb: 329865 } } },
      {
        id: 2,
        type: 'episode',
        progress_at_update: 62,
        show: { title: 'Severance', ids: { tmdb: 95396 } },
        episode: { season: { number: 0 }, episode: 3 },
      },
    ])

    expect(items[0]).toMatchObject({ type: 'movie', progress: 41.5 })
    expect(items[1]).toMatchObject({
      type: 'episode',
      progress: 62,
      episode: { season: 0, number: 3 },
      show: { title: 'Severance' },
    })
  })

  it('uses the server-resolved next episode instead of incrementing locally', () => {
    const items = normalizeMdblistUpNext({
      items: [{
        show: { title: 'Slow Horses', ids: { imdb: 'tt5875444', tmdb: 95480 } },
        next_episode: { season: 3, number: 1 },
        last_watched_at: '2026-09-12T20:00:00Z',
      }],
    })

    expect(items).toEqual([expect.objectContaining({
      title: 'Slow Horses',
      tmdbId: 95480,
      season: 3,
      episode: 1,
    })])
  })

  it('expands nested watched seasons and keeps specials season zero', () => {
    const items = normalizeMdblistWatched({
      shows: [{
        show: { title: 'Doctor Who', ids: { tvdb: 76107 } },
        seasons: [{ number: 0, episodes: [{ number: 2, watched_at: '2026-09-01T12:00:00Z' }] }],
      }],
    })

    expect(items).toEqual([expect.objectContaining({
      media_type: 'show',
      tvdb_id: 76107,
      season: 0,
      episode: 2,
    })])
  })

  it('matches MDBList watched and resume semantics at 80 percent', () => {
    expect(mdblistPlaybackAction('start', 0, false, true)).toBeNull()
    expect(mdblistPlaybackAction('stop', 79.99, true, true)).toBe('stop')
    expect(mdblistPlaybackAction('stop', 79.99, true, false)).toBe('stop')
    expect(mdblistPlaybackAction('stop', 80, true, false)).toBe('stop')
    expect(mdblistPlaybackAction('pause', 80, false, true)).toBe('clear')
    expect(mdblistPlaybackAction('pause', 20, true, false)).toBe('pause')
    expect(mdblistPlaybackAction('stop', 20, true, false)).toBe('stop')
  })

  it('uses MDBList episode scrobble nesting', () => {
    expect(scrobblePayload(123, 'series', 35, 2, 4)).toEqual({
      show: { ids: { tmdb: 123 }, season: { number: 2, episode: { number: 4 } } },
      progress: 35,
    })
  })
})
