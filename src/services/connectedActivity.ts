import { getWatchedMovies, getWatchedShows } from './trakt/sync'
import { getSimklWatchedEpisodes, getSimklWatchedMovies } from './simkl/history'
import { getAniListFullList } from './anilist'
import { getMdblistWatched } from './mdblist'
import { getPMDBWatched } from './pmdb'
import { resolveAnimeIds } from './animeLists'
import { tmdbProvider, getTmdbRuntimeMetadata } from './tmdb'
import { resolveArtFromProviders } from './artwork'
import { getStremioAuth, getStremioWatchHistory } from './stremio'
import { cacheGet, cacheGetMany, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { getActiveProfileId, profileProviderCacheKey } from './profiles'

export type ConnectedHistorySource = 'trakt' | 'simkl' | 'anilist' | 'pmdb' | 'mdblist' | 'stremio'
export type ConnectedHistoryMediaType = 'movie' | 'series' | 'anime'

export interface ConnectedHistoryItem {
  id: string
  title: string
  year?: number
  mediaType: ConnectedHistoryMediaType
  poster?: string
  watchedAt?: string
  watchedCount: number
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  anilistId?: number
  malId?: number
  watchedEpisodes?: { season: number; episode: number }[]
  runtimeMinutes?: number
  genres?: string[]
  watchedDates?: string[]
  sources: ConnectedHistorySource[]
}

export interface ConnectedHistoryResult {
  items: ConnectedHistoryItem[]
  errors: Partial<Record<ConnectedHistorySource, string>>
  sourceCounts: Partial<Record<ConnectedHistorySource, number>>
}

const memoryCache = new Map<string, { timestamp: number; result: ConnectedHistoryResult }>()
const enrichedItemCache = new Map<string, Pick<ConnectedHistoryItem, 'title' | 'year' | 'poster' | 'genres'>>()
const MAX_HISTORY_SNAPSHOTS = 24
const MAX_ENRICHED_HISTORY_ITEMS = 1_500
const RUNTIME_CACHE_KEY = 'aurales_connected_runtime_v2'
const HISTORY_CACHE_VERSION = 1

function getRecent<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

const latest = (...values: (string | undefined)[]): string | undefined => values
  .filter((value): value is string => Boolean(value))
  .reduce<string | undefined>((best, candidate) => {
    if (!best) return candidate
    const candidateTime = timestamp(candidate)
    const bestTime = timestamp(best)
    if (Number.isFinite(candidateTime) && (!Number.isFinite(bestTime) || candidateTime > bestTime)) return candidate
    if (!Number.isFinite(candidateTime) && !Number.isFinite(bestTime) && candidate.localeCompare(best) > 0) return candidate
    return best
  }, undefined)
// Keep titles in every writing system when building fallback identities.
// Stripping everything outside ASCII made Japanese, Chinese, and Korean
// titles normalize to the same empty string, which could produce colliding
// display IDs and prevent title-based deduplication from working correctly.
const normalizedTitle = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

function baseId(item: ConnectedHistoryItem) {
  return item.tmdbId ? `tmdb:${item.tmdbId}` : item.imdbId ? `imdb:${item.imdbId}` : item.tvdbId ? `tvdb:${item.tvdbId}` : item.anilistId ? `anilist:${item.anilistId}` : `${item.mediaType}:${normalizedTitle(item.title)}:${item.year || ''}`
}

function identifierSet(item: ConnectedHistoryItem) {
  const identifiers = new Set<string>()
  if (item.tmdbId) identifiers.add(`tmdb:${item.tmdbId}`)
  if (item.tvdbId) identifiers.add(`tvdb:${item.tvdbId}`)
  if (item.imdbId) identifiers.add(`imdb:${item.imdbId}`)
  if (item.anilistId) identifiers.add(`anilist:${item.anilistId}`)
  if (item.malId) identifiers.add(`mal:${item.malId}`)
  const title = normalizedTitle(item.title)
  if (title) identifiers.add(`title:${title}:${item.year || ''}`)
  return identifiers
}

function aggregateSourceItems(items: ConnectedHistoryItem[]) {
  const groups = new Map<string, ConnectedHistoryItem>()
  for (const item of items) {
    const key = baseId(item)
    const existing = groups.get(key)
    if (!existing) { groups.set(key, { ...item, sources: [...item.sources] }); continue }
    groups.set(key, {
      ...existing,
      title: existing.title || item.title,
      year: existing.year || item.year,
      poster: existing.poster || item.poster,
      watchedAt: latest(existing.watchedAt, item.watchedAt),
      watchedCount: existing.watchedCount + item.watchedCount,
      tmdbId: existing.tmdbId || item.tmdbId,
      tvdbId: existing.tvdbId || item.tvdbId,
      imdbId: existing.imdbId || item.imdbId,
      anilistId: existing.anilistId || item.anilistId,
      malId: existing.malId || item.malId,
      watchedEpisodes: mergeEpisodes(existing.watchedEpisodes, item.watchedEpisodes),
      watchedDates: mergeDates(existing.watchedDates, item.watchedDates, existing.watchedAt, item.watchedAt),
    })
  }
  return [...groups.values()]
}

function mergeEpisodes(...groups: ({ season: number; episode: number }[] | undefined)[]) {
  const episodes = groups.flatMap((group) => group || [])
  return [...new Map(episodes.map((episode) => [`${episode.season}:${episode.episode}`, episode])).values()]
}

function mergeDates(...groups: (string[] | string | undefined)[]) {
  return [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : group ? [group] : []).filter(Boolean))]
    .sort((left, right) => {
      const leftTime = timestamp(left)
      const rightTime = timestamp(right)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
      if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1
      return left.localeCompare(right)
    })
}

