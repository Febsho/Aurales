/**
 * PMDB (PublicMetaDB) service.
 *
 * All HTTP calls are routed through the Rust `pmdb_request` Tauri command so
 * that they originate from the native process — bypassing the WebView's CORS
 * restrictions. The browser `fetch` API cannot reach publicmetadb.com from a
 * tauri://localhost origin without explicit CORS headers on the server side.
 */
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../stores/appStore'
import { getTmdbApiKey } from './apiKeys'

const BASE_URL = 'https://publicmetadb.com/api/external'

// ── Low-level proxy ───────────────────────────────────────────────────────────

interface RustPmdbResponse {
  status: number
  ok: boolean
  /** Raw response body (JSON string). We JSON.parse it on the JS side. */
  body: string
}

async function pmdbFetch(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  path: string,
  bodyObj?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const apiKey = useAppStore.getState().pmdbApiKey
  if (!apiKey) return { ok: false, status: 0, data: null }

  try {
    const result = await invoke<RustPmdbResponse>('pmdb_request', {
      method,
      url: `${BASE_URL}${path}`,
      apiKey,
      body: bodyObj !== undefined ? JSON.stringify(bodyObj) : null,
    })

    let data: unknown = null
    try { data = JSON.parse(result.body) } catch (_) { data = result.body }

    if (!result.ok) {
      console.warn(
        `[PMDB] ${method} ${path} → ${result.status}:`,
        typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)
      )
    }
    return { ok: result.ok, status: result.status, data }
  } catch (e) {
    console.error(`[PMDB] invoke failed for ${method} ${path}:`, e)
    return { ok: false, status: 0, data: null }
  }
}

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface PMDBResumePoint {
  id: string
  tmdb_id: number
  media_type: 'movie' | 'tv'
  season?: number
  episode?: number
  position_ms: number
  runtime_ms: number
  progress?: number
  updated?: string
  updated_at?: string
  paused_at?: string
  created_at?: string
}

export interface PMDBSkipSegment {
  id: string
  tmdb_id: number
  media_type: 'movie' | 'tv'
  season?: number
  episode?: number
  intro_start_ms: number
  intro_end_ms: number
  credits_start_ms?: number
  credits_end_ms?: number
  recap_start_ms?: number
  recap_end_ms?: number
}

export interface PMDBWatchedItem {
  id: string
  tmdb_id: number
  media_type: 'movie' | 'tv'
  season?: number
  episode?: number
  watched_at?: string
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function pickArrayPayload(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  const d = data as Record<string, unknown>
  if (Array.isArray(d.items)) return d.items
  if (Array.isArray(d.data)) return d.data
  if (Array.isArray(d.results)) return d.results
  if (Array.isArray(d.resume)) return d.resume
  return []
}

function toNumber(value: unknown): number | undefined {
  if (value == null) return undefined
  const num = Number(String(value).replace(/^(tmdb|tvdb|mal|anilist)-/i, ''))
  return Number.isFinite(num) && num > 0 ? num : undefined
}


function msFromApi(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  // If the value is suspiciously small, assume it's seconds → convert
  return num < 10000 ? Math.floor(num * 1000) : Math.floor(num)
}

function normalizeMediaType(value: unknown): 'movie' | 'tv' | null {
  const raw = String(value ?? '').toLowerCase()
  if (raw === 'movie' || raw === 'movies') return 'movie'
  if (['tv', 'show', 'shows', 'series', 'anime'].includes(raw)) return 'tv'
  return null
}

function normalizeResumePoint(raw: unknown): PMDBResumePoint | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ids = (r.ids ?? (r.media as any)?.ids ?? (r.item as any)?.ids ?? {}) as Record<string, unknown>

  const tmdbId = toNumber(r.tmdb_id ?? r.tmdbId ?? r.tmdb ?? ids.tmdb ?? (r.media as any)?.tmdb_id ?? (r.item as any)?.tmdb_id)
  const mediaType = normalizeMediaType(r.media_type ?? r.mediaType ?? r.type ?? (r.media as any)?.media_type ?? (r.item as any)?.media_type)
  if (!tmdbId || !mediaType) return null

  const runtimeMs = msFromApi(r.runtime_ms ?? r.runtimeMs ?? r.duration_ms ?? r.durationMs ?? r.runtime)
  let positionMs = msFromApi(r.position_ms ?? r.positionMs ?? r.progress_ms ?? r.progressMs ?? r.position)

  const progress = toNumber(r.progress ?? r.percent ?? r.percentage)
  if (!positionMs && runtimeMs > 0 && progress != null) {
    positionMs = Math.floor(runtimeMs * (progress > 1 ? progress / 100 : progress))
  }
  if (positionMs <= 0) return null

