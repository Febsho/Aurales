import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../stores/appStore'
import { getSelfhstIconUrl } from './serviceIcons'
import type { SearchResult } from '../types'
import { mediaIdentity } from './mediaPresentation'
import { rotateProviderCredentialScope } from './cache/homeStartupSnapshot'
import { withRequestTimeout } from './network/timeout'
import { readBoundedResponseJson, readBoundedResponseText } from './network/boundedResponse'
import { getPlatformCapabilities } from '../platform/capabilities'
import { getMediaWorkerConfig, proxyMdblistRequest } from './mediaWorker'

export interface MdblistRating {
  source: string
  label: string
  value: string
  icon: string
  iconUrl?: string
}

interface RatingRequest {
  mediaType: 'movie' | 'series'
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  season?: number
  episode?: number
}

const BASE_URL = 'https://api.mdblist.com'
const MAX_MDBLIST_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_MDBLIST_OAUTH_RESPONSE_BYTES = 1024 * 1024
const MAX_MDBLIST_PUBLIC_LIST_HTML_BYTES = 2 * 1024 * 1024
const BUILTIN_KEY = '9x2ikjc88drsgwc0ocsp2p5wn'
const BUILTIN_MDBLIST_CLIENT_ID = '1QZNjkmxhfpFEWOsOmAmkphArnbfoKeWlmbJZMOC'
const MDBLIST_CLIENT_ID = import.meta.env.VITE_MDBLIST_CLIENT_ID || BUILTIN_MDBLIST_CLIENT_ID
const MDBLIST_TOKEN_KEY = 'mdblist_oauth_tokens'
const MDBLIST_REQUEST_SPACING_MS = 250
let mdblistRequestQueue: Promise<void> = Promise.resolve()
let mdblistNextRequestAt = 0
const mdblistRefreshPending = new Map<string, Promise<MdblistOAuthTokens | null>>()
let mdblistAuthGeneration = 0
let mdblistCallbackCancellation: Promise<void> | null = null

class MdblistRateLimitError extends Error {
  retryAfterMs: number

  constructor(retryAfterMs = 10_000) {
    super('MDBList rate limit reached')
    this.retryAfterMs = retryAfterMs
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function queueMdblistRequest<T>(request: () => Promise<T>): Promise<T> {
  const queued = mdblistRequestQueue.then(async () => {
    const delay = Math.max(0, mdblistNextRequestAt - Date.now())
    if (delay) await wait(delay)
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await request()
        } catch (error) {
          const rateLimit = error instanceof MdblistRateLimitError
            ? error
            : /\b429\b|rate limit|too many requests/i.test(error instanceof Error ? error.message : String(error))
              ? new MdblistRateLimitError()
              : null
          if (!rateLimit) throw error
          mdblistNextRequestAt = Math.max(mdblistNextRequestAt, Date.now() + rateLimit.retryAfterMs)
          if (attempt === 0) {
            await wait(rateLimit.retryAfterMs)
            continue
          }
          throw rateLimit
        }
      }
      throw new MdblistRateLimitError()
    } finally {
      mdblistNextRequestAt = Math.max(mdblistNextRequestAt, Date.now() + MDBLIST_REQUEST_SPACING_MS)
    }
  })
  mdblistRequestQueue = queued.then(() => undefined, () => undefined)
  return queued
}

function mdblistRetryAfterMs(response: Response): number {
  const retrySeconds = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retrySeconds) && retrySeconds > 0) return retrySeconds * 1000
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) return Math.max(1000, resetSeconds * 1000 - Date.now())
  return 10_000
}

export interface MdblistUser {
  user_id?: number
  username?: string
  name?: string
  avatar_url?: string
  plan?: string
  is_supporter?: boolean
  rate_limit_remaining?: number
}

export interface MdblistList {
  id: string
  name: string
  slug?: string
  mediatype?: string
  private?: boolean
  items?: number
  likes?: number
  user_name?: string
  user_id?: number
}

export interface MdblistPlaybackItem {
  id: string
  progress: number
  runtime?: number
  updated_at?: string
  paused_at?: string
  type: 'movie' | 'episode'
  movie?: any
  show?: any
  episode?: any
}

export interface MdblistWatchedItem {
  id: string
  media_type: 'movie' | 'show'
  watched_at?: string
  title?: string
  year?: number
  imdb_id?: string
  tmdb_id?: number
  tvdb_id?: number
  mdblist_id?: string
  season?: number
  episode?: number
}

export interface MdblistOAuthTokens {
  accessToken: string
  refreshToken?: string
  tokenType: string
  scope?: string
  expiresAt: number
  createdAt: number
}

export interface MdblistDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

const PROVIDER_LABELS: Record<string, string> = {
  imdb: 'IMDb',
  tomatoesaudience: 'TOMATOES',
  tomato_meter: 'TOMATOES',
  tomato: 'TOMATOES',
  rottentomatoes: 'TOMATOES',
  metacritic: 'Metacritic',
  metacriticuser: 'MC User',
  tmdb: 'TMDB',
  trakt: 'Trakt',
  letterboxd: 'Letterboxd',
  myanimelist: 'MAL',
  mal: 'MAL',
  popcorn: 'POPCORN',
}

const PROVIDER_ICONS: Record<string, string> = {
  imdb: 'IMDb',
  tomatoesaudience: 'RT',
  tomato_meter: 'RT',
  tomato: 'RT',
  rottentomatoes: 'RT',
  metacritic: 'M',
  metacriticuser: 'M',
  tmdb: 'TMDB',
  trakt: 'T',
  letterboxd: 'LB',
  myanimelist: 'MAL',
  mal: 'MAL',
  popcorn: 'PO',
}

function userApiKey(): string {
  return useAppStore.getState().mdblistApiKey.trim()
}

export function getMdblistClientId(): string {
  return localStorage.getItem('mdblist_client_id') || MDBLIST_CLIENT_ID
}

export function setMdblistClientId(clientId: string): void {
  mdblistAuthGeneration++
  localStorage.setItem('mdblist_client_id', clientId.trim())
}