export function dedupeConnectedHistory(items: ConnectedHistoryItem[]) {
  const merged: ConnectedHistoryItem[] = []
  const parent: number[] = []
  const firstIndexByIdentity = new Map<string, number>()
  const findRoot = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== index) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const combine = (existing: ConnectedHistoryItem, item: ConnectedHistoryItem): ConnectedHistoryItem => ({
    ...existing,
    title: existing.title || item.title,
    year: existing.year || item.year,
    mediaType: existing.mediaType === 'anime' || item.mediaType === 'anime' ? 'anime' : existing.mediaType,
    poster: existing.poster || item.poster,
    watchedAt: latest(existing.watchedAt, item.watchedAt),
    watchedCount: Math.max(existing.watchedCount, item.watchedCount),
    tmdbId: existing.tmdbId || item.tmdbId,
    tvdbId: existing.tvdbId || item.tvdbId,
    imdbId: existing.imdbId || item.imdbId,
    anilistId: existing.anilistId || item.anilistId,
    malId: existing.malId || item.malId,
    watchedEpisodes: mergeEpisodes(existing.watchedEpisodes, item.watchedEpisodes),
    watchedDates: mergeDates(existing.watchedDates, item.watchedDates, existing.watchedAt, item.watchedAt),
    genres: existing.genres?.length ? existing.genres : item.genres,
    sources: [...new Set([...existing.sources, ...item.sources])],
  })
  for (const item of items) {
    const ids = identifierSet(item)
    const kind = item.mediaType === 'movie' ? 'movie' : 'series'
    const matches = new Set<number>()
    for (const id of ids) {
      const candidate = firstIndexByIdentity.get(`${kind}:${id}`)
      if (candidate != null) matches.add(findRoot(candidate))
    }
    if (!matches.size) {
      const index = merged.length
      merged.push({ ...item, id: baseId(item), sources: [...new Set(item.sources)] })
      parent.push(index)
      for (const id of ids) firstIndexByIdentity.set(`${kind}:${id}`, index)
      continue
    }
    const index = Math.min(...matches)
    for (const other of matches) {
      if (other === index) continue
      merged[index] = combine(merged[index], merged[other])
      parent[other] = index
    }
    merged[index] = combine(merged[index], item)
    // Older aliases can still point at a merged child; findRoot resolves them
    // on lookup, so copying every accumulated identifier here would turn a
    // long alias chain into quadratic work.
    for (const id of ids) firstIndexByIdentity.set(`${kind}:${id}`, index)
    merged[index].id = baseId(merged[index])
  }
  return merged.filter((_, index) => findRoot(index) === index)
}

