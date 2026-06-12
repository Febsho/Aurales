import type { SearchResult, WatchProgress } from '../types'
import { getWatchedMovies, getWatchedShows, type TraktWatchedItem } from './trakt/sync'
import { getSimklWatchedEpisodes, getSimklWatchedMovies } from './simkl/history'
import type { SimklWatchlistItem } from './simkl/types'
import { getPMDBWatched, type PMDBWatchedItem } from './pmdb'
import { getAniListWatched } from './anilist'

export type WatchedSource = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist'

export interface WatchedLookupItem {
  id: string
  type: 'movie' | 'series'
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  season?: number
  episode?: number
}

interface WatchedCache {
  trakt?: { at: number; movies: TraktWatchedItem[]; shows: TraktWatchedItem[] }
  simkl?: { at: number; items: SimklWatchlistItem[] }
  pmdb?: { at: number; items: PMDBWatchedItem[] }
  anilist?: { at: number; items: any[] }
}

const CACHE_TTL = 5 * 60 * 1000
const cache: WatchedCache = {}

export function searchResultToLookup(item: SearchResult): WatchedLookupItem {
  return {
    id: item.id,
    type: item.type,
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
    anilistId: item.anilistId,
    season: item.season,
    episode: item.episode,
  }
}

export function getLocalWatchedStatus(item: WatchedLookupItem, watchProgress: Map<string, WatchProgress>): boolean {
  const ids = normalizedIds(item)
  for (const id of ids) {
    const direct = watchProgress.get(id)
    if (direct?.completed) return true
  }

  if (item.type === 'series' && item.season != null && item.episode != null) {
    for (const id of ids) {
      const ep = watchProgress.get(`${id}:${item.season}:${item.episode}`)
      if (ep?.completed) return true
    }
  }

  for (const [, progress] of watchProgress.entries()) {
    if (!progress.completed) continue
    if (!ids.includes(progress.mediaId) && !ids.includes(String(progress.tmdbId || '')) && !ids.includes(String(progress.imdbId || ''))) continue
    if (item.type === 'movie') return true
    if (item.season == null || item.episode == null) return true
    if (progress.season === item.season && progress.episode === item.episode) return true
  }
  return false
}

export async function isWatchedFromProviders(
  item: WatchedLookupItem,
  sources: WatchedSource[],
  watchProgress: Map<string, WatchProgress>,
): Promise<boolean> {
  if (sources.includes('local') && getLocalWatchedStatus(item, watchProgress)) return true
  const checks = await Promise.all(
    sources
      .filter((source) => source !== 'local')
      .map(async (source) => {
        if (source === 'trakt') return isTraktWatched(item)
        if (source === 'simkl') return isSimklWatched(item)
        if (source === 'pmdb') return isPmdbWatched(item)
        if (source === 'anilist') return isAniListWatched(item)
        return false
      })
  )
  return checks.some(Boolean)
}

async function isAniListWatched(item: WatchedLookupItem): Promise<boolean> {
  if (item.type !== 'series') return false
  try {
    const data = await getAniListCache()
    return data.items.some((entry) => {
      const media = entry.media
      if (!media) return false
      return sameNumber(item.anilistId, media.id) || sameNumber(item.malId, media.idMal)
    })
  } catch {
    return false
  }
}

async function isTraktWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getTraktCache()
    if (item.type === 'movie') {
      return data.movies.some((entry) => matchesIds(item, entry.movie?.ids))
    }
    return data.shows.some((entry) => {
      if (!matchesIds(item, entry.show?.ids)) return false
      if (item.season == null || item.episode == null) return true
      return entry.seasons?.some((season) =>
        season.number === item.season && season.episodes.some((episode) => episode.number === item.episode && episode.plays > 0)
      ) ?? false
    })
  } catch {
    return false
  }
}

async function isSimklWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getSimklCache()
    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.type !== 'movie') return false
      if (item.type === 'series' && entry.type === 'movie') return false
      if (!matchesFlatIds(item, entry)) return false
      if (item.type === 'movie') return true
      if (item.season == null || item.episode == null) return true
      if (!entry.watchedEpisodes || entry.watchedEpisodes.length === 0) return true
      return entry.watchedEpisodes.some((episode) => episode.season === item.season && episode.episode === item.episode)
    })
  } catch {
    return false
  }
}

async function isPmdbWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getPmdbCache()
    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.media_type !== 'movie') return false
      if (item.type === 'series' && entry.media_type !== 'tv') return false
      if (!sameNumber(item.tmdbId, entry.tmdb_id)) return false
      if (item.type === 'movie') return true
      if (item.season == null || item.episode == null) return true
      return entry.season === item.season && entry.episode === item.episode
    })
  } catch {
    return false
  }
}

async function getTraktCache() {
  const now = Date.now()
  if (cache.trakt && now - cache.trakt.at < CACHE_TTL) return cache.trakt
  const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
  cache.trakt = { at: now, movies, shows }
  return cache.trakt
}

async function getSimklCache() {
  const now = Date.now()
  if (cache.simkl && now - cache.simkl.at < CACHE_TTL) return cache.simkl
  const [movies, episodes] = await Promise.all([getSimklWatchedMovies(), getSimklWatchedEpisodes()])
  cache.simkl = { at: now, items: [...movies, ...episodes] }
  return cache.simkl
}

async function getPmdbCache() {
  const now = Date.now()
  if (cache.pmdb && now - cache.pmdb.at < CACHE_TTL) return cache.pmdb
  const items = await getPMDBWatched()
  cache.pmdb = { at: now, items }
  return cache.pmdb
}

async function getAniListCache() {
  const now = Date.now()
  if (cache.anilist && now - cache.anilist.at < CACHE_TTL) return cache.anilist
  const items = await getAniListWatched()
  cache.anilist = { at: now, items }
  return cache.anilist
}

function normalizedIds(item: WatchedLookupItem): string[] {
  return [item.id, item.imdbId, item.tmdbId ? `tmdb-${item.tmdbId}` : undefined, item.tmdbId, item.tvdbId ? `tvdb-${item.tvdbId}` : undefined, item.tvdbId, item.malId ? `mal-${item.malId}` : undefined, item.anilistId ? `anilist-${item.anilistId}` : undefined]
    .filter((id): id is string | number => id != null && id !== '')
    .map(String)
}

function matchesIds(item: WatchedLookupItem, ids?: Record<string, unknown>): boolean {
  if (!ids) return false
  return (
    sameString(item.imdbId, ids.imdb) ||
    sameNumber(item.tmdbId, ids.tmdb) ||
    sameNumber(item.tvdbId, ids.tvdb)
  )
}

function matchesFlatIds(item: WatchedLookupItem, ids: { imdbId?: unknown; tmdbId?: unknown; tvdbId?: unknown }): boolean {
  return (
    sameString(item.imdbId, ids.imdbId) ||
    sameNumber(item.tmdbId, ids.tmdbId) ||
    sameNumber(item.tvdbId, ids.tvdbId)
  )
}

function sameString(a: unknown, b: unknown): boolean {
  return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase())
}

function sameNumber(a: unknown, b: unknown): boolean {
  const left = Number(a)
  const right = Number(b)
  return Number.isFinite(left) && Number.isFinite(right) && left === right
}
