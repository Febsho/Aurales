import { beforeEach, describe, expect, it } from 'vitest'
import { useWatchTogetherStore, type LocalSourceCandidate } from './watchTogetherStore'

const candidate = (id: string): LocalSourceCandidate => ({
  stream: { url: `https://example.com/${id}.mp4`, title: id },
  addonId: `addon-${id}`,
  addonName: `Addon ${id}`,
  playableUrl: `https://example.com/${id}.mp4`,
  score: 100,
  reasons: ['test'],
})

describe('watch together local playback state', () => {
  beforeEach(() => {
    useWatchTogetherStore.getState().clearLocalSource()
  })

  it('rejects results from an obsolete source resolution', () => {
    const first = useWatchTogetherStore.getState().beginSourceResolution()
    const second = useWatchTogetherStore.getState().beginSourceResolution()
    expect(useWatchTogetherStore.getState().setLocalSourceCandidates(first, [candidate('old')])).toBe(false)
    expect(useWatchTogetherStore.getState().setLocalSourceCandidates(second, [candidate('new')])).toBe(true)
    expect(useWatchTogetherStore.getState().selectedLocalStream?.stream.title).toBe('new')
  })

  it('advances locally without changing the room when a source fails', () => {
    const generation = useWatchTogetherStore.getState().beginSourceResolution()
    useWatchTogetherStore.getState().setLocalSourceCandidates(generation, [candidate('first'), candidate('fallback')])
    expect(useWatchTogetherStore.getState().advanceLocalSource()?.stream.title).toBe('fallback')
    expect(useWatchTogetherStore.getState().advanceLocalSource()).toBeNull()
    expect(useWatchTogetherStore.getState().localSourceStatus).toBe('failed')
  })

  it('keeps only newer pending sync states', () => {
    const store = useWatchTogetherStore.getState()
    expect(store.queuePendingSync({ time: 10, isPlaying: true, serverTime: 1000, sequence: 4 })).toBe(true)
    expect(useWatchTogetherStore.getState().queuePendingSync({ time: 8, isPlaying: true, serverTime: 900, sequence: 3 })).toBe(false)
    useWatchTogetherStore.getState().markPendingSyncApplied(4)
    expect(useWatchTogetherStore.getState().pendingSync).toBeNull()
    expect(useWatchTogetherStore.getState().queuePendingSync({ time: 9, isPlaying: true, serverTime: 950, sequence: 4 })).toBe(false)
  })
})
