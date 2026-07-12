import { getWatchedMovies, getWatchedShows } from './trakt/sync'
import { getSimklWatchedEpisodes, getSimklWatchedMovies } from './simkl/history'
import { getAniListFullList } from './anilist'
import { getMdblistWatched } from './mdblist'
import { getPMDBWatched } from './pmdb'
import { resolveAnimeIds } from './animeLists'
import { tmdbProvider } from './tmdb'
import { resolveArtFromProviders } from './artwork'
import { getStremioAuth, getStremioWatchHistory } from './stremio'

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
const enrichedItemCache = new Map<string, ConnectedHistoryItem>()
const RUNTIME_CACHE_KEY = 'aurales_connected_runtime_v2'

const latest = (...values: (string | undefined)[]) => values.filter(Boolean).sort().at(-1)
const normalizedTitle = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '')
const numberOrUndefined = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

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
  return [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : group ? [group] : []).filter(Boolean))].sort()
}

function sameKind(left: ConnectedHistoryItem, right: ConnectedHistoryItem) {
  return left.mediaType === 'movie' ? right.mediaType === 'movie' : right.mediaType !== 'movie'
}

export function dedupeConnectedHistory(items: ConnectedHistoryItem[]) {
  const merged: ConnectedHistoryItem[] = []
  const identifiers: Set<string>[] = []
  for (const item of items) {
    const ids = identifierSet(item)
    const index = merged.findIndex((candidate, candidateIndex) => sameKind(candidate, item) && [...ids].some((id) => identifiers[candidateIndex].has(id)))
    if (index < 0) {
      merged.push({ ...item, id: baseId(item), sources: [...new Set(item.sources)] })
      identifiers.push(ids)
      continue
    }
    const existing = merged[index]
    const sources = [...new Set([...existing.sources, ...item.sources])]
    merged[index] = {
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
      sources,
    }
    identifiers[index] = new Set([...identifiers[index], ...ids])
    merged[index].id = baseId(merged[index])
  }
  return merged
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
  return Promise.all(entries.map(async (entry) => {
    const mapped = await resolveAnimeIds({ anilistId: entry.mediaId, malId: entry.idMal }).catch(() => null)
    return {
      id: '', title: entry.title, year: entry.seasonYear, mediaType: 'anime' as const, poster: entry.poster,
      watchedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : undefined,
      watchedDates: entry.updatedAt ? [new Date(entry.updatedAt * 1000).toISOString()] : [],
      watchedCount: Math.max(entry.progress, entry.status === 'COMPLETED' ? entry.episodes || 1 : 0) + entry.repeat * (entry.episodes || 1),
      tmdbId: mapped?.tmdbId, tvdbId: mapped?.tvdbId, imdbId: mapped?.imdbId, anilistId: entry.mediaId, malId: entry.idMal, sources: ['anilist' as const],
    }
  }))
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

function readRuntimeCache() {
  try { return JSON.parse(localStorage.getItem(RUNTIME_CACHE_KEY) || '{}') as Record<string, RuntimeMetadata> } catch (_) { return {} }
}

function writeRuntimeCache(cache: Record<string, RuntimeMetadata>) {
  try { localStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify(cache)) } catch (_) { /* storage is best effort */ }
}

function runtimeCacheKey(item: ConnectedHistoryItem) {
  const episodes = (item.watchedEpisodes || []).map((episode) => `${episode.season}:${episode.episode}`).sort().join(',')
  return `${item.id}:${item.watchedCount}:${episodes}`
}

