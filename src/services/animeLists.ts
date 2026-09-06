interface AnimeMapping {
  anidb_id?: number
  anilist_id?: number
  mal_id?: number
  simkl_id?: number
  trakt_id?: number
  tvdb_id?: number
  themoviedb_id?: number | { tv?: number; movie?: number }
  imdb_id?: string | string[]
  tvdb_season?: number
  tvdb_epoffset?: number
  episode_offset?: { tvdb?: number; tmdb?: number }
  season?: { tvdb?: number; tmdb?: number; trakt?: number }
  type?: string
}

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000
const FAILURE_RETRY_MS = 60 * 1000
const ANIME_LIST_FETCH_TIMEOUT_MS = 8_000
const DATA_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json'
const PERSISTENT_CACHE = 'aurales-anime-lists-v2'
const CACHE_TIMESTAMP_HEADER = 'x-aurales-cached-at'

// ── Indexed lookup maps (O(1) instead of O(n) linear scan) ──────────
let indexByMal = new Map<number, AnimeMapping[]>()
let indexByAnilist = new Map<number, AnimeMapping[]>()
let indexByTvdb = new Map<number, AnimeMapping[]>()
let indexByTmdb = new Map<number, AnimeMapping[]>()
let indexByImdb = new Map<string, AnimeMapping>()

let cachedData: AnimeMapping[] | null = null
let cacheTimestamp = 0
let activePromise: Promise<AnimeMapping[]> | null = null
let lastFetchFailureAt = 0

type WorkerLookupPlatform = 'mal' | 'anilist' | 'tvdb' | 'tmdb' | 'imdb'
let mappingWorker: Worker | null = null
let mappingWorkerFailed = false
let nextWorkerRequestId = 1
const workerRequests = new Map<number, { resolve: (value: unknown) => void }>()
const workerLookupCache = new Map<string, Promise<AnimeMapping[] | null>>()

function getMappingWorker(): Worker | null {
  if (mappingWorkerFailed || typeof Worker === 'undefined') return null
  if (mappingWorker) return mappingWorker
  try {
    mappingWorker = new Worker(new URL('./animeLists.worker.ts', import.meta.url), { type: 'module' })
    mappingWorker.onmessage = (event: MessageEvent<{ id: number; result: unknown }>) => {
      const pending = workerRequests.get(event.data.id)
      if (!pending) return
      workerRequests.delete(event.data.id)
      pending.resolve(event.data.result)
    }
    mappingWorker.onerror = () => {
      mappingWorkerFailed = true
      mappingWorker?.terminate()
      mappingWorker = null
      for (const request of workerRequests.values()) request.resolve(null)
      workerRequests.clear()
    }
    return mappingWorker
  } catch (_) {
    mappingWorkerFailed = true
    return null
  }
}

function workerRequest<T>(message: Record<string, unknown>): Promise<T | null> | null {
  const worker = getMappingWorker()
  if (!worker) return null
  const id = nextWorkerRequestId++
  return new Promise<T | null>((resolve) => {
    workerRequests.set(id, { resolve: (value) => resolve(value as T | null) })
    worker.postMessage({ ...message, id })
  })
}

async function workerLookup(platform: WorkerLookupPlatform, key: string | number): Promise<AnimeMapping[] | null> {
  const cacheKey = `${platform}:${key}`
  const cached = workerLookupCache.get(cacheKey)
  if (cached) return cached
  const request = workerRequest<AnimeMapping[]>({ type: 'lookup', platform, key: String(key) })
  if (!request) return null
  workerLookupCache.set(cacheKey, request)
  return request
}

function extractTmdbId(val: unknown, contentType?: 'movie' | 'series'): number | undefined {
  if (val === null || val === undefined) return undefined
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    const parsed = parseInt(val, 10)
    return isNaN(parsed) ? undefined : parsed
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    const possible = contentType === 'movie'
      ? obj.movie
      : contentType === 'series'
        ? obj.tv
        : obj.tv ?? obj.movie ?? obj.id ?? obj.value
    if (possible !== undefined) return extractTmdbId(possible, contentType)
  }
  return undefined
}

