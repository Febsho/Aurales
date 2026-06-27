import type { TraktTokens, TraktDeviceCode, TraktAccount } from '../../types'

const TRAKT_API = 'https://api.trakt.tv'
const LS_ACCOUNT = 'trakt_account'

export function getClientId(): string {
  return localStorage.getItem('trakt_client_id') || import.meta.env.VITE_TRAKT_CLIENT_ID || ''
}

function getClientSecret(): string {
  return localStorage.getItem('trakt_client_secret') || import.meta.env.VITE_TRAKT_CLIENT_SECRET || ''
}

export function hasTraktClientCredentials(): boolean {
  return !!getClientId() && !!getClientSecret()
}

export function hasBundledTraktClientCredentials(): boolean {
  return !!import.meta.env.VITE_TRAKT_CLIENT_ID && !!import.meta.env.VITE_TRAKT_CLIENT_SECRET
}

export function getStoredTokens(): TraktTokens | null {
  const raw = localStorage.getItem('trakt_tokens')
  if (!raw) return null
  return JSON.parse(raw)
}

export function storeTokens(tokens: TraktTokens): void {
  localStorage.setItem('trakt_tokens', JSON.stringify(tokens))
}

export function saveTraktAccount(account: TraktAccount): void {
  localStorage.setItem(LS_ACCOUNT, JSON.stringify(account))
}

export function getStoredTraktAccount(): TraktAccount | null {
  try {
    const raw = localStorage.getItem(LS_ACCOUNT)
    if (!raw) return null
    return JSON.parse(raw) as TraktAccount
  } catch (_) {
    return null
  }
}

export function clearTokens(): void {
  localStorage.removeItem('trakt_tokens')
  localStorage.removeItem(LS_ACCOUNT)
}

export function isAuthenticated(): boolean {
  const tokens = getStoredTokens()
  if (!tokens) return false
  return Date.now() / 1000 < tokens.expiresAt
}

export async function getDeviceCode(): Promise<TraktDeviceCode> {
  const clientId = getClientId()
  if (!clientId) throw new Error('Trakt client ID not configured')

  const res = await fetch(`${TRAKT_API}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  })
  if (!res.ok) throw new Error(`Trakt device code error: ${res.status}`)
  const data = await res.json()

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresIn: data.expires_in,
    interval: data.interval,
  }
}

export async function pollForToken(deviceCode: string): Promise<TraktTokens | null> {
  const clientId = getClientId()
  const clientSecret = getClientSecret()
  if (!clientId || !clientSecret) throw new Error('Trakt client credentials not configured')

  const res = await fetch(`${TRAKT_API}/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: deviceCode,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (res.status === 400) return null
  if (res.status === 200) {
    const data = await res.json()
    const tokens: TraktTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.created_at + data.expires_in,
      createdAt: data.created_at,
    }
    storeTokens(tokens)
    return tokens
  }
  return null
}

export async function refreshAccessToken(): Promise<TraktTokens | null> {
  const tokens = getStoredTokens()
  if (!tokens) return null

  const res = await fetch(`${TRAKT_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: tokens.refreshToken,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) {
    clearTokens()
    return null
  }

  const data = await res.json()
  const newTokens: TraktTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.created_at + data.expires_in,
    createdAt: data.created_at,
  }
  storeTokens(newTokens)
  return newTokens
}

export async function traktFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  let tokens = getStoredTokens()
  if (!tokens) throw new Error('Not authenticated with Trakt')

  if (Date.now() / 1000 >= tokens.expiresAt - 86400) {
    tokens = await refreshAccessToken()
    if (!tokens) throw new Error('Failed to refresh Trakt token')
  }

  const res = await fetch(`${TRAKT_API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': getClientId(),
      Authorization: `Bearer ${tokens.accessToken}`,
      ...options.headers,
    },
  })

  if (!res.ok) throw new Error(`Trakt API error: ${res.status}`)
  if (res.status === 204) return null
  return res.json()
}

export async function fetchTraktAccount(): Promise<TraktAccount> {
  const data = await traktFetch('/users/settings') as any
  const user = data?.user || {}
  const avatar = user.images?.avatar?.full
  return {
    username: user.username || 'Trakt User',
    name: user.name || user.username || 'Trakt User',
    avatar: avatar || undefined,
  }
}
