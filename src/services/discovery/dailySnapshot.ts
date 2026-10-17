import type { RankedRecommendation } from './types'

export const DISCOVERY_ALGORITHM_VERSION = 1

export interface DailySnapshotMeta {
  dateKey: string
  generatedAt: number
  profileFingerprint: string
  algorithmVersion: number
}

export function makeDailySnapshotKey(dateKey: string, scope: string): string {
  return `${dateKey}|${scope}`
}

/** Keep yesterday visible while today's snapshot is assembled in the background. */
export function latestSnapshotForScope(
  snapshots: Record<string, RankedRecommendation[]>,
  scope: string,
): RankedRecommendation[] | undefined {
  return Object.entries(snapshots)
    .filter(([key, value]) => key.endsWith(`|${scope}`) && value.length > 0)
    .sort(([a], [b]) => b.localeCompare(a))[0]?.[1]
}