async function loadTrakt(): Promise<ConnectedHistoryItem[]> {
  const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
  return [
    ...movies.flatMap((entry) => entry.movie ? [{ id: '', title: entry.movie.title, year: entry.movie.year, mediaType: 'movie' as const, watchedAt: entry.lastWatchedAt, watchedDates: mergeDates(entry.lastWatchedAt), watchedCount: Math.max(1, entry.plays), tmdbId: entry.movie.ids.tmdb, imdbId: entry.movie.ids.imdb, sources: ['trakt' as const] }] : []),
    ...shows.flatMap((entry) => entry.show ? [{ id: '', title: entry.show.title, year: entry.show.year, mediaType: 'series' as const, watchedAt: latest(entry.lastWatchedAt, ...(entry.seasons || []).flatMap((season) => season.episodes.map((episode) => episode.lastWatchedAt))), watchedDates: mergeDates(entry.lastWatchedAt, (entry.seasons || []).flatMap((season) => season.episodes.map((episode) => episode.lastWatchedAt))), watchedCount: (entry.seasons || []).reduce((count, season) => count + season.episodes.filter((episode) => episode.plays > 0).length, 0) || Math.max(1, entry.plays), watchedEpisodes: (entry.seasons || []).flatMap((season) => season.episodes.filter((episode) => episode.plays > 0).map((episode) => ({ season: season.number, episode: episode.number }))), tmdbId: entry.show.ids.tmdb, imdbId: entry.show.ids.imdb, sources: ['trakt' as const] }] : []),
  ]
}

async function loadSimkl(): Promise<ConnectedHistoryItem[]> {
  const [movies, shows] = await Promise.all([getSimklWatchedMovies(), getSimklWatchedEpisodes()])
  return [...movies, ...shows].map((entry) => ({
    id: '', title: entry.title, year: entry.year, mediaType: entry.type === 'movie' ? 'movie' as const : entry.type === 'anime' ? 'anime' as const : 'series' as const,
    poster: entry.poster, watchedAt: latest(entry.watchedAt, ...(entry.watchedEpisodes || []).map((episode) => episode.watchedAt)), watchedDates: mergeDates(entry.watchedAt, (entry.watchedEpisodes || []).map((episode) => episode.watchedAt).filter((date): date is string => Boolean(date))), watchedCount: entry.type === 'movie' ? 1 : Math.max(1, entry.watchedEpisodes?.length || 0),
    watchedEpisodes: entry.watchedEpisodes?.map((episode) => ({ season: episode.season, episode: episode.episode })), tmdbId: entry.tmdbId, tvdbId: entry.tvdbId, imdbId: entry.imdbId, malId: entry.malId, sources: ['simkl' as const],
  }))
}

async function loadAniList(): Promise<ConnectedHistoryItem[]> {
  const entries = (await getAniListFullList()).filter((entry) => entry.progress > 0 || entry.status === 'COMPLETED' || entry.repeat > 0)
  // A large AniList account can contain hundreds of watched entries. Resolve
  // external IDs with bounded concurrency instead of opening one request per
  // title at once (which can overwhelm the mapping service and delay the page).
  return mapLimit(entries, 6, async (entry) => {
    const mapped = await resolveAnimeIds({ anilistId: entry.mediaId, malId: entry.idMal }).catch(() => null)
    return {
      id: '', title: entry.title, year: entry.seasonYear, mediaType: 'anime' as const, poster: entry.poster,
      watchedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : undefined,
      watchedDates: entry.updatedAt ? [new Date(entry.updatedAt * 1000).toISOString()] : [],
      watchedCount: Math.max(entry.progress, entry.status === 'COMPLETED' ? entry.episodes || 1 : 0) + entry.repeat * (entry.episodes || 1),
      tmdbId: mapped?.tmdbId, tvdbId: mapped?.tvdbId, imdbId: mapped?.imdbId, anilistId: entry.mediaId, malId: entry.idMal, sources: ['anilist' as const],
    }
  })
}

async function loadPmdb(): Promise<ConnectedHistoryItem[]> {
  return aggregateSourceItems((await getPMDBWatched()).map((entry) => ({ id: '', title: '', mediaType: entry.media_type === 'movie' ? 'movie' as const : 'series' as const, watchedAt: entry.watched_at, watchedDates: mergeDates(entry.watched_at), watchedCount: 1, watchedEpisodes: entry.season != null && entry.episode != null ? [{ season: entry.season, episode: entry.episode }] : undefined, tmdbId: entry.tmdb_id, sources: ['pmdb' as const] })))
}