function getTvdbSeason(entry: AnimeMapping): number | undefined {
  return entry.tvdb_season ?? entry.season?.tvdb
}

function getTvdbEpisodeOffset(entry: AnimeMapping): number {
  return entry.tvdb_epoffset ?? entry.episode_offset?.tvdb ?? 0
}

function getTmdbEpisodeOffset(entry: AnimeMapping): number {
  return entry.episode_offset?.tmdb ?? 0
}

export interface AnimeTmdbSeasonSegment {
  tmdbId: number
  tmdbSeason: number
  tvdbStartEpisode: number
  tmdbStartEpisode: number
}

export interface AnimeProviderEpisodeMapping {
  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  tmdbId?: number
  /** Episode number relative to the matched anime cour (MAL/AniList). */
  episode: number
  /** Trakt season, retained for progress-provider compatibility. */
  season: number
  tmdbSeason?: number
  tmdbEpisode?: number
}

function inferMediaKind(entry: AnimeMapping): 'movie' | 'series' {
  if (entry.themoviedb_id && typeof entry.themoviedb_id === 'object') {
    if (entry.themoviedb_id.movie != null && entry.themoviedb_id.tv == null) return 'movie'
    if (entry.themoviedb_id.tv != null) return 'series'
  }
  return /movie|film/i.test(entry.type || '') ? 'movie' : 'series'
}

function selectBestMapping(
  entries: AnimeMapping[] | undefined,
  known: { anilistId?: number | string; malId?: number | string; tvdbId?: number | string; tmdbId?: number | string; imdbId?: string; contentType?: 'movie' | 'series' },
): AnimeMapping | undefined {
  if (!entries?.length) return undefined
  const numeric = (value: unknown) => value == null ? undefined : Number(String(value).replace(/^[a-z]+[-:]/i, ''))
  const score = (entry: AnimeMapping) => {
    let value = 0
    if (known.contentType) value += inferMediaKind(entry) === known.contentType ? 40 : -100
    if (numeric(known.anilistId) === entry.anilist_id) value += 100
    if (numeric(known.malId) === entry.mal_id) value += 100
    if (numeric(known.tvdbId) === entry.tvdb_id) value += 80
    if (numeric(known.tmdbId) === extractTmdbId(entry.themoviedb_id, known.contentType)) value += 100
    const imdbIds = Array.isArray(entry.imdb_id) ? entry.imdb_id : [entry.imdb_id]
    if (known.imdbId && imdbIds.includes(known.imdbId)) value += 100
    return value
  }
  return [...entries].sort((left, right) => score(right) - score(left))[0]
}

function buildIndexes(data: AnimeMapping[]): void {
  const byMal = new Map<number, AnimeMapping[]>()
  const byAnilist = new Map<number, AnimeMapping[]>()
  const byTvdb = new Map<number, AnimeMapping[]>()
  const byTmdb = new Map<number, AnimeMapping[]>()
  const byImdb = new Map<string, AnimeMapping>()

  for (const entry of data) {
    if (entry.mal_id != null) {
      const arr = byMal.get(entry.mal_id)
      if (arr) arr.push(entry)
      else byMal.set(entry.mal_id, [entry])
    }
    if (entry.anilist_id != null) {
      const arr = byAnilist.get(entry.anilist_id)
      if (arr) arr.push(entry)
      else byAnilist.set(entry.anilist_id, [entry])
    }
    if (entry.tvdb_id != null) {
      const arr = byTvdb.get(entry.tvdb_id)
      if (arr) arr.push(entry)
      else byTvdb.set(entry.tvdb_id, [entry])
    }
    const tmdbIds = new Set([
      extractTmdbId(entry.themoviedb_id, 'series'),
      extractTmdbId(entry.themoviedb_id, 'movie'),
    ].filter((value): value is number => value != null))
    for (const tmdb of tmdbIds) {
      const arr = byTmdb.get(tmdb)
      if (arr) arr.push(entry)
      else byTmdb.set(tmdb, [entry])
    }
    if (entry.imdb_id != null) {
      const imdbIds = Array.isArray(entry.imdb_id) ? entry.imdb_id : [entry.imdb_id]
      for (const imdbId of imdbIds) byImdb.set(imdbId, entry)
    }
  }

  indexByMal = byMal
  indexByAnilist = byAnilist
  indexByTvdb = byTvdb
  indexByTmdb = byTmdb
  indexByImdb = byImdb
}

