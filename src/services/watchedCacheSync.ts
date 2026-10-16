import { useWatchedCacheStore, makeWatchedKey, type WatchedKey } from '../stores/watchedCacheStore'
import { cachedFetch, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { getWatchedMovies, getWatchedShows, type TraktWatchedItem } from './trakt/sync'
import { getSimklWatchedMovies, getSimklWatchedEpisodes } from './simkl/history'
import { getSimklSyncedSnapshot } from './simkl/sync'
import type { SimklWatchlistItem } from './simkl/types'
import { getPMDBWatched } from './pmdb'
import { getMdblistWatched } from './mdblist'
import type { WatchedSource } from './watchedStatus'
import { getActiveProfileId, profileProviderCacheKey } from './profiles'

const providerSnapshots = new Map<string, WatchedKey[]>()

function snapshotKey(source: WatchedSource, profileId = getActiveProfileId()): string {
  return source === 'local'
    ? `${source}:profile:${profileId}`
    : profileProviderCacheKey(`watched-snapshot:${source}`, source, profileId)
}

function providerCacheKey(source: SyncableWatchedSource, profileId = getActiveProfileId()): string {
  const versionedKey = source === 'simkl' ? 'watched:simkl:v2' : `watched:${source}`
  return profileProviderCacheKey(versionedKey, source, profileId)
}

function rebuildFromSnapshots(sources: WatchedSource[]): void {
  const keys = new Set<WatchedKey>()
  for (const source of sources) {
    for (const key of providerSnapshots.get(snapshotKey(source)) || []) keys.add(key)
  }
  useWatchedCacheStore.getState().setWatchedKeys(keys)
}

function storeProviderSnapshot(source: WatchedSource, profileId: string, key: string, values: WatchedKey[]): void {
  // An older request may finish after the user switched profiles/accounts.
  // Never let that stale response evict the current account's snapshot.
  if (getActiveProfileId() !== profileId || snapshotKey(source, profileId) !== key) return
  if (source !== 'local') {
    const prefix = `watched-snapshot:${source}:profile:${profileId}:account:`
    for (const existing of providerSnapshots.keys()) {
      if (existing.startsWith(prefix) && existing !== key) providerSnapshots.delete(existing)
    }
  }
  providerSnapshots.set(key, values)
}

export function setWatchedProviderSnapshot(source: WatchedSource, keys: WatchedKey[], activeSources: WatchedSource[]): void {
  const profileId = getActiveProfileId()
  storeProviderSnapshot(source, profileId, snapshotKey(source, profileId), keys)
  rebuildFromSnapshots(activeSources)
}

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

function extractSimklKeys(items: { status?: string; type?: string; watchedEpisodes?: { episode?: number }[]; watchedEpisodesCount?: number; totalEpisodesCount?: number; imdbId?: string; tmdbId?: number | string; tvdbId?: number | string; malId?: number | string }[]): WatchedKey[] {
  const keys: WatchedKey[] = []
  for (const item of items) {
    const fullyWatched = item.status === 'completed'
      || ((item.type === 'show' || item.type === 'anime')
        && (item.totalEpisodesCount ?? 0) > 0
        && (item.watchedEpisodesCount ?? item.watchedEpisodes?.length ?? 0) >= (item.totalEpisodesCount ?? 0))
    if (!fullyWatched) continue
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
  fetch: () => Promise<unknown>
  extract: (data: any) => WatchedKey[]
}

const PROVIDER_FETCHERS: Record<SyncableWatchedSource, ProviderFetcher> = {
  trakt: {
    fetch: async () => {
      const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
      return { movies, shows }
    },
    extract: (data) => extractTraktKeys(data.movies, data.shows),
  },
  simkl: {
    fetch: async () => {
      // `syncSimkl` has already activity-gated and merged the v2 delta.
      // Reuse that snapshot instead of immediately doing two full pulls.
      const synced = await getSimklSyncedSnapshot()
      if (synced !== null) return { items: synced }
      const [movies, episodes] = await Promise.all([getSimklWatchedMovies(true), getSimklWatchedEpisodes(true)])
      return { items: [...movies, ...episodes] as SimklWatchlistItem[] }
    },
    extract: (data) => extractSimklKeys(data.items),
  },
  pmdb: {
    fetch: async () => ({ items: await getPMDBWatched() }),
    extract: (data) => extractPmdbKeys(data.items),
  },
  mdblist: {
    fetch: async () => ({ items: await getMdblistWatched() }),
    extract: (data) => extractMdblistKeys(data.items),
  },
}

const providerRefreshes = new Map<string, Promise<void>>()

/**
 * Bypass the cache TTL for a single provider: fetch fresh data and overwrite
 * its cache entry. Used by the per-provider background sync scheduler.
 */
export async function forceRefreshProviderWatched(source: SyncableWatchedSource): Promise<void> {
  const profileId = getActiveProfileId()
  // Capture the account scope before starting network work. Recomputing it
  // after await can label an old account's response with a newly connected
  // account's key when credentials change without changing the profile.
  const targetSnapshotKey = snapshotKey(source, profileId)
  const refreshKey = targetSnapshotKey
  const pending = providerRefreshes.get(refreshKey)
  if (pending) return pending
  const def = PROVIDER_FETCHERS[source]
  const cacheKey = providerCacheKey(source, profileId)
  const refresh = (async () => {
    const fresh = await def.fetch()
    void cacheSet(cacheKey, fresh, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
    storeProviderSnapshot(source, profileId, targetSnapshotKey, def.extract(fresh))
    const { useAppStore } = await import('../stores/appStore')
    if (getActiveProfileId() === profileId && snapshotKey(source, profileId) === targetSnapshotKey) {
      rebuildFromSnapshots(useAppStore.getState().watchedCheckmarkSources as WatchedSource[])
    }
  })().finally(() => providerRefreshes.delete(refreshKey))
  providerRefreshes.set(refreshKey, refresh)
  return refresh
}

async function fetchProviderKeys(sources: WatchedSource[]): Promise<WatchedKey[]> {
  const allKeys: WatchedKey[] = []
  const profileId = getActiveProfileId()

  const tasks = sources
    .filter((s): s is SyncableWatchedSource => s !== 'local' && s in PROVIDER_FETCHERS)
    .map(async (source) => {
      try {
        const targetSnapshotKey = snapshotKey(source, profileId)
        const def = PROVIDER_FETCHERS[source]
        const data = await cachedFetch(providerCacheKey(source, profileId), def.fetch, {
          category: CACHE_CATEGORIES.WATCHED_STATUS,
          ttlSeconds: CACHE_TTLS.WATCHED_STATUS,
        })
        const keys = def.extract(data)
        storeProviderSnapshot(source, profileId, targetSnapshotKey, keys)
        return keys
      } catch (e) {
        console.warn(`[WatchedCache] failed to fetch ${source}:`, e)
      }
      return [] as WatchedKey[]
    })

  // AniList resolves ids itself (async), so it can't use the sync extract() shape.
  if (sources.includes('anilist')) {
    tasks.push((async () => {
      try {
        const targetSnapshotKey = snapshotKey('anilist', profileId)
        const { getAniListWatchedTitleKeys } = await import('./anilist')
        const keys = await getAniListWatchedTitleKeys()
        storeProviderSnapshot('anilist', profileId, targetSnapshotKey, keys)
        return keys
      } catch (e) {
        console.warn('[WatchedCache] failed to fetch anilist:', e)
        return [] as WatchedKey[]
      }
    })())
  }

  const results = await Promise.all(tasks)
  for (const keys of results) allKeys.push(...keys)
  return allKeys
}

export async function refreshWatchedCache(sources: WatchedSource[]): Promise<void> {
  const profileId = getActiveProfileId()
  const store = useWatchedCacheStore.getState()
  store.setLoading(true)
  // Drop snapshots for providers/accounts that are no longer active before
  // waiting on the next network response. In particular, a newly logged-in
  // account must not keep showing the previous account's watched checkmarks
  // while its first snapshot is loading.
  rebuildFromSnapshots(sources)
  try {
    await fetchProviderKeys(sources)
    if (getActiveProfileId() === profileId) rebuildFromSnapshots(sources)
  } catch (e) {
    console.warn('[WatchedCache] refresh failed:', e)
  } finally {
    if (getActiveProfileId() === profileId) useWatchedCacheStore.getState().setLoading(false)
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
  void intervalMs
  // Compatibility entry point: hydrate once. Periodic refresh belongs solely
  // to providerSync and follows each provider's configured frequency.
  void refreshWatchedCache(sources)
}

export function stopWatchedCacheSync(): void {
  // No independent watched-status polling timer remains.
}
