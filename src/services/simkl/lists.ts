/**
 * Simkl list operations — watchlist, watching, completed, anime, custom lists.
 */

import { simklRequest, MOCK_WATCHLIST } from './client'
import { getSimklClientId, isSimklMockMode } from './auth'
import { resolveSimklId, type MediaRef } from './mappings'
import type { SimklWatchlistItem, SimklApiItem, SimklMediaType, SimklWatchStatus } from './types'
import type { SearchResult } from '../../types'

const LS_WATCHLIST_CACHE = 'simkl_watchlist_cache'
const LS_WATCHING_CACHE  = 'simkl_watching_cache'
const LS_COMPLETED_CACHE = 'simkl_completed_cache'

// ─── Fetch lists ───────────────────────────────────────────────────────────────

export async function getSimklWatchlist(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => i.status === 'plantowatch'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/plantowatch?extended=full')
    const items = toWatchlistItems(data ?? [])
    localStorage.setItem(LS_WATCHLIST_CACHE, JSON.stringify(items))
    return items
  } catch (_) {
    return getCached(LS_WATCHLIST_CACHE)
  }
}

export async function getSimklWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/watching?extended=full')
    const items = toWatchlistItems(data ?? [])
    localStorage.setItem(LS_WATCHING_CACHE, JSON.stringify(items))
    return items
  } catch (_) {
    return getCached(LS_WATCHING_CACHE)
  }
}

export async function getSimklCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/completed?extended=full')
    const items = toWatchlistItems(data ?? [])
    localStorage.setItem(LS_COMPLETED_CACHE, JSON.stringify(items))
    return items
  } catch (_) {
    return getCached(LS_COMPLETED_CACHE)
  }
}

export async function getSimklAnimeWatchlist(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.anime))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/anime/plantowatch?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklCustomLists(): Promise<{ id: string; name: string; items: SimklWatchlistItem[] }[]> {
  // Simkl doesn't have a custom-lists endpoint in the public API (v1).
  // TODO: implement when Simkl exposes this endpoint.
  return []
}

// ─── Per-type lists ────────────────────────────────────────────────────────────

