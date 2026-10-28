import type { StreamResult } from '../types'
import { invoke } from '@tauri-apps/api/core'
import { getPlayableDirectUrl } from './streams/playableUrl'
import { readBoundedResponseText } from './network/boundedResponse'
import { getMediaWorkerConfig, proxyTorboxRequest } from './mediaWorker'

const API_BASE = 'https://api.torbox.app/v1/api'
const TOKEN_KEY = 'torbox_api_token'
const CACHE_TTL_MS = 60 * 60 * 1000
const RESOLVED_URL_TTL_MS = 50 * 60 * 1000
const MAX_TORBOX_CACHE_ENTRIES = 500
const MAX_TORBOX_RESPONSE_BYTES = 16 * 1024 * 1024

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
let torBoxAuthGeneration = 0
let torBoxDeviceAuthGeneration = 0
let activeDeviceCode: string | null = null

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_TORBOX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function normalizedHash(value: string | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function directUrl(stream: StreamResult): string | null {
  return getPlayableDirectUrl(stream)
}

async function request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
  const token = getTorBoxToken()
  const authGeneration = torBoxAuthGeneration
  if (authenticated && !token) throw new Error('Connect TorBox in Settings first.')
  const headers = new Headers(init.headers)
  if (authenticated) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', init.body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json')
  }
  const usingTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)
  let responseStatus: number
  let responseOk: boolean
  let responseBody: string
  if (usingTauri) {
    const proxy = await invoke<{ status: number; ok: boolean; body: string }>('torbox_request', {
      method: init.method || 'GET',
      path,
      token: authenticated ? token : null,
      body: typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null,
      contentType: headers.get('Content-Type') || 'application/json',
    })
    responseStatus = proxy.status
    responseOk = proxy.ok
    responseBody = proxy.body
  } else {
    if (getMediaWorkerConfig()) {
      const response = await proxyTorboxRequest(
        (init.method || 'GET').toUpperCase() as 'GET' | 'POST',
        path,
        authenticated ? token : undefined,
        typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined,
        headers.get('Content-Type') || 'application/json',
        init.signal ?? undefined,
      )
      responseStatus = response.status
      responseOk = response.ok
      responseBody = response.body
    } else {
      const controller = init.signal ? undefined : new AbortController()
      const timeout = controller ? window.setTimeout(() => controller.abort(), 15_000) : undefined
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          ...init,
          headers,
          signal: init.signal ?? controller?.signal,
        })
        responseStatus = response.status
        responseOk = response.ok
        responseBody = await readBoundedResponseText(response, MAX_TORBOX_RESPONSE_BYTES, 'TorBox response')
      } finally {
        if (timeout != null) window.clearTimeout(timeout)
      }
    }
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
  if (authenticated && (authGeneration !== torBoxAuthGeneration || getTorBoxToken() !== token)) {
    throw new Error('TorBox connection changed before the request completed.')
  }
  return payload.data
}

export function getTorBoxToken(): string {
  return typeof localStorage === 'undefined' ? '' : localStorage.getItem(TOKEN_KEY)?.trim() || ''
}

export function setTorBoxToken(token: string): void {
  torBoxAuthGeneration++
  const clean = token.trim()
  if (clean) localStorage.setItem(TOKEN_KEY, clean)
  else localStorage.removeItem(TOKEN_KEY)
  cachedAvailability.clear()
  resolvedUrls.clear()
}

export function clearTorBoxToken(): void {
  setTorBoxToken('')
}

export function getTorBoxAuthGeneration(): number {
  return torBoxAuthGeneration
}

export function cancelTorBoxDeviceAuth(): void {
  torBoxDeviceAuthGeneration++
  activeDeviceCode = null
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
  cancelTorBoxDeviceAuth()
  const generation = torBoxDeviceAuthGeneration
  const device = await request<TorBoxDeviceCode>('/user/auth/device/start?app=Aurales', {}, false)
  if (generation !== torBoxDeviceAuthGeneration) throw new Error('TorBox sign-in was cancelled.')
  activeDeviceCode = device.device_code
  return device
}

