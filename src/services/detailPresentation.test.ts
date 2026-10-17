import { describe, expect, it } from 'vitest'
import { moviePrimaryLabel, promoteDecodedArtwork, seriesPrimaryLabel } from './detailPresentation'

describe('cinematic detail presentation', () => {
  it('describes partial movie progress without creating playback state', () => {
    expect(moviePrimaryLabel(false, { progressSeconds: 48 * 60, durationSeconds: 120 * 60 }))
      .toBe('Resume • 1h 12m left')
    expect(moviePrimaryLabel(true, null)).toBe('Watch Again')
  })

  it('distinguishes continue and next-episode actions', () => {
    expect(seriesPrimaryLabel({ allWatched: false, resume: { season: 2, episode: 4 }, hasHistory: true }))
      .toBe('Continue S2 E4')
    expect(seriesPrimaryLabel({
      allWatched: false,
      next: { seasonNumber: 2, episodeNumber: 5 },
      hasHistory: true,
    })).toBe('Next Episode • S2 E5')
  })

  it('keeps successful artwork visible until a decoded upgrade is ready', () => {
    expect(promoteDecodedArtwork('cached.jpg', 'better.jpg', false)).toEqual({ current: 'cached.jpg' })
    expect(promoteDecodedArtwork('cached.jpg', 'better.jpg', true)).toEqual({
      current: 'better.jpg',
      previous: 'cached.jpg',
    })
  })
})
