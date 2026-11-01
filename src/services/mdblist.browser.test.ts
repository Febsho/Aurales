import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ mdblistApiKey: '' }) } }))
vi.mock('./network/requestCoordinator', () => ({
  requestCoordinator: { run: (_request: unknown, operation: (signal: AbortSignal) => unknown) => operation(new AbortController().signal) },
}))

import { completeMdblistBrowserCallback, getMdblistUserLists, startMdblistPKCELogin } from './mdblist'
import { saveMediaWorkerConfig } from './mediaWorker'

const storage = new Map<string, string>()
const sessionStorageValues = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  sessionStorageValues.clear()
  storage.set('mdblist_oauth_tokens', JSON.stringify({
    accessToken: 'browser-account-token',
    expiresAt: Math.floor(Date.now() / 1000) + 172800,
  }))
  vi.stubGlobal('window', { location: { origin: 'https://aurales.example' }, dispatchEvent: vi.fn() })
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => sessionStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => sessionStorageValues.set(key, value),
    removeItem: (key: string) => sessionStorageValues.delete(key),
  })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('MDBList browser account requests', () => {
  it('sends the stored account token through browser fetch without invoking Tauri', async () => {
    await expect(getMdblistUserLists()).resolves.toEqual([])

    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer browser-account-token')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('routes browser account requests through the configured worker for provider CORS', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(32) })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, ok: true, body: '{"items":[]}' }), { status: 200 }))
    await expect(getMdblistUserLists()).resolves.toEqual([])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/providers/mdblist')
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${'w'.repeat(32)}` })
    expect(JSON.parse(String(options?.body))).toMatchObject({ method: 'GET', path: '/lists/user/?sort=rank&unified=false', bearerToken: 'browser-account-token' })
  })

  it('exchanges MDBList browser OAuth codes through the trusted worker when configured', async () => {
    saveMediaWorkerConfig({ baseUrl: 'https://worker.example', apiKey: 'w'.repeat(32) })
    const { session } = await startMdblistPKCELogin()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 200,
      ok: true,
      body: JSON.stringify({ access_token: 'worker-exchanged-token', refresh_token: 'worker-refresh-token', expires_in: 3600 }),
    }), { status: 200 }))

    const callback = new URLSearchParams({ code: 'authorization-code', state: session.state })
    await expect(completeMdblistBrowserCallback(`?${callback}`)).resolves.toMatchObject({ accessToken: 'worker-exchanged-token' })
    const [endpoint, options] = vi.mocked(fetch).mock.calls[0]
    expect(endpoint).toBe('https://worker.example/v1/providers/mdblist')
    expect(JSON.parse(String(options?.body))).toMatchObject({
      method: 'POST', path: '/oauth/token/', contentType: 'application/x-www-form-urlencoded',
    })
    expect(String(JSON.parse(String(options?.body)).body)).toContain('code_verifier=')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('starts a same-origin PKCE authorization without desktop IPC', async () => {
    const { authUrl, session } = await startMdblistPKCELogin()
    const authorize = new URL(authUrl)
    expect(authorize.origin).toBe('https://mdblist.com')
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://aurales.example/auth/mdblist/callback')
    expect(authorize.searchParams.get('state')).toBe(session.state)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(JSON.parse(sessionStorageValues.get('mdblist_oauth_pkce_v1') || '{}').codeVerifier).toBe(session.codeVerifier)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('validates callback state, exchanges the code with PKCE, and stores tokens', async () => {
    const { authUrl, session } = await startMdblistPKCELogin()
    const callback = new URLSearchParams({ code: 'one-time-code', state: session.state })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-browser-token', refresh_token: 'refresh-token', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(completeMdblistBrowserCallback(`?${callback}`)).resolves.toMatchObject({ accessToken: 'new-browser-token' })
    expect(storage.get('mdblist_oauth_tokens')).toContain('new-browser-token')
    expect(sessionStorageValues.has('mdblist_oauth_pkce_v1')).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
    const authorize = new URL(authUrl)
    const requestBody = new URLSearchParams(String(fetchMock.mock.calls.at(-1)?.[1]?.body))
    expect(requestBody.get('code_verifier')).toBe(session.codeVerifier)
    expect(requestBody.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'))
  })

  it('rejects a callback with a mismatched state without exchanging its code', async () => {
    await startMdblistPKCELogin()
    await expect(completeMdblistBrowserCallback('?code=stolen&state=wrong')).rejects.toThrow('unexpected MDBList authorization response')
    expect(fetch).not.toHaveBeenCalled()
  })
})
