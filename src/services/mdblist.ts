import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../stores/appStore'
import { getSelfhstIconUrl } from './serviceIcons'
import type { SearchResult } from '../types'

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
const BUILTIN_KEY = '9x2ikjc88drsgwc0ocsp2p5wn'
const BUILTIN_MDBLIST_CLIENT_ID = '1QZNjkmxhfpFEWOsOmAmkphArnbfoKeWlmbJZMOC'
const MDBLIST_CLIENT_ID = import.meta.env.VITE_MDBLIST_CLIENT_ID || BUILTIN_MDBLIST_CLIENT_ID
const MDBLIST_TOKEN_KEY = 'mdblist_oauth_tokens'

type MdblistMediaType = 'movie' | 'show'

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
  type: 'movie' | 'show' | 'episode'
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

function storeMdblistTokens(data: any): MdblistOAuthTokens {
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
  localStorage.setItem(MDBLIST_TOKEN_KEY, JSON.stringify(tokens))
  return tokens
}

export function clearMdblistOAuth(): void {
  localStorage.removeItem(MDBLIST_TOKEN_KEY)
}

async function postMdblistOAuthForm(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams(params),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const message = data?.error_description || data?.detail || data?.error || `MDBList OAuth failed (${res.status})`
    const err = new Error(String(message)) as Error & { code?: string }
    err.code = data?.error
    throw err
  }
  return data
}

async function refreshMdblistAccessToken(tokens: MdblistOAuthTokens): Promise<MdblistOAuthTokens | null> {
  const clientId = getMdblistClientId()
  if (!clientId || !tokens.refreshToken) return null
  try {
    const data = await postMdblistOAuthForm('/oauth/token/', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
    })
    return storeMdblistTokens(data)
  } catch (_) {
    clearMdblistOAuth()
    return null
  }
}

async function getValidMdblistAccessToken(): Promise<string> {
  const tokens = getStoredMdblistTokens()
  if (!tokens) return ''
  if (Date.now() / 1000 < tokens.expiresAt - 86400) return tokens.accessToken
  const refreshed = await refreshMdblistAccessToken(tokens)
  return refreshed?.accessToken || ''
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

const MDBLIST_REDIRECT_URI = 'http://localhost:42814/'

export interface MdblistPKCESession {
  codeVerifier: string
  state: string
}

export async function startMdblistPKCELogin(): Promise<{ authUrl: string; session: MdblistPKCESession }> {
  const clientId = getMdblistClientId()
  if (!clientId) throw new Error('MDBList OAuth Client ID is required')
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = crypto.randomUUID()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: MDBLIST_REDIRECT_URI,
    response_type: 'code',
    scope: 'write',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return {
    authUrl: `https://mdblist.com/oauth/authorize/?${params}`,
    session: { codeVerifier, state },
  }
}

export async function exchangeMdblistPKCEToken(code: string, session: MdblistPKCESession): Promise<MdblistOAuthTokens> {
  const clientId = getMdblistClientId()
  if (!clientId) throw new Error('MDBList OAuth Client ID is required')
  const data = await postMdblistOAuthForm('/oauth/token/', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: MDBLIST_REDIRECT_URI,
    client_id: clientId,
    code_verifier: session.codeVerifier,
  })
  return storeMdblistTokens(data)
}

export async function waitForMdblistCallback(): Promise<string> {
  return invoke<string>('start_anilist_callback_server')
}

