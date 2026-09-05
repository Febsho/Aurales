import { describe, expect, it, vi } from 'vitest'

// streamMatcher also owns runtime source resolution; isolate its small room
// reference helpers from the desktop-only addon and storage integrations.
vi.mock('../addons', () => ({ getAddonStreams: vi.fn(), getStreamAddons: vi.fn() }))
vi.mock('../streams/preloadManager', () => ({ streamPreloadManager: {}, StreamPreloadPriority: { PLAYBACK: 100 } }))
vi.mock('../streams/preparedStreams', () => ({ buildSmartContext: vi.fn() }))
vi.mock('../streams/smartScoring', () => ({ rankStreams: vi.fn() }))
vi.mock('../streams/streamProbe', () => ({ probeStreamUrl: vi.fn() }))
vi.mock('../torbox', () => ({ annotateTorBoxStreams: vi.fn(), resolveTorBoxStream: vi.fn() }))

import { createRoomStream, isSameRoomStream } from './streamMatcher'

describe('Watch Together stream references', () => {
  it('shares an opaque release reference without sharing the playable URL', () => {
    const host = {
      addonId: 'com.example.addon',
      infoHash: 'abc123',
      fileIdx: 2,
      title: 'Example.1080p.WEB-DL',
      url: 'https://private.example/tokenized-link',
    }
    const reference = createRoomStream(host)

    expect(reference).not.toHaveProperty('url')
    expect(reference.quality).toBe('1080p')
    expect(isSameRoomStream({ ...host, url: 'https://another-device.example/link' }, reference)).toBe(true)
  })

  it('does not treat the same quality as the same release', () => {
    const reference = createRoomStream({ addonId: 'host-addon', infoHash: 'host-hash', title: 'Example 1080p' })

    expect(isSameRoomStream({ addonId: 'guest-addon', infoHash: 'different-hash', title: 'Example 1080p' }, reference)).toBe(false)
  })
})
