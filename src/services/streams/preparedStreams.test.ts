import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadedStream, StreamPreloadRequest } from './preloadManager'

const requestMock = vi.fn()
const probeMock = vi.fn()

vi.mock('./preloadManager', () => ({
  streamPreloadManager: { request: (...args: unknown[]) => requestMock(...args) },
  StreamPreloadPriority: { PLAYBACK: 100, DETAILS_OPEN: 90, CONTINUE_CURRENT: 80, CONTINUE_NEXT_EPISODE: 70, IDLE_PREDICTION: 10 },
}))
vi.mock('./streamProbe', () => ({
  probeStreamUrl: (...args: unknown[]) => probeMock(...args),
}))
vi.mock('./reliabilityHistory', () => ({
  loadReliabilityHistory: () => ({}),
  getReliability: () => ({ success: 0, preferred: 0, failedStart: 0, unstable: 0, reportedBad: 0 }),
  streamFingerprint: (stream: { url?: string }) => stream.url || 'fp',
}))
vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({ preferredAudio: [], preferredSubtitles: [], cacheBufferSize: 'default' }),
  },
}))

import { preparedStreamRegistry } from './preparedStreams'
import { canonicalStreamKey } from './preloadUtils'

function makeStream(overrides: Partial<PreloadedStream> = {}): PreloadedStream {
  return {
    name: 'Torrentio 1080p',
    title: 'Movie 1080p WebDL',
    url: 'https://cdn.example.com/video.mp4',
    addonId: 'torrentio',
    addonName: 'Torrentio',
    ...overrides,
  }
}

function movieRequest(id = 'tt0111161'): StreamPreloadRequest {
  return { mediaType: 'movie', mediaId: id }
}

const okProbe = (url: string) => ({
  ok: true, status: 206, contentType: 'video/mp4', acceptsRanges: true,
  finalUrl: url, probedAt: Date.now(), sampledBytes: 262144, elapsedMs: 250, throughputMbps: 80,
})

beforeEach(() => {
  vi.useRealTimers()
  preparedStreamRegistry.clear()
  requestMock.mockReset()
  probeMock.mockReset()
})

