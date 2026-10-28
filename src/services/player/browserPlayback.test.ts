import { describe, expect, it, vi } from 'vitest'
import { AUTOPLAY_GESTURE_MESSAGE, browserPlaybackFailureMessage, isAutoplayGestureError, isMediaSessionExpired } from './browserPlayback'

describe('browser playback failure diagnostics', () => {
  it('recognizes an expired media-worker session using Unix seconds', () => {
    expect(isMediaSessionExpired(1_700_000_000, 1_700_000_000)).toBe(true)
    expect(isMediaSessionExpired(1_700_000_001, 1_700_000_000)).toBe(false)
    expect(isMediaSessionExpired(Number.NaN, 1_700_000_000)).toBe(false)
  })

  it('recognizes autoplay policy errors as a user gesture requirement', () => {
    expect(isAutoplayGestureError({ name: 'NotAllowedError' })).toBe(true)
    expect(isAutoplayGestureError(new DOMException('play() failed', 'NotAllowedError'))).toBe(true)
    expect(isAutoplayGestureError(new DOMException('unsupported media', 'NotSupportedError'))).toBe(false)
    expect(AUTOPLAY_GESTURE_MESSAGE).toContain('Tap Play')
  })

  it('reports when the browser declares a known direct-play container unsupported', () => {
    const video = { canPlayType: vi.fn((): CanPlayTypeResult => '') }
    const message = browserPlaybackFailureMessage('https://media.example/movie.webm?sig=abc', video)

    expect(video.canPlayType).toHaveBeenCalledWith('video/webm')
    expect(message).toContain('cannot play video/webm directly')
  })

  it('does not call a maybe-supported container failure a codec incompatibility', () => {
    const video = { canPlayType: vi.fn((): CanPlayTypeResult => 'maybe') }
    const message = browserPlaybackFailureMessage('https://media.example/movie.mp4', video)

    expect(message).toContain('codec or container may be unsupported')
    expect(message).not.toContain('reports that it cannot play')
  })

  it('keeps HLS errors specific to browser requests, expiry, and codec support', () => {
    const video = { canPlayType: vi.fn((): CanPlayTypeResult => '') }
    const message = browserPlaybackFailureMessage('https://media.example/master.m3u8?token=abc', video)

    expect(message).toContain('This HLS stream could not be played')
    expect(video.canPlayType).not.toHaveBeenCalled()
  })
})
