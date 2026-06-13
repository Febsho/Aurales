interface AnimeMapping {
  anidb_id?: number
  anilist_id?: number
  mal_id?: number
  thetvdb_id?: number
  themoviedb_id?: number
  imdb_id?: string
  tvdb_season?: number
  tvdb_epoffset?: number
  type?: string
}

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000
const DATA_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
const PERSISTENT_CACHE = 'orynt-anime-lists-v1'
const CACHE_TIMESTAMP_HEADER = 'x-orynt-cached-at'

let cachedData: AnimeMapping[] | null = null
let cacheTimestamp = 0
let activePromise: Promise<AnimeMapping[]> | null = null

async function readPersistentCache(): Promise<{ data: AnimeMapping[]; timestamp: number } | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(PERSISTENT_CACHE)
    const response = await cache.match(DATA_URL)
    if (!response) return null
    const data = await response.json() as AnimeMapping[]
    const timestamp = Number(response.headers.get(CACHE_TIMESTAMP_HEADER)) || 0
    return Array.isArray(data) ? { data, timestamp } : null
  } catch {
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
  } catch { /* memory cache still works */ }
}

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
      return persistent.data
    }

    try {
      const response = await fetch(DATA_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data: AnimeMapping[] = await response.json()
      cachedData = data
      cacheTimestamp = Date.now()
      void writePersistentCache(data)
      console.log(`[anime-lists] loaded ${data.length} mappings`)
      return data
    } catch (e) {
      console.warn('[anime-lists] fetch failed:', e)
      if (persistent) {
        cachedData = persistent.data
        cacheTimestamp = persistent.timestamp
      }
      return cachedData ?? []
    } finally {
      activePromise = null
    }
  })()

  return activePromise
}

export async function lookupByAniListId(anilistId: number): Promise<AnimeMapping[]> {
  const data = await loadAnimeLists()
  return data.filter((e) => e.anilist_id === anilistId)
}

export async function lookupByMalId(malId: number): Promise<AnimeMapping[]> {
  const data = await loadAnimeLists()
  return data.filter((e) => e.mal_id === malId)
}

export async function lookupByTvdbId(tvdbId: number): Promise<AnimeMapping[]> {
  const data = await loadAnimeLists()
  return data.filter((e) => e.thetvdb_id === tvdbId)
}

export async function lookupByImdbId(imdbId: string): Promise<AnimeMapping | undefined> {
  const data = await loadAnimeLists()
  return data.find((e) => e.imdb_id === imdbId)
}

async function fetchYunaMoeIds(known: {
  anilistId?: number
  malId?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
}): Promise<{
  anilistId?: number
  malId?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
} | null> {
  try {
    let queryParam = ''
    if (known.anilistId != null) queryParam = `anilist=${known.anilistId}`
    else if (known.malId != null) queryParam = `mal=${known.malId}`
    else if (known.tvdbId != null) queryParam = `thetvdb=${known.tvdbId}`
    else if (known.tmdbId != null) queryParam = `themoviedb=${known.tmdbId}`
    else if (known.imdbId != null) queryParam = `imdb=${known.imdbId}`

    if (!queryParam) return null

    const res = await fetch(`https://relations.yuna.moe/api/ids?${queryParam}`)
    if (res.ok) {
      const match = await res.json() as any
      return {
        anilistId: match.anilist ? Number(match.anilist) : undefined,
        malId: match.mal ? Number(match.mal) : undefined,
        tvdbId: match.thetvdb ? Number(match.thetvdb) : undefined,
        tmdbId: match.themoviedb ? Number(match.themoviedb) : undefined,
        imdbId: match.imdb || undefined,
      }
    }
  } catch (e) {
    console.warn('[anime-lists] Yuna Moe API lookup failed:', e)
  }
  return null
}

export async function resolveAnimeIds(known: {
  anilistId?: number
  malId?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
}): Promise<{
  anilistId?: number
  malId?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
  tvdbSeason?: number
  tvdbEpOffset?: number
} | null> {
  const data = await loadAnimeLists()

  let match: AnimeMapping | undefined

  if (known.anilistId != null) {
    match = data.find((e) => e.anilist_id === known.anilistId)
  }
  if (!match && known.malId != null) {
    match = data.find((e) => e.mal_id === known.malId)
  }
  if (!match && known.tvdbId != null) {
    match = data.find((e) => e.thetvdb_id === known.tvdbId)
  }
  if (!match && known.tmdbId != null) {
    match = data.find((e) => e.themoviedb_id === known.tmdbId)
  }
  if (!match && known.imdbId != null) {
    match = data.find((e) => e.imdb_id === known.imdbId)
  }

  if (match) {
    return {
      anilistId: match.anilist_id,
      malId: match.mal_id,
      tvdbId: match.thetvdb_id,
      tmdbId: match.themoviedb_id,
      imdbId: match.imdb_id,
      tvdbSeason: match.tvdb_season,
      tvdbEpOffset: match.tvdb_epoffset,
    }
  }

  // Fallback to online API lookup
  const online = await fetchYunaMoeIds(known)
  if (online) return online

  return null
}

export async function mapAniListEpisodeToTvdb(
  anilistId: number,
  absoluteEpisode: number
): Promise<{ season: number; episode: number; tvdbId: number } | null> {
  const entries = await lookupByAniListId(anilistId)
  if (entries.length === 0) return null

  const sorted = entries
    .filter((e) => e.tvdb_season != null && e.tvdb_epoffset != null && e.thetvdb_id != null)
    .sort((a, b) => (a.tvdb_epoffset ?? 0) - (b.tvdb_epoffset ?? 0))

  if (sorted.length === 0) return null

  let matched = sorted[0]
  for (const entry of sorted) {
    if (absoluteEpisode > (entry.tvdb_epoffset ?? 0)) {
      matched = entry
    } else {
      break
    }
  }

  return {
    season: matched.tvdb_season!,
    episode: absoluteEpisode - (matched.tvdb_epoffset ?? 0),
    tvdbId: matched.thetvdb_id!,
  }
}

export async function mapTvdbEpisodeToAniList(
  tvdbId: number,
  season: number,
  episode: number
): Promise<{ anilistId: number; absoluteEpisode: number } | null> {
  const data = await loadAnimeLists()

  const entry = data.find(
    (e) => e.thetvdb_id === tvdbId && e.tvdb_season === season && e.anilist_id != null
  )

  if (!entry) return null

  return {
    anilistId: entry.anilist_id!,
    absoluteEpisode: (entry.tvdb_epoffset ?? 0) + episode,
  }
}
