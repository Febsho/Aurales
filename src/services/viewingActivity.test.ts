import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordPlaybackSample, seedViewingActivity, summarizeViewingActivity } from './viewingActivity'
import type { WatchProgress } from '../types'

describe('viewing activity', () => {
  beforeEach(() => {
    const preserved = new Map(['aurales_profiles_v1', 'aurales_active_profile_v1']
      .map((key) => [key, localStorage.getItem(key)] as const))
    localStorage.clear()
    for (const [key, value] of preserved) if (value != null) localStorage.setItem(key, value)
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })

  it('counts normal playback deltas and ignores large seeks', () => {
    const sampledAt = Date.now() - 20_000
    const base = { mediaKey: 'movie-a', title: 'Movie A', mediaType: 'movie' as const, genres: ['Drama'], positionSeconds: 10, durationSeconds: 100, playing: true, completed: false }
    recordPlaybackSample({ ...base, sampledAt })
    recordPlaybackSample({ ...base, positionSeconds: 20, sampledAt: sampledAt + 10_000 })
    recordPlaybackSample({ ...base, positionSeconds: 90, sampledAt: sampledAt + 12_000 })
    const summary = summarizeViewingActivity('all')
    expect(summary.totalSeconds).toBe(10)
    expect(summary.mediaSeconds.movie).toBe(10)
    expect(summary.topTitles[0]).toMatchObject({ title: 'Movie A', seconds: 10 })
    expect(summary.topGenres).toContainEqual({ genre: 'Drama', seconds: 10 })
    expect(summary.recent[0]).toMatchObject({ title: 'Movie A', seconds: 10 })
    expect(summarizeViewingActivity('12m').totalSeconds).toBe(10)
  })

  it('counts a completion once', () => {
    const sampledAt = Date.now() - 20_000
    const base = { mediaKey: 'episode-a', title: 'Series A', mediaType: 'series' as const, season: 1, episode: 2, durationSeconds: 100, playing: true }
    recordPlaybackSample({ ...base, positionSeconds: 80, completed: false, sampledAt })
    recordPlaybackSample({ ...base, positionSeconds: 90, completed: true, sampledAt: sampledAt + 10_000 })
    recordPlaybackSample({ ...base, positionSeconds: 95, completed: true, sampledAt: sampledAt + 15_000 })
    const summary = summarizeViewingActivity('all')
    expect(summary.completions).toBe(1)
    expect(summary.recent).toHaveLength(1)
    expect(summary.recent[0].seconds).toBe(15)
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
    const sampledAt = Date.now() - 20_000
    const base = { mediaKey: 'silo', title: 'Silo', mediaType: 'anime' as const, genres: ['Drama', 'Sci-Fi & Fantasy'], season: 1, episode: 1, positionSeconds: 10, durationSeconds: 100, playing: true, completed: false }
    recordPlaybackSample({ ...base, sampledAt })
    recordPlaybackSample({ ...base, positionSeconds: 20, sampledAt: sampledAt + 10_000 })
    expect(summarizeViewingActivity('all', 'anime').totalSeconds).toBe(0)
    expect(summarizeViewingActivity('all', 'series').totalSeconds).toBe(10)
  })
})
