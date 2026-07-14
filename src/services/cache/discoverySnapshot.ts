import type { SearchResult } from '../../types'
import type { RankedRecommendation } from '../discovery/types'

export interface DiscoveryRowSnapshot {
  items: SearchResult[]
  timestamp: number
}

export interface DiscoveryScreenSnapshot {
  version: 2
  cachedRows: Record<string, DiscoveryRowSnapshot>
  rankedSnapshots: Record<string, RankedRecommendation[]>
}

/** Durable snapshots intentionally survive age/day boundaries until replaced. */
export function retainDiscoverySnapshot(saved?: (Partial<Omit<DiscoveryScreenSnapshot, 'version'>> & { version?: 2 }) | null) {
  return {
    cachedRows: saved?.cachedRows || {},
    rankedSnapshots: saved?.rankedSnapshots || {},
  }
}
