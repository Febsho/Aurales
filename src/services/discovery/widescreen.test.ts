import { describe, expect, it } from 'vitest'
import { mediaIdentity } from '../mediaPresentation'
import { buildTasteProfile, rankCandidates } from './recommendationEngine'
import type { DiscoveryActivity, RecommendationCandidate } from './types'
import { MIN_WIDESCREEN_RECOMMENDATIONS, selectWidescreenMovies } from './widescreen'

function candidate(id: number, overrides: Partial<RecommendationCandidate['item']> = {}): RecommendationCandidate {
  return {
    item: {
      id: `tmdb-${id}`, tmdbId: id, title: `Movie ${id}`, type: 'movie', provider: 'tmdb',
      poster: `poster-${id}`, backdrop: `backdrop-${id}`, rating: 7.5, year: 2026,
      ...overrides,
    },
    source: 'tmdb-discover',
    popularity: 50,
    voteCount: 100,
  }
}

describe('Discovery widescreen picks', () => {
  it('shows the reference row with two results and keeps it public, cinematic, and deduplicated', () => {
    const first = candidate(1)
    const second = candidate(2)
    const third = candidate(3)
    const missingBackdrop = candidate(4, { backdrop: undefined })
    const series = candidate(5, { type: 'series' })
    const activity: DiscoveryActivity = { progress: [], recent: [] }
    const profile = buildTasteProfile(activity)
    const trends = rankCandidates([first, second], profile, activity, [], 'for-you')
    const general = rankCandidates([second, third, missingBackdrop, series], profile, activity, [], 'for-you')
    const spotlightKey = mediaIdentity(first.item)

    expect(MIN_WIDESCREEN_RECOMMENDATIONS).toBe(2)
    expect(selectWidescreenMovies(trends, general, spotlightKey).map((item) => item.tmdbId)).toEqual([2, 3])
  })
})