async function loadMdblist(): Promise<ConnectedHistoryItem[]> {
  return aggregateSourceItems((await getMdblistWatched()).map((entry) => ({ id: '', title: entry.title || '', year: entry.year, mediaType: entry.media_type === 'movie' ? 'movie' as const : 'series' as const, watchedAt: entry.watched_at, watchedDates: mergeDates(entry.watched_at), watchedCount: 1, watchedEpisodes: entry.season != null && entry.episode != null ? [{ season: entry.season, episode: entry.episode }] : undefined, tmdbId: entry.tmdb_id, tvdbId: entry.tvdb_id, imdbId: entry.imdb_id, sources: ['mdblist' as const] })))
}

async function loadStremio(): Promise<ConnectedHistoryItem[]> {
  const auth = getStremioAuth()
  if (!auth) return []
  return aggregateSourceItems((await getStremioWatchHistory(auth.authKey)).map((entry) => ({
    id: '', title: entry.title, year: entry.year, mediaType: entry.type === 'movie' ? 'movie' as const : 'series' as const,
    poster: entry.poster, watchedAt: entry.lastWatched, watchedDates: mergeDates(entry.lastWatched), watchedCount: entry.watchedCount,
    watchedEpisodes: entry.season != null && entry.episode != null ? [{ season: entry.season, episode: entry.episode }] : undefined,
    imdbId: entry.imdbId, sources: ['stremio' as const],
  })))
}

const loaders: Record<ConnectedHistorySource, () => Promise<ConnectedHistoryItem[]>> = { trakt: loadTrakt, simkl: loadSimkl, anilist: loadAniList, pmdb: loadPmdb, mdblist: loadMdblist, stremio: loadStremio }

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length)
  let index = 0
  const worker = async () => { while (index < items.length) { const current = index++; results[current] = await mapper(items[current]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

interface RuntimeMetadata { minutes?: number; genres: string[] }

function normalizeRuntimeMetadata(value: unknown): RuntimeMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as { minutes?: unknown; genres?: unknown }
  const minutes = typeof entry.minutes === 'number' && Number.isFinite(entry.minutes) && entry.minutes > 0
    ? entry.minutes
    : undefined
  const genres = Array.isArray(entry.genres)
    ? entry.genres.filter((genre): genre is string => typeof genre === 'string')
    : []
  if (minutes == null && genres.length === 0) return undefined
  return { minutes, genres }
}

function readRuntimeCache() {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RUNTIME_CACHE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed)
      .map(([key, value]) => [key, normalizeRuntimeMetadata(value)] as const)
      .filter((entry): entry is readonly [string, RuntimeMetadata] => entry[1] != null))
  } catch (_) { return {} }
}

function writeRuntimeCache(cache: Record<string, RuntimeMetadata>) {
  try { localStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify(cache)) } catch (_) { /* storage is best effort */ }
}

function runtimeCacheKey(item: ConnectedHistoryItem) {
  const episodes = (item.watchedEpisodes || []).map((episode) => `${episode.season}:${episode.episode}`).sort().join(',')
  return `${item.id}:${item.watchedCount}:${episodes}`
}

function runtimeDiskCacheKey(item: ConnectedHistoryItem) {
  return `connected_history:runtime:v3:${runtimeCacheKey(item)}`
}

function stremioAccountScope(): string {
  const auth = getStremioAuth()
  if (!auth) return 'anonymous'
  // Do not put Stremio's authentication key in a SQLite cache key.
  const value = `${auth.email}:${auth.authKey}`
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(36)
}

function historySelectionKey(selected: ConnectedHistorySource[], profileId = getActiveProfileId()): string {
  return [...selected].sort().map((source) => {
    if (source === 'stremio') return `stremio:${profileId}:${stremioAccountScope()}`
    return profileProviderCacheKey(`connected-history:${source}`, source, profileId)
  }).join('|')
}

function historyCacheKey(selected: ConnectedHistorySource[], profileId = getActiveProfileId()) {
  return `connected_history:snapshot:v${HISTORY_CACHE_VERSION}:${historySelectionKey(selected, profileId)}`
}

export async function persistConnectedHistorySnapshot(
  selected: ConnectedHistorySource[],
  items: ConnectedHistoryItem[],
  profileId = getActiveProfileId(),
) {
  if (!selected.length) return
  const key = historySelectionKey(selected, profileId)
  const previous = getRecent(memoryCache, key)?.result
  const result: ConnectedHistoryResult = {
    items,
    errors: previous?.errors || {},
    sourceCounts: previous?.sourceCounts || {},
  }
  rememberBounded(memoryCache, key, { timestamp: Date.now(), result }, MAX_HISTORY_SNAPSHOTS)
  void cacheSet(historyCacheKey(selected, profileId), result, {
    category: CACHE_CATEGORIES.CONNECTED_HISTORY,
    ttlSeconds: CACHE_TTLS.CONNECTED_HISTORY,
  })
}

