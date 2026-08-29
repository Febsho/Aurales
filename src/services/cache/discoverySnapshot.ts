import type { SearchResult } from '../../types'
import type { RankedRecommendation } from '../discovery/types'
import type { DailySnapshotMeta } from '../discovery/dailySnapshot'

export interface DiscoveryRowSnapshot {
  items: SearchResult[]
  timestamp: number
}

export interface DiscoveryScreenSnapshot {
  version: 3
  cachedRows: Record<string, DiscoveryRowSnapshot>
  rankedSnapshots: Record<string, RankedRecommendation[]>
  dailySnapshotMeta: Record<string, DailySnapshotMeta>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSearchResult(value: unknown): value is SearchResult {
  if (!isRecord(value)) return false
  return (typeof value.id === 'string' || typeof value.id === 'number')
    && typeof value.title === 'string'
    && (value.type === 'movie' || value.type === 'series')
}

/** Durable snapshots intentionally survive age/day boundaries until replaced. */
export function retainDiscoverySnapshot(saved?: (Partial<Omit<DiscoveryScreenSnapshot, 'version'>> & { version?: 2 | 3 }) | null) {
  const cachedRows: Record<string, DiscoveryRowSnapshot> = {}
  if (isRecord(saved?.cachedRows)) {
    for (const [key, value] of Object.entries(saved.cachedRows)) {
      if (!isRecord(value) || !Array.isArray(value.items)) continue
      const items = value.items.filter(isSearchResult)
      if (items.length === 0 && value.items.length > 0) continue
      cachedRows[key] = {
        items,
        timestamp: typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? value.timestamp : 0,
      }
    }
  }

  const rankedSnapshots: Record<string, RankedRecommendation[]> = {}
  if (isRecord(saved?.rankedSnapshots)) {
    for (const [key, value] of Object.entries(saved.rankedSnapshots)) {
      if (!Array.isArray(value)) continue
      const entries = value.filter((entry): entry is RankedRecommendation => isRecord(entry) && isSearchResult(entry.item))
      if (entries.length === 0 && value.length > 0) continue
      rankedSnapshots[key] = entries
    }
  }

  const dailySnapshotMeta: Record<string, DailySnapshotMeta> = {}
  if (isRecord(saved?.dailySnapshotMeta)) {
    for (const [key, value] of Object.entries(saved.dailySnapshotMeta)) {
      if (!isRecord(value) || typeof value.dateKey !== 'string' || typeof value.generatedAt !== 'number'
        || typeof value.profileFingerprint !== 'string' || typeof value.algorithmVersion !== 'number') continue
      dailySnapshotMeta[key] = value as DailySnapshotMeta
    }
  }

  return {
    cachedRows,
    rankedSnapshots,
    dailySnapshotMeta,
  }
}
