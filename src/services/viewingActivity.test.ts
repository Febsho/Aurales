import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordPlaybackSample, seedViewingActivity, summarizeViewingActivity } from './viewingActivity'
import type { WatchProgress } from '../types'

describe('viewing activity', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })

  it('counts normal playback deltas and ignores large seeks', () => {
    const base = { mediaKey: 'movie-a', title: 'Movie A', mediaType: 'movie' as const, positionSeconds: 10, durationSeconds: 100, playing: true, completed: false }
    recordPlaybackSample({ ...base, sampledAt: 1_700_000_000_000 })
    recordPlaybackSample({ ...base, positionSeconds: 20, sampledAt: 1_700_000_010_000 })
    recordPlaybackSample({ ...base, positionSeconds: 90, sampledAt: 1_700_000_012_000 })
    expect(summarizeViewingActivity('all').totalSeconds).toBe(10)
  })

  it('counts a completion once', () => {
    const base = { mediaKey: 'episode-a', title: 'Series A', mediaType: 'series' as const, season: 1, episode: 2, durationSeconds: 100, playing: true }
    recordPlaybackSample({ ...base, positionSeconds: 80, completed: false, sampledAt: 1_700_100_000_000 })
    recordPlaybackSample({ ...base, positionSeconds: 90, completed: true, sampledAt: 1_700_100_010_000 })
    recordPlaybackSample({ ...base, positionSeconds: 95, completed: true, sampledAt: 1_700_100_015_000 })
    expect(summarizeViewingActivity('all').completions).toBe(1)
  })

  it('seeds saved progress only once and marks it estimated', () => {
    const progress: WatchProgress = { id: 'saved', mediaId: 'saved', mediaType: 'movie', title: 'Saved Movie', progressSeconds: 600, durationSeconds: 1200, completed: false, updatedAt: '2025-01-02T12:00:00.000Z' }
    const map = new Map([['saved', progress]])
    seedViewingActivity(map)
    seedViewingActivity(map)
    const summary = summarizeViewingActivity('all')
    expect(summary.totalSeconds).toBe(600)
    expect(summary.containsEstimates).toBe(true)
  })

  it('does not keep non-animation titles in the anime category', () => {
    const base = { mediaKey: 'silo', title: 'Silo', mediaType: 'anime' as const, genres: ['Drama', 'Sci-Fi & Fantasy'], season: 1, episode: 1, positionSeconds: 10, durationSeconds: 100, playing: true, completed: false }
    recordPlaybackSample({ ...base, sampledAt: 1_700_200_000_000 })
    recordPlaybackSample({ ...base, positionSeconds: 20, sampledAt: 1_700_200_010_000 })
    expect(summarizeViewingActivity('all', 'anime').totalSeconds).toBe(0)
    expect(summarizeViewingActivity('all', 'series').totalSeconds).toBe(10)
  })
})
