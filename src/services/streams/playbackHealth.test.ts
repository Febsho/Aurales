import { describe, expect, it } from 'vitest'
import { classifyPlaybackFailure, recoveryCandidates, shouldAutomaticallyRecoverSource } from './playbackHealth'
import { streamFingerprint } from './reliabilityHistory'

describe('playback health', () => {
  it('classifies only supported evidence', () => {
    expect(classifyPlaybackFailure('HTTP 403 expired signature')).toBe('SOURCE_EXPIRED')
    expect(classifyPlaybackFailure('mpv decoder failed')).toBe('DECODER_FAILURE')
    expect(classifyPlaybackFailure('something odd')).toBe('UNKNOWN')
  })

  it('automatically recovers sources that cannot be fetched, decoded, or converted', () => {
    for (const message of [
      'The source denied the media worker request (HTTP 403).',
      'The source returned HTTP 404. Refresh the stream URL.',
      'FFmpeg could not create a compatible copy with its available codecs and output formats.',
      'The browser could not decode the prepared stream after the available playback strategies.',
      'The media worker could not identify a supported video or playlist in this source.',
      'The media worker could not be reached to check conversion support.',
      'This browser reports that it cannot play video/x-matroska directly.',
    ]) expect(shouldAutomaticallyRecoverSource(message)).toBe(true)
  })

  it('does not treat an unrelated worker or addon failure as a bad source', () => {
    expect(shouldAutomaticallyRecoverSource('The media worker encountered an internal error.')).toBe(false)
    expect(shouldAutomaticallyRecoverSource('The addon catalog timed out.')).toBe(false)
  })

  it('does not immediately reselect failed sources or repeated addons', () => {
    const failed = { addonId: 'a', url: 'https://source.test/video.mp4?token=secret' }
    const candidates = [failed, { addonId: 'a', url: 'https://source.test/other.mp4' }, { addonId: 'b', url: 'https://other.test/video.mp4' }]
    expect(recoveryCandidates(candidates, new Set([streamFingerprint(failed)]), new Map([['a', 2]])).map((item) => item.addonId)).toEqual(['b'])
  })
})
