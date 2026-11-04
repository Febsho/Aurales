import { describe, expect, it, vi } from 'vitest'
import { AUTOPLAY_GESTURE_MESSAGE, browserMediaCapabilitiesRejectsKnownMedia, browserPlaybackFailureMessage, browserRejectsKnownMedia, inferSourceMediaInfo, isAutoplayGestureError, isMediaSessionExpired, nextPlaybackConversionAfterDecodeFailure, playbackHeadersForSubtitle } from './browserPlayback'

describe('subtitle source request headers', () => {
  const providerHeaders = {
    authorization: 'Bearer private-token',
    cookie: 'session=private',
    'x-provider-token': 'private',
    referer: 'https://addon.example/watch?token=private-referer',
    'user-agent': 'ProviderPlayer/4.2',
    accept: 'text/vtt',
  }

  it('keeps provider headers for subtitles on the same media origin', () => {
    expect(playbackHeadersForSubtitle('https://cdn.example/subtitles/en.vtt', 'https://cdn.example/video.mkv', providerHeaders)).toEqual(providerHeaders)
  })

  it('does not forward source credentials to a different subtitle host', () => {
    expect(playbackHeadersForSubtitle('https://subs.example/en.vtt', 'https://cdn.example/video.mkv', providerHeaders)).toEqual({
      'user-agent': 'ProviderPlayer/4.2',
      accept: 'text/vtt',
    })
  })

  it('does not attach provider headers to locally prepared subtitle blobs', () => {
    expect(playbackHeadersForSubtitle('blob:https://aurales.example/subtitle', 'https://cdn.example/video.mkv', providerHeaders)).toEqual({})
  })
})

describe('addon media hint inference', () => {
  it('extracts unambiguous codec, resolution, and container hints from addon metadata', () => {
    expect(inferSourceMediaInfo({ title: 'Movie.2160p.WEB-DL.HEVC.DDP5.1.mkv' })).toMatchObject({
      container: 'mkv', videoCodec: 'hevc', audioCodec: 'ddp', resolution: '2160p',
    })
  })

  it('keeps explicit media metadata and ignores ambiguous labels', () => {
    expect(inferSourceMediaInfo({ name: 'Movie HD', filename: 'movie.mp4', videoCodec: 'AV1', resolution: '720p' })).toMatchObject({
      container: 'mp4', videoCodec: 'AV1', resolution: '720p',
    })
    expect(inferSourceMediaInfo({ title: 'Movie HDR' })).toMatchObject({ videoCodec: undefined })
  })

  it('preserves profile hints from common release names for the mobile decoder probe', () => {
    expect(inferSourceMediaInfo({ title: 'Movie.2160p.WEB-DL.HEVC.Main10.DDP5.1.mkv' })).toMatchObject({ videoCodec: 'HEVC (Main 10)' })
    expect(inferSourceMediaInfo({ title: 'Movie.1080p.x265.10bit.mkv' })).toMatchObject({ videoCodec: 'HEVC (Main 10)' })
  })

  it('extracts declared bitrate and frame rate without replacing explicit stream values', () => {
    expect(inferSourceMediaInfo({ title: 'Movie.35Mbps.59.94fps.mkv' })).toMatchObject({ bitrate: 35_000_000, frameRate: 59.94 })
    expect(inferSourceMediaInfo({ title: 'Movie.35Mbps.60fps.mkv', bitrate: 12_000_000, frameRate: 24 })).toMatchObject({ bitrate: 12_000_000, frameRate: 24 })
  })

  it('recognizes 8K and high-frame-rate release labels', async () => {
    const inferred = inferSourceMediaInfo({ title: 'Demo.8K.240fps.HEVC.mkv' })
    expect(inferred).toMatchObject({ resolution: '8K', frameRate: 240 })
    const decodingInfo = vi.fn().mockResolvedValue({ supported: true, smooth: false, powerEfficient: false })
    await browserMediaCapabilitiesRejectsKnownMedia({ decodingInfo }, {
      videoCodec: inferred.videoCodec,
      resolution: inferred.resolution,
      frameRate: inferred.frameRate,
    })
    expect(decodingInfo.mock.calls[0][0].video).toMatchObject({ width: 7680, height: 4320, framerate: 240 })
  })
})