  return {
    id: String(r.id ?? `${mediaType}-${tmdbId}-${r.season ?? ''}-${r.episode ?? ''}`),
    tmdb_id: tmdbId,
    media_type: mediaType,
    season: toNumber(r.season),
    episode: toNumber(r.episode),
    position_ms: positionMs,
    runtime_ms: runtimeMs,
    progress,
    updated: r.updated as string | undefined,
    updated_at: (r.updated_at ?? r.updatedAt) as string | undefined,
    paused_at: (r.paused_at ?? r.pausedAt) as string | undefined,
    created_at: (r.created_at ?? r.createdAt) as string | undefined,
  }
}

function normalizeWatchedItem(raw: unknown): PMDBWatchedItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const media = (r.media ?? r.item ?? {}) as Record<string, unknown>
  const ids = (r.ids ?? media.ids ?? {}) as Record<string, unknown>
  const episodeData = r.episode && typeof r.episode === 'object' ? r.episode as Record<string, unknown> : null

  const tmdbId = toNumber(r.tmdb_id ?? r.tmdbId ?? r.tmdb ?? ids.tmdb ?? media.tmdb_id ?? media.tmdbId)
  const mediaType = normalizeMediaType(r.media_type ?? r.mediaType ?? r.type ?? media.media_type ?? media.mediaType ?? media.type)
  if (!tmdbId || !mediaType) return null

  return {
    id: String(r.id ?? `${mediaType}-${tmdbId}-${r.season ?? ''}-${r.episode ?? ''}`),
    tmdb_id: tmdbId,
    media_type: mediaType,
    season: toNumber(r.season ?? r.season_number ?? r.seasonNumber ?? episodeData?.season ?? episodeData?.season_number ?? episodeData?.seasonNumber),
    episode: toNumber(episodeData?.number ?? episodeData?.episode ?? episodeData?.episode_number ?? episodeData?.episodeNumber ?? r.episode),
    watched_at: (r.watched_at ?? r.watchedAt ?? r.last_watched_at) as string | undefined,
  }
}

// ── Connection check ──────────────────────────────────────────────────────────

export interface PMDBConnectionStatus {
  connected: boolean
  status?: number
  error?: string
  /** Total resume points stored (from meta.total if available) */
  resumeCount?: number
}

export async function checkPMDBConnection(): Promise<PMDBConnectionStatus> {
  const apiKey = useAppStore.getState().pmdbApiKey
  if (!apiKey) return { connected: false, error: 'No API key entered' }
  if (!apiKey.startsWith('pm-')) {
    return { connected: false, error: 'Key should start with "pm-" — check your PMDB dashboard' }
  }

  try {
    const result = await pmdbFetch('GET', '/resume?perPage=1&page=1')
    if (result.ok) {
      const d = result.data as Record<string, unknown> | null
      const total = (d?.meta as any)?.total ?? d?.total
      return {
        connected: true,
        status: result.status,
        resumeCount: typeof total === 'number' ? total : undefined,
      }
    }
    if (result.status === 401 || result.status === 403) {
      return { connected: false, status: result.status, error: 'Invalid API key — check your PMDB dashboard' }
    }
    const errText = typeof result.data === 'string'
      ? result.data.slice(0, 120)
      : JSON.stringify(result.data ?? '').slice(0, 120)
    return { connected: false, status: result.status, error: `Server error ${result.status}: ${errText}` }
  } catch (e) {
    return { connected: false, error: String(e) }
  }
}

// ── TMDB ID Lookup ────────────────────────────────────────────────────────────