export function getStoredMdblistTokens(): MdblistOAuthTokens | null {
  try {
    const raw = localStorage.getItem(MDBLIST_TOKEN_KEY)
    return raw ? JSON.parse(raw) as MdblistOAuthTokens : null
  } catch (_) {
    return null
  }
}

function storeMdblistTokens(data: any, replaceAccount = false): MdblistOAuthTokens {
  const createdAt = Math.floor(Date.now() / 1000)
  const tokens: MdblistOAuthTokens = {
    accessToken: String(data.access_token || ''),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    tokenType: String(data.token_type || 'Bearer'),
    scope: data.scope ? String(data.scope) : undefined,
    expiresAt: createdAt + Number(data.expires_in || 2592000),
    createdAt,
  }
  if (!tokens.accessToken) throw new Error('MDBList did not return an access token')
  const accountChanged = replaceAccount || !localStorage.getItem(MDBLIST_TOKEN_KEY)
  if (accountChanged) rotateProviderCredentialScope('mdblist', true)
  localStorage.setItem(MDBLIST_TOKEN_KEY, JSON.stringify(tokens))
  window.dispatchEvent(new Event('aurales:mdblist-auth-changed'))
  if (accountChanged) window.dispatchEvent(new Event('aurales:provider-account-changed'))
  return tokens
}

export function clearMdblistOAuth(): void {
  mdblistAuthGeneration++
  localStorage.removeItem(MDBLIST_TOKEN_KEY)
  rotateProviderCredentialScope('mdblist', Boolean(userApiKey()))
  window.dispatchEvent(new Event('aurales:mdblist-auth-changed'))
  window.dispatchEvent(new Event('aurales:provider-account-changed'))
}

export function cancelMdblistOAuthLogin(): void {
  mdblistAuthGeneration++
  if (getPlatformCapabilities().platform === 'web') {
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    return
  }
  const cancellation = invoke<void>('cancel_anilist_callback_server', { provider: 'mdblist' })
  mdblistCallbackCancellation = cancellation
  void cancellation.finally(() => {
    if (mdblistCallbackCancellation === cancellation) mdblistCallbackCancellation = null
  }).catch(() => {})
}

async function postMdblistOAuthForm(path: string, params: Record<string, string>): Promise<any> {
  return withRequestTimeout(15_000, async (signal) => {
    let status: number
    let ok: boolean
    let data: any
    if (getPlatformCapabilities().platform === 'web' && getMediaWorkerConfig()) {
      const response = await proxyMdblistRequest('POST', path, {}, new URLSearchParams(params).toString(), 'application/x-www-form-urlencoded', signal)
      status = response.status
      ok = response.ok
      try { data = JSON.parse(response.body) } catch { data = null }
    } else {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams(params),
        signal,
      })
      status = response.status
      ok = response.ok
      data = await readBoundedResponseJson<any>(response, MAX_MDBLIST_OAUTH_RESPONSE_BYTES, 'MDBList OAuth response').catch(() => null)
    }
    if (!ok) {
      const message = data?.error_description || data?.detail || data?.error || `MDBList OAuth failed (${status})`
      const err = new Error(String(message)) as Error & { code?: string; status?: number }
      err.code = data?.error
      err.status = status
      throw err
    }
    return data
  }, 'MDBList OAuth request timed out')
}

async function refreshMdblistAccessToken(tokens: MdblistOAuthTokens): Promise<MdblistOAuthTokens | null> {
  const key = `${getMdblistClientId()}\u0000${tokens.refreshToken || ''}\u0000${tokens.accessToken}`
  const existing = mdblistRefreshPending.get(key)
  if (existing) return existing
  const pending = refreshMdblistAccessTokenImpl(tokens)
  const tracked = pending.finally(() => {
    if (mdblistRefreshPending.get(key) === tracked) mdblistRefreshPending.delete(key)
  })
  mdblistRefreshPending.set(key, tracked)
  return tracked
}

async function refreshMdblistAccessTokenImpl(tokens: MdblistOAuthTokens): Promise<MdblistOAuthTokens | null> {
  const clientId = getMdblistClientId()
  const generation = mdblistAuthGeneration
  if (!clientId || !tokens.refreshToken) return null
  const isCurrentRefresh = () => {
    const current = getStoredMdblistTokens()
    return Boolean(current && current.refreshToken === tokens.refreshToken && current.accessToken === tokens.accessToken)
  }
  try {
    const data = await postMdblistOAuthForm('/oauth/token/', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
    })
    if (generation !== mdblistAuthGeneration || clientId !== getMdblistClientId() || !isCurrentRefresh()) return null
    // Keep the current refresh token if the server rotates access tokens only.
    return storeMdblistTokens({ ...data, refresh_token: data.refresh_token || tokens.refreshToken })
  } catch (error) {
    const oauthError = error as Error & { code?: string; status?: number }
    const credentialsRejected = oauthError.code === 'invalid_grant' || oauthError.status === 401 || oauthError.status === 403
    if (credentialsRejected && isCurrentRefresh()) clearMdblistOAuth()
    return null
  }
}

async function getValidMdblistAccessToken(): Promise<string> {
  const tokens = getStoredMdblistTokens()
  if (!tokens) return ''
  if (Date.now() / 1000 < tokens.expiresAt - 86400) return tokens.accessToken
  const refreshed = await refreshMdblistAccessToken(tokens)
  const current = getStoredMdblistTokens()
  return refreshed && current?.accessToken === refreshed.accessToken ? refreshed.accessToken : ''
}

