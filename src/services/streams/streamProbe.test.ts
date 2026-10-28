import { afterEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { probeStreamWithWorker } from '../mediaWorker'
import { probeStreamUrl } from './streamProbe'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../mediaWorker', () => ({ probeStreamWithWorker: vi.fn() }))

describe('stream probe platform adapter', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the authenticated worker in browsers and preserves its final redirect URL', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: undefined })
    vi.mocked(probeStreamWithWorker).mockResolvedValueOnce({
      status: 206,
      contentType: 'video/mp4',
      acceptRanges: true,
      contentLength: 10_000_000,
      sampledBytes: 262_144,
      elapsedMs: 125,
      finalUrl: 'https://cdn.example/final.mp4?signature=secret',
    })

    const probe = await probeStreamUrl('https://stream.example/start.mp4')

    expect(probe).toMatchObject({
      ok: true,
      status: 206,
      acceptsRanges: true,
      contentLength: 10_000_000,
      finalUrl: 'https://cdn.example/final.mp4?signature=secret',
      sampledBytes: 262_144,
      throughputMbps: expect.any(Number),
    })
    expect(probeStreamWithWorker).toHaveBeenCalledWith('https://stream.example/start.mp4', 4_000)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps probing optional when no worker can serve the browser', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: undefined })
    vi.mocked(probeStreamWithWorker).mockResolvedValueOnce(null)
    await expect(probeStreamUrl('https://stream.example/video.mp4')).resolves.toBeNull()
  })

  it('reads the camelCase response shape returned by Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 206,
      contentType: 'video/mp4',
      acceptRanges: true,
      contentLength: 12_000,
      finalUrl: 'https://cdn.example/redirected.mp4',
      sampledBytes: 262_144,
      elapsedMs: 200,
    })
    await expect(probeStreamUrl('https://stream.example/video.mp4')).resolves.toMatchObject({
      ok: true,
      contentType: 'video/mp4',
      acceptsRanges: true,
      contentLength: 12_000,
      finalUrl: 'https://cdn.example/redirected.mp4',
    })
    expect(invoke).toHaveBeenCalledWith('http_probe_stream', { url: 'https://stream.example/video.mp4', timeoutMs: 4_000 })
  })
})