export async function lookupTmdbId(
  idType: string,
  idValue: string,
  preferredMediaType?: 'movie' | 'tv'
): Promise<{ tmdbId: number; mediaType: 'movie' | 'tv' } | null> {
  // 1. Try TMDB /find directly (imdb IDs, no PMDB key needed)
  if (idType === 'imdb') {
    const tmdbKey = getTmdbApiKey()
    if (tmdbKey) {
      try {
        const res = await fetch(
          `https://api.themoviedb.org/3/find/${encodeURIComponent(idValue)}?api_key=${tmdbKey}&external_source=imdb_id`
        )
        if (res.ok) {
          const data = await res.json()
          const movies: { id: number }[] = data.movie_results || []
          const shows: { id: number }[] = data.tv_results || []
          if (preferredMediaType === 'movie' && movies.length > 0) return { tmdbId: movies[0].id, mediaType: 'movie' }
          if (preferredMediaType === 'tv' && shows.length > 0) return { tmdbId: shows[0].id, mediaType: 'tv' }
          if (movies.length > 0) return { tmdbId: movies[0].id, mediaType: 'movie' }
          if (shows.length > 0) return { tmdbId: shows[0].id, mediaType: 'tv' }
        }
      } catch (_) { /* fall through */ }
    }
  }

  // TMDB /find also resolves TVDB ids directly (no PMDB key needed)
  if (idType === 'tvdb') {
    const tmdbKey = getTmdbApiKey()
    if (tmdbKey) {
      try {
        const res = await fetch(
          `https://api.themoviedb.org/3/find/${encodeURIComponent(idValue)}?api_key=${tmdbKey}&external_source=tvdb_id`
        )
        if (res.ok) {
          const data = await res.json()
          const shows: { id: number }[] = data.tv_results || []
          if (shows.length > 0) return { tmdbId: shows[0].id, mediaType: 'tv' }
        }
      } catch (_) { /* fall through */ }
    }
  }

  // 2. Fall back to PMDB mappings/lookup
  if (!useAppStore.getState().pmdbApiKey) return null
  try {
    const qs = new URLSearchParams({ id_type: idType, id_value: idValue })
    if (preferredMediaType) qs.set('media_type', preferredMediaType)
    const result = await pmdbFetch('GET', `/mappings/lookup?${qs}`)
    if (!result.ok || !result.data) return null

    const d = result.data as Record<string, unknown>
    const directId = toNumber(d.tmdb_id ?? d.tmdbId)
    const directType = normalizeMediaType(d.media_type ?? d.mediaType)
    if (directId && directType) return { tmdbId: directId, mediaType: directType }

    const matches = pickArrayPayload(result.data)
    if (matches.length > 0) {
      const m = matches[0] as Record<string, unknown>
      const tmdbId = toNumber(m.tmdb_id ?? m.tmdbId ?? m.tmdb)
      const mediaType = normalizeMediaType(m.media_type ?? m.mediaType ?? m.type)
      if (tmdbId && mediaType) return { tmdbId, mediaType }
    }
  } catch (_) { /* ignore */ }
  return null
}

// ── Resume Points (Continue Watching) ────────────────────────────────────────

export async function getPMDBPlaybackProgress(): Promise<PMDBResumePoint[]> {
  if (!useAppStore.getState().pmdbApiKey) return []
  try {
    const points: PMDBResumePoint[] = []
    const perPage = 500

    for (let page = 1; page <= 20; page++) {
      const result = await pmdbFetch('GET', `/resume?perPage=${perPage}&page=${page}`)
      if (!result.ok) {
        console.warn(`[PMDB] GET /resume page ${page} failed:`, result.status)
        break
      }

      const rawItems = pickArrayPayload(result.data)
      const normalized = rawItems
        .map(normalizeResumePoint)
        .filter((item): item is PMDBResumePoint => item !== null)
      points.push(...normalized)

      const d = result.data as Record<string, unknown> | null
      const total = toNumber((d?.meta as any)?.total ?? d?.total)
      if (rawItems.length < perPage || (total != null && points.length >= total)) break
    }

    return points
  } catch (e) {
    console.error('[PMDB] getPMDBPlaybackProgress failed:', e)
    return []
  }
}

export async function savePMDBPlaybackProgress(
  tmdbId: number | undefined,
  mediaType: 'movie' | 'tv',
  season: number | undefined,
  episode: number | undefined,
  positionMs: number,
  runtimeMs: number,
  imdbId?: string
): Promise<{ action?: string } | null> {
  if (!useAppStore.getState().pmdbApiKey) return null
  if (runtimeMs <= 0) return null
  if (!tmdbId && !imdbId) return null
  if (mediaType === 'tv' && (season == null || episode == null)) return null

  const body: Record<string, unknown> = {
    media_type: mediaType,
    position_ms: Math.floor(positionMs),
    runtime_ms: Math.floor(runtimeMs),
  }
  if (mediaType === 'tv') {
    body.season = season
    body.episode = episode
  }
  if (tmdbId) {
    body.tmdb_id = tmdbId
  } else {
    body.id_type = 'imdb'
    body.id_value = imdbId
  }

  const result = await pmdbFetch('POST', '/resume', body)
  if (!result.ok) return null
  return result.data as { action?: string } | null
}

export async function deletePMDBResumePoint(id: string): Promise<void> {
  if (!useAppStore.getState().pmdbApiKey) return
  await pmdbFetch('DELETE', `/resume/${id}`)
}

// ── Watch History ─────────────────────────────────────────────────────────────

