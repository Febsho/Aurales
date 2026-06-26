/**
 * Simkl authentication.
 *
 * This follows the working SyncMeta PIN flow:
 * 1. GET /oauth/pin?client_id=...
 * 2. Open Simkl's verification URL with the user code.
 * 3. Poll GET /oauth/pin/{user_code}?client_id=... until approved.
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

const DEFAULT_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'
const SIMKL_API_BASE = 'https://api.simkl.com'

let _config: SimklConfig | null = null
let _configResolved = false

export async function getSimklConfig(): Promise<SimklConfig> {
  if (_configResolved) return _config!

  try {
    // Dynamic import: the local file is optional and gitignored.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const mod = await import(/* @vite-ignore */ '../../config/simkl.local')
    if (mod?.SIMKL_CONFIG?.clientId) {
      _config = mod.SIMKL_CONFIG as SimklConfig
      _configResolved = true
      return _config
    }
  } catch {
    // Local config absent; fall through to env vars.
  }

  _config = {
    clientId: import.meta.env.VITE_SIMKL_CLIENT_ID || '',
    clientSecret: '',
    redirectUri: import.meta.env.VITE_SIMKL_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  }
  _configResolved = true
  return _config
}

export function isSimklMockMode(): boolean {
  if (_configResolved) return !_config?.clientId
  return !import.meta.env.VITE_SIMKL_CLIENT_ID
}

export async function initiateSimklLogin(): Promise<SimklPinAuth> {
  const config = await getSimklConfig()
  if (!config.clientId) {
    return { userCode: '', verificationUrl: '', interval: 5, expiresIn: 900 }
  }

  const pinJson = await invoke<string>('request_simkl_pin', { clientId: config.clientId })
  const pin = parsePinResponse(pinJson)
  if (!pin.userCode) throw new Error('Simkl PIN response did not include a user code.')

  await invoke('open_simkl_auth', {
    url: buildVerificationUrl(pin.verificationUrl, pin.userCode),
  })
  return pin
}

export async function completeSimklLogin(code: string): Promise<SimklAccount> {
  const config = await getSimklConfig()
  if (!config.clientId) return mockLogin()

  const tokenJson = await invoke<string>('check_simkl_pin', {
    userCode: code.trim(),
    clientId: config.clientId,
  })
  const token = parseTokenResponse(tokenJson)
  return finaliseSimklLogin(token)
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
  if (isSimklMockMode()) return mockToken()
  const config = await getSimklConfig()
  const tokenJson = await invoke<string>('check_simkl_pin', {
    userCode: code.trim(),
    clientId: config.clientId,
  })
  return parseTokenResponse(tokenJson)
}

export async function finaliseSimklLogin(token: SimklToken): Promise<SimklAccount> {
  const config = await getSimklConfig()
  saveSimklToken(token)
  const account = await fetchSimklAccount(token.accessToken, config.clientId)
  saveSimklAccount(account)
  return account
}

function parsePinResponse(json: string): SimklPinAuth {
  const data = JSON.parse(json) as Record<string, unknown>
  return {
    userCode: String(data.user_code || data.userCode || ''),
    verificationUrl: String(data.verification_url || data.verificationUrl || 'https://simkl.com/pin/'),
    interval: Number(data.interval || 5),
    expiresIn: Number(data.expires_in || data.expiresIn || 900),
  }
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
  }
}

function buildVerificationUrl(verificationUrl: string, userCode: string): string {
  const url = verificationUrl || 'https://simkl.com/pin/'
  if (!userCode) return url
  if (url.includes('{user_code}')) return url.replace('{user_code}', encodeURIComponent(userCode))
  if (url.includes('{code}')) return url.replace('{code}', encodeURIComponent(userCode))
  const separator = url.endsWith('/') || url.endsWith('=') ? '' : '/'
  return `${url}${separator}${encodeURIComponent(userCode)}`
}

export function getStoredSimklToken(): SimklToken | null {
  try {
    const raw = localStorage.getItem(LS_TOKEN)
    if (!raw) return null
    return JSON.parse(raw) as SimklToken
  } catch {
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
  } catch {
    return null
  }
}

export function disconnectSimkl(): void {
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_ACCOUNT)
  localStorage.removeItem(LS_LAST_SYNC)
  Object.keys(localStorage)
    .filter((key) => key.startsWith('simkl_'))
    .forEach((key) => localStorage.removeItem(key))
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
  const params = new URLSearchParams({
    client_id: clientId,
    'app-name': 'Aurales',
    'app-version': '0.1.0',
  })
  const res = await fetch(`${SIMKL_API_BASE}/users/settings?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'simkl-api-key': clientId,
    },
  })
  if (!res.ok) throw new Error(`Simkl account fetch failed: ${res.status}`)
  const data = (await res.json()) as Record<string, unknown>
  const user = (data.user || data) as Record<string, unknown>
  return {
    id: String(user.id || user.simkl_id || ''),
    username: String(user.username || user.name || 'Simkl User'),
    avatar: typeof user.avatar === 'string' ? `https://wsrv.nl/?url=https://simkl.in${user.avatar}&w=64` : undefined,
  }
}

async function mockLogin(): Promise<SimklAccount> {
  const account: SimklAccount = { id: 'mock-1', username: 'MockUser', avatar: undefined }
  saveSimklToken(mockToken())
  saveSimklAccount(account)
  return account
}

function mockToken(): SimklToken {
  return { accessToken: 'mock-token', tokenType: 'Bearer', scope: '' }
}