function ratingsApiKey(): string {
  return userApiKey() || BUILTIN_KEY
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
  const token = options?.allowBuiltinForRatings ? '' : await getValidMdblistAccessToken()
  const key = token ? '' : options?.allowBuiltinForRatings ? ratingsApiKey() : userApiKey()
  if (!token && !key) throw new Error('MDBList account auth is required')

  const url = new URL(`${BASE_URL}${path}`)
  if (key) url.searchParams.set('apikey', key)

  if (token) {
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

  const res = await fetch(url.toString(), {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let message = `MDBList ${method} ${path} failed (${res.status})`
    try {
      const data = await res.json()
      message = String((data as any)?.detail || (data as any)?.error || message)
    } catch (_) {
      try { message = await res.text() || message } catch (_) { /* ignore */ }
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
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

function scrobblePayload(
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
  return { show: { ids, season, episode }, progress }
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
  const res = await fetch(url)
  if (!res.ok) return []
  const html = await res.text()

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
  return pickArray(data).map((item: any) => ({
    id: String(item.id),
    progress: Number(item.progress || 0),
    runtime: toNumber(item.runtime),
    updated_at: item.updated_at,
    paused_at: item.paused_at,
    type: item.type === 'movie' ? 'movie' : item.type === 'show' ? 'show' : 'episode',
    movie: item.movie,
    show: item.show,
    episode: item.episode,
  }))
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
  const watched = await getMdblistWatched()
  const shows = watched.filter((i) => i.media_type === 'show' && (i.season != null || i.episode != null))
  const grouped = new Map<string, { item: MdblistWatchedItem; maxSeason: number; maxEpisode: number; watchedAt?: string }>()
  for (const s of shows) {
    const key = String(s.tmdb_id || s.imdb_id || s.id)
    const prev = grouped.get(key)
    const se = s.season ?? 1
    const ep = s.episode ?? 0
    if (!prev || se > prev.maxSeason || (se === prev.maxSeason && ep > prev.maxEpisode)) {
      grouped.set(key, { item: s, maxSeason: se, maxEpisode: ep, watchedAt: s.watched_at })
    }
  }
  const results: MdblistUpNextItem[] = []
  for (const [, entry] of grouped) {
    results.push({
      showId: String(entry.item.tmdb_id || entry.item.imdb_id || entry.item.id),
      title: entry.item.title || 'Show',
      imdbId: entry.item.imdb_id,
      tmdbId: entry.item.tmdb_id ?? undefined,
      tvdbId: entry.item.tvdb_id ?? undefined,
      season: entry.maxSeason,
      episode: entry.maxEpisode + 1,
      lastWatchedAt: entry.watchedAt,
    })
  }
  results.sort((a, b) => (b.lastWatchedAt || '').localeCompare(a.lastWatchedAt || ''))
  return results.slice(0, 20)
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
    for (const raw of pickArray(data)) items.push(...normalizeWatchedRows(raw))
    cursor = nextCursor(data)
    if (!cursor) break
  }
  return items
}

function normalizeWatched(raw: any): MdblistWatchedItem | null {
  const media = raw.movie || raw.show || raw.episode?.show || raw
  const ids = idsFrom(media)
  const isEpisode = Boolean(raw.episode)
  const type = raw.movie ? 'movie' : 'show'
  const tmdbId = toNumber(ids.tmdb ?? media.tmdb_id ?? media.id)
  const imdbId = String(ids.imdb ?? media.imdb_id ?? '').trim() || undefined
  const tvdbId = toNumber(ids.tvdb ?? media.tvdb_id)
  if (!tmdbId && !imdbId && !tvdbId) return null
  return {
    id: String(raw.id || ids.mdblist || `${type}-${tmdbId || imdbId}`),
    media_type: type,
    watched_at: raw.watched_at || raw.last_watched_at,
    title: media.title,
    year: toNumber(media.release_year ?? media.year),
    imdb_id: imdbId,
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    mdblist_id: ids.mdblist ? String(ids.mdblist) : undefined,
    season: toNumber(raw.season?.number ?? raw.season ?? raw.episode?.season ?? raw.episode?.season_number),
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
    const seasonNumber = toNumber(season?.number ?? season?.season)
    if (!seasonNumber || !Array.isArray(season?.episodes)) return []
    return season.episodes.flatMap((episode: any) => {
      const episodeNumber = toNumber(episode?.number ?? episode?.episode)
      if (!episodeNumber) return []
      return [{ ...base, season: seasonNumber, episode: episodeNumber, watched_at: episode.watched_at || season.watched_at || base.watched_at }]
    })
  })
  return episodes.length ? episodes : [base]
}

function dedupeSearchResults(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.imdbId || (item.tmdbId ? `${item.type}:${item.tmdbId}` : item.id)
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
    { category: 'MDBLIST_RATINGS', ttlSeconds: 86400 },
  )
}

async function fetchMdblistRatingsRaw(req: RatingRequest): Promise<MdblistRating[]> {
  const apiKey = ratingsApiKey()

  const media = req.mediaType === 'movie' ? 'movie' : 'show'
  const candidates: string[] = []
  if (req.imdbId) candidates.push(`/imdb/${media}/${encodeURIComponent(req.imdbId)}`)
  if (req.tmdbId) candidates.push(`/tmdb/${media}/${encodeURIComponent(String(req.tmdbId))}`)
  if (req.tvdbId) candidates.push(`/tvdb/${media}/${encodeURIComponent(String(req.tvdbId))}`)
  if (req.malId) candidates.push(`/mal/${media}/${encodeURIComponent(String(req.malId))}`)

  for (const path of candidates) {
    try {
      const url = new URL(`${BASE_URL}${path}`)
      url.searchParams.set('apikey', apiKey)
      if (req.season != null) url.searchParams.set('season', String(req.season))
      if (req.episode != null) url.searchParams.set('episode', String(req.episode))
      const res = await fetch(url.toString())
      if (!res.ok) continue
      const data = await res.json()
      const ratings = normalizeRatings(data)
      if (ratings.length > 0) return ratings
    } catch (_) {
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