export function hasMdblistOAuth(): boolean {
  return Boolean(getStoredMdblistTokens()?.accessToken)
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(64)
  crypto.getRandomValues(array)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const MDBLIST_NATIVE_REDIRECT_URI = 'http://localhost:42814/'
const MDBLIST_BROWSER_SESSION_KEY = 'mdblist_oauth_pkce_v1'

function mdblistRedirectUri(): string {
  if (getPlatformCapabilities().platform !== 'web') return MDBLIST_NATIVE_REDIRECT_URI
  return import.meta.env.VITE_MDBLIST_WEB_REDIRECT_URI || `${window.location.origin}/auth/mdblist/callback`
}

export interface MdblistPKCESession {
  codeVerifier: string
  state: string
  redirectUri?: string
  authGeneration?: number
}

export async function startMdblistPKCELogin(): Promise<{ authUrl: string; session: MdblistPKCESession }> {
  if (mdblistCallbackCancellation) await mdblistCallbackCancellation
  const generation = mdblistAuthGeneration
  const clientId = getMdblistClientId()
  if (!clientId) throw new Error('MDBList OAuth Client ID is required')
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  if (generation !== mdblistAuthGeneration || clientId !== getMdblistClientId()) {
    throw new Error('MDBList sign-in was cancelled.')
  }
  const state = crypto.randomUUID()
  const redirectUri = mdblistRedirectUri()
  if (getPlatformCapabilities().platform === 'web') {
    const redirect = new URL(redirectUri)
    if (redirect.origin !== window.location.origin || (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost' && redirect.hostname !== '127.0.0.1')) {
      throw new Error('MDBList browser redirect URI must use this app origin over HTTPS and be registered with MDBList.')
    }
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'write',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  const session: MdblistPKCESession = {
    codeVerifier,
    state,
    redirectUri,
    ...(getPlatformCapabilities().platform === 'web' ? {} : { authGeneration: generation }),
  }
  if (getPlatformCapabilities().platform === 'web') {
    sessionStorage.setItem(MDBLIST_BROWSER_SESSION_KEY, JSON.stringify(session))
  }
  return {
    authUrl: `https://mdblist.com/oauth/authorize/?${params}`,
    session,
  }
}

export async function exchangeMdblistPKCEToken(code: string, session: MdblistPKCESession): Promise<MdblistOAuthTokens> {
  const clientId = getMdblistClientId()
  const generation = session.authGeneration ?? mdblistAuthGeneration
  if (!clientId) throw new Error('MDBList OAuth Client ID is required')
  if (generation !== mdblistAuthGeneration) throw new Error('MDBList sign-in was cancelled.')
  const data = await postMdblistOAuthForm('/oauth/token/', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: session.redirectUri || MDBLIST_NATIVE_REDIRECT_URI,
    client_id: clientId,
    code_verifier: session.codeVerifier,
  })
  if (generation !== mdblistAuthGeneration || clientId !== getMdblistClientId()) {
    throw new Error('MDBList sign-in was cancelled.')
  }
  return storeMdblistTokens(data, true)
}

export interface MdblistOAuthCallback {
  code?: string
  state?: string
  error?: string
}

export async function waitForMdblistCallback(): Promise<MdblistOAuthCallback> {
  if (getPlatformCapabilities().platform === 'web') {
    throw new Error('MDBList browser authorization returns through the Aurales callback page.')
  }
  const result = await invoke<string>('start_anilist_callback_server', { provider: 'mdblist' })
  let callback: unknown
  try {
    callback = JSON.parse(result)
  } catch {
    throw new Error('MDBList returned an invalid OAuth callback.')
  }
  if (!callback || typeof callback !== 'object' || Array.isArray(callback)) {
    throw new Error('MDBList returned an invalid OAuth callback.')
  }
  const values = callback as Record<string, unknown>
  return {
    ...(typeof values.code === 'string' ? { code: values.code } : {}),
    ...(typeof values.state === 'string' ? { state: values.state } : {}),
    ...(typeof values.error === 'string' ? { error: values.error } : {}),
  }
}

/** Validate MDBList's same-origin browser callback and exchange its PKCE code. */
export async function completeMdblistBrowserCallback(search: string): Promise<MdblistOAuthTokens> {
  const params = new URLSearchParams(search)
  let session: MdblistPKCESession
  try {
    session = JSON.parse(sessionStorage.getItem(MDBLIST_BROWSER_SESSION_KEY) || '') as MdblistPKCESession
  } catch {
    throw new Error('MDBList sign-in session expired. Start the connection again.')
  }
  if (!session?.codeVerifier || !session.state || !session.redirectUri) {
    throw new Error('MDBList sign-in session expired. Start the connection again.')
  }
  let redirect: URL
  try { redirect = new URL(session.redirectUri) } catch { throw new Error('MDBList sign-in session has an invalid redirect URI.') }
  if (redirect.origin !== window.location.origin || redirect.pathname !== '/auth/mdblist/callback') {
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    throw new Error('MDBList sign-in redirect did not match this Aurales site.')
  }
  if (params.get('state') !== session.state) {
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    throw new Error('Rejected an unexpected MDBList authorization response.')
  }
  const providerError = params.get('error')
  if (providerError) {
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    throw new Error(providerError === 'access_denied' ? 'MDBList sign-in was cancelled.' : `MDBList authorization failed: ${providerError}`)
  }
  const code = params.get('code')
  if (!code) {
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    throw new Error('MDBList did not return an authorization code.')
  }
  try {
    const tokens = await exchangeMdblistPKCEToken(code, session)
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    return tokens
  } catch (error) {
    sessionStorage.removeItem(MDBLIST_BROWSER_SESSION_KEY)
    throw error
  }
}

function ratingsApiKey(): string {
  return userApiKey() || BUILTIN_KEY
}

function authFingerprint(value: string): string {
  // Keep credentials out of request-coordinator keys while separating requests
  // made by different MDBList accounts.
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function hasMdblistUserApiKey(): boolean {
  return Boolean(userApiKey() || hasMdblistOAuth())
}

async function mdblistFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options?: { allowBuiltinForRatings?: boolean }
): Promise<T> {
  let token = options?.allowBuiltinForRatings ? '' : await getValidMdblistAccessToken()
  if (token && getStoredMdblistTokens()?.accessToken !== token) token = ''
  const key = token ? '' : options?.allowBuiltinForRatings ? ratingsApiKey() : userApiKey()
  if (!token && !key) throw new Error('MDBList account auth is required')

  const url = new URL(`${BASE_URL}${path}`)
  if (key) url.searchParams.set('apikey', key)

  const { requestCoordinator } = await import('./network/requestCoordinator')
  return requestCoordinator.run<T>({
    origin: BASE_URL,
    label: 'MDBList',
    kind: 'metadata',
    dedupeKey: `${authFingerprint(token || key)}:${method}:${path}:${body === undefined ? '' : JSON.stringify(body)}`,
    priority: method === 'GET' ? 'visible' : 'interactive',
    timeoutMs: 20_000,
    retry: 'none',
  }, (signal) => queueMdblistRequest(async () => {
    if (token && getPlatformCapabilities().platform === 'tauri') {
      if (getStoredMdblistTokens()?.accessToken !== token) {
        throw new Error('MDBList connection changed before the request could be sent.')
      }
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const raw = await invoke<string>('http_request', {
        method,
        url: url.toString(),
        headers,
        body: body !== undefined ? JSON.stringify(body) : null,
      })
      if (!raw) return undefined as T
      const statusMatch = raw.match(/^(\d{3}):/)
      if (statusMatch) {
        const code = Number(statusMatch[1])
        if (code === 429) throw new MdblistRateLimitError()
        if (code >= 400) {
          const respBody = raw.slice(statusMatch[0].length)
          try {
            const data = JSON.parse(respBody)
            throw new Error(String(data?.detail || data?.error || `MDBList ${method} ${path} failed (${code})`))
          } catch (e) {
            if (e instanceof Error && !e.message.startsWith('MDBList')) throw e
            throw new Error(`MDBList ${method} ${path} failed (${code})`)
          }
        }
      }
      return JSON.parse(raw) as T
    }

    if (getPlatformCapabilities().platform === 'web' && getMediaWorkerConfig()) {
      const response = await proxyMdblistRequest(method, path, {
        ...(token ? { bearerToken: token } : {}),
        ...(key ? { apiKey: key } : {}),
      }, body !== undefined ? JSON.stringify(body) : undefined, 'application/json', signal)
      if (response.status === 429) throw new MdblistRateLimitError()
      if (!response.ok) {
        let message = `MDBList ${method} ${path} failed (${response.status})`
        try {
          const data = JSON.parse(response.body)
          message = String(data?.detail || data?.error || message)
        } catch { /* keep bounded generic message */ }
        throw new Error(message)
      }
      if (response.status === 204) return undefined as T
      try { return JSON.parse(response.body) as T } catch { throw new Error('MDBList returned an invalid JSON response.') }
    }

    const res = await fetch(url.toString(), {
      method,
      signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) throw new MdblistRateLimitError(mdblistRetryAfterMs(res))
    if (!res.ok) {
      let message = `MDBList ${method} ${path} failed (${res.status})`
      try {
        const text = await readBoundedResponseText(res, MAX_MDBLIST_RESPONSE_BYTES, 'MDBList response')
        const data = JSON.parse(text)
        message = String((data as any)?.detail || (data as any)?.error || message)
      } catch (_) { /* retain bounded generic error */ }
      throw new Error(message)
    }
    if (res.status === 204) return undefined as T
    return readBoundedResponseJson<T>(res, MAX_MDBLIST_RESPONSE_BYTES, 'MDBList response')
  }))
}

function pickArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  if (Array.isArray(d.items)) return d.items
  if (Array.isArray(d.movies) || Array.isArray(d.shows) || Array.isArray(d.seasons) || Array.isArray(d.episodes)) {
    return [...(d.movies as unknown[] || []), ...(d.shows as unknown[] || []), ...(d.seasons as unknown[] || []), ...(d.episodes as unknown[] || [])]
  }
  if (Array.isArray(d.results)) return d.results
  if (Array.isArray(d.lists)) return d.lists
  return []
}

function nextCursor(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const pagination = (data as any).pagination || {}
  return pagination.next_cursor || (data as any).next_cursor || null
}

function toNumber(value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}

function toNonNegativeNumber(value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : undefined
}

function idsFrom(raw: any): Record<string, unknown> {
  return raw?.ids || raw?.movie?.ids || raw?.show?.ids || raw?.episode?.ids || {}
}

function mdblistItemToSearchResult(raw: any, fallbackType?: 'movie' | 'series'): SearchResult | null {
  if (!raw || typeof raw !== 'object') return null
  const media = raw.movie || raw.show || raw
  const ids = idsFrom(media)
  const mediaType = String(media.mediatype || media.media_type || raw.mediatype || raw.media_type || '').toLowerCase()
  const type: 'movie' | 'series' = fallbackType || (mediaType === 'show' || mediaType === 'series' || mediaType === 'tv' ? 'series' : 'movie')
  const tmdbId = toNumber(ids.tmdb ?? media.tmdb_id ?? media.tmdb ?? media.id)
  const tvdbId = toNumber(ids.tvdb ?? media.tvdb_id)
  const imdbId = String(ids.imdb ?? media.imdb_id ?? '').trim() || undefined
  const title = String(media.title || media.name || raw.title || '').trim()
  if (!title && !tmdbId && !imdbId) return null
  return {
    id: imdbId || (tmdbId ? `tmdb-${tmdbId}` : `mdblist-${ids.mdblist || raw.id || title}`),
    title: title || `${type === 'movie' ? 'Movie' : 'Show'} ${tmdbId || ids.mdblist || raw.id}`,
    type,
    year: toNumber(media.release_year ?? media.year),
    poster: media.poster || media.poster_url || (media.poster_path ? `https://image.tmdb.org/t/p/w342${media.poster_path}` : undefined),
    backdrop: media.backdrop || media.backdrop_url || (media.backdrop_path ? `https://image.tmdb.org/t/p/original${media.backdrop_path}` : undefined),
    overview: media.description || media.overview,
    provider: 'mdblist',
    imdbId,
    tmdbId,
    tvdbId,
  }
}

function itemIds(tmdbId?: number, imdbId?: string, tvdbId?: number): Record<string, string | number> {
  const ids: Record<string, string | number> = {}
  if (tmdbId) ids.tmdb = tmdbId
  if (imdbId) ids.imdb = imdbId
  if (tvdbId) ids.tvdb = tvdbId
  return ids
}

export function scrobblePayload(
  tmdbId: number | undefined,
  mediaType: 'movie' | 'series',
  progress: number,
  season?: number,
  episode?: number,
  imdbId?: string,
  tvdbId?: number
): Record<string, unknown> {
  const ids = itemIds(tmdbId, imdbId, tvdbId)
  if (mediaType === 'movie') return { movie: { ids }, progress }
  return { show: { ids, season: { number: season, episode: { number: episode } } }, progress }
}

export function mdblistPlaybackAction(
  requested: 'start' | 'pause' | 'stop',
  progressPercent: number,
  scrobbleEnabled: boolean,
  saveResumePosition: boolean,
): 'start' | 'pause' | 'stop' | 'clear' | null {
  if (requested === 'start') return scrobbleEnabled ? 'start' : null
  // An active start must always be paired with the real pause/stop event.
  // Clearing resume progress instead leaves the remote session running.
  if (scrobbleEnabled) return requested
  if (progressPercent >= 80) return 'clear'
  if (requested === 'stop') return saveResumePosition ? 'stop' : 'clear'
  return saveResumePosition ? 'pause' : 'clear'
}

export async function checkMdblistConnection(): Promise<{ connected: boolean; user?: MdblistUser; error?: string }> {
  if (!userApiKey() && !hasMdblistOAuth()) return { connected: false, error: 'No MDBList account auth configured' }
  try {
    const user = await mdblistFetch<MdblistUser>('GET', '/user')
    return { connected: true, user }
  } catch (err: any) {
    return { connected: false, error: err?.message || 'MDBList connection failed' }
  }
}

export async function getMdblistUserLists(): Promise<MdblistList[]> {
  if (!hasMdblistUserApiKey()) return []
  const data = await mdblistFetch<unknown>('GET', '/lists/user/?sort=rank&unified=false')
  return pickArray(data).map((list: any) => ({
    id: String(list.id),
    name: String(list.name || list.slug || list.id),
    slug: list.slug ? String(list.slug) : undefined,
    mediatype: list.mediatype ? String(list.mediatype) : undefined,
    private: Boolean(list.private),
    items: toNumber(list.items),
    likes: toNumber(list.likes),
    user_name: list.user_name,
    user_id: toNumber(list.user_id),
  }))
}

function normalizeListResult(list: any): MdblistList | null {
  if (!list || typeof list !== 'object') return null
  const id = list.id
  if (id == null) return null
  const name = String(list.name || list.slug || list.id).trim()
  if (!name) return null
  return {
    id: String(id),
    name,
    slug: list.slug ? String(list.slug) : undefined,
    mediatype: list.mediatype ? String(list.mediatype) : undefined,
    private: Boolean(list.private),
    items: toNumber(list.items),
    likes: toNumber(list.likes),
    user_name: list.user_name ? String(list.user_name) : undefined,
    user_id: toNumber(list.user_id),
  }
}

function extractListResults(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const d = payload as Record<string, unknown>
  for (const key of ['results', 'lists', 'items', 'data']) {
    if (Array.isArray(d[key])) return d[key] as unknown[]
  }
  return []
}

export async function searchMdblistPublicLists(query: string, limit = 20): Promise<MdblistList[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const endpoints = [
    `/search/lists?query=${encodeURIComponent(trimmed)}&limit=${limit}`,
    `/lists/search?query=${encodeURIComponent(trimmed)}&limit=${limit}`,
  ]

  for (const path of endpoints) {
    try {
      const data = await mdblistFetch<unknown>('GET', path, undefined, { allowBuiltinForRatings: true })
      const results = extractListResults(data)
        .map(normalizeListResult)
        .filter((item): item is MdblistList => item !== null && !item.private)
      if (results.length > 0) return results
    } catch (err: any) {
      if (err?.message?.includes('404')) continue
      throw err
    }
  }

  // HTML scraping fallback
  try {
    return await searchMdblistPublicListsFallback(trimmed)
  } catch (_) {
    return []
  }
}

async function searchMdblistPublicListsFallback(query: string): Promise<MdblistList[]> {
  const url = `https://mdblist.com/toplists/?public_list_name=${encodeURIComponent(query)}`
  const html = await withRequestTimeout(10_000, async (signal) => {
    const res = await fetch(url, { signal })
    return res.ok ? readBoundedResponseText(res, MAX_MDBLIST_PUBLIC_LIST_HTML_BYTES, 'MDBList public list response') : ''
  }, 'MDBList public list request timed out')
  if (!html) return []

  const results: MdblistList[] = []
  const seen = new Set<string>()

  const cardRegex = /<article class="related-list-card">([\s\S]*?)<\/article>/g
  let cardMatch: RegExpExecArray | null
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const card = cardMatch[1]
    const titleMatch = /<div class="related-list-meta__title">\s*<a [^>]+>([\s\S]*?)<\/a>/i.exec(card)
    const listIdMatch = /href="\/(?:movies|shows)\/\?list=(\d+)"/i.exec(card)
    const userMatch = /<a class="related-list-meta__user" [^>]*>([\s\S]*?)<\/a>/i.exec(card)
    const typeMatch = /<span class="related-list-meta__type">([\s\S]*?)<\/span>/i.exec(card)
    const itemsMatch = /<span class="related-list-meta__items">(\d+)\s+items<\/span>/i.exec(card)
    const likesMatch = /<span class="related-list-meta__likes">\s*<span class="ui medium text">(\d+)<\/span>/i.exec(card)

    if (!titleMatch || !listIdMatch || !typeMatch) continue

    const listId = listIdMatch[1]
    const mediaRaw = typeMatch[1].trim().toLowerCase()
    const mediatype = mediaRaw.startsWith('movie') ? 'movie' : mediaRaw.startsWith('show') || mediaRaw.startsWith('tv') ? 'show' : null
    if (!mediatype) continue

    const key = `${listId}:${mediatype}`
    if (seen.has(key)) continue
    seen.add(key)

    const hrefMatch = /<a href="(\/lists\/[^"]+)"/i.exec(card)
    const href = hrefMatch?.[1]?.replace(/^\//, '') || ''
    const slug = href.includes('/') ? href.split('/').slice(1).join('/') : href.replace(/^lists\//, '')

    results.push({
      id: listId,
      name: decodeHtmlEntities(titleMatch[1].trim()),
      slug,
      mediatype,
      private: false,
      items: itemsMatch ? (toNumber(itemsMatch[1]) ?? 0) : undefined,
      likes: likesMatch ? (toNumber(likesMatch[1]) ?? 0) : undefined,
      user_name: userMatch ? decodeHtmlEntities(userMatch[1].trim()) : undefined,
    })
  }

  return results
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
}

export async function createMdblistList(name: string, isPrivate = false): Promise<MdblistList | null> {
  if (!hasMdblistUserApiKey() || !name.trim()) return null
  const data = await mdblistFetch<any>('POST', '/lists/user/add', { name: name.trim(), private: isPrivate })
  return data ? { id: String(data.id), name: String(data.name || name), slug: data.slug, private: Boolean(data.private) } : null
}

async function getMdblistListPage(path: string, cursor?: string): Promise<unknown> {
  const qs = new URLSearchParams({
    limit: '200',
    append_to_response: 'genres,poster,description',
  })
  if (cursor) qs.set('cursor', cursor)
  return mdblistFetch<unknown>('GET', `${path}?${qs.toString()}`)
}

export async function getMdblistListItems(listId: string): Promise<SearchResult[]> {
  if (!hasMdblistUserApiKey() || !listId) return []
  const items: SearchResult[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const data = await getMdblistListPage(`/lists/${encodeURIComponent(listId)}/items`, cursor)
    const batch = pickArray(data)
    for (const raw of batch) {
      const item = mdblistItemToSearchResult(raw)
      if (item) items.push(item)
    }
    const next = nextCursor(data)
    if (!next || batch.length === 0 || next === cursor) break
    cursor = next
  }
  return dedupeSearchResults(items)
}

export async function getMdblistWatchlistItems(): Promise<SearchResult[]> {
  if (!hasMdblistUserApiKey()) return []
  const items: SearchResult[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const data = await getMdblistListPage('/watchlist/items', cursor)
    const batch = pickArray(data)
    for (const raw of batch) {
      const item = mdblistItemToSearchResult(raw)
      if (item) items.push(item)
    }
    const next = nextCursor(data)
    if (!next || batch.length === 0 || next === cursor) break
    cursor = next
  }
  return dedupeSearchResults(items)
}

export async function addToMdblistWatchlist(tmdbId: number, mediaType: 'movie' | 'series', imdbId?: string): Promise<boolean> {
  if (!hasMdblistUserApiKey()) return false
  const key = mediaType === 'movie' ? 'movies' : 'shows'
  await mdblistFetch('POST', '/watchlist/items/add', { [key]: [itemIds(tmdbId, imdbId)] })
  return true
}

export async function removeFromMdblistWatchlist(tmdbId: number, mediaType: 'movie' | 'series', imdbId?: string): Promise<boolean> {
  if (!hasMdblistUserApiKey()) return false
  const key = mediaType === 'movie' ? 'movies' : 'shows'
  await mdblistFetch('POST', '/watchlist/items/remove', { [key]: [itemIds(tmdbId, imdbId)] })
  return true
}

export async function addToMdblistList(listId: string, tmdbId: number, mediaType: 'movie' | 'series', imdbId?: string): Promise<boolean> {
  if (!hasMdblistUserApiKey() || !listId) return false
  const key = mediaType === 'movie' ? 'movies' : 'shows'
  await mdblistFetch('POST', `/lists/${encodeURIComponent(listId)}/items/add`, { [key]: [itemIds(tmdbId, imdbId)] })
  return true
}

export async function getMdblistPlaybackProgress(): Promise<MdblistPlaybackItem[]> {
  if (!hasMdblistUserApiKey()) return []
  const data = await mdblistFetch<unknown>('GET', '/sync/playback')
  return normalizeMdblistPlayback(data)
}

export function normalizeMdblistPlayback(data: unknown): MdblistPlaybackItem[] {
  return pickArray(data).flatMap((item: any) => {
    if (!item || typeof item !== 'object') return []
    const isMovie = item.type === 'movie' || Boolean(item.movie)
    const episode = item.episode && typeof item.episode === 'object'
      ? {
          ...item.episode,
          season: toNonNegativeNumber(item.episode.season?.number ?? item.episode.season ?? item.season),
          number: toNumber(item.episode.number ?? item.episode.episode ?? item.episode_number),
        }
      : item.episode
    return [{
      id: String(item.id ?? `${isMovie ? 'movie' : 'episode'}-${item.updated_at || ''}`),
      progress: Math.max(0, Math.min(100, Number(item.progress ?? item.progress_at_update ?? 0) || 0)),
      runtime: toNumber(item.runtime),
      updated_at: item.updated_at,
      paused_at: item.paused_at,
      type: isMovie ? 'movie' : 'episode',
      movie: item.movie,
      show: item.show || item.episode?.show,
      episode,
    }]
  })
}

export interface MdblistUpNextItem {
  showId: string
  title: string
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  season: number
  episode: number
  lastWatchedAt?: string
}

export async function getMdblistUpNext(): Promise<MdblistUpNextItem[]> {
  if (!hasMdblistUserApiKey()) return []
  const data = await mdblistFetch<unknown>('GET', '/upnext?limit=20&hide_unreleased=true&air_date_format=instant')
  return normalizeMdblistUpNext(data)
}

export function normalizeMdblistUpNext(data: unknown): MdblistUpNextItem[] {
  return pickArray(data).flatMap((raw: any) => {
    const show = raw?.show || raw?.media || raw
    const nextEpisode = raw?.next_episode || raw?.episode
    const ids = idsFrom(show)
    const season = toNonNegativeNumber(nextEpisode?.season?.number ?? nextEpisode?.season ?? nextEpisode?.season_number)
    const episode = toNumber(nextEpisode?.number ?? nextEpisode?.episode ?? nextEpisode?.episode_number)
    const tmdbId = toNumber(ids.tmdb ?? show?.tmdb_id)
    const tvdbId = toNumber(ids.tvdb ?? show?.tvdb_id)
    const imdbId = String(ids.imdb ?? show?.imdb_id ?? '').trim() || undefined
    const mdblistId = ids.mdblist ? String(ids.mdblist) : undefined
    if (season == null || episode == null || (!tmdbId && !tvdbId && !imdbId && !mdblistId)) return []
    return [{
      showId: String(tmdbId || tvdbId || imdbId || mdblistId),
      title: String(show?.title || show?.name || raw?.title || 'Show'),
      imdbId,
      tmdbId,
      tvdbId,
      season,
      episode,
      lastWatchedAt: raw?.last_watched_at || raw?.watched_at || raw?.updated_at,
    }]
  })
}

export async function scrobbleMdblist(
  action: 'start' | 'pause' | 'stop' | 'clear',
  tmdbId: number | undefined,
  mediaType: 'movie' | 'series',
  progress: number,
  season?: number,
  episode?: number,
  imdbId?: string,
  tvdbId?: number
): Promise<void> {
  if (!hasMdblistUserApiKey()) return
  await mdblistFetch('POST', `/scrobble/${action}`, scrobblePayload(tmdbId, mediaType, progress, season, episode, imdbId, tvdbId))
}

export async function markMdblistWatched(
  tmdbId: number | undefined,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  imdbId?: string,
  tvdbId?: number
): Promise<void> {
  if (!hasMdblistUserApiKey()) return
  const watchedAt = new Date().toISOString()
  if (mediaType === 'movie') {
    await mdblistFetch('POST', '/sync/watched', { movies: [{ ids: itemIds(tmdbId, imdbId, tvdbId), watched_at: watchedAt }] })
    return
  }
  await mdblistFetch('POST', '/sync/watched', {
    shows: [{
      ids: itemIds(tmdbId, imdbId, tvdbId),
      seasons: season != null ? [{ number: season, episodes: episode != null ? [{ number: episode, watched_at: watchedAt }] : undefined, watched_at: watchedAt }] : undefined,
    }],
  })
}

export async function removeMdblistWatched(
  tmdbId: number | undefined,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  imdbId?: string,
  tvdbId?: number
): Promise<void> {
  if (!hasMdblistUserApiKey()) return
  if (mediaType === 'movie') {
    await mdblistFetch('POST', '/sync/watched/remove', { movies: [{ ids: itemIds(tmdbId, imdbId, tvdbId) }] })
    return
  }
  await mdblistFetch('POST', '/sync/watched/remove', {
    shows: [{
      ids: itemIds(tmdbId, imdbId, tvdbId),
      seasons: season != null ? [{ number: season, episodes: episode != null ? [{ number: episode }] : undefined }] : undefined,
    }],
  })
}

export async function getMdblistWatched(): Promise<MdblistWatchedItem[]> {
  if (!hasMdblistUserApiKey()) return []
  const items: MdblistWatchedItem[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '1000', append_to_response: 'poster' })
    if (cursor) qs.set('cursor', cursor)
    const data = await mdblistFetch<unknown>('GET', `/sync/watched?${qs}`)
    items.push(...normalizeMdblistWatched(data))
    cursor = nextCursor(data)
    if (!cursor) break
  }
  return items
}

