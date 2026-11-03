import type { SearchResult } from '../../types'
import { mediaIdentity } from '../mediaPresentation'
import type { RankedRecommendation } from './types'

export const MIN_WIDESCREEN_RECOMMENDATIONS = 2

/** Public, poster-and-backdrop movie picks for the widescreen shelf. */
export function selectWidescreenMovies(
  currentTrends: readonly RankedRecommendation[],
  ranked: readonly RankedRecommendation[],
  spotlightKey?: string,
  limit = 20,
): SearchResult[] {
  const seen = new Set<string>()
  return [...currentTrends, ...ranked]
    .filter(({ item }) => {
      const key = mediaIdentity(item)
      if (item.type !== 'movie' || !item.poster || !item.backdrop || key === spotlightKey || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) =>
      (right.popularity || 0) - (left.popularity || 0)
      || right.score.total - left.score.total,
    )
    .slice(0, limit)
    .map((entry) => entry.item)
}
