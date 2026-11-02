import { describe, expect, it } from 'vitest'
import { discoverySourcesSettled, latestSnapshotForScope, makeDailySnapshotKey } from './dailySnapshot'
import type { RankedRecommendation } from './types'

const entry = (id: string) => [{ item: { id, title: id, type: 'movie' as const, provider: 'tmdb' }, source: 'fallback' as const, score: {} as RankedRecommendation['score'], matchPercent: 70, reasons: [] }]

describe('daily discovery snapshots', () => {
  it('keeps the same key for the same Berlin day and selects a prior fallback by scope', () => {
    const scope = 'movies:for-you:de-local'
    const today = makeDailySnapshotKey('2026-08-29', scope)
    const snapshots = {
      [makeDailySnapshotKey('2026-08-28', scope)]: entry('yesterday'),
      [today]: entry('today'),
    }
    const metadata = {
      [makeDailySnapshotKey('2026-08-28', scope)]: { dateKey: '2026-08-28', generatedAt: 1, profileFingerprint: 'a', algorithmVersion: 12 },
      [today]: { dateKey: '2026-08-29', generatedAt: 2, profileFingerprint: 'a', algorithmVersion: 12 },
    }
    expect(today).toBe(makeDailySnapshotKey('2026-08-29', scope))
    expect(latestSnapshotForScope(snapshots, metadata, scope, 12)?.[0].item.id).toBe('today')
  })

  it('skips newer snapshots produced by a different ranking algorithm', () => {
    const scope = 'movies:for-you:de-local'
    const yesterday = makeDailySnapshotKey('2026-08-28', scope)
    const today = makeDailySnapshotKey('2026-08-29', scope)
    const snapshots = { [yesterday]: entry('old-yesterday'), [today]: entry('old-today') }
    const metadata = {
      [yesterday]: { dateKey: '2026-08-28', generatedAt: 1, profileFingerprint: 'a', algorithmVersion: 12 },
      [today]: { dateKey: '2026-08-29', generatedAt: 2, profileFingerprint: 'a', algorithmVersion: 11 },
    }

    expect(latestSnapshotForScope(snapshots, metadata, scope, 12)?.[0].item.id).toBe('old-yesterday')
    expect(latestSnapshotForScope(snapshots, metadata, scope, 13)).toBeUndefined()
  })

  it('does not freeze a partial ranking while an active catalogue or taste source is pending', () => {
    const rows = ['trending', 'top-rated', 'quick-watch']
    expect(discoverySourcesSettled(rows, { trending: false, 'top-rated': false, 'quick-watch': true }, [true, true, true])).toBe(false)
    expect(discoverySourcesSettled(rows, { trending: false, 'top-rated': false, 'quick-watch': false }, [true, false, true])).toBe(false)
    expect(discoverySourcesSettled(rows, { trending: false, 'top-rated': false, 'quick-watch': false }, [true, true, true])).toBe(true)
  })
})
