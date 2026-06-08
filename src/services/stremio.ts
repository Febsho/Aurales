import type { StremioAddonManifest } from '../types'
import type { InstalledAddon } from './addons'

const STREMIO_API = 'https://api.strem.io/api'

interface StremioLoginResult {
  authKey: string
  user: {
    _id: string
    email: string
    fbId?: string
    gdriveMigrated?: boolean
  }
}

interface StremioAddonCollectionItem {
  manifest: StremioAddonManifest
  transportUrl: string
  flags?: Record<string, unknown>
}

function formatApiError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const message = record.message || record.error || record.description || record.name
    if (typeof message === 'string') return message
    try {
      return JSON.stringify(error)
    } catch {
      return 'Unknown API error'
    }
  }
  return 'Unknown API error'
}

async function parseStremioResponse(res: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {}
  try {
    data = await res.json()
  } catch {
    // keep fallback below
  }

  if (!res.ok) {
    throw new Error(data.error ? formatApiError(data.error) : `${fallbackMessage}: ${res.status}`)
  }
  if (data.error) throw new Error(formatApiError(data.error))
  return data
}

function normalizeTransportUrl(url: string): string {
  if (url.startsWith('stremio://')) return url.replace(/^stremio:\/\//, 'https://')
  return url
}

export async function stremioLogin(email: string, password: string): Promise<StremioLoginResult> {
  const res = await fetch(`${STREMIO_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'Login', email, password }),
  })
  const data = await parseStremioResponse(res, 'Stremio login failed')
  const result = data.result as StremioLoginResult | undefined
  if (!result?.authKey) throw new Error('No auth key returned')
  return result
}

export async function getStremioAddons(authKey: string): Promise<InstalledAddon[]> {
  const res = await fetch(`${STREMIO_API}/addonCollectionGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'AddonCollectionGet', authKey }),
  })
  const data = await parseStremioResponse(res, 'Failed to fetch addons')

  const result = data.result as { addons?: StremioAddonCollectionItem[] } | undefined
  const addons: StremioAddonCollectionItem[] = result?.addons || []
  return addons
    .filter((a) => a.manifest && a.transportUrl)
    .map((a) => ({
      manifest: a.manifest,
      url: normalizeTransportUrl(a.transportUrl),
      enabled: true,
    }))
}

export function saveStremioAuth(authKey: string, email: string): void {
  localStorage.setItem('stremio_auth_key', authKey)
  localStorage.setItem('stremio_email', email)
}

export function getStremioAuth(): { authKey: string; email: string } | null {
  const authKey = localStorage.getItem('stremio_auth_key')
  const email = localStorage.getItem('stremio_email')
  if (authKey && email) return { authKey, email }
  return null
}

export function clearStremioAuth(): void {
  localStorage.removeItem('stremio_auth_key')
  localStorage.removeItem('stremio_email')
}