// ── Persistent cache (Cache API) ────────────────────────────────────

async function readPersistentCache(): Promise<{ data: AnimeMapping[]; timestamp: number } | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(PERSISTENT_CACHE)
    const response = await cache.match(DATA_URL)
    if (!response) return null
    const data = await response.json() as AnimeMapping[]
    const timestamp = Number(response.headers.get(CACHE_TIMESTAMP_HEADER)) || 0
    return Array.isArray(data) ? { data, timestamp } : null
  } catch (_) {
    return null
  }
}

async function writePersistentCache(data: AnimeMapping[]): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(PERSISTENT_CACHE)
    await cache.put(DATA_URL, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        [CACHE_TIMESTAMP_HEADER]: String(Date.now()),
      },
    }))
  } catch (_) { /* memory cache still works */ }
}

// ── Load + index ────────────────────────────────────────────────────

export function loadAnimeLists(): Promise<AnimeMapping[]> {
  if (cachedData && (Date.now() - cacheTimestamp < CACHE_DURATION_MS || Date.now() - lastFetchFailureAt < FAILURE_RETRY_MS)) {
    return Promise.resolve(cachedData)
  }
  if (activePromise) {
    return activePromise
  }

  activePromise = (async () => {
    const persistent = await readPersistentCache()
    if (persistent && Date.now() - persistent.timestamp < CACHE_DURATION_MS) {
      cachedData = persistent.data
      cacheTimestamp = persistent.timestamp
      buildIndexes(persistent.data)
      return persistent.data
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), ANIME_LIST_FETCH_TIMEOUT_MS)
      const response = await fetch(DATA_URL, { signal: controller.signal }).finally(() => clearTimeout(timeout))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data: AnimeMapping[] = await response.json()
      cachedData = data
      cacheTimestamp = Date.now()
      lastFetchFailureAt = 0
      buildIndexes(data)
      void writePersistentCache(data)
      console.log(`[anime-lists] loaded & indexed ${data.length} mappings`)
      return data
    } catch (e) {
      console.warn('[anime-lists] fetch failed:', e)
      if (persistent) {
        cachedData = persistent.data
        cacheTimestamp = persistent.timestamp
        buildIndexes(persistent.data)
      } else {
        cachedData = []
        buildIndexes(cachedData)
      }
      lastFetchFailureAt = Date.now()
      return cachedData
    } finally {
      activePromise = null
    }
  })()

  return activePromise
}

export async function getStoredAnimeListEntryCount(): Promise<number> {
  const workerCount = workerRequest<number>({ type: 'count' })
  if (workerCount) {
    const count = await workerCount
    if (count != null) return count
  }
  const persistent = await readPersistentCache()
  if (persistent?.data?.length) return persistent.data.length
  if (cachedData?.length) return cachedData.length
  return 0
}

// Warm Fribb in a worker. Downloading, JSON.parse, and indexing never touch the
// React thread, so opening an anime cannot freeze scrolling or playback.
void workerRequest<number>({ type: 'count' })

// ── Indexed lookups (O(1)) ──────────────────────────────────────────

export async function lookupByAniListId(anilistId: number): Promise<AnimeMapping[]> {
  const workerResult = await workerLookup('anilist', anilistId)
  if (workerResult !== null || typeof Worker !== 'undefined') return workerResult ?? []
  await loadAnimeLists()
  return indexByAnilist.get(anilistId) ?? []
}

export async function lookupByMalId(malId: number): Promise<AnimeMapping[]> {
  const workerResult = await workerLookup('mal', malId)
  if (workerResult !== null || typeof Worker !== 'undefined') return workerResult ?? []
  await loadAnimeLists()
  return indexByMal.get(malId) ?? []
}

