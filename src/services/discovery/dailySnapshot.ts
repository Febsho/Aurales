import type { RankedRecommendation } from './types'

// Version 12 uses a stable popularity scale across recommendation pools.
export const DISCOVERY_ALGORITHM_VERSION = 12

export interface DailySnapshotMeta {
  dateKey: string
  generatedAt: number
  profileFingerprint: string
  algorithmVersion: number
}

export function makeDailySnapshotKey(dateKey: string, scope: string): string {
  return `${dateKey}|${scope}`
}

/** A ranking is ready only after each active row and auxiliary source settled. */
export function discoverySourcesSettled(
  rowIds: readonly string[],
  rowLoads: Record<string, boolean>,
  auxiliarySourcesReady: readonly boolean[],
): boolean {
  return rowIds.every((rowId) => rowLoads[rowId] !== true) && auxiliarySourcesReady.every(Boolean)
}

/** Keep yesterday visible while today's snapshot is assembled in the background. */
export function latestSnapshotForScope(
  snapshots: Record<string, RankedRecommendation[]>,
  metadata: Record<string, DailySnapshotMeta>,
  scope: string,
  algorithmVersion: number,
): RankedRecommendation[] | undefined {
  return Object.entries(snapshots)
    .filter(([key, value]) => key.endsWith(`|${scope}`) && value.length > 0 && metadata[key]?.algorithmVersion === algorithmVersion)
    .sort(([a], [b]) => b.localeCompare(a))[0]?.[1]
}
