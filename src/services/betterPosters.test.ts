import { describe, expect, it } from 'vitest'
import { DEFAULT_BETTER_POSTERS_SETTINGS, getBetterPostersUrl } from './betterPosters'

describe('BetterPosters URL generation', () => {
  it('uses BetterPosters defaults without unnecessary query parameters', () => {
    expect(getBetterPostersUrl(DEFAULT_BETTER_POSTERS_SETTINGS))
      .toBe('https://btttr.cc/poster/imdb/poster-default/{imdb_id}.jpg')
  })

  it('encodes enabled artwork badges and rating preferences', () => {
    expect(getBetterPostersUrl({
      ...DEFAULT_BETTER_POSTERS_SETTINGS,
      qualityTags: true,
      showGenre: false,
      ageRating: true,
      trendTags: false,
      ratingSource: 'RT',
      language: 'de',
    })).toBe('https://btttr.cc/poster-rqa/imdb/poster-default/{imdb_id}.jpg?tag=none&lang=de&rs=RT')
  })
})
