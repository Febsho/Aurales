import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveMediaWorkerConfig } from '../mediaWorker'
import { getDeviceCode, getStoredTokens, pollForToken } from './auth'

const storageValues = new Map<string, string>()
const testStorage: Storage = {
  get length() { return storageValues.size },
  key: (index) => [...storageValues.keys()][index] ?? null,
  getItem: (key) => storageValues.get(key) ?? null,
  setItem: (key, value) => { storageValues.set(key, String(value)) },
  removeItem: (key) => { storageValues.delete(key) },
  clear: () => { storageValues.clear() },
}

beforeEach(() => {
  testStorage.clear()
  vi.stubGlobal('localStorage', testStorage)
  vi.stubGlobal('window', {})
  saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(32) })
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Trakt browser auth through the optional media worker', () => {
  it('never sends a build-time client secret to the worker', async () => {
    vi.stubEnv('VITE_TRAKT_CLIENT_SECRET', 'shared-build-secret')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 200,
      ok: true,
      body: JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', created_at: 1_800_000_000, expires_in: 3600 }),
    }), { status: 200 }))

    await pollForToken('private-device-code')
    const [, options] = vi.mocked(fetch).mock.calls[0]
    const request = JSON.parse(String(options?.body)) as { body: string }
    expect(JSON.parse(request.body)).not.toHaveProperty('client_secret')
    expect(JSON.stringify(options?.body)).not.toContain('shared-build-secret')
  })

  it('uses the fixed-origin worker for device code and token requests', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 200,
      ok: true,
      body: JSON.stringify({ device_code: 'device-code', user_code: 'ABCD-1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 }),
    }), { status: 200 }))
    await expect(getDeviceCode()).resolves.toMatchObject({ deviceCode: 'device-code', userCode: 'ABCD-1234' })

    localStorage.setItem('trakt_client_secret', 'user-provided-secret')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 200,
      ok: true,
      body: JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', created_at: 1_800_000_000, expires_in: 3600 }),
    }), { status: 200 }))
    await expect(pollForToken('private-device-code')).resolves.toMatchObject({ accessToken: 'access-token' })
    expect(getStoredTokens()).toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' })

    const [deviceEndpoint, deviceOptions] = vi.mocked(fetch).mock.calls[0]
    expect(deviceEndpoint).toBe('https://worker.example/v1/providers/trakt')
    expect(deviceOptions?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(32)}` })
    expect(JSON.parse(String(deviceOptions?.body))).toMatchObject({
      method: 'POST', path: '/oauth/device/code',
      headers: { 'content-type': 'application/json' },
      body: expect.stringContaining('client_id'),
    })

    const [, tokenOptions] = vi.mocked(fetch).mock.calls[1]
    const tokenRequest = JSON.parse(String(tokenOptions?.body)) as { path: string; body: string }
    expect(tokenRequest.path).toBe('/oauth/device/token')
    expect(JSON.parse(tokenRequest.body)).toMatchObject({ code: 'private-device-code', client_secret: 'user-provided-secret' })
  })
})
