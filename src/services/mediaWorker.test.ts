import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelMediaConversion, createMediaSession, getMediaConversionOutputFormat, getSupportedMediaConversionOutputFormat, getMediaConversionStatus, getMediaWorkerConfig, getMediaWorkerCapabilities, proxyAuralesSyncRequest, proxyMdblistRequest, proxyPmdbRequest, proxyTorboxRequest, proxyTraktRequest, rankStreamsWithWorker, saveMediaWorkerConfig, startMediaConversion } from './mediaWorker'
import type { SmartScoreContext } from './streams/smartScoring'

const context: SmartScoreContext = { title: 'Example', preferredAudio: [], preferredSubtitles: [], subtitles: [], mode: 'best', player: 'web', history: {}, playbackMemories: [] }
const streams = [{ url: 'https://cdn.example/movie.mp4', title: 'Example 1080p', addonId: 'addon', addonName: 'Test addon', name: '1080p' }]

describe('optional Aurales media worker adapter', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('chooses mobile-native MP4 when available and falls back to the available worker muxer', () => {
    expect(getMediaConversionOutputFormat('Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile')).toBe('mp4')
    expect(getSupportedMediaConversionOutputFormat({ mediaRemux: true, mediaMp4: true, mediaHls: true }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('mp4')
    expect(getSupportedMediaConversionOutputFormat({ mediaRemux: true, mediaMp4: false, mediaHls: true }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('hls')
    expect(getSupportedMediaConversionOutputFormat({ mediaRemux: true, mediaMp4: true, mediaHls: false }, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120')).toBe('mp4')
    expect(getSupportedMediaConversionOutputFormat({ mediaRemux: false, mediaMp4: false, mediaHls: false }, 'Android')).toBeNull()
  })

  it('stores only an HTTPS worker endpoint and a sufficiently long private key', () => {
    expect(() => saveMediaWorkerConfig({ baseUrl: 'http://public.example', apiKey: 'x'.repeat(32) })).toThrow('must use HTTPS')
    expect(() => saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'short' })).toThrow('at least 32 characters')
    expect(() => saveMediaWorkerConfig({ baseUrl: 'https://worker.example/api', apiKey: 'x'.repeat(32) })).toThrow('without a path prefix')
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example/', apiKey: 'x'.repeat(32) })
    expect(getMediaWorkerConfig()).toEqual({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
  })

  it('requests worker capabilities with the configured bearer key', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mdblistProxy: true, traktProxy: true, mediaRemux: false, audioTranscode: false, videoTranscode: false }), { status: 200 }))
    await expect(getMediaWorkerCapabilities()).resolves.toMatchObject({ streamRanking: true, mediaDirectProxy: true, pmdbProxy: true, mdblistProxy: true, traktProxy: true, mediaRemux: false })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://worker.example/v1/capabilities')
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${'x'.repeat(32)}` })
  })

  it('creates a signed worker playback session without returning provider credentials', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ url: '/v1/media/0123456789abcdef0123456789abcdef?expires=123&signature=opaque', expiresAt: 123 }), { status: 200 }))
    await expect(createMediaSession('https://cdn.example/video.mp4?token=private')).resolves.toEqual({ url: 'https://worker.example/v1/media/0123456789abcdef0123456789abcdef?expires=123&signature=opaque', expiresAt: 123 })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ url: 'https://cdn.example/video.mp4?token=private', headers: {} })
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${'x'.repeat(32)}` })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://attacker.example/v1/media/0123456789abcdef0123456789abcdef?expires=123&signature=x', expiresAt: 123 }), { status: 200 }))
    await expect(createMediaSession('https://cdn.example/video.mp4')).rejects.toThrow('unsafe playback session URL')
  })

  it('creates proxy sessions for HLS manifests and expects the worker to rewrite child URLs', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ url: '/v1/media/0123456789abcdef0123456789abcdef?expires=123&signature=opaque', expiresAt: 123 }), { status: 200 }))
    await expect(createMediaSession('https://cdn.example/video.m3u8?sig=x')).resolves.toMatchObject({ expiresAt: 123 })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ url: 'https://cdn.example/video.m3u8?sig=x', headers: {} })
  })

  it('starts an authenticated conversion job without returning the source URL', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    const jobId = '0123456789abcdef0123456789abcdef'
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ jobId, status: 'processing' }), { status: 202 }))
    await expect(startMediaConversion('https://cdn.example/video.mkv?token=private', 'audioAac', undefined, {}, 'hls')).resolves.toBe(jobId)
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/media/conversions')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'x'.repeat(32)}` })
    expect(JSON.parse(String(options?.body))).toEqual({ url: 'https://cdn.example/video.mkv?token=private', mode: 'audioAac', outputFormat: 'hls', headers: {} })
  })

  it('requests the server-owned playback fallback strategy', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ jobId: '0123456789abcdef0123456789abcdef', status: 'processing' }), { status: 202 }))
    await startMediaConversion('https://cdn.example/movie.mkv?sig=private', 'auto')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ url: 'https://cdn.example/movie.mkv?sig=private', mode: 'auto', outputFormat: 'mp4', headers: {} })
  })

  it('sends Stremio request headers only inside an authenticated worker request', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ url: '/v1/media/0123456789abcdef0123456789abcdef?expires=123&signature=opaque', expiresAt: 123 }), { status: 200 }))
    const session = await createMediaSession('https://cdn.example/video.mp4?sig=short-lived', undefined, { authorization: 'Bearer provider-secret', referer: 'https://addon.example/' })
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/media/sessions')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'x'.repeat(32)}` })
    expect(JSON.parse(String(options?.body))).toMatchObject({ headers: { authorization: 'Bearer provider-secret', referer: 'https://addon.example/' } })
    expect(session.url).not.toContain('provider-secret')
  })

  it('rejects unsafe provider request headers before sending them to the worker', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    await expect(createMediaSession('https://cdn.example/video.mp4', undefined, { 'x-forwarded-host': '127.0.0.1' })).rejects.toThrow('unsupported playback request header')
    expect(fetch).not.toHaveBeenCalled()
    await expect(createMediaSession('https://cdn.example/video.mp4', undefined, { Authorization: 'Bearer value\r\nX-Evil: true' })).rejects.toThrow('invalid playback request header value')
  })

  it('polls conversion status and accepts only a signed same-worker media session', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    const jobId = '0123456789abcdef0123456789abcdef'
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ jobId, status: 'processing' }), { status: 200 }))
    await expect(getMediaConversionStatus(jobId)).resolves.toEqual({ jobId, status: 'processing' })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      jobId,
      status: 'ready',
      mode: 'audioAac',
      bytes: 4096,
      url: '/v1/media/abcdef0123456789abcdef0123456789?expires=123&signature=opaque',
      sourceInfo: { container: 'matroska,webm', streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'opus' }] },
    }), { status: 200 }))
    await expect(getMediaConversionStatus(jobId)).resolves.toMatchObject({
      jobId,
      status: 'ready',
      mode: 'audioAac',
      bytes: 4096,
      url: 'https://worker.example/v1/media/abcdef0123456789abcdef0123456789?expires=123&signature=opaque',
      sourceInfo: { container: 'matroska,webm', streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'opus' }] },
    })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      jobId,
      status: 'ready',
      mode: 'remux',
      bytes: 10,
      url: 'https://attacker.example/v1/media/abcdef0123456789abcdef0123456789?expires=123&signature=x',
    }), { status: 200 }))
    await expect(getMediaConversionStatus(jobId)).rejects.toThrow('unsafe playback session URL')
  })

  it('cancels the worker conversion with the authenticated job endpoint', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await cancelMediaConversion('0123456789abcdef0123456789abcdef')
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/media/conversions/0123456789abcdef0123456789abcdef')
    expect(options?.method).toBe('DELETE')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(32)}` })
  })

  it('relays MDBList calls only to the configured worker with provider credentials in the authenticated body', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: '{"access_token":"private-result"}' }), { status: 200 }))
    await expect(proxyMdblistRequest('POST', '/oauth/token/', {}, 'grant_type=authorization_code', 'application/x-www-form-urlencoded'))
      .resolves.toEqual({ status: 200, ok: true, body: '{"access_token":"private-result"}' })
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/providers/mdblist')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'x'.repeat(32)}` })
    expect(JSON.parse(String(options?.body))).toEqual({
      method: 'POST', path: '/oauth/token/', body: 'grant_type=authorization_code', contentType: 'application/x-www-form-urlencoded',
    })
  })

  it('relays Trakt calls through its fixed provider endpoint and rejects unsafe origins or headers', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 204, ok: true, body: '' }), { status: 200 }))
    await expect(proxyTraktRequest(
      'https://api.trakt.tv/sync/history',
      'POST',
      { 'Content-Type': 'application/json', 'trakt-api-key': 'public-client-id', Authorization: 'Bearer user-token' },
      '{"movies":[]}',
    )).resolves.toEqual({ status: 204, ok: true, body: '' })
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/providers/trakt')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(32)}` })
    expect(JSON.parse(String(options?.body))).toEqual({
      method: 'POST', path: '/sync/history',
      headers: { 'content-type': 'application/json', 'trakt-api-key': 'public-client-id', authorization: 'Bearer user-token' },
      body: '{"movies":[]}',
    })
    await expect(proxyTraktRequest('https://attacker.example/path', 'GET', {})).rejects.toThrow('fixed HTTPS Trakt API origin')
    await expect(proxyTraktRequest('https://api.trakt.tv/path', 'GET', { 'x-forwarded-host': 'attacker.example' })).rejects.toThrow('unsupported header')
  })

  it('relays TorBox calls through the authenticated worker without mixing provider and worker credentials', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(40) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: '{"success":true,"data":[]}' }), { status: 200 }))
    await expect(proxyTorboxRequest('POST', '/torrents/checkcached', 'torbox-private-token', '{"hashes":[]}'))
      .resolves.toEqual({ status: 200, ok: true, body: '{"success":true,"data":[]}' })
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/providers/torbox')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(40)}` })
    expect(JSON.parse(String(options?.body))).toEqual({
      method: 'POST', path: '/torrents/checkcached', token: 'torbox-private-token', body: '{"hashes":[]}', contentType: 'application/json',
    })
  })

  it('relays Aurales Sync credentials and records only to the configured worker route', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(40) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: '{"accessToken":"account-token"}' }), { status: 200 }))
    await expect(proxyAuralesSyncRequest('/v1/auth/login', '{"email":"user@example.test","password":"private"}'))
      .resolves.toEqual({ status: 200, ok: true, body: '{"accessToken":"account-token"}' })
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/providers/aurales-sync')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(40)}` })
    expect(JSON.parse(String(options?.body))).toEqual({
      method: 'POST', path: '/v1/auth/login', bearerToken: null,
      body: '{"email":"user@example.test","password":"private"}',
    })
  })

  it('uses Rust ranked results through the service and validates its response contract', async () => {
    saveMediaWorkerConfig({ baseUrl: 'http://localhost:8188', apiKey: 'x'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ stream: streams[0], score: 72, reasons: ['1080p quality'], fingerprint: 'a' }], stale: false }), { status: 200 }))
    await expect(rankStreamsWithWorker(streams, context)).resolves.toEqual([{ stream: streams[0], score: 72, reasons: ['1080p quality'] }])
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ streams, context })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [] }), { status: 200 }))
    await expect(rankStreamsWithWorker(streams, context)).rejects.toThrow('invalid stream ranking response')
  })

  it('relays PMDB requests through a fixed worker endpoint with separate worker and provider credentials', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(40) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: '{"items":[]}' }), { status: 200 }))
    await expect(proxyPmdbRequest('GET', '/resume?perPage=1&page=1', 'pm-user-private-key'))
      .resolves.toEqual({ status: 200, ok: true, body: '{"items":[]}' })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://worker.example/v1/providers/pmdb')
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(40)}` })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      method: 'GET', path: '/resume?perPage=1&page=1', apiKey: 'pm-user-private-key', body: null,
    })
  })
})