function normalizeWatched(raw: any): MdblistWatchedItem | null {
  const media = raw.movie || raw.show || raw.episode?.show || raw
  const ids = idsFrom(media)
  const type = raw.movie ? 'movie' : 'show'
  const tmdbId = toNumber(ids.tmdb ?? media.tmdb_id ?? media.id)
  const imdbId = String(ids.imdb ?? media.imdb_id ?? '').trim() || undefined
  const tvdbId = toNumber(ids.tvdb ?? media.tvdb_id)
  if (!tmdbId && !imdbId && !tvdbId) return null
  return {
    id: String(raw.id || ids.mdblist || `${type}-${tmdbId || imdbId || tvdbId}`),
    media_type: type,
    watched_at: raw.watched_at || raw.last_watched_at,
    title: media.title,
    year: toNumber(media.release_year ?? media.year),
    imdb_id: imdbId,
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    mdblist_id: ids.mdblist ? String(ids.mdblist) : undefined,
    season: toNonNegativeNumber(raw.season?.number ?? raw.season ?? raw.episode?.season?.number ?? raw.episode?.season ?? raw.episode?.season_number),
    episode: toNumber(raw.episode?.number ?? raw.episode?.episode ?? raw.episode),
  }
}

function normalizeWatchedRows(raw: any): MdblistWatchedItem[] {
  const base = normalizeWatched(raw)
  if (!base) return []
  const seasons = Array.isArray(raw?.seasons)
    ? raw.seasons
    : raw?.season && typeof raw.season === 'object'
      ? [raw.season]
      : Array.isArray(raw?.show?.seasons) ? raw.show.seasons : []
  const episodes = seasons.flatMap((season: any) => {
    const seasonNumber = toNonNegativeNumber(season?.number ?? season?.season)
    if (seasonNumber == null || !Array.isArray(season?.episodes)) return []
    return season.episodes.flatMap((episode: any) => {
      const episodeNumber = toNumber(episode?.number ?? episode?.episode)
      if (!episodeNumber) return []
      return [{ ...base, season: seasonNumber, episode: episodeNumber, watched_at: episode.watched_at || season.watched_at || base.watched_at }]
    })
  })
  return episodes.length ? episodes : [base]
}

