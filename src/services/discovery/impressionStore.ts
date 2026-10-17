import type { SearchResult } from '../../types'
import { getProfileSetting, setProfileSetting } from '../profiles'
import { mediaKey } from './recommendationEngine'

const KEY = 'aurales_discovery_impressions_v1'
const MAX_IMPRESSIONS_PER_ITEM = 10
const MAX_IMPRESSED_ITEMS = 1_000

export function loadRecommendationImpressions(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(getProfileSetting(KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

    return Object.fromEntries(Object.entries(value)
      .filter(([key, count]) => key.length > 0 && typeof count === 'number' && Number.isFinite(count) && count >= 0)
      .map(([key, count]) => [key, Math.min(MAX_IMPRESSIONS_PER_ITEM, Math.floor(count as number))]))
  } catch {
    return {}
  }
}

export function recordRecommendationImpressions(items: SearchResult[]): void {
  if (items.length === 0) return
  const current = loadRecommendationImpressions()
  for (const item of items) {
    const key = mediaKey(item)
    current[key] = Math.min(MAX_IMPRESSIONS_PER_ITEM, (current[key] || 0) + 1)
  }
  const entries = Object.entries(current).sort((a, b) => b[1] - a[1]).slice(0, MAX_IMPRESSED_ITEMS)
  try { setProfileSetting(KEY, JSON.stringify(Object.fromEntries(entries))) } catch { /* best-effort preference data */ }
}
