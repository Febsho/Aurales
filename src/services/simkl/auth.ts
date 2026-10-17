/**
 * Simkl authentication.
 *
 * AUTH V2 browser login with PKCE and a localhost callback.
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  SimklAccount,
  SimklConfig,
  SimklConnectionStatus,
  SimklPinAuth,
  SimklToken,
} from './types'

const LS_TOKEN = 'simkl_token'
const LS_ACCOUNT = 'simkl_account'
const LS_LAST_SYNC = 'simkl_last_sync'

// Simkl matches loopback redirects without the port at authorization time;
// keep the active port here because callback handling and token exchange use it.
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:42814/auth/simkl/callback'
const V2_CLIENT_ID_KEY = 'simkl_v2_client_id'
let pendingCallback: Promise<string> | null = null
let pendingAccount: Promise<SimklAccount> | null = null
let startingLogin: Promise<SimklPinAuth> | null = null
let cancellingCallback: Promise<void> | null = null
const refreshingToken = new Map<string, Promise<SimklToken | null>>()
let authGeneration = 0
const OAUTH_PENDING: SimklPinAuth = { userCode: '', verificationUrl: '', interval: 5, expiresIn: 600 }

export function getSimklAuthGeneration(): number {
  return authGeneration
}

export function getSimklClientId(): string {
  return localStorage.getItem(V2_CLIENT_ID_KEY) || import.meta.env.VITE_SIMKL_V2_CLIENT_ID || ''
}

export async function getSimklConfig(): Promise<SimklConfig> {
  return {
    clientId: getSimklClientId(),
    clientSecret: '',
    redirectUri: import.meta.env.VITE_SIMKL_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  }
}

export function isSimklMockMode(): boolean {
  return false
}

export function initiateSimklLogin(): Promise<SimklPinAuth> {
  // A second click must reuse the active callback and PKCE state. Replacing
  // either would make the first browser approval fail after it reaches us.
  if (pendingCallback) return Promise.resolve(OAUTH_PENDING)
  if (startingLogin) return startingLogin
  const generation = authGeneration
  const request = (async () => {
    let callback: Promise<string> | null = null
    try {
      if (cancellingCallback) await cancellingCallback
      if (generation !== authGeneration) throw new DOMException('Simkl sign-in was cancelled.', 'AbortError')
      const config = await getSimklConfig()
      if (!config.clientId) {
        throw new Error('SIMKL AUTH V2 is not configured. Set VITE_SIMKL_V2_CLIENT_ID to a desktop/browser AUTH V2 client ID.')
      }
      const verifier = randomUrlSafe(48)
      const state = randomUrlSafe(24)
      const challenge = await sha256UrlSafe(verifier)
      if (generation !== authGeneration) throw new DOMException('Simkl sign-in was cancelled.', 'AbortError')
      sessionStorage.setItem('simkl_oauth_v2', JSON.stringify({ verifier, state, redirectUri: config.redirectUri }))
      // The callback server must own the port before the browser is sent away.
      callback = invoke<string>('start_simkl_callback_server')
      pendingCallback = callback
      void callback.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 75))
      if (generation !== authGeneration) throw new DOMException('Simkl sign-in was cancelled.', 'AbortError')
      const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'media:read media:write', state, code_challenge: challenge, code_challenge_method: 'S256' })
      await invoke('open_simkl_auth', { url: `https://simkl.com/oauth2/authorize?${params}` })
      return OAUTH_PENDING
    } catch (error) {
      if (callback && pendingCallback === callback) pendingCallback = null
      if (generation === authGeneration) sessionStorage.removeItem('simkl_oauth_v2')
      // Disconnect can race ahead of the Rust command registering its cancel
      // handle. Retry cancellation after the start command has settled.
      if (callback) await invoke<void>('cancel_simkl_callback_server').catch(() => {})
      throw error
    }
  })()
  startingLogin = request
  void request.finally(() => { if (startingLogin === request) startingLogin = null }).catch(() => {})
  return request
}

export async function completeSimklLogin(code: string): Promise<SimklAccount> {
  const generation = ++authGeneration
  const config = await getSimklConfig()
  const pending = readPendingOauth()
  if (!code.trim()) throw new Error('Simkl did not return an authorization code.')
  const tokenJson = await invoke<string>('exchange_simkl_v2_token', { code: code.trim(), clientId: config.clientId, redirectUri: pending.redirectUri, codeVerifier: pending.verifier })
  if (generation !== authGeneration) throw new Error('Simkl sign-in was cancelled.')
  const token = parseTokenResponse(tokenJson)
  sessionStorage.removeItem('simkl_oauth_v2')
  return finaliseSimklLogin(token, generation)
}

/** @deprecated kept for older call sites. */
export async function startSimklLogin(): Promise<SimklAccount> {
  return completeSimklLogin('')
}