export function normalizeMdblistWatched(data: unknown): MdblistWatchedItem[] {
  return pickArray(data).flatMap(normalizeWatchedRows)
}

function dedupeSearchResults(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = mediaIdentity(item)
    if (seen.has(String(key))) return false
    seen.add(String(key))
    return true
  })
}

export async function getMdblistRatings(req: RatingRequest): Promise<MdblistRating[]> {
  const cacheKey = `mdblist_ratings:${req.mediaType}:${req.imdbId || ''}:${req.tmdbId || ''}:${req.tvdbId || ''}:${req.malId || ''}:${req.season ?? ''}:${req.episode ?? ''}`
  const { cachedFetch } = await import('./cache/sqliteCache')
  return cachedFetch<MdblistRating[]>(
    cacheKey,
    () => fetchMdblistRatingsRaw(req),
    { category: 'MDBLIST_RATINGS', ttlSeconds: 86400, cacheEmptyResults: true },
  )
}

async function fetchMdblistRatingsRaw(req: RatingRequest): Promise<MdblistRating[]> {
  const media = req.mediaType === 'movie' ? 'movie' : 'show'
  const candidates: string[] = []
  if (req.imdbId) candidates.push(`/imdb/${media}/${encodeURIComponent(req.imdbId)}`)
  if (req.tmdbId) candidates.push(`/tmdb/${media}/${encodeURIComponent(String(req.tmdbId))}`)
  if (req.tvdbId) candidates.push(`/tvdb/${media}/${encodeURIComponent(String(req.tvdbId))}`)
  if (req.malId) candidates.push(`/mal/${media}/${encodeURIComponent(String(req.malId))}`)

  for (const path of candidates) {
    try {
      const params = new URLSearchParams()
      if (req.season != null) params.set('season', String(req.season))
      if (req.episode != null) params.set('episode', String(req.episode))
      const suffix = params.size ? `?${params.toString()}` : ''
      const data = await mdblistFetch<any>('GET', `${path}${suffix}`, undefined, { allowBuiltinForRatings: true })
      // A successful response identified the item. An empty ratings array is a
      // valid result; probing the same title through every alternate ID only
      // spends more of MDBList's daily request allowance.
      return normalizeRatings(data)
    } catch (error) {
      if (error instanceof MdblistRateLimitError) throw error
      // Try next ID route.
    }
  }
  return []
}

