import { describe, expect, it } from 'vitest'
import { estimateRoomPosition, estimateServerTiming, serverTimestampToLocal } from './clockSync'

describe('watch together clock synchronization', () => {
  it('estimates server offset independently of a large clock difference', () => {
    // Client clock is 5 minutes behind; symmetric network latency is 100 ms.
    const timing = estimateServerTiming(1_000_000, 1_300_050, 1_000_100)
    expect(timing.roundTripTimeMs).toBe(100)
    expect(timing.serverClockOffsetMs).toBe(300_000)
    expect(serverTimestampToLocal(1_301_000, timing.serverClockOffsetMs)).toBe(1_001_000)
  })

  it('advances a playing room anchor using local elapsed time', () => {
    expect(estimateRoomPosition(42, true, 1_300_000, 300_000, 1_002_500)).toBeCloseTo(44.5)
    expect(estimateRoomPosition(42, false, 1_300_000, 300_000, 1_002_500)).toBe(42)
  })

  it('does not add clock skew to a room position', () => {
    // Both clocks describe the same instant even though the server is five
    // minutes ahead. Only the 2.5 seconds elapsed locally should be added.
    expect(estimateRoomPosition(10, true, 1_300_000, 300_000, 1_002_500)).toBeCloseTo(12.5)
  })
})
