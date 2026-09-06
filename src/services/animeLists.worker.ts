type AnimeMapping = {
  anilist_id?: number
  mal_id?: number
  tvdb_id?: number
  themoviedb_id?: number | { tv?: number; movie?: number | number[] }
  imdb_id?: string | string[]
  [key: string]: unknown
}

type LookupPlatform = 'mal' | 'anilist' | 'tvdb' | 'tmdb' | 'imdb'
type WorkerRequest =
  | { id: number; type: 'lookup'; platform: LookupPlatform; key: string }
  | { id: number; type: 'count' }

const DATA_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json'
const CACHE_NAME = 'aurales-fribb-anime-list-v2'
const LEGACY_DATA_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
const LEGACY_CACHE_NAME = 'aurales-anime-lists-v1'
const CACHE_TIMESTAMP_HEADER = 'x-aurales-cached-at'
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000

let loadPromise: Promise<void> | null = null
let entryCount = 0
const indexes: Record<LookupPlatform, Map<string, AnimeMapping[]>> = {
  mal: new Map(),
  anilist: new Map(),
  tvdb: new Map(),
  tmdb: new Map(),
  imdb: new Map(),
}

function append(platform: LookupPlatform, key: unknown, entry: AnimeMapping): void {
  if (key == null || key === '') return
  const normalized = String(key)
  const values = indexes[platform].get(normalized)
  if (values) values.push(entry)
  else indexes[platform].set(normalized, [entry])
}

function tmdbIds(value: AnimeMapping['themoviedb_id']): Array<number | string> {
  if (typeof value === 'number') return [value]
  if (!value || typeof value !== 'object') return []
  const movie = Array.isArray(value.movie) ? value.movie : value.movie == null ? [] : [value.movie]
  return [value.tv, ...movie].filter((id): id is number => id != null)
}

function buildIndexes(data: AnimeMapping[]): void {
  entryCount = data.length
  for (const map of Object.values(indexes)) map.clear()
  for (const entry of data) {
    append('mal', entry.mal_id, entry)
    append('anilist', entry.anilist_id, entry)
    append('tvdb', entry.tvdb_id, entry)
    for (const id of tmdbIds(entry.themoviedb_id)) append('tmdb', id, entry)
    const imdbIds = Array.isArray(entry.imdb_id) ? entry.imdb_id : [entry.imdb_id]
    for (const id of imdbIds) append('imdb', id, entry)
  }
}

async function readCached(): Promise<{ text: string; timestamp: number } | null> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const response = await cache.match(DATA_URL)
    if (response) {
      return {
        text: await response.text(),
        timestamp: Number(response.headers.get(CACHE_TIMESTAMP_HEADER)) || 0,
      }
    }
    // Reuse the full-list cache written by older Aurales builds. It contains
    // the same records, and parsing it in this worker is still UI-safe.
    const legacyCache = await caches.open(LEGACY_CACHE_NAME)
    const legacy = await legacyCache.match(LEGACY_DATA_URL)
    return legacy ? {
      text: await legacy.text(),
      timestamp: Number(legacy.headers.get(CACHE_TIMESTAMP_HEADER)) || 0,
    } : null
  } catch (_) {
    return null
  }
}

async function fetchLatest(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(DATA_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`Fribb HTTP ${response.status}`)
    const text = await response.text()
    const cache = await caches.open(CACHE_NAME)
    void cache.put(DATA_URL, new Response(text, {
      headers: {
        'Content-Type': 'application/json',
        [CACHE_TIMESTAMP_HEADER]: String(Date.now()),
      },
    }))
    return text
  } finally {
    clearTimeout(timer)
  }
}

function ensureLoaded(): Promise<void> {
  if (entryCount > 0) return Promise.resolve()
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const cached = await readCached()
    if (cached?.text) {
      const parsed = JSON.parse(cached.text) as AnimeMapping[]
      if (Array.isArray(parsed)) buildIndexes(parsed)
      if (Date.now() - cached.timestamp >= CACHE_DURATION_MS) {
        // Stale-while-revalidate: lookups use the existing index immediately;
        // the smaller current file replaces it without delaying the caller.
        void fetchLatest().then((text) => {
          const fresh = JSON.parse(text) as AnimeMapping[]
          if (Array.isArray(fresh)) buildIndexes(fresh)
        }).catch(() => undefined)
      }
      return
    }

    const text = await fetchLatest().catch(() => '')
    if (!text) return
    const parsed = JSON.parse(text) as AnimeMapping[]
    if (Array.isArray(parsed)) buildIndexes(parsed)
  })().finally(() => { loadPromise = null })
  return loadPromise
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    await ensureLoaded()
    const result = request.type === 'count'
      ? entryCount
      : (indexes[request.platform].get(request.key) || [])
    self.postMessage({ id: request.id, result })
  } catch (error) {
    self.postMessage({ id: request.id, result: request.type === 'count' ? 0 : [], error: String(error) })
  }
}
