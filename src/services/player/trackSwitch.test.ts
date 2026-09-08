import { describe, expect, it } from 'vitest'
import { createTrackPropertyQueue } from './trackSwitch'

describe('createTrackPropertyQueue', () => {
  it('keeps rapid in-place track changes ordered', async () => {
    const calls: Array<[string, number | 'no']> = []
    const send = async (property: 'aid' | 'sid', value: number | 'no') => {
      calls.push([property, value])
    }
    const setTrack = createTrackPropertyQueue(send)

    await Promise.all([setTrack('aid', 2), setTrack('sid', 4), setTrack('aid', 3)])

    expect(calls).toEqual([['aid', 2], ['sid', 4], ['aid', 3]])
  })

  it('continues after a bad track without issuing playback commands', async () => {
    const calls: Array<[string, number | 'no']> = []
    const setTrack = createTrackPropertyQueue(async (property, value) => {
      calls.push([property, value])
      if (value === 2) throw new Error('unsupported track')
    })

    await expect(setTrack('aid', 2)).rejects.toThrow('unsupported track')
    await expect(setTrack('sid', 4)).resolves.toBeUndefined()

    expect(calls).toEqual([['aid', 2], ['sid', 4]])
  })
})
