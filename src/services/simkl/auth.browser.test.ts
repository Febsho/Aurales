import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../platform/capabilities', () => ({ getPlatformCapabilities: () => ({ platform: 'web' }) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { completeSimklBrowserCallback, disconnectSimkl, getStoredSimklAccount, getStoredSimklToken, initiateSimklLogin, refreshSimklToken } from './auth'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
}

describe('Simkl browser AUTH V2', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
    vi.stubGlobal('sessionStorage', storage())
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('window', { location: { origin: 'https://aurales.example', assign: vi.fn() } })
    invoke.mockReset()
    localStorage.setItem('simkl_v2_client_id', 'public-client')
    sessionStorage.setItem('simkl_oauth_v2', JSON.stringify({ verifier: 'verifier', state: 'state-123', redirectUri: 'https://aurales.example/auth/simkl/callback' }))
  })

  it('starts browser PKCE navigation with a same-origin callback and no Tauri IPC', async () => {
    await expect(initiateSimklLogin()).resolves.toMatchObject({ userCode: '' })
    const target = new URL(vi.mocked(window.location.assign).mock.calls[0][0])
    expect(target.origin).toBe('https://simkl.com')
    expect(target.searchParams.get('redirect_uri')).toBe('https://aurales.example/auth/simkl/callback')
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    expect(sessionStorage.getItem('simkl_oauth_v2')).toContain('state')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('validates callback state/issuer, exchanges the code, and stores the account', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 60, scope: 'media:read media:write' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 42, username: 'aurales-user' } }), { status: 200 }))

    await expect(completeSimklBrowserCallback('?code=auth-code&state=state-123&iss=https%3A%2F%2Fsimkl.com')).resolves.toEqual({ id: '42', username: 'aurales-user', avatar: undefined })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.simkl.com/oauth2/token')
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('code_verifier')).toBe('verifier')
    expect(getStoredSimklToken()?.accessToken).toBe('access')
    expect(getStoredSimklAccount()?.id).toBe('42')
    expect(sessionStorage.getItem('simkl_oauth_v2')).toBeNull()
  })

  it('rejects state mismatch before any network request', async () => {
    await expect(completeSimklBrowserCallback('?code=auth-code&state=wrong&iss=https%3A%2F%2Fsimkl.com')).rejects.toThrow('Rejected an unexpected Simkl authorization response')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refreshes in browser and keeps the existing refresh token when omitted', async () => {
    localStorage.setItem('simkl_token', JSON.stringify({ accessToken: 'old', refreshToken: 'refresh' }))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new', expires_in: 60 }), { status: 200 }))
    await expect(refreshSimklToken()).resolves.toMatchObject({ accessToken: 'new', refreshToken: 'refresh' })
    expect(new URLSearchParams(String(vi.mocked(fetch).mock.calls[0][1]?.body)).get('grant_type')).toBe('refresh_token')
    disconnectSimkl()
    expect(getStoredSimklToken()).toBeNull()
  })
})
