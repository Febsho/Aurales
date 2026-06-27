/**
 * Central Simkl API client.
 *
 * Handles auth, error types, rate-limit back-off, retries, and mock mode.
 * All calls are authenticated with Bearer token + simkl-api-key header.
 */

import { getStoredSimklToken, getSimklConfig, isSimklMockMode } from './auth'
import type { SimklApiItem, SimklMapping } from './types'

const BASE = 'https://api.simkl.com'
const MOCK_DELAY_MS = 200

// ─── Error types ──────────────────────────────────────────────────────────────

export class SimklError extends Error {
  readonly code: SimklErrorCode
  readonly status?: number

  constructor(message: string, code: SimklErrorCode, status?: number) {
    super(message)
    this.name = 'SimklError'
    this.code = code
    this.status = status
  }
}

export type SimklErrorCode =
  | 'not_connected'
  | 'invalid_token'
  | 'expired_token'
  | 'rate_limited'
  | 'network_offline'
  | 'not_found'
  | 'missing_mapping'
  | 'duplicate_item'
  | 'api_error'

// ─── Request wrapper ──────────────────────────────────────────────────────────

let _clientId = ''

async function ensureClientId(): Promise<string> {
  if (_clientId) return _clientId
  const config = await getSimklConfig()
  _clientId = config.clientId
  return _clientId
}