/** @deprecated Aurales now uses the Simkl PIN flow, not OAuth callbacks. */
export async function handleSimklCallback(code: string): Promise<void> {
  const account = await completeSimklLogin(code)
  saveSimklAccount(account)
}

/** @deprecated Aurales now uses the Simkl PIN flow, not authorization-code exchange. */
export async function exchangeSimklCodeForToken(code: string): Promise<SimklToken> {
  const account = await completeSimklLogin(code)
  if (!account.id) throw new Error('Simkl account details were missing.')
  return getStoredSimklToken()!
}

export async function finaliseSimklLogin(token: SimklToken, generation = authGeneration): Promise<SimklAccount> {
  if (generation !== authGeneration) throw new Error('Simkl sign-in was cancelled.')
  const config = await getSimklConfig()
  if (generation !== authGeneration) throw new Error('Simkl sign-in was cancelled.')
  saveSimklToken(token)
  const account = await fetchSimklAccount(token.accessToken, config.clientId)
  const current = getStoredSimklToken()
  if (generation !== authGeneration || current?.accessToken !== token.accessToken) {
    throw new Error('Simkl sign-in was cancelled.')
  }
  saveSimklAccount(account)
  return account
}

function parseTokenResponse(json: string): SimklToken {
  const data = JSON.parse(json) as Record<string, unknown>
  if (data.status && data.status !== 'approved') {
    throw new Error(String(data.message || 'Waiting for Simkl approval.'))
  }

  const accessToken = String(data.access_token || data.accessToken || '')
  if (!accessToken) throw new Error(String(data.message || 'Simkl did not return an access token yet.'))

  return {
    accessToken,
    tokenType: String(data.token_type || data.tokenType || 'Bearer'),
    scope: String(data.scope || ''),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
  }
}