export async function scrobblePMDB(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<void> {
  if (!useAppStore.getState().pmdbApiKey) return
  if (mediaType === 'tv' && (season == null || episode == null)) return

  const body: Record<string, unknown> = { tmdb_id: tmdbId, media_type: mediaType }
  if (mediaType === 'tv') { body.season = season; body.episode = episode }

  const result = await pmdbFetch('POST', '/watched?dedupe=true', body)
  if (!result.ok) {
    console.warn('[PMDB] scrobblePMDB failed:', result.status)
  }
}

export async function removePMDBWatched(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<void> {
  if (!useAppStore.getState().pmdbApiKey) return
  if (mediaType === 'tv' && (season == null || episode == null)) return

  const watched = await getPMDBWatched()
  const target = watched.find((item) =>
    item.tmdb_id === tmdbId &&
    item.media_type === mediaType &&
    (mediaType === 'movie' || (item.season === season && item.episode === episode))
  )
  if (!target) return

  const result = await pmdbFetch('DELETE', `/watched/${encodeURIComponent(target.id)}`)
  if (!result.ok) {
    console.warn('[PMDB] removePMDBWatched failed:', result.status)
  }
}

export async function getPMDBWatched(): Promise<PMDBWatchedItem[]> {
  if (!useAppStore.getState().pmdbApiKey) return []
  try {
    const perPage = 500
    const first = await pmdbFetch('GET', `/watched?perPage=${perPage}&page=1`)
    if (!first.ok) return []
    const firstRaw = pickArrayPayload(first.data)
    const items = firstRaw.map(normalizeWatchedItem).filter((i): i is PMDBWatchedItem => i !== null)
    const firstData = first.data as Record<string, unknown> | null
    const meta = firstData?.meta as Record<string, unknown> | undefined
    const total = toNumber(meta?.total ?? firstData?.total)
    const reportedPages = toNumber(meta?.totalPages ?? meta?.total_pages ?? firstData?.totalPages ?? firstData?.total_pages)
    const reportedPerPage = toNumber(meta?.perPage ?? meta?.per_page ?? firstData?.perPage ?? firstData?.per_page)
    const effectivePerPage = reportedPerPage || firstRaw.length || perPage
    const totalPages = reportedPages != null
      ? Math.min(20, reportedPages)
      : total != null
      ? Math.min(20, Math.ceil(total / effectivePerPage))
      : (firstRaw.length < perPage ? 1 : 20)

    if (totalPages > 1) {
      const remaining = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, index) => pmdbFetch('GET', `/watched?perPage=${perPage}&page=${index + 2}`))
      )
      for (const result of remaining) {
        if (!result.ok) continue
        items.push(...pickArrayPayload(result.data).map(normalizeWatchedItem).filter((i): i is PMDBWatchedItem => i !== null))
      }
    }
    return items
  } catch (e) {
    console.error('[PMDB] getPMDBWatched failed:', e)
    return []
  }
}

// ── Skip Segments ─────────────────────────────────────────────────────────────

