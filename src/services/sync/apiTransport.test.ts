import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestSyncEndpoint } from './apiTransport'

afterEach(() => vi.unstubAllGlobals())

describe('Aurales Sync browser transport', () => {
  it('retries CORS-blocked requests from a local LAN web preview through its same-origin proxy', async () => {
    vi.stubGlobal('window', { location: new URL('http://192.168.178.59:5188/') })
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"error":"Invalid email or password."}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await requestSyncEndpoint('https://sync.febsho.me', '/v1/auth/login', { method: 'POST' })

    expect(response.status).toBe(401)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://sync.febsho.me/v1/auth/login',
      '/__aurales_sync/v1/auth/login',
    ])
  })

  it('explains CORS configuration for non-local deployments instead of returning a browser TypeError', async () => {
    vi.stubGlobal('window', { location: new URL('https://watch.example.com/') })
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestSyncEndpoint('https://sync.febsho.me', '/v1/auth/register', { method: 'POST' }))
      .rejects.toThrow('allow this exact HTTPS app origin')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
