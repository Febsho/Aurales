import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { getPlayerSnapshot, shouldMarkWatched } from './player'

describe('player snapshot', () => {
  beforeEach(() => invoke.mockReset())

  it('reads the polling state with one IPC call', async () => {
    const snapshot = {
      timePos: 12,
      duration: 90,
      paused: false,
      buffering: false,
      cacheBufferingState: 100,
      demuxerCacheDuration: 20,
      eofReached: false,
      idleActive: false,
      coreIdle: false,
    }
    invoke.mockResolvedValue(snapshot)

    await expect(getPlayerSnapshot()).resolves.toEqual(snapshot)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('get_player_snapshot')
  })
})

describe('watched threshold', () => {
  it('keeps playback resumable below 80% and completes it at 80%', () => {
    expect(shouldMarkWatched(79.99)).toBe(false)
    expect(shouldMarkWatched(80)).toBe(true)
  })
})