export async function pollTorBoxDeviceToken(deviceCode: string): Promise<string | null> {
  const generation = torBoxDeviceAuthGeneration
  if (!activeDeviceCode || activeDeviceCode !== deviceCode) return null
  try {
    const data = await request<{ access_token: string }>('/user/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({ device_code: deviceCode }),
    }, false)
    if (generation !== torBoxDeviceAuthGeneration || activeDeviceCode !== deviceCode) return null
    return data.access_token || null
  } catch (error) {
    if (generation !== torBoxDeviceAuthGeneration || activeDeviceCode !== deviceCode) return null
    const code = (error as Error & { code?: string }).code || ''
    if (code === 'DEVICE_CODE_NOT_USED' || /pending|authorization|not.?ready/i.test(code) || /pending|authorize|waiting|not been used/i.test((error as Error).message)) return null
    throw error
  }
}

export function getTorBoxUser(): Promise<TorBoxUser> {
  return request<TorBoxUser>('/user/me?settings=false')
}

export async function checkTorBoxCached(hashes: string[]): Promise<Map<string, TorBoxCachedTorrent>> {
  const authGeneration = torBoxAuthGeneration
  const unique = [...new Set(hashes.map(normalizedHash).filter(Boolean))]
  const now = Date.now()
  const result = new Map<string, TorBoxCachedTorrent>()
  const missing: string[] = []
  for (const hash of unique) {
    const cached = cachedAvailability.get(hash)
    if (cached && cached.expiresAt > now) {
      rememberBounded(cachedAvailability, hash, cached)
      if (cached.value) result.set(hash, cached.value)
    } else {
      if (cached) cachedAvailability.delete(hash)
      missing.push(hash)
    }
  }
  if (missing.length > 0) {
    const data = await request<Record<string, TorBoxCachedTorrent>>('/torrents/checkcached', {
      method: 'POST',
      body: JSON.stringify({ hashes: missing }),
    })
    if (authGeneration !== torBoxAuthGeneration) throw new Error('TorBox connection changed before the request completed.')
    const normalized = new Map(Object.entries(data || {}).map(([hash, torrent]) => [normalizedHash(hash || torrent.hash), torrent]))
    for (const hash of missing) {
      const value = normalized.get(hash) || null
      rememberBounded(cachedAvailability, hash, { value, expiresAt: now + CACHE_TTL_MS })
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
  if (typeof stream.fileIdx === 'number') {
    const indexed = files[stream.fileIdx]
    if (indexed && looksLikeVideo(indexed) && !/\b(sample|trailer|featurette)\b/i.test(indexed.name)) return indexed
  }
  const videos = files.filter(looksLikeVideo).filter((file) => !/\b(sample|trailer|featurette)\b/i.test(file.name))
  if (videos.length === 0) return null
  if (context.season != null && context.episode != null) {
    const season = String(context.season)
    const episode = String(context.episode)
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
  const authGeneration = torBoxAuthGeneration
  const cacheKey = `${authGeneration}:${hash}:${stream.fileIdx ?? 'auto'}:${context.season ?? ''}:${context.episode ?? ''}`
  const cachedUrl = resolvedUrls.get(cacheKey)
  if (cachedUrl && cachedUrl.expiresAt > Date.now()) {
    rememberBounded(resolvedUrls, cacheKey, cachedUrl)
    return cachedUrl.url
  }
  if (cachedUrl) resolvedUrls.delete(cacheKey)
  const pending = resolveFlights.get(cacheKey)
  if (pending) return pending

  const flight: Promise<string> = (async () => {
    const availability = (await checkTorBoxCached([hash])).get(hash)
    if (authGeneration !== torBoxAuthGeneration) throw new Error('TorBox connection changed before the request completed.')
    if (!availability) throw new Error('This torrent is not cached on TorBox yet.')
    const file = selectTorBoxFile(availability.files || [], stream, context)
    if (!file) throw new Error('TorBox did not find a playable video file in this torrent.')
    const torrentId = await createCachedTorrent(hash, context.title || availability.name)
    if (authGeneration !== torBoxAuthGeneration) throw new Error('TorBox connection changed before the request completed.')
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
    rememberBounded(resolvedUrls, cacheKey, { url, expiresAt: Date.now() + RESOLVED_URL_TTL_MS })
    return url
  })().finally(() => {
    if (resolveFlights.get(cacheKey) === flight) resolveFlights.delete(cacheKey)
  })
  resolveFlights.set(cacheKey, flight)
  return flight
}
