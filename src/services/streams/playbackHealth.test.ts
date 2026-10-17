import { describe, expect, it } from 'vitest'
import { classifyPlaybackFailure, recoveryCandidates } from './playbackHealth'
import { streamFingerprint } from './reliabilityHistory'

describe('playback health', () => {
  it('classifies only supported evidence', () => {
    expect(classifyPlaybackFailure('HTTP 403 expired signature')).toBe('SOURCE_EXPIRED')
    expect(classifyPlaybackFailure('mpv decoder failed')).toBe('DECODER_FAILURE')
    expect(classifyPlaybackFailure('something odd')).toBe('UNKNOWN')
  })

  it('does not immediately reselect failed sources or repeated addons', () => {
    const failed = { addonId: 'a', url: 'https://source.test/video.mp4?token=secret' }
    const candidates = [failed, { addonId: 'a', url: 'https://source.test/other.mp4' }, { addonId: 'b', url: 'https://other.test/video.mp4' }]
    expect(recoveryCandidates(candidates, new Set([streamFingerprint(failed)]), new Map([['a', 2]])).map((item) => item.addonId)).toEqual(['b'])
  })
})