function randomUrlSafe(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256UrlSafe(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function readPendingOauth(): { verifier: string; state: string; redirectUri: string } {
  try {
    const parsed = JSON.parse(sessionStorage.getItem('simkl_oauth_v2') || '')
    if (parsed?.verifier && parsed?.state && parsed?.redirectUri) return parsed
  } catch (_) { /* handled below */ }
  throw new Error('Simkl sign-in session expired. Start the connection again.')
}

export async function waitForSimklOauthCallback(): Promise<SimklAccount> {
  if (pendingAccount) return pendingAccount
  const generation = authGeneration
  const pending = readPendingOauth()
  if (!pendingCallback) throw new Error('Simkl sign-in session expired. Start the connection again.')
  const callbackPromise = pendingCallback
  const request = (async () => {
    const callback = JSON.parse(await callbackPromise) as { code?: string; state?: string; iss?: string; error?: string }
    if (generation !== authGeneration) throw new DOMException('Simkl sign-in was cancelled.', 'AbortError')
    if (callback.state !== pending.state || callback.iss !== 'https://simkl.com') throw new Error('Rejected an unexpected Simkl authorization response.')
    if (callback.error) throw new Error(callback.error === 'access_denied' ? 'Simkl sign-in was cancelled.' : `Simkl authorization failed: ${callback.error}`)
    return completeSimklLogin(callback.code || '')
  })()
  pendingAccount = request
  try {
    return await request
  } finally {
    if (pendingCallback === callbackPromise) pendingCallback = null
    if (pendingAccount === request) pendingAccount = null
    if (generation === authGeneration) sessionStorage.removeItem('simkl_oauth_v2')
  }
}

export function refreshSimklToken(): Promise<SimklToken | null> {
  const token = getStoredSimklToken()
  const clientId = getSimklClientId()
  if (!token?.refreshToken || !clientId) return Promise.resolve(null)
  const key = `${clientId}\u0000${token.refreshToken}\u0000${token.accessToken}`
  const existing = refreshingToken.get(key)
  if (existing) return existing
  const pending = refreshSimklTokenImpl(token, clientId)
  const tracked = pending.finally(() => {
    if (refreshingToken.get(key) === tracked) refreshingToken.delete(key)
  })
  refreshingToken.set(key, tracked)
  return tracked
}

async function refreshSimklTokenImpl(token: SimklToken, clientId: string): Promise<SimklToken | null> {
  const generation = authGeneration
  if (!token?.refreshToken || !clientId) return null
  try {
    const json = await invoke<string>('refresh_simkl_v2_token', { refreshToken: token.refreshToken, clientId })
    const current = getStoredSimklToken()
    if (generation !== authGeneration || !current || current.refreshToken !== token.refreshToken || current.accessToken !== token.accessToken) return null
    const response = parseTokenResponse(json)
    const refreshed = {
      ...response,
      // OAuth servers may omit a refresh token when the existing one remains valid.
      refreshToken: response.refreshToken || token.refreshToken,
    }
    saveSimklToken(refreshed)
    return refreshed
  } catch (_) { return null }
}

export function getStoredSimklToken(): SimklToken | null {
  try {
    const raw = localStorage.getItem(LS_TOKEN)
    if (!raw) return null
    return JSON.parse(raw) as SimklToken
  } catch (_) {
    return null
  }
}

export function saveSimklToken(token: SimklToken): void {
  localStorage.setItem(LS_TOKEN, JSON.stringify(token))
}

function saveSimklAccount(account: SimklAccount): void {
  localStorage.setItem(LS_ACCOUNT, JSON.stringify(account))
}

export function getStoredSimklAccount(): SimklAccount | null {
  try {
    const raw = localStorage.getItem(LS_ACCOUNT)
    if (!raw) return null
    return JSON.parse(raw) as SimklAccount
  } catch (_) {
    return null
  }
}

export function disconnectSimkl(): void {
  authGeneration++
  pendingCallback = null
  pendingAccount = null
  startingLogin = null
  const cancellation = invoke<void>('cancel_simkl_callback_server').catch(() => {})
  cancellingCallback = cancellation
  void cancellation.finally(() => { if (cancellingCallback === cancellation) cancellingCallback = null })
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_ACCOUNT)
  localStorage.removeItem(LS_LAST_SYNC)
  sessionStorage.removeItem('simkl_oauth_v2')
}

export function getSimklConnectionStatus(): SimklConnectionStatus {
  const token = getStoredSimklToken()
  const account = getStoredSimklAccount()
  const lastSyncAt = localStorage.getItem(LS_LAST_SYNC) || undefined
  return {
    connected: !!token?.accessToken,
    account: account ?? undefined,
    lastSyncAt,
    mockMode: isSimklMockMode(),
  }
}

async function fetchSimklAccount(accessToken: string, clientId: string): Promise<SimklAccount> {
  const json = await invoke<string>('fetch_simkl_user', {
    accessToken,
    clientId,
  })
  const data = JSON.parse(json) as Record<string, unknown>
  const user = (data.user || data) as Record<string, unknown>
  return {
    id: String(user.id || user.simkl_id || ''),
    username: String(user.username || user.name || 'Simkl User'),
    avatar: typeof user.avatar === 'string'
      ? (user.avatar.startsWith('http') ? user.avatar : `https://wsrv.nl/?url=https://simkl.in${user.avatar}&w=64`)
      : undefined,
  }
}
