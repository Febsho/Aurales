import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamResult } from '../types'
import { selectTorBoxFile, startTorBoxDeviceAuth, pollTorBoxDeviceToken, type TorBoxCachedFile } from './torbox'
import { saveMediaWorkerConfig } from './mediaWorker'

const files: TorBoxCachedFile[] = [
  { id: 10, name: 'Show.S01E01.1080p.mkv', size: 2_000, mimetype: 'video/x-matroska' },
  { id: 11, name: 'Show.S01E02.1080p.mkv', size: 2_100, mimetype: 'video/x-matroska' },
  { id: 12, name: 'sample.mkv', size: 100, mimetype: 'video/x-matroska' },
]

describe('selectTorBoxFile', () => {
  it('honors the Stremio file index', () => {
    expect(selectTorBoxFile(files, { fileIdx: 0 } as StreamResult)?.id).toBe(10)
  })

  it('matches the requested episode', () => {
    expect(selectTorBoxFile(files, {}, { season: 1, episode: 2 })?.id).toBe(11)
  })

  it('uses the largest non-sample video as fallback', () => {
    expect(selectTorBoxFile(files, {})?.id).toBe(11)
  })
})

describe('TorBox browser worker transport', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(40) })
  })

  it('relays device login and polling to the authenticated worker without a provider token', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: JSON.stringify({ success: true, error: null, detail: '', data: {
      device_code: 'device-private', interval: 5, expires_at: '2026-10-18T00:00:00Z', verification_url: 'https://torbox.app/activate', friendly_verification_url: 'https://torbox.app/activate', code: 'ABCD',
    } }) }), { status: 200 }))
    await expect(startTorBoxDeviceAuth()).resolves.toMatchObject({ device_code: 'device-private' })
    const [startEndpoint, startOptions] = vi.mocked(fetch).mock.calls[0]
    expect(startEndpoint).toBe('https://worker.example/v1/providers/torbox')
    expect(startOptions?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(40)}` })
    expect(JSON.parse(String(startOptions?.body))).toMatchObject({ method: 'GET', path: '/user/auth/device/start?app=Aurales', token: null })

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: JSON.stringify({ success: true, error: null, detail: '', data: { access_token: 'torbox-user-token' } }) }), { status: 200 }))
    await expect(pollTorBoxDeviceToken('device-private')).resolves.toBe('torbox-user-token')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toMatchObject({
      method: 'POST', path: '/user/auth/device/token', token: null, body: '{"device_code":"device-private"}',
    })
  })
})