export async function lookupByTvdbId(tvdbId: number | string): Promise<AnimeMapping[]> {
  const num = Number(String(tvdbId).replace(/^tvdb[-:]/i, ''))
  if (isNaN(num)) return []
  const workerResult = await workerLookup('tvdb', num)
  if (workerResult !== null || typeof Worker !== 'undefined') return workerResult ?? []
  await loadAnimeLists()
  return isNaN(num) ? [] : (indexByTvdb.get(num) ?? [])
}

export async function lookupByTmdbId(tmdbId: number | string): Promise<AnimeMapping[]> {
  const num = Number(String(tmdbId).replace(/^tmdb[-:]/i, ''))
  if (isNaN(num)) return []
  const workerResult = await workerLookup('tmdb', num)
  if (workerResult !== null || typeof Worker !== 'undefined') return workerResult ?? []
  await loadAnimeLists()
  return isNaN(num) ? [] : (indexByTmdb.get(num) ?? [])
}

export async function lookupByImdbId(imdbId: string): Promise<AnimeMapping | undefined> {
  const workerResult = await workerLookup('imdb', imdbId)
  if (workerResult !== null || typeof Worker !== 'undefined') return workerResult?.[0]
  await loadAnimeLists()
  return indexByImdb.get(imdbId)
}

// ── Main resolver ───────────────────────────────────────────────────

export async function resolveAnimeIds(known: {
  anilistId?: number | string
  malId?: number | string
  tvdbId?: number | string
  tmdbId?: number | string
  imdbId?: string
  contentType?: 'movie' | 'series'
}): Promise<{
  anilistId?: number
  malId?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
  traktId?: number
  simklId?: number
  tvdbSeason?: number
  tvdbEpOffset?: number
  mediaKind?: 'movie' | 'series'
} | null> {
  const malId = known.malId ? Number(known.malId) : undefined
  const anilistId = known.anilistId ? Number(known.anilistId) : undefined
  const tvdbId = known.tvdbId ? Number(String(known.tvdbId).replace(/^tvdb[-:]/i, '')) : undefined
  const tmdbId = known.tmdbId ? Number(String(known.tmdbId).replace(/^tmdb[-:]/i, '')) : undefined
  const imdbId = known.imdbId

  // 1. Instant local lookup via indexed maps (O(1))
  let match: AnimeMapping | undefined

  if (malId != null && !isNaN(malId)) match = selectBestMapping(await lookupByMalId(malId), known)
  if (!match && anilistId != null && !isNaN(anilistId)) match = selectBestMapping(await lookupByAniListId(anilistId), known)
  if (!match && tvdbId != null && !isNaN(tvdbId)) match = selectBestMapping(await lookupByTvdbId(tvdbId), known)
  if (!match && tmdbId != null && !isNaN(tmdbId)) match = selectBestMapping(await lookupByTmdbId(tmdbId), known)
  if (!match && imdbId != null) match = await lookupByImdbId(imdbId)

  if (match) {
    const base = {
      anilistId: match.anilist_id,
      malId: match.mal_id,
      tvdbId: match.tvdb_id,
      tmdbId: extractTmdbId(match.themoviedb_id, known.contentType),
      imdbId: Array.isArray(match.imdb_id) ? match.imdb_id[0] : match.imdb_id,
      tvdbSeason: getTvdbSeason(match),
      tvdbEpOffset: getTvdbEpisodeOffset(match),
      mediaKind: inferMediaKind(match),
    }

    // The local index already contains every core ID needed to build a detail
    // page. Do not put an optional trakt/simkl enrichment request on the
    // critical path when the complete local mapping is available.
    if (base.anilistId && base.malId && base.tvdbId && base.tmdbId) return base

    // 2. Supplement incomplete local mappings with IDS.moe.
    try {
      const { resolveViaIdsMoe } = await import('./idsMoe')
      const idsMoe = await resolveViaIdsMoe({
        malId: base.malId ?? malId,
        anilistId: base.anilistId ?? anilistId,
        tmdbId: base.tmdbId ?? tmdbId,
        imdbId: base.imdbId ?? imdbId,
      })
      if (idsMoe) {
        return {
          ...base,
          anilistId: base.anilistId ?? idsMoe.anilistId,
          malId: base.malId ?? idsMoe.malId,
          tmdbId: base.tmdbId ?? idsMoe.tmdbId,
          imdbId: base.imdbId ?? idsMoe.imdbId,
          traktId: idsMoe.traktId,
          simklId: idsMoe.simklId,
          mediaKind: base.mediaKind ?? (idsMoe.tmdbType === 'movie' ? 'movie' : idsMoe.tmdbType ? 'series' : known.contentType),
        }
      }
    } catch (_) { /* local data is sufficient */ }

    return base
  }

  // 3. Not in local data — try IDS.moe API (for new/rare anime)
  try {
    const { resolveViaIdsMoe } = await import('./idsMoe')
    const idsMoe = await resolveViaIdsMoe({
      malId,
      anilistId,
      tmdbId,
      imdbId,
    })
    if (idsMoe && (idsMoe.malId || idsMoe.anilistId || idsMoe.tmdbId)) {
      let resolvedTvdbId = tvdbId
      if (!resolvedTvdbId && idsMoe.tmdbId && idsMoe.tmdbType !== 'movie') {
        try {
          const { getTvdbIdFromTmdb } = await import('./tmdb')
          resolvedTvdbId = await getTvdbIdFromTmdb(idsMoe.tmdbId)
        } catch (_) { /* ok */ }
      }
      return {
        anilistId: idsMoe.anilistId ?? anilistId,
        malId: idsMoe.malId ?? malId,
        tvdbId: resolvedTvdbId,
        tmdbId: idsMoe.tmdbId ?? tmdbId,
        imdbId: idsMoe.imdbId ?? imdbId,
        traktId: idsMoe.traktId,
        simklId: idsMoe.simklId,
        mediaKind: idsMoe.tmdbType === 'movie' ? 'movie' : idsMoe.tmdbType ? 'series' : known.contentType,
      }
    }
  } catch (_) { /* no data available */ }

  return null
}