async function resolveRuntimeMetadata(item: ConnectedHistoryItem): Promise<RuntimeMetadata | undefined> {
  if (!item.tmdbId) return undefined
  if (item.mediaType === 'movie') {
    const details = await getTmdbRuntimeMetadata('movie', item.tmdbId)
    return { minutes: details.runtime && details.runtime > 0 ? details.runtime * Math.max(1, item.watchedCount) : undefined, genres: details.genres }
  }

  const show = await getTmdbRuntimeMetadata('tv', item.tmdbId)
  if (show.episodeRunTime && show.episodeRunTime > 0) {
    return {
      minutes: Math.round(show.episodeRunTime * Math.max(1, item.watchedCount)),
      genres: show.genres,
    }
  }
  const watchedEpisodes = item.watchedEpisodes || []
  const knownRuntimes: number[] = []
  let exactTotal = 0
  if (watchedEpisodes.length) {
    const bySeason = new Map<number, { season: number; episode: number }[]>()
    watchedEpisodes.forEach((episode) => { const list = bySeason.get(episode.season) || []; list.push(episode); bySeason.set(episode.season, list) })
    const seasons = await mapLimit([...bySeason], 4, async ([seasonNumber, episodes]) => ({
      episodes,
      details: await tmdbProvider.getSeason(`tmdb-${item.tmdbId}`, seasonNumber).catch(() => null),
    }))
    for (const season of seasons) for (const watched of season.episodes) {
      const runtime = season.details?.episodes.find((episode) => episode.episodeNumber === watched.episode)?.runtime
      if (runtime && runtime > 0) { exactTotal += runtime; knownRuntimes.push(runtime) }
    }
  }

  if (!knownRuntimes.length && show.episodeRunTime) knownRuntimes.push(show.episodeRunTime)
  if (!knownRuntimes.length) {
    for (const season of (show.seasons || []).slice(0, 2)) {
      const details = await tmdbProvider.getSeason(`tmdb-${item.tmdbId}`, season.seasonNumber).catch(() => null)
      const runtimes = details?.episodes.map((episode) => episode.runtime).filter((runtime): runtime is number => Boolean(runtime && runtime > 0)) || []
      knownRuntimes.push(...runtimes)
      if (knownRuntimes.length) break
    }
  }
  if (!knownRuntimes.length) return { genres: show.genres }
  const average = knownRuntimes.reduce((sum, runtime) => sum + runtime, 0) / knownRuntimes.length
  const unmatched = Math.max(0, item.watchedCount - watchedEpisodes.length)
  return { minutes: Math.round(exactTotal + unmatched * average), genres: show.genres }
}

export async function estimateConnectedHistoryRuntime(
  items: ConnectedHistoryItem[],
  onProgress?: (completed: number, total: number, item: ConnectedHistoryItem) => void,
) {
  const cache = readRuntimeCache()
  const fresh: Record<string, RuntimeMetadata> = {}
  const results = new Array<ConnectedHistoryItem>(items.length)
  let completed = 0

  const diskKeys = items.map(runtimeDiskCacheKey)
  const diskCache = await cacheGetMany<RuntimeMetadata>(diskKeys)

  const applyMetadata = (index: number, metadata: RuntimeMetadata | undefined) => {
    const item = items[index]
    const result = { ...item, runtimeMinutes: metadata?.minutes, genres: metadata?.genres?.length ? metadata.genres : item.genres }
    results[index] = result
    completed += 1
    onProgress?.(completed, items.length, result)
  }

  // Fast pass: apply all cached items synchronously so revisits render instantly.
  const misses: number[] = []
  items.forEach((item, index) => {
    const key = runtimeCacheKey(item)
    const cached = normalizeRuntimeMetadata(cache[key])
      || normalizeRuntimeMetadata(diskCache.get(runtimeDiskCacheKey(item))?.data)
    if (cached) { fresh[key] = cached; applyMetadata(index, cached) } else misses.push(index)
  })

  let cursor = 0
  const worker = async () => {
    while (cursor < misses.length) {
      const index = misses[cursor++]
      const item = items[index]
      const metadata = await resolveRuntimeMetadata(item).catch(() => undefined)
      if (metadata) fresh[runtimeCacheKey(item)] = metadata
      applyMetadata(index, metadata)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, misses.length) }, worker))
  // Persist only keys for current items — stale watchedCount variants get pruned.
  writeRuntimeCache(fresh)
  await Promise.all(Object.entries(fresh).map(([key, metadata]) => cacheSet(
    `connected_history:runtime:v3:${key}`,
    metadata,
    { category: CACHE_CATEGORIES.CONNECTED_HISTORY, ttlSeconds: CACHE_TTLS.CONNECTED_HISTORY },
  )))
  return results
}

