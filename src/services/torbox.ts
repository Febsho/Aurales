import type { StreamResult } from '../types'
import { invoke } from '@tauri-apps/api/core'

const API_BASE = 'https://api.torbox.app/v1/api'
const TOKEN_KEY = 'torbox_api_token'
const CACHE_TTL_MS = 60 * 60 * 1000
const RESOLVED_URL_TTL_MS = 50 * 60 * 1000

interface TorBoxResponse<T> {
  success: boolean
  error: string | null
  detail: string
  data: T
}

export interface TorBoxUser {
  id: number
  email: string
  plan: number
  is_subscribed: boolean
  premium_expires_at?: string
}

export interface TorBoxDeviceCode {
  device_code: string
  interval: number
  expires_at: string
  verification_url: string
  friendly_verification_url: string
  code: string
}

export interface TorBoxCachedFile {
  id: number
  name: string
  short_name?: string
  size: number
  mimetype?: string
}

export interface TorBoxCachedTorrent {
  name: string
  size: number
  hash: string
  files: TorBoxCachedFile[]
}

interface TorBoxTorrentListItem {
  id: number
  hash: string
  cached: boolean
  download_finished: boolean
  files: TorBoxCachedFile[]
}

export interface TorBoxResolveContext {
  title?: string
  season?: number
  episode?: number
}

const cachedAvailability = new Map<string, { value: TorBoxCachedTorrent | null; expiresAt: number }>()
const resolvedUrls = new Map<string, { url: string; expiresAt: number }>()
const resolveFlights = new Map<string, Promise<string>>()

function normalizedHash(value: string | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function directUrl(stream: StreamResult): string | null {
  for (const value of [stream.url, stream.externalUrl]) {
    if (value && /^https?:\/\//i.test(value.trim())) return value
  }
  return null
}

async function request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
  const token = getTorBoxToken()
  if (authenticated && !token) throw new Error('Connect TorBox in Settings first.')
  const headers = new Headers(init.headers)
  if (authenticated) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const usingTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)
  let responseStatus: number
  let responseOk: boolean
  let responseBody: string
  if (usingTauri) {
    const proxy = await invoke<{ status: number; ok: boolean; body: string }>('torbox_request', {
      method: init.method || 'GET',
      path,
      token: authenticated ? token : null,
      body: typeof init.body === 'string' ? init.body : null,
      contentType: headers.get('Content-Type') || 'application/json',
    })
    responseStatus = proxy.status
    responseOk = proxy.ok
    responseBody = proxy.body
  } else {
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
    responseStatus = response.status
    responseOk = response.ok
    responseBody = await response.text()
  }
  let payload: TorBoxResponse<T>
  try {
    payload = JSON.parse(responseBody) as TorBoxResponse<T>
  } catch (_) {
    throw new Error(`TorBox returned HTTP ${responseStatus}.`)
  }
  if (!responseOk || !payload.success) {
    const error = new Error(payload.detail || `TorBox request failed (${responseStatus}).`) as Error & { code?: string; data?: unknown }
    error.code = payload.error || undefined
    error.data = payload.data
    throw error
  }
  return payload.data
}

export function getTorBoxToken(): string {
  return typeof localStorage === 'undefined' ? '' : localStorage.getItem(TOKEN_KEY)?.trim() || ''
}

export function setTorBoxToken(token: string): void {
  const clean = token.trim()
  if (clean) localStorage.setItem(TOKEN_KEY, clean)
  else localStorage.removeItem(TOKEN_KEY)
  cachedAvailability.clear()
  resolvedUrls.clear()
}

export function clearTorBoxToken(): void {
  setTorBoxToken('')
}

export function isTorBoxConnected(): boolean {
  return Boolean(getTorBoxToken())
}

export function isTorBoxCachedStream(stream: StreamResult): boolean {
  return Boolean(stream.infoHash && stream.behaviorHints?.torboxCached === true && isTorBoxConnected())
}

export function isTorBoxCandidate(stream: StreamResult): boolean {
  return Boolean(stream.infoHash && isTorBoxConnected())
}

export async function startTorBoxDeviceAuth(): Promise<TorBoxDeviceCode> {
  return request<TorBoxDeviceCode>('/user/auth/device/start?app=Aurales', {}, false)
}

export async function pollTorBoxDeviceToken(deviceCode: string): Promise<string | null> {
  try {
    const data = await request<{ access_token: string }>('/user/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({ device_code: deviceCode }),
    }, false)
    return data.access_token || null
  } catch (error) {
    const code = (error as Error & { code?: string }).code || ''
    if (code === 'DEVICE_CODE_NOT_USED' || /pending|authorization|not.?ready/i.test(code) || /pending|authorize|waiting|not been used/i.test((error as Error).message)) return null
    throw error
  }
}

export function getTorBoxUser(): Promise<TorBoxUser> {
  return request<TorBoxUser>('/user/me?settings=false')
}

export async function checkTorBoxCached(hashes: string[]): Promise<Map<string, TorBoxCachedTorrent>> {
  const unique = [...new Set(hashes.map(normalizedHash).filter(Boolean))]
  const now = Date.now()
  const result = new Map<string, TorBoxCachedTorrent>()
  const missing: string[] = []
  for (const hash of unique) {
    const cached = cachedAvailability.get(hash)
    if (cached && cached.expiresAt > now) {
      if (cached.value) result.set(hash, cached.value)
    } else missing.push(hash)
  }
  if (missing.length > 0) {
    const data = await request<Record<string, TorBoxCachedTorrent>>('/torrents/checkcached', {
      method: 'POST',
      body: JSON.stringify({ hashes: missing }),
    })
    const normalized = new Map(Object.entries(data || {}).map(([hash, torrent]) => [normalizedHash(hash || torrent.hash), torrent]))
    for (const hash of missing) {
      const value = normalized.get(hash) || null
      cachedAvailability.set(hash, { value, expiresAt: now + CACHE_TTL_MS })
      if (value) result.set(hash, value)
    }
  }
  return result
}

