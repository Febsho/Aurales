import type { SearchResult } from '../../types'
import { mediaKey } from './recommendationEngine'
import type { RecommendationFeedback, RecommendationFeedbackKind } from './types'
import { profileStorageKey } from '../profiles'
import { enqueueSyncRecord } from '../sync/syncQueue'

const KEY = 'aurales_discovery_feedback_v1'
export function loadRecommendationFeedback(): RecommendationFeedback[] { try { const value = JSON.parse(localStorage.getItem(profileStorageKey(KEY)) || '[]'); return Array.isArray(value) ? value : [] } catch { return [] } }
export function saveRecommendationFeedback(item: SearchResult, kind: RecommendationFeedbackKind): RecommendationFeedback[] {
  const entry: RecommendationFeedback = { mediaKey: mediaKey(item), kind, item: { id:item.id,title:item.title,type:item.type,tmdbId:item.tmdbId,genreIds:item.genreIds }, createdAt: Date.now() }
  const next = [entry, ...loadRecommendationFeedback().filter((value) => value.mediaKey !== entry.mediaKey)].slice(0, 500)
  try { localStorage.setItem(profileStorageKey(KEY), JSON.stringify(next)) } catch { /* best-effort preference data */ }
  enqueueSyncRecord('discovery-feedback', entry.mediaKey, entry)
  window.dispatchEvent(new CustomEvent('aurales:discovery-feedback')); return next
}