// ── Episode mapping (uses indexed lookups) ──────────────────────────

export async function mapAniListEpisodeToTvdb(
  anilistId: number,
  absoluteEpisode: number
): Promise<{ season: number; episode: number; tvdbId: number } | null> {
  const entries = await lookupByAniListId(anilistId)
  if (entries.length === 0) return null

  const sorted = entries
    .filter((e) => getTvdbSeason(e) != null && e.tvdb_id != null)
    .sort((a, b) => getTvdbEpisodeOffset(a) - getTvdbEpisodeOffset(b))

  if (sorted.length === 0) return null

  let matched = sorted[0]
  for (const entry of sorted) {
    if (absoluteEpisode > getTvdbEpisodeOffset(entry)) {
      matched = entry
    } else {
      break
    }
  }

  return {
    season: getTvdbSeason(matched)!,
    episode: absoluteEpisode - getTvdbEpisodeOffset(matched),
    tvdbId: matched.tvdb_id!,
  }
}

export async function mapTvdbEpisodeToAniList(
  tvdbId: number,
  season: number,
  episode: number
): Promise<{ anilistId: number; absoluteEpisode: number } | null> {
  const entries = await lookupByTvdbId(tvdbId)
  const seasonEntries = (entries || [])
    .filter((e) => getTvdbSeason(e) === season && e.anilist_id != null)
    .sort((a, b) => getTvdbEpisodeOffset(a) - getTvdbEpisodeOffset(b))
  let entry = seasonEntries[0]
  for (const candidate of seasonEntries) {
    if (episode > getTvdbEpisodeOffset(candidate)) entry = candidate
    else break
  }

  if (!entry) return null

  return {
    anilistId: entry.anilist_id!,
    // AniList progress is relative to the matched cour/media entry.
    absoluteEpisode: episode - getTvdbEpisodeOffset(entry),
  }
}