export async function getSimklMoviesWatchlist(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.movie && i.status === 'plantowatch'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/plantowatch?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklShowsWatchlist(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.show && i.status === 'plantowatch'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/plantowatch?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklMoviesWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.movie && i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/watching?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklShowsWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.show && i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/watching?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklAnimeWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.anime && i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/anime/watching?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklMoviesCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.movie && i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/completed?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklShowsCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.show && i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/completed?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklAnimeCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.anime && i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/anime/completed?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklOnHold(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return []
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/hold?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklDropped(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return []
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/dropped?extended=full')
    return toWatchlistItems(data ?? [])
  } catch (_) { return [] }
}

export async function getSimklWatchStatusList(listId: string): Promise<SimklWatchlistItem[]> {
  switch (listId) {
    case 'watching':          return getSimklWatching()
    case 'plantowatch':
    case 'watchlist':         return getSimklWatchlist()
    case 'completed':         return getSimklCompleted()
    case 'hold':
    case 'on-hold':           return getSimklOnHold()
    case 'dropped':           return getSimklDropped()
    case 'movies-watchlist':  return getSimklTypedStatusList('movies', 'plantowatch')
    case 'movies-watching':   return getSimklTypedStatusList('movies', 'watching')
    case 'movies-completed':  return getSimklTypedStatusList('movies', 'completed')
    case 'movies-on-hold':    return getSimklTypedStatusList('movies', 'hold')
    case 'movies-dropped':    return getSimklTypedStatusList('movies', 'dropped')
    case 'shows-watchlist':   return getSimklTypedStatusList('shows', 'plantowatch')
    case 'shows-watching':    return getSimklTypedStatusList('shows', 'watching')
    case 'shows-completed':   return getSimklTypedStatusList('shows', 'completed')
    case 'shows-on-hold':     return getSimklTypedStatusList('shows', 'hold')
    case 'shows-dropped':     return getSimklTypedStatusList('shows', 'dropped')
    case 'anime-watchlist':   return getSimklTypedStatusList('anime', 'plantowatch')
    case 'anime-watching':    return getSimklTypedStatusList('anime', 'watching')
    case 'anime-completed':   return getSimklTypedStatusList('anime', 'completed')
    case 'anime-on-hold':     return getSimklTypedStatusList('anime', 'hold')
    case 'anime-dropped':     return getSimklTypedStatusList('anime', 'dropped')
    default:                  return getSimklWatchlist()
  }
}

const SIMKL_DERIVED_CATALOG_IDS = new Set([
  'trending-movies',
  'trending-shows',
  'trending-anime',
  'anime-airing-soon',
  'anime-airing-soon-earlier',
  'dvd-releases',
  'hidden-gems-movies',
  'hidden-gems-shows',
  'hidden-gems-anime',
  'binge-worthy-shows',
  'binge-worthy-anime',
  'quick-watches',
  'box-office-hits',
])

export function isSimklDerivedCatalogId(listId?: string): boolean {
  return !!listId && SIMKL_DERIVED_CATALOG_IDS.has(listId)
}

export async function getSimklDerivedCatalogItems(listId: string): Promise<SearchResult[]> {
  let items: SimklDataItem[] = []
  let type: SimklDataType = 'movies'

  switch (listId) {
    case 'trending-movies':
      type = 'movies'
      items = await fetchSimklDataFile('discover/trending/movies/today_100.json')
      break
    case 'trending-shows':
      type = 'tv'
      items = await fetchSimklDataFile('discover/trending/tv/today_100.json')
      break
    case 'trending-anime':
      type = 'anime'
      items = await fetchSimklDataFile('discover/trending/anime/today_100.json')
      break
    case 'anime-airing-soon':
      type = 'anime'
      items = (await fetchSimklDataFile('calendar/anime.json')).filter((item) => isFutureDate(item.date))
      break
    case 'anime-airing-soon-earlier':
      type = 'anime'
      items = (await fetchSimklDataFile('calendar/anime.json')).filter((item) => !isFutureDate(item.date))
      break
    case 'dvd-releases':
      type = 'movies'
      items = await fetchSimklDataFile('discover/dvd/releases_100.json')
      break
    case 'hidden-gems-movies':
      type = 'movies'
      items = hiddenGems(await fetchSimklDataFile('discover/trending/movies/today_500.json'))
      break
    case 'hidden-gems-shows':
      type = 'tv'
      items = hiddenGems(await fetchSimklDataFile('discover/trending/tv/today_500.json'))
      break
    case 'hidden-gems-anime':
      type = 'anime'
      items = hiddenGems(await fetchSimklDataFile('discover/trending/anime/today_500.json'), 'mal')
      break
    case 'binge-worthy-shows':
      type = 'tv'
      items = marathonWorthy(await fetchSimklDataFile('discover/trending/tv/today_500.json'))
      break
    case 'binge-worthy-anime':
      type = 'anime'
      items = marathonWorthy(await fetchSimklDataFile('discover/trending/anime/today_500.json'))
      break
    case 'quick-watches':
      type = 'movies'
      items = quickWatches(await fetchSimklDataFile('discover/trending/movies/today_500.json'))
      break
    case 'box-office-hits':
      type = 'movies'
      items = boxOfficeHits(await fetchSimklDataFile('discover/trending/movies/today_500.json'))
      break
    default:
      return []
  }

  return items.map((item) => simklDataItemToSearchResult(item, type))
}

async function getSimklTypedStatusList(mediaType: 'movies' | 'shows' | 'anime', status: SimklWatchStatus | 'hold'): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) {
    const expectedType = mediaType === 'movies' ? 'movie' : mediaType === 'shows' ? 'show' : 'anime'
    return toWatchlistItems(MOCK_WATCHLIST.filter((item: any) => {
      const rawType = item.movie ? 'movie' : item.show ? 'show' : 'anime'
      return rawType === expectedType && item.status === status
    }))
  }

  try {
    const data = await simklRequest<SimklApiItem[]>(`/sync/all-items/${mediaType}/${status}?extended=full`)
    return toWatchlistItems(data ?? [])
  } catch (_) {
    return []
  }
}