function normalizeRatings(data: any): MdblistRating[] {
  const raw = data?.ratings ?? data?.rating ?? data?.external_ratings ?? data?.score ?? []
  const items: MdblistRating[] = []

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const source = normalizeSource(entry?.source ?? entry?.name ?? entry?.provider ?? entry?.id)
      const value = formatValue(entry?.value ?? entry?.score ?? entry?.rating ?? entry?.percent, entry?.type)
      if (source && value) items.push(toRating(source, value))
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const source = normalizeSource(key)
      const formatted = typeof value === 'object'
        ? formatValue((value as any).value ?? (value as any).score ?? (value as any).rating ?? (value as any).percent, (value as any).type)
        : formatValue(value)
      if (source && formatted) items.push(toRating(source, formatted))
    }
  }

  const directKeys = ['imdb', 'rottentomatoes', 'tomato_meter', 'tomatoesaudience', 'metacritic', 'tmdb', 'trakt', 'letterboxd', 'myanimelist', 'mal']
  for (const key of directKeys) {
    if (data?.[key] == null) continue
    const source = normalizeSource(key)
    const value = typeof data[key] === 'object' ? formatValue(data[key].rating ?? data[key].score ?? data[key].value) : formatValue(data[key])
    if (source && value) items.push(toRating(source, value))
  }

  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.source}:${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

function normalizeSource(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function formatValue(value: unknown, type?: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const val = value.trim()
    if (val.includes('/10')) return val.split('/10')[0].trim()
    return val
  }
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const typeText = String(type || '').toLowerCase()
  if (typeText.includes('percent') || num > 10) return `${Math.round(num)}%`
  return `${Number.isInteger(num) ? num : num.toFixed(1)}`
}

export function getRatingIconUrl(source: string): string | null {
  const norm = source.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (norm === 'imdb') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/IMDB_Logo_2016.svg/960px-IMDB_Logo_2016.svg.png'
  }
  if (norm === 'metacritic' || norm === 'metacriticuser') {
    return 'https://upload.wikimedia.org/wikipedia/commons/f/f2/Metacritic_M.png'
  }
  if (norm === 'rottentomatoes' || norm === 'tomato' || norm === 'tomatometer') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Rotten_Tomatoes.svg/250px-Rotten_Tomatoes.svg.png'
  }
  if (norm === 'tomatoesaudience' || norm === 'rottentomatoesaudience' || norm === 'popcorn') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Rotten_Tomatoes_positive_audience.svg/250px-Rotten_Tomatoes_positive_audience.svg.png'
  }
  if (norm === 'trakt') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Trakt.tv-favicon.svg/250px-Trakt.tv-favicon.svg.png'
  }
  if (norm === 'tmdb') {
    return 'https://raw.githubusercontent.com/yodaluca23/fusion-icon-packs/refs/heads/main/icons/TMDb.png'
  }
  if (norm === 'letterboxd') {
    return 'https://a.ltrbxd.com/logos/letterboxd-decal-dots-pos-rgb-500px.png'
  }
  if (norm === 'myanimelist' || norm === 'mal') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/MyAnimeList_favicon.svg/250px-MyAnimeList_favicon.svg.png'
  }
  if (norm === 'anilist') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/AniList_logo.svg/250px-AniList_logo.svg.png'
  }
  if (norm === 'rogerebert') {
    return 'https://raw.githubusercontent.com/yodaluca23/fusion-icon-packs/refs/heads/main/icons/RogerEbert.png'
  }
  return getSelfhstIconUrl(source)
}

function toRating(source: string, value: string): MdblistRating {
  return {
    source,
    label: PROVIDER_LABELS[source] || source.toUpperCase(),
    icon: PROVIDER_ICONS[source] || source.slice(0, 2).toUpperCase(),
    iconUrl: getRatingIconUrl(source) ?? undefined,
    value,
  }
}