export async function enrichConnectedHistoryItems(items: ConnectedHistoryItem[]) {
  const profileId = getActiveProfileId()
  return mapLimit(items, 4, async (item) => {
    const cacheKey = `${profileId}:${item.id}`
    const cached = getRecent(enrichedItemCache, cacheKey)
    if (cached?.poster && cached.title) return { ...item, ...cached, sources: item.sources }
    if (item.poster && item.title) return item
    try {
      const details = item.tmdbId ? (item.mediaType === 'movie' ? await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`) : await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)) : undefined
      const art = await resolveArtFromProviders(item.mediaType === 'movie' ? 'movie' : 'series', { tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId }, item.mediaType === 'anime').catch(() => undefined)
      const result = { ...item, title: item.title || details?.title || `TMDB ${item.tmdbId}`, year: item.year || details?.year, poster: item.poster || art?.poster || details?.poster, genres: item.genres?.length ? item.genres : details?.genres }
      rememberBounded(enrichedItemCache, cacheKey, { title: result.title, year: result.year, poster: result.poster, genres: result.genres }, MAX_ENRICHED_HISTORY_ITEMS)
      return result
    } catch (_) { return { ...item, title: item.title || `TMDB ${item.tmdbId}` } }
  })
}

export async function loadConnectedHistory(selected: ConnectedHistorySource[], force = false): Promise<ConnectedHistoryResult> {
  const profileId = getActiveProfileId()
  const key = historySelectionKey(selected, profileId)
  const diskKey = historyCacheKey(selected, profileId)
  const cached = getRecent(memoryCache, key)
  if (!force && cached && Date.now() - cached.timestamp < 5 * 60_000) return cached.result
  const persisted = await cacheGet<ConnectedHistoryResult>(diskKey)
  if (!force && persisted) {
    rememberBounded(memoryCache, key, { timestamp: Date.now(), result: persisted.data }, MAX_HISTORY_SNAPSHOTS)
    return persisted.data
  }
  const settled = await Promise.all(selected.map(async (source) => ({ source, items: await loaders[source]() })).map((request) => request.then((value) => ({ status: 'fulfilled' as const, value })).catch((reason) => ({ status: 'rejected' as const, reason }))))
  const errors: ConnectedHistoryResult['errors'] = {}
  const sourceCounts: ConnectedHistoryResult['sourceCounts'] = {}
  const raw = settled.flatMap((result, index) => {
    const source = selected[index]
    if (result.status === 'rejected') { errors[source] = result.reason instanceof Error ? result.reason.message : 'Could not load history'; return [] }
    sourceCounts[source] = result.value.items.length
    return result.value.items
  })
  const previousItems = persisted?.data.items || []
  const previousById = new Map(previousItems.map((item) => [item.id, item]))
  const combined = dedupeConnectedHistory(raw)
    .map((item) => {
      const previous = previousById.get(item.id)
      if (!previous) return item
      return {
        ...item,
        title: item.title || previous.title,
        poster: item.poster || previous.poster,
        runtimeMinutes: previous.runtimeMinutes,
        genres: previous.genres?.length ? previous.genres : item.genres,
      }
    })
    .sort((left, right) => {
      const leftTime = timestamp(left.watchedAt)
      const rightTime = timestamp(right.watchedAt)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
      if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1
      return (right.watchedAt || '').localeCompare(left.watchedAt || '') || left.title.localeCompare(right.title)
    })
  const result = { items: combined, errors, sourceCounts }
  rememberBounded(memoryCache, key, { timestamp: Date.now(), result }, MAX_HISTORY_SNAPSHOTS)
  void cacheSet(diskKey, result, {
    category: CACHE_CATEGORIES.CONNECTED_HISTORY,
    ttlSeconds: CACHE_TTLS.CONNECTED_HISTORY,
  })
  return result
}