type SimklDataType = 'movies' | 'tv' | 'anime'

interface SimklDataItem {
  title?: string
  poster?: string | null
  fanart?: string | null
  url?: string
  ids?: {
    simkl?: number | string
    simkl_id?: number | string
    imdb?: string
    tmdb?: number | string | null
    tvdb?: number | string | null
    mal?: number | string | null
    anilist?: number | string | null
  }
  release_date?: string
  date?: string
  rank?: number
  ratings?: Record<string, { rating?: number; votes?: number } | undefined>
  runtime?: string
  status?: string
  genres?: string[]
  overview?: string
  metadata?: string
  total_episodes?: number
}

async function fetchSimklDataFile(path: string): Promise<SimklDataItem[]> {
  const clientId = getSimklClientId()
  const params = new URLSearchParams({
    client_id: clientId || 'aurales',
    'app-name': 'Aurales',
    'app-version': '0.1.0',
  })
  const res = await fetch(`https://data.simkl.in/${path}?${params.toString()}`, {
    headers: { 'User-Agent': 'Aurales/0.1.0' },
  })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

function simklDataItemToSearchResult(item: SimklDataItem, type: SimklDataType): SearchResult {
  const ids = item.ids || {}
  const tmdbId = toNumber(ids.tmdb)
  const tvdbId = toNumber(ids.tvdb)
  const malId = toNumber(ids.mal)
  const anilistId = toNumber(ids.anilist)
  const simklId = toNumber(ids.simkl_id ?? ids.simkl)

  return {
    id: ids.imdb || (tmdbId ? `tmdb-${tmdbId}` : tvdbId ? `tvdb-${tvdbId}` : simklId ? `simkl-${simklId}` : item.title || crypto.randomUUID()),
    title: item.title || 'Untitled',
    type: type === 'movies' ? 'movie' : 'series',
    year: parseYear(item.release_date || item.date),
    poster: simklImageUrl('posters', item.poster),
    backdrop: simklImageUrl('fanart', item.fanart),
    overview: item.overview,
    rating: item.ratings?.simkl?.rating ?? item.ratings?.imdb?.rating ?? item.ratings?.mal?.rating,
    genres: item.genres,
    provider: 'simkl',
    imdbId: ids.imdb,
    tmdbId,
    tvdbId,
    malId,
    anilistId,
    simklId,
  }
}

function hiddenGems(items: SimklDataItem[], ratingSource = 'simkl'): SimklDataItem[] {
  return [...items]
    .filter((item) => (item.rank || 0) > 2000 && rating(item, ratingSource) >= 7.5 && votes(item, ratingSource) >= 500)
    .sort((a, b) => rating(b, ratingSource) - rating(a, ratingSource))
}

function marathonWorthy(items: SimklDataItem[]): SimklDataItem[] {
  return [...items]
    .filter((item) => item.status === 'ended' && (item.total_episodes || 0) >= 20 && (item.total_episodes || 0) <= 100)
    .sort((a, b) => rating(b) - rating(a))
}

function quickWatches(items: SimklDataItem[]): SimklDataItem[] {
  return [...items]
    .filter((item) => runtimeMinutes(item.runtime) > 0 && runtimeMinutes(item.runtime) <= 90)
    .sort((a, b) => rating(b) - rating(a))
}

function boxOfficeHits(items: SimklDataItem[]): SimklDataItem[] {
  return [...items]
    .filter((item) => boxOfficeValue(item.metadata) > 0)
    .sort((a, b) => boxOfficeValue(b.metadata) - boxOfficeValue(a.metadata))
}

function rating(item: SimklDataItem, source = 'simkl'): number {
  return item.ratings?.[source]?.rating ?? item.ratings?.simkl?.rating ?? 0
}

function votes(item: SimklDataItem, source = 'simkl'): number {
  return item.ratings?.[source]?.votes ?? item.ratings?.simkl?.votes ?? 0
}

function runtimeMinutes(runtime?: string): number {
  if (!runtime) return 0
  const hours = Number(runtime.match(/(\d+)\s*h/)?.[1] || 0)
  const minutes = Number(runtime.match(/(\d+)\s*m/)?.[1] || 0)
  return hours * 60 + minutes
}

function boxOfficeValue(metadata?: string): number {
  const match = metadata?.match(/Box office \$([\d.]+)([MBK])/i)
  if (!match) return 0
  const value = Number(match[1] || 0)
  const unit = match[2]?.toUpperCase()
  if (unit === 'B') return value * 1_000_000_000
  if (unit === 'M') return value * 1_000_000
  if (unit === 'K') return value * 1_000
  return value
}

function isFutureDate(value?: string): boolean {
  if (!value) return false
  const time = new Date(value).getTime()
  return Number.isFinite(time) && time >= Date.now()
}

function parseYear(value?: string): number | undefined {
  const year = value?.match(/\d{4}/)?.[0]
  return year ? Number(year) : undefined
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function simklImageUrl(kind: 'posters' | 'fanart', path?: string | null): string | undefined {
  if (!path) return undefined
  if (path.startsWith('http')) return path
  const clean = path.startsWith('/') ? path.slice(1) : path
  const suffix = kind === 'posters' ? '_m.webp' : '_medium.jpg'
  return `https://wsrv.nl/?url=https://simkl.in/${kind}/${clean}${suffix}&q=90`
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

export async function addToSimklWatchlist(item: MediaRef, type?: SimklMediaType): Promise<void> {
  if (isSimklMockMode()) {
    mockWatchlistAdd(item.localId)
    return
  }

  const mapping = await resolveSimklId(item)
  if (!mapping?.simklId) {
    // Fallback: use external IDs directly
    await addToListByExternalIds(item, type ?? inferType(item.type), 'plantowatch')
    return
  }

  await addToListBySimklId(mapping.simklId, type ?? mapping.type, 'plantowatch')
}

export async function removeFromSimklWatchlist(item: MediaRef): Promise<void> {
  if (isSimklMockMode()) {
    mockWatchlistRemove(item.localId)
    return
  }

  const mapping = await resolveSimklId(item)
  if (!mapping?.simklId) return

  const mediaType = mapping.type === 'movie' ? 'movies' : mapping.type === 'show' ? 'shows' : 'anime'
  await simklRequest('/sync/add-to-list', {
    method: 'POST',
    body: JSON.stringify({
      [mediaType]: [{ ids: { simkl: mapping.simklId }, to: 'plantowatch', deleted: 1 }],
    }),
  })
}

export async function isInSimklWatchlist(item: MediaRef): Promise<boolean> {
  if (isSimklMockMode()) return isMockWatchlisted(item.localId)
  try {
    const mapping = await resolveSimklId(item)
    if (!mapping?.simklId) return false
    const data = await simklRequest<{ list?: string }>(`/sync/userlist?id=${mapping.simklId}`)
    return data?.list === 'plantowatch'
  } catch (_) { return false }
}

// ─── Private helpers ───────────────────────────────────────────────────────────

async function addToListBySimklId(simklId: number, type: SimklMediaType, status: SimklWatchStatus) {
  const key = type === 'movie' ? 'movies' : type === 'show' ? 'shows' : 'anime'
  await simklRequest('/sync/add-to-list', {
    method: 'POST',
    body: JSON.stringify({
      [key]: [{ ids: { simkl: simklId }, to: status }],
    }),
  })
}

async function addToListByExternalIds(item: MediaRef, type: SimklMediaType, status: SimklWatchStatus) {
  const key = type === 'movie' ? 'movies' : type === 'show' ? 'shows' : 'anime'
  const ids: Record<string, string | number> = {}
  if (item.imdbId) ids.imdb = item.imdbId
  if (item.tmdbId) ids.tmdb = item.tmdbId
  if (item.tvdbId) ids.tvdb = item.tvdbId
  await simklRequest('/sync/add-to-list', {
    method: 'POST',
    body: JSON.stringify({
      [key]: [{ title: item.title, year: item.year, ids, to: status }],
    }),
  })
}

function inferType(t?: string): SimklMediaType {
  if (t === 'show' || t === 'series') return 'show'
  if (t === 'anime') return 'anime'
  return 'movie'
}

function toWatchlistItems(raw: any): SimklWatchlistItem[] {
  if (!raw) return []
  let items: any[] = []
  if (Array.isArray(raw)) {
    items = raw
  } else if (typeof raw === 'object') {
    if (Array.isArray(raw.movies)) {
      items.push(...raw.movies.map((m: any) => ({ ...m, movie: m.movie || m })))
    }
    if (Array.isArray(raw.shows)) {
      items.push(...raw.shows.map((s: any) => ({ ...s, show: s.show || s })))
    }
    if (Array.isArray(raw.anime)) {
      items.push(...raw.anime.map((a: any) => ({ ...a, anime: a.anime || a })))
    }
    if (Array.isArray(raw.tv)) {
      items.push(...raw.tv.map((t: any) => ({ ...t, show: t.show || t })))
    }
  }

  return items.map((r) => {
    const type: SimklMediaType = r.movie ? 'movie' : r.show ? 'show' : 'anime'
    const media = r.movie || r.show || r.anime
    if (!media) return null
    const ids = media.ids
    if (!ids) return null

    let poster: string | undefined = undefined
    if (media.poster) {
      if (media.poster.startsWith('http')) {
        poster = media.poster
      } else {
        // Simkl poster is a relative path like "0823142_w.jpg"
        const cleaned = media.poster.startsWith('/') ? media.poster.slice(1) : media.poster
        poster = `https://simkl.in/posters/${cleaned}_ca.jpg`
      }
    }
    // Fallback: construct poster from IMDB id via a public poster service
    if (!poster && ids.imdb) {
      poster = `https://images.metahub.space/poster/small/${ids.imdb}/img`
    }

    let backdrop: string | undefined = undefined
    if (media.fanart) {
      if (media.fanart.startsWith('http')) {
        backdrop = media.fanart
      } else {
        const cleaned = media.fanart.startsWith('/') ? media.fanart.slice(1) : media.fanart
        backdrop = `https://simkl.in/fanart/${cleaned}_medium.jpg`
      }
    }

    return {
      id: String(ids.simkl || ids.simkl_id || ids.imdb || media.title),
      type,
      title: media.title,
      year: media.year,
      simklId: ids.simkl || ids.simkl_id,
      tmdbId: ids.tmdb,
      tvdbId: ids.tvdb,
      imdbId: ids.imdb,
      malId: ids.mal,
      poster,
      backdrop,
      status: (r.status || 'plantowatch') as SimklWatchStatus,
      addedAt: undefined,
      watchedAt: r.last_watched_at,
    } satisfies SimklWatchlistItem
  }).filter(Boolean) as SimklWatchlistItem[]
}

function getCached(key: string): SimklWatchlistItem[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as SimklWatchlistItem[]) : []
  } catch (_) { return [] }
}

// ─── Mock watchlist state ──────────────────────────────────────────────────────

const MOCK_LS = 'simkl_mock_watchlist'

function getMockSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(MOCK_LS) || '[]') as string[]) }
  catch { return new Set() }
}

function saveMockSet(s: Set<string>) {
  localStorage.setItem(MOCK_LS, JSON.stringify(Array.from(s)))
}

function mockWatchlistAdd(id: string) {
  const s = getMockSet(); s.add(id); saveMockSet(s)
}

function mockWatchlistRemove(id: string) {
  const s = getMockSet(); s.delete(id); saveMockSet(s)
}

function isMockWatchlisted(id: string): boolean {
  return getMockSet().has(id)
}
