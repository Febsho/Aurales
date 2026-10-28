import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  appState: { pmdbApiKey: 'pm-browser-private-key' },
}))
const storedValues = new Map<string, string>()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => mocks.appState } }))
vi.mock('./network/requestCoordinator', () => ({
  requestCoordinator: {
    run: (_request: unknown, operation: () => unknown) => operation(),
  },
}))

import { checkPMDBConnection } from './pmdb'

beforeEach(() => {
  storedValues.clear()
  mocks.invoke.mockReset()
  mocks.appState.pmdbApiKey = 'pm-browser-private-key'
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
    clear: () => storedValues.clear(),
  })
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => vi.unstubAllGlobals())

describe('PMDB browser transport', () => {
  it('uses the authenticated Aurales worker when configured for a CORS-restricted provider', async () => {
    localStorage.setItem('aurales_media_worker_secret_v1', JSON.stringify({
      baseUrl: 'https://worker.example',
      apiKey: 'worker-private-key-which-is-long-enough',
    }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 200,
      ok: true,
      body: JSON.stringify({ meta: { total: 12 } }),
    }), { status: 200 }))

    await expect(checkPMDBConnection()).resolves.toMatchObject({ connected: true, resumeCount: 12 })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://worker.example/v1/providers/pmdb')
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer worker-private-key-which-is-long-enough' })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      method: 'GET', path: '/resume?perPage=1&page=1', apiKey: 'pm-browser-private-key', body: null,
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('uses bounded browser fetch when no worker is configured', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ meta: { total: 4 } }), { status: 200 }))

    await expect(checkPMDBConnection()).resolves.toMatchObject({ connected: true, resumeCount: 4 })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://publicmetadb.com/api/external/resume?perPage=1&page=1')
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer pm-browser-private-key')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
