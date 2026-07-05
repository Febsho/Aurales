import { useWatchedCacheStore, makeWatchedKey, type WatchedKey } from '../stores/watchedCacheStore'
import { cachedFetch, cacheSet } from './cache/sqliteCache'
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

export type SyncableWatchedSource = 'trakt' | 'simkl' | 'pmdb' | 'mdblist'

interface ProviderFetcher {
  key: string
  fetch: () => Promise<unknown>
  extract: (data: any) => WatchedKey[]
}

const PROVIDER_FETCHERS: Record<SyncableWatchedSource, ProviderFetcher> = {
  trakt: {
    key: 'watched:trakt',
    fetch: async () => {
      const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
      return { movies, shows }
    },
    extract: (data) => extractTraktKeys(data.movies, data.shows),
  },
  simkl: {
    key: 'watched:simkl',
    fetch: async () => {
      const [movies, episodes] = await Promise.all([getSimklWatchedMovies(), getSimklWatchedEpisodes()])
      return { items: [...movies, ...episodes] as SimklWatchlistItem[] }
    },
    extract: (data) => extractSimklKeys(data.items),
  },
  pmdb: {
    key: 'watched:pmdb',
    fetch: () => getPMDBWatched(),
    extract: (data) => extractPmdbKeys(data),
  },
  mdblist: {
    key: 'watched:mdblist',
    fetch: () => getMdblistWatched(),
    extract: (data) => extractMdblistKeys(data),
  },
}

/**
 * Bypass the cache TTL for a single provider: fetch fresh data and overwrite
 * its cache entry. Used by the per-provider background sync scheduler.
 */
export async function forceRefreshProviderWatched(source: SyncableWatchedSource): Promise<void> {
  const def = PROVIDER_FETCHERS[source]
  const fresh = await def.fetch()
  await cacheSet(def.key, fresh, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
}

async function fetchProviderKeys(sources: WatchedSource[]): Promise<WatchedKey[]> {
  const allKeys: WatchedKey[] = []

  const tasks = sources
    .filter((s): s is SyncableWatchedSource => s !== 'local' && s in PROVIDER_FETCHERS)
    .map(async (source) => {
      try {
        const def = PROVIDER_FETCHERS[source]
        const data = await cachedFetch(def.key, def.fetch, {
          category: CACHE_CATEGORIES.WATCHED_STATUS,
          ttlSeconds: CACHE_TTLS.WATCHED_STATUS,
        })
        return def.extract(data)
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

export async function invalidateWatchedStatusCache(sources?: WatchedSource[]): Promise<void> {
  const { cacheClearCategory } = await import('./cache/sqliteCache')
  const { CACHE_CATEGORIES } = await import('./cache/constants')
  await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)

  const { useAppStore } = await import('../stores/appStore')
  const activeSources = sources || (useAppStore.getState().watchedCheckmarkSources as WatchedSource[])
  await refreshWatchedCache(activeSources)
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
