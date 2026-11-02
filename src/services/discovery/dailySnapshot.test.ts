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
    expect(today).toBe(makeDailySnapshotKey('2026-08-29', scope))
    expect(latestSnapshotForScope(snapshots, scope)?.[0].item.id).toBe('today')
  })

  it('does not freeze a partial ranking while an active catalogue or taste source is pending', () => {
    const rows = ['trending', 'top-rated', 'quick-watch']
    expect(discoverySourcesSettled(rows, { trending: false, 'top-rated': false, 'quick-watch': true }, [true, true, true])).toBe(false)
    expect(discoverySourcesSettled(rows, { trending: false, 'top-rated': false, 'quick-watch': false }, [true, false, true])).toBe(false)
    expect(discoverySourcesSettled(rows, { trending: false, 'top-rated': false, 'quick-watch': false }, [true, true, true])).toBe(true)
  })
})
