import type { SearchResult } from '../../types'
import { mediaKey } from './recommendationEngine'
import type { RecommendationFeedback, RecommendationFeedbackKind } from './types'
import { profileStorageKey } from '../profiles'
import { enqueueSyncRecord } from '../sync/syncQueue'

const KEY = 'aurales_discovery_feedback_v1'
export function loadRecommendationFeedback(): RecommendationFeedback[] { try { const value = JSON.parse(localStorage.getItem(profileStorageKey(KEY)) || '[]'); return Array.isArray(value) ? value : [] } catch { return [] } }
export function saveRecommendationFeedback(item: SearchResult, kind: RecommendationFeedbackKind, genreId?: number): RecommendationFeedback[] {
  const entry: RecommendationFeedback = { mediaKey: mediaKey(item), kind, item: { id:item.id,title:item.title,type:item.type,provider:item.provider,tmdbId:item.tmdbId,imdbId:item.imdbId,tvdbId:item.tvdbId,anilistId:item.anilistId,malId:item.malId,genreIds:item.genreIds,genres:item.genres,overview:item.overview,year:item.year,runtime:item.runtime,originalLanguage:item.originalLanguage,originCountry:item.originCountry,isAnime:item.isAnime }, createdAt: Date.now(), genreId: kind === 'hide-genre' ? genreId : undefined }
  // Multiple hidden genres from one title are independent preferences.
  const samePreference = (value: RecommendationFeedback) => kind === 'hide-genre'
    ? mediaKey(value.item) === entry.mediaKey && value.kind === 'hide-genre' && value.genreId === entry.genreId
    : mediaKey(value.item) === entry.mediaKey && value.kind !== 'hide-genre'
  const next = [entry, ...loadRecommendationFeedback().filter((value) => !samePreference(value))].slice(0, 500)
  try { localStorage.setItem(profileStorageKey(KEY), JSON.stringify(next)) } catch { /* best-effort preference data */ }
  enqueueSyncRecord('discovery-feedback', kind === 'hide-genre' ? `${entry.mediaKey}:genre:${genreId}` : entry.mediaKey, entry)
  window.dispatchEvent(new CustomEvent('aurales:discovery-feedback')); return next
}

export function unhideRecommendationGenre(genreId: number): RecommendationFeedback[] {
  const next = loadRecommendationFeedback().filter((entry) => entry.kind !== 'hide-genre' || (entry.genreId == null ? !entry.item.genreIds?.includes(genreId) : entry.genreId !== genreId))
  try { localStorage.setItem(profileStorageKey(KEY), JSON.stringify(next)) } catch { /* keep live preference */ }
  enqueueSyncRecord('discovery-feedback', `genre:${genreId}`, { kind: 'show-genre', genreId })
  window.dispatchEvent(new CustomEvent('aurales:discovery-feedback'))
  return next
}

/** Removes taste-picker signals and syncs a clear marker for each selected title. */
export function resetTasteFeedback(items: RecommendationFeedback['item'][], storedMediaKeys: string[] = []): RecommendationFeedback[] {
  const keys = new Set([...items.map((item) => mediaKey(item)), ...storedMediaKeys])
  const next = loadRecommendationFeedback().filter((entry) => !(entry.kind === 'more-like-this' && (keys.has(entry.mediaKey) || keys.has(mediaKey(entry.item)))))
  try { localStorage.setItem(profileStorageKey(KEY), JSON.stringify(next)) } catch { /* keep live preference */ }
  for (const key of keys) enqueueSyncRecord('discovery-feedback', key, { kind: 'clear', mediaKey: key })
  window.dispatchEvent(new CustomEvent('aurales:discovery-feedback'))
  return next
}
