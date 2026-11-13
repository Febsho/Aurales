import type { DiscoveryCatalogContinuation, SearchResult } from '../../types'
import { mediaIdentity } from '../mediaPresentation'

/** Check that a continuation result belongs to one of the requested families. */
export function matchesDiscoveryContinuation(item: SearchResult, continuation: DiscoveryCatalogContinuation): boolean {
  const isAnime = Boolean(item.isAnime || (item.genreIds?.includes(16) && ['ja', 'zh', 'ko'].includes(item.originalLanguage || '')))
  const tabs = continuation.tabs?.length ? continuation.tabs : [continuation.tab]
  const matchesTab = tabs.some((tab) => tab === 'anime'
    ? isAnime
    : tab === 'movies'
      ? item.type === 'movie' && !isAnime
      : item.type === 'series' && !isAnime)
  if (!matchesTab || !item.poster) return false
  if (continuation.genreIds?.length && !item.genreIds?.some((genreId) => continuation.genreIds!.includes(genreId))) return false
  if (continuation.maxPopularity != null && (item.popularity == null || item.popularity >= continuation.maxPopularity)) return false
  if (continuation.minRating != null && (item.rating == null || item.rating < continuation.minRating)) return false
  if (continuation.excludeIds?.includes(mediaIdentity(item))) return false
  return true
}