describe('browser decode fallback order', () => {
  it('escalates from stream copy through standard and low-resolution video profiles', () => {
    expect(nextPlaybackConversionAfterDecodeFailure('remux')).toBe('audioAac')
    expect(nextPlaybackConversionAfterDecodeFailure('audioAac')).toBe('h264Aac')
    expect(nextPlaybackConversionAfterDecodeFailure('h264Aac')).toBe('h264AacLow')
    expect(nextPlaybackConversionAfterDecodeFailure('h264AacLow')).toBe('h264AacCompat')
    expect(nextPlaybackConversionAfterDecodeFailure('h264AacCompat')).toBeNull()
  })
})

describe('browser playback failure diagnostics', () => {
  it('uses Media Capabilities to detect a rejected mobile codec profile when canPlayType is inconclusive', async () => {
    const decodingInfo = vi.fn().mockResolvedValue({ supported: false, smooth: false, powerEfficient: false })

    await expect(browserMediaCapabilitiesRejectsKnownMedia({ decodingInfo }, {
      container: 'mp4',
      videoCodec: 'HEVC (Main 10)',
      audioCodec: 'AAC',
      resolution: '1920x1080',
      bitrate: 8_000_000,
    })).resolves.toBe(true)
    expect(decodingInfo).toHaveBeenCalledWith({
      type: 'file',
      video: {
        contentType: 'video/mp4; codecs="hvc1.2.4.L120.B0,mp4a.40.2"',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 30,
      },
    })
  })

  it('does not guess decode support without source dimensions', async () => {
    const decodingInfo = vi.fn()
    await expect(browserMediaCapabilitiesRejectsKnownMedia({ decodingInfo }, {
      videoCodec: 'HEVC (Main 10)',
    })).resolves.toBe(false)
    expect(decodingInfo).not.toHaveBeenCalled()
  })

  it('probes common 4K labels at UHD dimensions', async () => {
    const decodingInfo = vi.fn().mockResolvedValue({ supported: false, smooth: false, powerEfficient: false })
    await expect(browserMediaCapabilitiesRejectsKnownMedia({ decodingInfo }, {
      videoCodec: 'HEVC', resolution: '4K',
    })).resolves.toBe(true)
    expect(decodingInfo.mock.calls[0][0].video).toMatchObject({ width: 3840, height: 2160 })
  })

  it('converts a technically supported profile when the browser predicts playback will not be smooth', async () => {
    const decodingInfo = vi.fn().mockResolvedValue({ supported: true, smooth: false, powerEfficient: false })
    await expect(browserMediaCapabilitiesRejectsKnownMedia({ decodingInfo }, {
      videoCodec: 'H.264 High', resolution: '4K', bitrate: 35_000_000,
    })).resolves.toBe(true)
  })

  it('uses inferred frame rate and bitrate when checking mobile decoder smoothness', async () => {
    const decodingInfo = vi.fn().mockResolvedValue({ supported: true, smooth: false, powerEfficient: false })
    await browserMediaCapabilitiesRejectsKnownMedia({ decodingInfo }, {
      videoCodec: 'HEVC', resolution: '4K', bitrate: 35_000_000, frameRate: 59.94,
    })
    expect(decodingInfo.mock.calls[0][0].video).toMatchObject({ bitrate: 35_000_000, framerate: 59.94 })
  })

  it.each([
    ['HEVC (Main 10)', 'hvc1.2.4.L120.B0'],
    ['H.264 High Profile', 'avc1.640028'],
    ['VP9 Profile 2', 'vp09.02.10.10'],
  ])('checks the reported %s profile when deciding whether to convert', (codec, mimeCodec) => {
    const video = { canPlayType: vi.fn((): CanPlayTypeResult => '') }

    expect(browserRejectsKnownMedia(video, 'https://media.example/signed-stream?token=secret', {
      videoCodec: codec,
    })).toBe(true)
    expect(video.canPlayType).toHaveBeenCalledWith(`video/mp4; codecs="${mimeCodec}"`)
  })

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