export async function mapTvdbEpisodeToAnimeProviders(
  tvdbId: number,
  season: number,
  episode: number,
): Promise<AnimeProviderEpisodeMapping | null> {
  const anibridge = await import('./anime-mapping/anibridgeMappings')
    .then(({ mapTvdbEpisodeWithAniBridge }) => mapTvdbEpisodeWithAniBridge({
      localMediaId: `tvdb-${tvdbId}`,
      tvdbSeriesId: tvdbId,
      tvdbSeasonNumber: season,
      tvdbEpisodeNumber: episode,
    }))
    .catch(() => null)
  if (anibridge?.anilist || anibridge?.mal || anibridge?.tmdb) {
    return {
      anilistId: anibridge.anilist?.mediaId,
      malId: anibridge.mal?.id,
      tmdbId: anibridge.tmdb?.id,
      episode: anibridge.anilist?.episodeNumber ?? anibridge.mal?.episodeNumber ?? anibridge.tmdb?.episodeNumber ?? episode,
      season: anibridge.tmdb?.seasonNumber ?? season,
      tmdbSeason: anibridge.tmdb?.seasonNumber,
      tmdbEpisode: anibridge.tmdb?.episodeNumber,
    }
  }

  return mapTvdbEpisodeToAnimeProvidersLocal(tvdbId, season, episode)
}

export async function mapTvdbEpisodeToAnimeProvidersLocal(
  tvdbId: number,
  season: number,
  episode: number,
): Promise<AnimeProviderEpisodeMapping | null> {
  const entries = await lookupByTvdbId(tvdbId)
  const entry = entries
    ?.filter((candidate) => getTvdbSeason(candidate) === season)
    .filter((candidate) => getTvdbEpisodeOffset(candidate) < episode)
    .sort((left, right) => getTvdbEpisodeOffset(right) - getTvdbEpisodeOffset(left))[0]
  if (!entry) return null
  const relativeEpisode = episode - getTvdbEpisodeOffset(entry)
  return {
    anilistId: entry.anilist_id,
    malId: entry.mal_id,
    simklId: entry.simkl_id,
    traktId: entry.trakt_id,
    tmdbId: extractTmdbId(entry.themoviedb_id),
    episode: relativeEpisode,
    season: entry.season?.trakt ?? season,
    tmdbSeason: entry.season?.tmdb ?? season,
    tmdbEpisode: relativeEpisode + getTmdbEpisodeOffset(entry),
  }
}

/**
 * Returns the Fribb cour boundaries needed to rebase TMDB's anime layout back
 * onto TVDB's season/episode layout. Several anime (for example Re:Zero) keep
 * every cour in TMDB season 1 while TVDB exposes normal seasons.
 */
export async function getAnimeTmdbSeasonSegments(
  tvdbId: number,
  tvdbSeason: number,
): Promise<AnimeTmdbSeasonSegment[]> {
  const entries = await lookupByTvdbId(tvdbId)
  const unique = new Map<string, AnimeTmdbSeasonSegment>()
  for (const entry of entries) {
    if (getTvdbSeason(entry) !== tvdbSeason) continue
    const tmdbId = extractTmdbId(entry.themoviedb_id, 'series')
    if (tmdbId == null) continue
    const segment = {
      tmdbId,
      tmdbSeason: entry.season?.tmdb ?? tvdbSeason,
      tvdbStartEpisode: getTvdbEpisodeOffset(entry) + 1,
      tmdbStartEpisode: getTmdbEpisodeOffset(entry) + 1,
    }
    unique.set(`${segment.tmdbId}:${segment.tmdbSeason}:${segment.tvdbStartEpisode}:${segment.tmdbStartEpisode}`, segment)
  }
  return [...unique.values()].sort((left, right) => left.tvdbStartEpisode - right.tvdbStartEpisode)
}

export async function shouldFlattenPmdbAnimeEpisodes(
  tvdbId: number,
  tmdbId: number,
): Promise<boolean> {
  const entries = (await lookupByTvdbId(tvdbId)).filter((entry) => extractTmdbId(entry.themoviedb_id) === tmdbId)
  const seasons = new Set(entries.map(getTvdbSeason).filter((value): value is number => value != null))
  return seasons.size > 1 && entries.some((entry) => getTvdbEpisodeOffset(entry) > 0)
}