export async function getPMDBSkips(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<PMDBSkipSegment[]> {
  if (!useAppStore.getState().pmdbApiKey) return []
  const qs = new URLSearchParams({ tmdb_id: String(tmdbId), media_type: mediaType })
  if (mediaType === 'tv') {
    if (season != null) qs.append('season', String(season))
    if (episode != null) qs.append('episode', String(episode))
  }
  const result = await pmdbFetch('GET', `/skips?${qs}`)
  if (!result.ok) return []
  return pickArrayPayload(result.data) as PMDBSkipSegment[]
}

export async function submitPMDBSkip(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  season: number | undefined,
  episode: number | undefined,
  introStartMs: number,
  introEndMs: number,
  creditsStartMs?: number,
  creditsEndMs?: number
): Promise<void> {
  if (!useAppStore.getState().pmdbApiKey) return
  await pmdbFetch('POST', '/skips', {
    tmdb_id: tmdbId,
    media_type: mediaType,
    season,
    episode,
    intro_start_ms: introStartMs,
    intro_end_ms: introEndMs,
    credits_start_ms: creditsStartMs,
    credits_end_ms: creditsEndMs,
  })
}

// ── Lists / Watchlists ────────────────────────────────────────────────────────

export interface PMDBList {
  id: string
  name: string
  type: 'watchlist' | 'custom'
  is_public: boolean
}

export interface PMDBListItem {
  id: string
  tmdb_id: number
  media_type: 'movie' | 'tv'
  added_at: string
}

export interface PMDBPickCatalog {
  id: string
  slug: string
  name: string
  description?: string
  seed_type: string
  seed_params: Record<string, unknown>
  filters: Record<string, unknown>
  weights: Record<string, unknown>
  exclude_watched: boolean
  exclude_watchlist: boolean
  created?: string
  updated?: string
}

export interface PMDBPickItem {
  tmdb_id: number
  media_type: 'movie' | 'tv'
  title: string
  poster_path?: string | null
  backdrop_path?: string | null
  year?: string
  overview?: string
  genre_ids?: number[]
  vote_average?: number
  vote_count?: number
  popularity?: number
  original_language?: string
  score?: number
  reasons?: string[]
}

export async function getPMDBPickCatalogs(): Promise<PMDBPickCatalog[]> {
  if (!useAppStore.getState().pmdbApiKey) return []
  const result = await pmdbFetch('GET', '/catalogs')
  if (!result.ok) return []
  return pickArrayPayload(result.data) as PMDBPickCatalog[]
}

export async function getPMDBPickItems(catalogId: string): Promise<PMDBPickItem[]> {
  if (!useAppStore.getState().pmdbApiKey || !catalogId) return []

  const path = `/catalogs/${encodeURIComponent(catalogId)}/items`
  const first = await pmdbFetch('GET', `${path}?page=1`)
  if (!first.ok) return []

  const firstData = first.data as { items?: PMDBPickItem[]; totalPages?: number }
  const items = Array.isArray(firstData?.items) ? firstData.items : []
  const totalPages = Math.min(5, Math.max(1, Number(firstData?.totalPages) || 1))
  if (totalPages === 1) return items

  const remaining = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) => pmdbFetch('GET', `${path}?page=${index + 2}`))
  )
  for (const result of remaining) {
    if (!result.ok) continue
    const data = result.data as { items?: PMDBPickItem[] }
    if (Array.isArray(data?.items)) items.push(...data.items)
  }
  return items
}

export async function getPMDBLists(): Promise<PMDBList[]> {
  if (!useAppStore.getState().pmdbApiKey) return []
  const result = await pmdbFetch('GET', '/lists?perPage=100')
  if (!result.ok) return []
  return pickArrayPayload(result.data) as PMDBList[]
}

export async function getPMDBListItems(listId: string): Promise<PMDBListItem[]> {
  if (!useAppStore.getState().pmdbApiKey || !listId) return []
  const result = await pmdbFetch('GET', `/lists/${encodeURIComponent(listId)}/items?perPage=500`)
  if (!result.ok) return []
  return pickArrayPayload(result.data) as PMDBListItem[]
}

export async function getOrCreatePMDBWatchlist(): Promise<string | null> {
  if (!useAppStore.getState().pmdbApiKey) return null
  const result = await pmdbFetch('GET', '/lists?perPage=50')
  if (!result.ok) return null
  const lists = pickArrayPayload(result.data) as PMDBList[]
  const found = lists.find((l) => l.type === 'watchlist' || l.name?.toLowerCase() === 'watchlist')
  if (found) return found.id

  const create = await pmdbFetch('POST', '/lists', {
    name: 'Watchlist',
    description: 'My main watchlist',
    type: 'watchlist',
    is_public: false,
  })
  if (!create.ok) return null
  const d = create.data as Record<string, unknown>
  return String((d?.item as any)?.id ?? d?.id ?? '')  || null
}

export async function getPMDBWatchlistItems(): Promise<PMDBListItem[]> {
  if (!useAppStore.getState().pmdbApiKey) return []
  const listId = await getOrCreatePMDBWatchlist()
  if (!listId) return []
  const result = await pmdbFetch('GET', `/lists/${listId}/items?perPage=100`)
  if (!result.ok) return []
  return pickArrayPayload(result.data) as PMDBListItem[]
}

export async function addToPMDBWatchlist(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<boolean> {
  if (!useAppStore.getState().pmdbApiKey) return false
  const listId = await getOrCreatePMDBWatchlist()
  if (!listId) return false
  const result = await pmdbFetch('POST', `/lists/${listId}/items`, { tmdb_id: tmdbId, media_type: mediaType })
  return result.ok
}

export async function removeFromPMDBWatchlist(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<boolean> {
  if (!useAppStore.getState().pmdbApiKey) return false
  const listId = await getOrCreatePMDBWatchlist()
  if (!listId) return false
  const items = await getPMDBWatchlistItems()
  const target = items.find((i) => i.tmdb_id === tmdbId && i.media_type === mediaType)
  if (!target) return false
  const result = await pmdbFetch('DELETE', `/lists/${listId}/items/${target.id}`)
  return result.ok
}
