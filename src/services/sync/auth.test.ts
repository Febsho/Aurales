import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, workerConfig, proxy, integratedBuild, integratedConnected } = vi.hoisted(() => ({ invokeMock: vi.fn(), workerConfig: vi.fn(), proxy: vi.fn(), integratedBuild: vi.fn(), integratedConnected: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../mediaWorker', () => ({ getMediaWorkerConfig: workerConfig, isIntegratedMediaWorkerBuild: integratedBuild, isIntegratedMediaWorkerConnected: integratedConnected, proxyAuralesSyncRequest: proxy }))
vi.mock('./auralesSync', () => ({ DEFAULT_SYNC_ENDPOINT: 'https://sync.febsho.me' }))
import { requestSyncAuth } from './auth'

beforeEach(() => { vi.clearAllMocks(); workerConfig.mockReturnValue(null); integratedBuild.mockReturnValue(false); integratedConnected.mockReturnValue(false) })
afterEach(() => vi.unstubAllGlobals())

describe('Aurales Sync authentication', () => {
  it('uses native HTTP on desktop even if a media worker is configured', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    workerConfig.mockReturnValue({ baseUrl: 'https://worker.example' })
    invokeMock.mockResolvedValue('{"accessToken":"token"}')
    await expect(requestSyncAuth('login', 'user@example.test', 'test-password')).resolves.toEqual({ accessToken: 'token' })
    expect(invokeMock).toHaveBeenCalledWith('http_request', {
      method: 'POST', url: 'https://sync.febsho.me/v1/auth/login',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.test', password: 'test-password' }),
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(proxy).not.toHaveBeenCalled()
  })

  it('preserves invalid credential responses without retrying the request', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    invokeMock.mockRejectedValue('401:{"error":"Invalid email or password."}')
    await expect(requestSyncAuth('login', 'user@example.test', 'wrong')).rejects.toThrow('Invalid email or password.')
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a native connection failure without exposing credentials', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockRejectedValue('network failure password=test-password')
    await expect(requestSyncAuth('login', 'user@example.test', 'test-password')).rejects.toThrow('Could not connect to Aurales Sync')
  })

  it('uses browser fetch for registration', async () => {
    vi.stubGlobal('window', {})
    const fetchMock = vi.fn(async () => new Response('{"accessToken":"token"}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestSyncAuth('register', 'user@example.test', 'test-password')).resolves.toEqual({ accessToken: 'token' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('normalizes the email before sending login credentials', async () => {
    vi.stubGlobal('window', {})
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"accessToken":"token"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestSyncAuth('login', '  User@Example.Test  ', 'test-password')).resolves.toEqual({ accessToken: 'token' })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ email: 'user@example.test', password: 'test-password' })
  })

  it('explains that self-hosted web builds need the integrated service unlocked before Sync login', async () => {
    vi.stubGlobal('window', {})
    integratedBuild.mockReturnValue(true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestSyncAuth('login', 'user@example.test', 'test-password')).rejects.toThrow('Unlock the Aurales media service in Settings')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retains the configured browser worker route', async () => {
    vi.stubGlobal('window', {})
    workerConfig.mockReturnValue({ baseUrl: 'https://worker.example' })
    proxy.mockResolvedValue({ status: 200, ok: true, body: '{"accessToken":"token"}' })
    await expect(requestSyncAuth('login', 'user@example.test', 'test-password')).resolves.toEqual({ accessToken: 'token' })
    expect(proxy).toHaveBeenCalledOnce()
  })
})