describe('preparedStreamRegistry', () => {
  it('prepares a clear single candidate and probes exactly once', async () => {
    const stream = makeStream()
    requestMock.mockResolvedValue([stream])
    probeMock.mockImplementation(async (url: string) => okProbe(url))

    const prepared = await preparedStreamRegistry.prepare(movieRequest())
    expect(prepared?.state).toBe('ready')
    expect(prepared?.playableUrl).toBe(stream.url)
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('uses the post-redirect final URL from the probe', async () => {
    requestMock.mockResolvedValue([makeStream()])
    probeMock.mockResolvedValue({ ...okProbe('x'), finalUrl: 'https://edge7.example.com/video.mp4' })

    const prepared = await preparedStreamRegistry.prepare(movieRequest())
    expect(prepared?.playableUrl).toBe('https://edge7.example.com/video.mp4')
  })

  it('measures ambiguous candidates and selects the more responsive stream', async () => {
    requestMock.mockResolvedValue([
      makeStream({ url: 'https://a.example.com/v.mp4' }),
      makeStream({ url: 'https://b.example.com/v.mp4' }),
    ])
    probeMock.mockImplementation(async (url: string) => ({
      ...okProbe(url),
      elapsedMs: url.includes('b.example.com') ? 180 : 1600,
      throughputMbps: url.includes('b.example.com') ? 90 : 6,
    }))

    const prepared = await preparedStreamRegistry.prepare(movieRequest())
    expect(prepared?.stream.url).toBe('https://b.example.com/v.mp4')
    expect(probeMock).toHaveBeenCalledTimes(2)
  })

  it('consume is one-shot', async () => {
    requestMock.mockResolvedValue([makeStream()])
    probeMock.mockImplementation(async (url: string) => okProbe(url))
    await preparedStreamRegistry.prepare(movieRequest())

    const key = canonicalStreamKey(movieRequest())
    expect(preparedStreamRegistry.consume(key)?.state).toBe('ready')
    expect(preparedStreamRegistry.consume(key)).toBeNull()
  })

  it('negative-caches a failed probe and does not re-probe within the TTL', async () => {
    requestMock.mockResolvedValue([makeStream()])
    probeMock.mockResolvedValue({ ok: false, status: 404, acceptsRanges: false, probedAt: Date.now() })

    expect(await preparedStreamRegistry.prepare(movieRequest())).toBeNull()
    expect(await preparedStreamRegistry.prepare(movieRequest())).toBeNull()
    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(preparedStreamRegistry.consume(canonicalStreamKey(movieRequest()))).toBeNull()
  })

  it('expires ready entries', async () => {
    vi.useFakeTimers()
    requestMock.mockResolvedValue([makeStream()])
    probeMock.mockImplementation(async (url: string) => okProbe(url))
    await preparedStreamRegistry.prepare(movieRequest())

    vi.advanceTimersByTime(16 * 60_000)
    expect(preparedStreamRegistry.consume(canonicalStreamKey(movieRequest()))).toBeNull()
  })

  it('caps tokenized URLs harder than plain URLs', async () => {
    vi.useFakeTimers()
    requestMock.mockResolvedValue([makeStream({ url: 'https://cdn.example.com/video.mp4?token=abc' })])
    probeMock.mockImplementation(async (url: string) => okProbe(url))
    const prepared = await preparedStreamRegistry.prepare(movieRequest())
    expect(prepared?.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  })

  it('evicts the least recently used entry beyond capacity', async () => {
    probeMock.mockImplementation(async (url: string) => okProbe(url))
    requestMock.mockResolvedValue([makeStream({ url: 'https://a.example.com/1.mp4' })])
    await preparedStreamRegistry.prepare(movieRequest('tt0000001'))
    requestMock.mockResolvedValue([makeStream({ url: 'https://a.example.com/2.mp4' })])
    await preparedStreamRegistry.prepare(movieRequest('tt0000002'))
    requestMock.mockResolvedValue([makeStream({ url: 'https://a.example.com/3.mp4' })])
    await preparedStreamRegistry.prepare(movieRequest('tt0000003'))

    expect(preparedStreamRegistry.peek(canonicalStreamKey(movieRequest('tt0000001')))).toBeNull()
    expect(preparedStreamRegistry.peek(canonicalStreamKey(movieRequest('tt0000002')))).not.toBeNull()
    expect(preparedStreamRegistry.peek(canonicalStreamKey(movieRequest('tt0000003')))).not.toBeNull()
  })

  it('honors an abort signal without storing an entry', async () => {
    const controller = new AbortController()
    requestMock.mockImplementation(async () => {
      controller.abort()
      return [makeStream()]
    })
    const prepared = await preparedStreamRegistry.prepare(movieRequest(), { signal: controller.signal })
    expect(prepared).toBeNull()
    expect(probeMock).not.toHaveBeenCalled()
    expect(preparedStreamRegistry.peek(canonicalStreamKey(movieRequest()))).toBeNull()
  })

  it('dedupes concurrent prepares for the same media', async () => {
    let release: (streams: PreloadedStream[]) => void = () => {}
    requestMock.mockReturnValue(new Promise((resolve) => { release = resolve }))
    probeMock.mockImplementation(async (url: string) => okProbe(url))

    const first = preparedStreamRegistry.prepare(movieRequest())
    const second = preparedStreamRegistry.prepare(movieRequest())
    release([makeStream()])
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(probeMock).toHaveBeenCalledTimes(1)
  })

  it('treats an unprobed result (web build) as ready', async () => {
    requestMock.mockResolvedValue([makeStream()])
    probeMock.mockResolvedValue(null)
    const prepared = await preparedStreamRegistry.prepare(movieRequest())
    expect(prepared?.state).toBe('ready')
    expect(prepared?.probe).toBeUndefined()
  })
})