export async function simklRequest<T = unknown>(
  path: string,
  options: RequestInit & { retries?: number } = {},
): Promise<T> {
  if (isSimklMockMode()) {
    return handleMockRequest<T>(path, options)
  }

  const token = getStoredSimklToken()
  if (!token?.accessToken) {
    throw new SimklError('Not connected to Simkl', 'not_connected')
  }

  const clientId = await ensureClientId()
  const retries = options.retries ?? 1
  const { retries: _r, ...fetchOptions } = options

  let lastError: SimklError | null = null

  const urlParams = new URLSearchParams()
  urlParams.set('client_id', clientId)
  urlParams.set('app-name', 'Aurales')
  urlParams.set('app-version', '0.1.0')

  let finalPath = path
  if (path.includes('?')) {
    const [basePath, search] = path.split('?')
    const existingParams = new URLSearchParams(search)
    existingParams.forEach((val, key) => {
      urlParams.set(key, val)
    })
    finalPath = basePath
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential back-off: 1s, 2s, …
      await sleep(1000 * attempt)
    }

    let res: Response
    try {
      res = await fetch(`${BASE}${finalPath}?${urlParams.toString()}`, {
        ...fetchOptions,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.accessToken}`,
          'simkl-api-key': clientId,
          ...fetchOptions.headers,
        },
      })
    } catch (networkErr) {
      lastError = new SimklError(
        `Network error: ${networkErr instanceof Error ? networkErr.message : networkErr}`,
        'network_offline',
      )
      continue
    }

    // Success
    if (res.status === 200 || res.status === 201) {
      try { return (await res.json()) as T } catch (_) { return null as T }
    }
    if (res.status === 204) return null as T

    // Retryable
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10)
      await sleep(retryAfter * 1000)
      lastError = new SimklError('Rate limited by Simkl', 'rate_limited', 429)
      continue
    }
    if (res.status >= 500) {
      lastError = new SimklError(`Simkl server error: ${res.status}`, 'api_error', res.status)
      continue
    }

    // Non-retryable
    if (res.status === 401 || res.status === 403) {
      throw new SimklError('Simkl token invalid or expired', 'invalid_token', res.status)
    }
    if (res.status === 404) {
      throw new SimklError(`Simkl: resource not found — ${path}`, 'not_found', 404)
    }
    throw new SimklError(`Simkl API error: ${res.status}`, 'api_error', res.status)
  }

  throw lastError ?? new SimklError('Simkl request failed', 'api_error')
}

// ─── High-level helpers ────────────────────────────────────────────────────────

/** Fetch the authenticated user's Simkl account settings. */
export async function getSimklAccount() {
  return simklRequest<Record<string, unknown>>('/users/settings')
}

/** Search Simkl by title / year. */
export async function searchSimklItem(opts: {
  title: string
  year?: number
  type?: 'movie' | 'show' | 'anime' | 'all'
}): Promise<SimklApiItem[]> {
  if (isSimklMockMode()) return mockSearch(opts.title)

  const params = new URLSearchParams({
    q: opts.title,
    type: opts.type ?? 'all',
    client_id: _clientId || import.meta.env.VITE_SIMKL_CLIENT_ID || '',
  })
  if (opts.year) params.set('years', String(opts.year))

  return simklRequest<SimklApiItem[]>(`/search/id?${params.toString()}`)
}

/** Resolve a Simkl item via external IDs (IMDb / TMDB / TVDB). */
export async function resolveSimklMapping(opts: {
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  malId?: number
}): Promise<SimklMapping | null> {
  if (isSimklMockMode()) return null

  const clientId = _clientId || import.meta.env.VITE_SIMKL_CLIENT_ID || ''

  const tryId = async (service: string, id: string | number): Promise<SimklMapping | null> => {
    try {
      const params = new URLSearchParams({ client_id: clientId })
      const res = await simklRequest<SimklApiItem[]>(
        `/search/id?${service}=${id}&${params.toString()}`,
      )
      if (!res || res.length === 0) return null
      const first = res[0]
      const media = first.movie || first.show || first.anime
      if (!media) return null
      const type = first.movie ? 'movie' : first.show ? 'show' : 'anime'
      return {
        simklId: media.ids.simkl || media.ids.simkl_id,
        imdbId: media.ids.imdb,
        tmdbId: media.ids.tmdb,
        tvdbId: media.ids.tvdb,
        malId: media.ids.mal,
        type,
        title: media.title,
        year: media.year,
      }
    } catch (_) { return null }
  }

  if (opts.imdbId) return tryId('imdb', opts.imdbId)
  if (opts.tmdbId) return tryId('tmdb', opts.tmdbId)
  if (opts.tvdbId) return tryId('tvdb', opts.tvdbId)
  if (opts.malId)  return tryId('mal',  opts.malId)
  return null
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Mock mode ─────────────────────────────────────────────────────────────────

async function handleMockRequest<T>(path: string, _options: RequestInit): Promise<T> {
  await sleep(MOCK_DELAY_MS)

  if (path.startsWith('/users/settings')) {
    return { user: { id: 1, username: 'MockUser', avatar: null } } as T
  }
  if (path.startsWith('/sync/all-items') || path.startsWith('/users/me/watchlist')) {
    return MOCK_WATCHLIST as T
  }
  if (path.includes('/sync/add-to-list') || path.includes('/sync/history')) {
    return { added: { movies: 1, shows: 0, anime: 0 } } as T
  }
  return null as T
}

function mockSearch(title: string): SimklApiItem[] {
  return [
    {
      movie: {
        title,
        year: 2023,
        ids: { simkl: 99999, imdb: 'tt9999999' },
      },
    },
  ]
}

export const MOCK_WATCHLIST: SimklApiItem[] = [
  {
    movie: { title: 'Dune: Part Two', year: 2024, ids: { simkl: 1001, imdb: 'tt15239678' } },
    status: 'plantowatch',
    last_watched_at: undefined,
  },
  {
    movie: { title: 'Oppenheimer', year: 2023, ids: { simkl: 1002, imdb: 'tt15398776' } },
    status: 'completed',
    last_watched_at: '2024-01-15T20:00:00Z',
  },
  {
    show: { title: 'Shogun', year: 2024, ids: { simkl: 2001, imdb: 'tt2788316' } },
    status: 'watching',
    watched_episodes_count: 6,
    total_episodes_count: 10,
  },
  {
    anime: { title: 'Frieren: Beyond Journey\'s End', year: 2023, ids: { simkl: 3001, mal: 52991 } },
    status: 'watching',
    watched_episodes_count: 18,
    total_episodes_count: 28,
  },
]
