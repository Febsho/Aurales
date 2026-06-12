/**
 * Simkl list operations — watchlist, watching, completed, anime, custom lists.
 */

import { simklRequest, MOCK_WATCHLIST } from './client'
import { isSimklMockMode } from './auth'
import { resolveSimklId, type MediaRef } from './mappings'
import type { SimklWatchlistItem, SimklApiItem, SimklMediaType, SimklWatchStatus } from './types'

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
  } catch {
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
  } catch {
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
  } catch {
    return getCached(LS_COMPLETED_CACHE)
  }
}

export async function getSimklAnimeWatchlist(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.anime))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/anime/plantowatch?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
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
  } catch { return [] }
}

export async function getSimklShowsWatchlist(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.show && i.status === 'plantowatch'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/plantowatch?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklMoviesWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.movie && i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/watching?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklShowsWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.show && i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/watching?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklAnimeWatching(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.anime && i.status === 'watching'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/anime/watching?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklMoviesCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.movie && i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/completed?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklShowsCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.show && i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/completed?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklAnimeCompleted(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return toWatchlistItems(MOCK_WATCHLIST.filter(i => !!i.anime && i.status === 'completed'))
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/anime/completed?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklOnHold(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return []
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/hold?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
}

export async function getSimklDropped(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) return []
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies,shows,anime/dropped?extended=full')
    return toWatchlistItems(data ?? [])
  } catch { return [] }
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
  } catch { return false }
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
  } catch { return [] }
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
