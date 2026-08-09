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
    } catch (_) {
      return 'Unknown API error'
    }
  }
  return 'Unknown API error'
}

async function parseStremioResponse(res: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {}
  try {
    data = await res.json()
  } catch (_) {
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

export interface StremioLibraryEntry {
  id: string
  imdbId?: string
  type: 'movie' | 'series'
  title: string
  poster?: string
  year?: number
  watched: boolean
  lastWatched?: string
  season?: number
  episode?: number
  watchedCount: number
  /** Whether this title is explicitly saved in the Stremio Library. */
  inLibrary: boolean
  /** Stremio's own Continue Watching predicate. */
  continueWatching: boolean
  progressSeconds: number
  durationSeconds: number
  /** Watched episode ids decoded from Stremio's compressed watched bitfield. */
  watchedEpisodeIds?: string[]
  watchedField?: string
}

interface StremioDatastoreItem {
  _id?: string
  name?: string
  type?: string
  poster?: string
  year?: number | string
  removed?: boolean
  temp?: boolean
  state?: {
    timeOffset?: number
    duration?: number
    flaggedWatched?: number
    timesWatched?: number
    lastWatched?: string
    video_id?: string
    season?: number
    episode?: number
    watched?: string
  }
}

interface StremioMetaVideo {
  id: string
  season?: number
  episode?: number
  released?: string
}

function parseEpisodeId(id?: string): { season?: number; episode?: number } {
  if (!id) return {}
  const parts = id.split(':')
  if (parts.length < 3) return {}
  const season = Number(parts.at(-2))
  const episode = Number(parts.at(-1))
  return {
    season: Number.isFinite(season) ? season : undefined,
    episode: Number.isFinite(episode) ? episode : undefined,
  }
}

function unpackDatastoreItem(value: unknown): StremioDatastoreItem | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const item = (record.d && typeof record.d === 'object' ? record.d : record) as StremioDatastoreItem
  return item._id ? item : null
}

/** Decode the format used by stremio-watched-bitfield. Falls back to its anchor episode. */
async function decodeWatchedEpisodes(entry: StremioLibraryEntry): Promise<string[]> {
  const serialized = entry.watchedField
  if (!serialized || entry.type !== 'series' || !entry.imdbId) return []
  const components = serialized.split(':')
  if (components.length < 3) return []
  const encoded = components.pop() || ''
  const anchorLength = Number(components.pop())
  const anchorId = components.join(':')
  const fallback = parseEpisodeId(anchorId).season != null ? [anchorId] : []

  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(entry.imdbId)}.json`)
    if (!response.ok) return fallback
    const payload = await response.json() as { meta?: { videos?: StremioMetaVideo[] } }
    const videos = (payload.meta?.videos || [])
      .filter((video) => video?.id)
      .sort((left, right) => (left.season ?? -1) - (right.season ?? -1)
        || (left.episode ?? -1) - (right.episode ?? -1)
        || String(left.released || '').localeCompare(String(right.released || '')))
    const anchorIndex = videos.findIndex((video) => video.id === anchorId)
    if (anchorIndex < 0 || !Number.isFinite(anchorLength) || typeof DecompressionStream === 'undefined') return fallback

    const compressed = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    const inflated = new Uint8Array(await new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')),
    ).arrayBuffer())
    const offset = anchorLength - anchorIndex - 1
    return videos.flatMap((video, index) => {
      const previousIndex = index + offset
      if (previousIndex < 0) return []
      const byte = inflated[Math.floor(previousIndex / 8)]
      return byte != null && ((byte >> (previousIndex % 8)) & 1) === 1 ? [video.id] : []
    })
  } catch {
    return fallback
  }
}

/**
 * Fetch the user's Stremio library from their cloud datastore. Library items carry
 * playback state, so we can surface genuinely-watched titles for Discover seeding.
 */
export async function getStremioLibrary(authKey: string, resolveEpisodeHistory = false): Promise<StremioLibraryEntry[]> {
  const res = await fetch(`${STREMIO_API}/datastoreGet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'DatastoreGet', authKey, collection: 'libraryItem', all: true }),
  })
  const data = await parseStremioResponse(res, 'Failed to fetch Stremio library')
  const items = ((data.result as unknown[] | undefined) || []).map(unpackDatastoreItem).filter((item): item is StremioDatastoreItem => item !== null)

  const entries = items
    .map((item): StremioLibraryEntry | null => {
      const rawId = item._id
      if (!rawId || !item.name || (item.type !== 'movie' && item.type !== 'series')) return null
      const baseId = rawId.split(':')[0]
      const imdbId = /^tt\d+$/.test(baseId) ? baseId : undefined
      const state = item.state || {}
      const videoEpisode = parseEpisodeId(state.video_id || rawId)
      const season = videoEpisode.season ?? (Number.isFinite(Number(state.season)) ? Number(state.season) : undefined)
      const episode = videoEpisode.episode ?? (Number.isFinite(Number(state.episode)) ? Number(state.episode) : undefined)
      const watchedCount = Math.max(0, Number(state.timesWatched) || 0)
      const timeOffsetMs = Math.max(0, Number(state.timeOffset) || 0)
      const durationMs = Math.max(0, Number(state.duration) || 0)
      return {
        id: baseId,
        imdbId,
        type: item.type === 'movie' ? 'movie' : 'series',
        title: item.name,
        poster: item.poster,
        year: Number.isFinite(Number(item.year)) ? Number(item.year) : undefined,
        watched: watchedCount > 0,
        lastWatched: state.lastWatched,
        season,
        episode,
        watchedCount,
        inLibrary: !item.removed && !item.temp,
        continueWatching: (!item.removed || Boolean(item.temp)) && timeOffsetMs > 0,
        progressSeconds: timeOffsetMs / 1000,
        durationSeconds: durationMs / 1000,
        watchedField: state.watched,
      }
    })
    .filter((entry): entry is StremioLibraryEntry => entry !== null)

  if (resolveEpisodeHistory) {
    await Promise.all(entries.map(async (entry) => {
      if (entry.type === 'series' && entry.watched) entry.watchedEpisodeIds = await decodeWatchedEpisodes(entry)
    }))
  }
  return entries
}

export async function getStremioWatchHistory(authKey: string): Promise<StremioLibraryEntry[]> {
  return (await getStremioLibrary(authKey)).filter((entry) => entry.watched)
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