export async function annotateTorBoxStreams<T extends StreamResult>(streams: T[]): Promise<T[]> {
  if (!isTorBoxConnected()) return streams
  const hashes = streams.map((stream) => stream.infoHash || '')
  if (!hashes.some(Boolean)) return streams
  const cached = await checkTorBoxCached(hashes)
  return streams.map((stream) => {
    const hash = normalizedHash(stream.infoHash)
    if (!hash) return stream
    const torrent = cached.get(hash)
    return {
      ...stream,
      behaviorHints: {
        ...stream.behaviorHints,
        torboxChecked: true,
        torboxCached: Boolean(torrent),
        torboxName: torrent?.name,
      },
    }
  })
}

function looksLikeVideo(file: TorBoxCachedFile): boolean {
  return /^video\//i.test(file.mimetype || '') || /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts)$/i.test(file.name)
}

export function selectTorBoxFile(files: TorBoxCachedFile[], stream: StreamResult, context: TorBoxResolveContext = {}): TorBoxCachedFile | null {
  if (typeof stream.fileIdx === 'number' && files[stream.fileIdx]) return files[stream.fileIdx]
  const videos = files.filter(looksLikeVideo).filter((file) => !/\b(sample|trailer|featurette)\b/i.test(file.name))
  if (videos.length === 0) return null
  if (context.season != null && context.episode != null) {
    const season = String(context.season).padStart(2, '0')
    const episode = String(context.episode).padStart(2, '0')
    const patterns = [
      new RegExp(`(?:^|[^a-z0-9])s0?${season}e0?${episode}(?:[^0-9]|$)`, 'i'),
      new RegExp(`(?:^|[^0-9])0?${context.season}x0?${context.episode}(?:[^0-9]|$)`, 'i'),
    ]
    const episodeFile = videos.find((file) => patterns.some((pattern) => pattern.test(file.name)))
    if (episodeFile) return episodeFile
  }
  return [...videos].sort((a, b) => b.size - a.size)[0]
}

async function findExistingTorrent(hash: string): Promise<TorBoxTorrentListItem | null> {
  const list = await request<TorBoxTorrentListItem[]>('/torrents/mylist?bypass_cache=true')
  return list.find((torrent) => normalizedHash(torrent.hash) === hash) || null
}

async function createCachedTorrent(hash: string, title?: string): Promise<number> {
  const body = new URLSearchParams()
  body.set('magnet', `magnet:?xt=urn:btih:${hash}${title ? `&dn=${encodeURIComponent(title)}` : ''}`)
  body.set('seed', '3')
  body.set('add_only_if_cached', 'true')
  try {
    const created = await request<{ torrent_id: number }>('/torrents/createtorrent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    return created.torrent_id
  } catch (error) {
    const torBoxError = error as Error & { code?: string; data?: { torrent_id?: number } }
    if (torBoxError.data?.torrent_id != null) return torBoxError.data.torrent_id
    if (!/DUPLICATE/i.test(torBoxError.code || '') && !/already exists/i.test(torBoxError.message)) throw error
    const existing = await findExistingTorrent(hash)
    if (!existing) throw new Error('TorBox already has this torrent, but it could not be found in your list.')
    return existing.id
  }
}

export async function resolveTorBoxStream(stream: StreamResult, context: TorBoxResolveContext = {}): Promise<string> {
  const direct = directUrl(stream)
  if (direct) return direct
  const hash = normalizedHash(stream.infoHash)
  if (!hash) throw new Error('This stream has no direct URL or torrent hash.')
  if (!isTorBoxConnected()) throw new Error('Connect TorBox in Settings to play torrent streams.')
  const cacheKey = `${hash}:${stream.fileIdx ?? 'auto'}:${context.season ?? ''}:${context.episode ?? ''}`
  const cachedUrl = resolvedUrls.get(cacheKey)
  if (cachedUrl && cachedUrl.expiresAt > Date.now()) return cachedUrl.url
  const pending = resolveFlights.get(cacheKey)
  if (pending) return pending

  const flight = (async () => {
    const availability = (await checkTorBoxCached([hash])).get(hash)
    if (!availability) throw new Error('This torrent is not cached on TorBox yet.')
    const file = selectTorBoxFile(availability.files || [], stream, context)
    if (!file) throw new Error('TorBox did not find a playable video file in this torrent.')
    const torrentId = await createCachedTorrent(hash, context.title || availability.name)
    const token = getTorBoxToken()
    const params = new URLSearchParams({
      token,
      torrent_id: String(torrentId),
      file_id: String(file.id),
      zip_link: 'false',
      redirect: 'false',
      append_name: 'true',
    })
    const url = await request<string>(`/torrents/requestdl?${params.toString()}`)
    if (!/^https?:\/\//i.test(url)) throw new Error('TorBox returned an invalid playback URL.')
    resolvedUrls.set(cacheKey, { url, expiresAt: Date.now() + RESOLVED_URL_TTL_MS })
    return url
  })().finally(() => resolveFlights.delete(cacheKey))
  resolveFlights.set(cacheKey, flight)
  return flight
}
