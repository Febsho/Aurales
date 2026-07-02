import { useWatchedCacheStore, makeWatchedKey, type WatchedKey } from '../stores/watchedCacheStore'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { getWatchedMovies, getWatchedShows, type TraktWatchedItem } from './trakt/sync'
import { getSimklWatchedMovies, getSimklWatchedEpisodes } from './simkl/history'
import type { SimklWatchlistItem } from './simkl/types'
import { getPMDBWatched } from './pmdb'
import { getMdblistWatched } from './mdblist'
import type { WatchedSource } from './watchedStatus'

let refreshTimer: ReturnType<typeof setTimeout> | null = null

function extractTraktKeys(movies: TraktWatchedItem[], shows: TraktWatchedItem[]): WatchedKey[] {
  const keys: WatchedKey[] = []
  for (const m of movies) {
    const ids = m.movie?.ids
    if (!ids) continue
    if (ids.imdb) keys.push(makeWatchedKey('imdb', ids.imdb))
    if (ids.tmdb) keys.push(makeWatchedKey('tmdb', ids.tmdb))
  }
  for (const s of shows) {
    const ids = s.show?.ids
    if (!ids) continue
    if (ids.imdb) keys.push(makeWatchedKey('imdb', ids.imdb))
    if (ids.tmdb) keys.push(makeWatchedKey('tmdb', ids.tmdb))
  }
  return keys
}

function extractSimklKeys(items: { imdbId?: string; tmdbId?: number | string; tvdbId?: number | string; malId?: number | string }[]): WatchedKey[] {
  const keys: WatchedKey[] = []
  for (const item of items) {
    if (item.imdbId) keys.push(makeWatchedKey('imdb', item.imdbId))
    if (item.tmdbId) keys.push(makeWatchedKey('tmdb', item.tmdbId))
    if (item.tvdbId) keys.push(makeWatchedKey('tvdb', item.tvdbId))
    if (item.malId) keys.push(makeWatchedKey('mal', item.malId))
  }
  return keys
}

function extractPmdbKeys(items: { tmdb_id?: number }[]): WatchedKey[] {
  const keys: WatchedKey[] = []
  for (const item of items) {
    if (item.tmdb_id) keys.push(makeWatchedKey('tmdb', item.tmdb_id))
  }
  return keys
}

function extractMdblistKeys(items: { imdb_id?: string; tmdb_id?: number; tvdb_id?: number }[]): WatchedKey[] {
  const keys: WatchedKey[] = []
  for (const item of items) {
    if (item.imdb_id) keys.push(makeWatchedKey('imdb', item.imdb_id))
    if (item.tmdb_id) keys.push(makeWatchedKey('tmdb', item.tmdb_id))
    if (item.tvdb_id) keys.push(makeWatchedKey('tvdb', item.tvdb_id))
  }
  return keys
}

async function fetchProviderKeys(sources: WatchedSource[]): Promise<WatchedKey[]> {
  const allKeys: WatchedKey[] = []

  const tasks = sources
    .filter((s) => s !== 'local')
    .map(async (source) => {
      try {
        if (source === 'trakt') {
          const data = await cachedFetch('watched:trakt', async () => {
            const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
            return { movies, shows }
          }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
          return extractTraktKeys(data.movies, data.shows)
        }
        if (source === 'simkl') {
          const data = await cachedFetch<{ items: SimklWatchlistItem[] }>('watched:simkl', async () => {
            const [movies, episodes] = await Promise.all([getSimklWatchedMovies(), getSimklWatchedEpisodes()])
            return { items: [...movies, ...episodes] }
          }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
          return extractSimklKeys(data.items)
        }
        if (source === 'pmdb') {
          const data = await cachedFetch('watched:pmdb', async () => {
            return await getPMDBWatched()
          }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
          return extractPmdbKeys(data)
        }
        if (source === 'mdblist') {
          const data = await cachedFetch('watched:mdblist', async () => {
            return await getMdblistWatched()
          }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
          return extractMdblistKeys(data)
        }
      } catch (e) {
        console.warn(`[WatchedCache] failed to fetch ${source}:`, e)
      }
      return [] as WatchedKey[]
    })

  const results = await Promise.all(tasks)
  for (const keys of results) allKeys.push(...keys)
  return allKeys
}

export async function refreshWatchedCache(sources: WatchedSource[]): Promise<void> {
  const store = useWatchedCacheStore.getState()
  store.setLoading(true)
  try {
    const keys = await fetchProviderKeys(sources)
    store.setWatchedKeys(new Set(keys))
  } catch (e) {
    console.warn('[WatchedCache] refresh failed:', e)
  } finally {
    store.setLoading(false)
  }
}

export function startWatchedCacheSync(sources: WatchedSource[], intervalMs = 5 * 60 * 1000): void {
  stopWatchedCacheSync()
  refreshWatchedCache(sources)
  refreshTimer = setInterval(() => refreshWatchedCache(sources), intervalMs)
}

export function stopWatchedCacheSync(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