async function resolveRuntimeMetadata(item: ConnectedHistoryItem): Promise<RuntimeMetadata | undefined> {
  if (!item.tmdbId) return undefined
  if (item.mediaType === 'movie') {
    const details = await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`)
    return { minutes: details.runtime && details.runtime > 0 ? details.runtime * Math.max(1, item.watchedCount) : undefined, genres: details.genres }
  }

  const show = await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)
  const watchedEpisodes = item.watchedEpisodes || []
  const knownRuntimes: number[] = []
  let exactTotal = 0
  if (watchedEpisodes.length) {
    const bySeason = new Map<number, { season: number; episode: number }[]>()
    watchedEpisodes.forEach((episode) => { const list = bySeason.get(episode.season) || []; list.push(episode); bySeason.set(episode.season, list) })
    const seasons = await Promise.all([...bySeason].map(async ([seasonNumber, episodes]) => ({ episodes, details: await tmdbProvider.getSeason(`tmdb-${item.tmdbId}`, seasonNumber).catch(() => null) })))
    for (const season of seasons) for (const watched of season.episodes) {
      const runtime = season.details?.episodes.find((episode) => episode.episodeNumber === watched.episode)?.runtime
      if (runtime && runtime > 0) { exactTotal += runtime; knownRuntimes.push(runtime) }
    }
  }

  if (!knownRuntimes.length) {
    for (const season of show.seasons.slice(0, 2)) {
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
  const results = new Array<ConnectedHistoryItem>(items.length)
  let cursor = 0
  let completed = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      const key = runtimeCacheKey(item)
      let metadata: RuntimeMetadata | undefined = cache[key]
      if (!metadata) metadata = await resolveRuntimeMetadata(item).catch(() => undefined)
      if (metadata) cache[key] = metadata
      const result = { ...item, runtimeMinutes: metadata?.minutes, genres: metadata?.genres?.length ? metadata.genres : item.genres }
      results[index] = result
      completed += 1
      onProgress?.(completed, items.length, result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
  writeRuntimeCache(cache)
  return results
}

export async function enrichConnectedHistoryItems(items: ConnectedHistoryItem[]) {
  return mapLimit(items, 4, async (item) => {
    const cached = enrichedItemCache.get(item.id)
    if (cached?.poster && cached.title) return { ...item, ...cached, sources: item.sources }
    if (item.poster && item.title) return item
    try {
      const details = item.tmdbId ? (item.mediaType === 'movie' ? await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`) : await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)) : undefined
      const art = await resolveArtFromProviders(item.mediaType === 'movie' ? 'movie' : 'series', { tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId }, item.mediaType === 'anime').catch(() => undefined)
      const result = { ...item, title: item.title || details?.title || `TMDB ${item.tmdbId}`, year: item.year || details?.year, poster: item.poster || art?.poster || details?.poster, genres: item.genres?.length ? item.genres : details?.genres }
      enrichedItemCache.set(item.id, result)
      return result
    } catch (_) { return { ...item, title: item.title || `TMDB ${item.tmdbId}` } }
  })
}

export async function loadConnectedHistory(selected: ConnectedHistorySource[], force = false): Promise<ConnectedHistoryResult> {
  const key = [...selected].sort().join('|')
  const cached = memoryCache.get(key)
  if (!force && cached && Date.now() - cached.timestamp < 5 * 60_000) return cached.result
  const settled = await Promise.all(selected.map(async (source) => ({ source, items: await loaders[source]() })).map((request) => request.then((value) => ({ status: 'fulfilled' as const, value })).catch((reason) => ({ status: 'rejected' as const, reason }))))
  const errors: ConnectedHistoryResult['errors'] = {}
  const sourceCounts: ConnectedHistoryResult['sourceCounts'] = {}
  const raw = settled.flatMap((result, index) => {
    const source = selected[index]
    if (result.status === 'rejected') { errors[source] = result.reason instanceof Error ? result.reason.message : 'Could not load history'; return [] }
    sourceCounts[source] = result.value.items.length
    return result.value.items
  })
  const combined = dedupeConnectedHistory(raw).sort((left, right) => (right.watchedAt || '').localeCompare(left.watchedAt || '') || left.title.localeCompare(right.title))
  const result = { items: combined, errors, sourceCounts }
  memoryCache.set(key, { timestamp: Date.now(), result })
  return result
}
