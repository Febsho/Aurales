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
const ANIME_LIST_FETCH_TIMEOUT_MS = 8_000
const DATA_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
const PERSISTENT_CACHE = 'aurales-anime-lists-v1'
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
  if (cachedData && Date.now() - cacheTimestamp < CACHE_DURATION_MS) {
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
      }
      return cachedData ?? []
    } finally {
      activePromise = null
    }
  })()

  return activePromise
}

export async function getStoredAnimeListEntryCount(): Promise<number> {
  const persistent = await readPersistentCache()
  if (persistent?.data?.length) return persistent.data.length
  if (cachedData?.length) return cachedData.length
  return 0
}

// Eagerly preload on module import so data is ready before user clicks anything
void loadAnimeLists()

// ── Indexed lookups (O(1)) ──────────────────────────────────────────

export async function lookupByAniListId(anilistId: number): Promise<AnimeMapping[]> {
  await loadAnimeLists()
  return indexByAnilist.get(anilistId) ?? []
}

export async function lookupByMalId(malId: number): Promise<AnimeMapping[]> {
  await loadAnimeLists()
  return indexByMal.get(malId) ?? []
}

export async function lookupByTvdbId(tvdbId: number | string): Promise<AnimeMapping[]> {
  await loadAnimeLists()
  const num = Number(String(tvdbId).replace(/^tvdb[-:]/i, ''))
  return isNaN(num) ? [] : (indexByTvdb.get(num) ?? [])
}

export async function lookupByTmdbId(tmdbId: number | string): Promise<AnimeMapping[]> {
  await loadAnimeLists()
  const num = Number(String(tmdbId).replace(/^tmdb[-:]/i, ''))
  return isNaN(num) ? [] : (indexByTmdb.get(num) ?? [])
}

export async function lookupByImdbId(imdbId: string): Promise<AnimeMapping | undefined> {
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
  // Ensure indexes are loaded
  await loadAnimeLists()

  const malId = known.malId ? Number(known.malId) : undefined
  const anilistId = known.anilistId ? Number(known.anilistId) : undefined
  const tvdbId = known.tvdbId ? Number(String(known.tvdbId).replace(/^tvdb[-:]/i, '')) : undefined
  const tmdbId = known.tmdbId ? Number(String(known.tmdbId).replace(/^tmdb[-:]/i, '')) : undefined
  const imdbId = known.imdbId

  // 1. Instant local lookup via indexed maps (O(1))
  let match: AnimeMapping | undefined

  if (malId != null && !isNaN(malId)) match = selectBestMapping(indexByMal.get(malId), known)
  if (!match && anilistId != null && !isNaN(anilistId)) match = selectBestMapping(indexByAnilist.get(anilistId), known)
  if (!match && tvdbId != null && !isNaN(tvdbId)) match = selectBestMapping(indexByTvdb.get(tvdbId), known)
  if (!match && tmdbId != null && !isNaN(tmdbId)) match = selectBestMapping(indexByTmdb.get(tmdbId), known)
  if (!match && imdbId != null) match = indexByImdb.get(imdbId)

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

    // 2. Supplement with IDS.moe for extra IDs (traktId, simklId) — non-blocking
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
  await loadAnimeLists()

  const entries = indexByTvdb.get(tvdbId)
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
): Promise<{
  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  tmdbId?: number
  episode: number
  season: number
} | null> {
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
    }
  }

  return mapTvdbEpisodeToAnimeProvidersLocal(tvdbId, season, episode)
}

export async function mapTvdbEpisodeToAnimeProvidersLocal(
  tvdbId: number,
  season: number,
  episode: number,
): Promise<{
  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  tmdbId?: number
  episode: number
  season: number
} | null> {
  await loadAnimeLists()
  const entries = indexByTvdb.get(tvdbId)
  const entry = entries
    ?.filter((candidate) => getTvdbSeason(candidate) === season)
    .filter((candidate) => getTvdbEpisodeOffset(candidate) < episode)
    .sort((left, right) => getTvdbEpisodeOffset(right) - getTvdbEpisodeOffset(left))[0]
  if (!entry) return null
  return {
    anilistId: entry.anilist_id,
    malId: entry.mal_id,
    simklId: entry.simkl_id,
    traktId: entry.trakt_id,
    tmdbId: extractTmdbId(entry.themoviedb_id),
    episode: episode - getTvdbEpisodeOffset(entry),
    season: entry.season?.trakt ?? season,
  }
}

export async function shouldFlattenPmdbAnimeEpisodes(
  tvdbId: number,
  tmdbId: number,
): Promise<boolean> {
  await loadAnimeLists()
  const entries = indexByTvdb.get(tvdbId)?.filter((entry) => extractTmdbId(entry.themoviedb_id) === tmdbId) ?? []
  const seasons = new Set(entries.map(getTvdbSeason).filter((value): value is number => value != null))
  return seasons.size > 1 && entries.some((entry) => getTvdbEpisodeOffset(entry) > 0)
}
