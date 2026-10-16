import { invoke } from '@tauri-apps/api/core'
import { scheduleTask, startupTaskQueue, taskQueue, type TaskPriority } from './backgroundTaskQueue'
import { requestCoordinator } from '../network/requestCoordinator'

// [PERF] logs are dev-only — they add noise and cost in production builds
const perfLog: (...args: unknown[]) => void = import.meta.env.DEV ? console.log : () => {}
// SQLite is a first-paint optimization, not a prerequisite for network work.
// A healthy local read completes in a few milliseconds; if the Tauri command
// stalls, move on quickly so nested row/catalog caches cannot stack seconds of
// waiting before the addon request even starts.
const CACHE_READ_TIMEOUT_MS = 250
// A timed-out Tauri invoke cannot be cancelled. Coalesce the same cache key
// and cap distinct native reads so a stalled bridge cannot accumulate an
// unbounded number of abandoned SQLite commands.
const MAX_PENDING_CACHE_READS = 128
// Keep SQLite's bound parameters below the default SQLITE_MAX_VARIABLE_NUMBER
// when a large connected-history batch contains thousands of cache keys.
const CACHE_GET_MANY_BATCH_SIZE = 500
// cache_entry_get_many invokes cannot be cancelled after their caller times
// out. Bound the IPC burst for very large connected histories; entries beyond
// this window behave as cache misses and are fetched by their normal source.
const MAX_CACHE_GET_MANY_BATCHES = 8
const MAX_PENDING_CACHE_BATCH_READS = 8

function readWithTimeout<T>(request: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    request,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), CACHE_READ_TIMEOUT_MS)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

interface RawCacheEntry {
  key: string
  value: string
  category: string
  created_at: string
  expires_at: string | null
  updated_at: string
}

const pendingCacheReads = new Map<string, Promise<RawCacheEntry | null>>()
const pendingCacheBatchReads = new Set<Promise<RawCacheEntry[]>>()

function readCacheEntry(key: string): Promise<RawCacheEntry | null> {
  const existing = pendingCacheReads.get(key)
  if (existing) return existing
  if (pendingCacheReads.size >= MAX_PENDING_CACHE_READS) return Promise.resolve(null)

  const request = invoke<RawCacheEntry | null>('cache_entry_get', { key }).finally(() => {
    if (pendingCacheReads.get(key) === request) pendingCacheReads.delete(key)
  })
  pendingCacheReads.set(key, request)
  return request
}

function readCacheBatch(keys: string[]): Promise<RawCacheEntry[]> {
  if (pendingCacheBatchReads.size >= MAX_PENDING_CACHE_BATCH_READS) return Promise.resolve([])
  const request = invoke<RawCacheEntry[]>('cache_entry_get_many', { keys }).finally(() => {
    pendingCacheBatchReads.delete(request)
  })
  pendingCacheBatchReads.add(request)
  return readWithTimeout(request, [])
}

export interface CacheResult<T> {
  data: T
  stale: boolean
  age: number
}

interface SessionCacheMetadata {
  createdAt: number
  expiresAt: number | null
}

export interface CacheOptions {
  category: string
  /** null creates a durable entry that is replaced or explicitly cleared, never expired. */
  ttlSeconds: number | null
  revalidate?: 'expired' | 'once-per-session'
  priority?: TaskPriority
  queue?: 'default' | 'startup'
  /** Persist legitimate empty arrays (for example, a ratings lookup with no matches). */
  cacheEmptyResults?: boolean
}

function parseSqliteUtc(value: string): number {
  // SQLite datetime('now') uses a space separator. Convert it to the ISO form
  // required by ECMAScript so WebKit does not need to guess the timezone or
  // accept a non-standard date string.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  return Date.parse(iso)
}

function isExpired(entry: RawCacheEntry): boolean {
  if (!entry.expires_at) return false
  const expiresAt = parseSqliteUtc(entry.expires_at)
  // A malformed expiry must be a cache miss, never a permanently fresh value.
  return !Number.isFinite(expiresAt) || expiresAt < Date.now()
}

function ageMs(entry: RawCacheEntry): number {
  const createdAt = parseSqliteUtc(entry.created_at)
  return Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : 0
}

export async function cacheGet<T>(key: string): Promise<CacheResult<T> | null> {
  const memory = sessionCache.get(key)
  if (memory) {
    const metadata = sessionMetadata.get(key)
    const now = Date.now()
    const result = metadata
      ? {
          ...memory,
          stale: metadata.expiresAt != null ? metadata.expiresAt < now : false,
          age: Math.max(0, now - metadata.createdAt),
        }
      : memory
    rememberSession(key, result, undefined, metadata)
    requestCoordinator.recordCacheHit()
    return result as CacheResult<T>
  }
  const generationsAtReadStart = new Map(categoryGenerations)
  try {
    const entry = await readWithTimeout(readCacheEntry(key), null)
    if (!entry) {
      requestCoordinator.recordCacheMiss()
      return null
    }
    const clearInProgress = categoryClearPromises.get(entry.category)
    if (clearInProgress) {
      await clearInProgress
      requestCoordinator.recordCacheMiss()
      return null
    }
    if ((generationsAtReadStart.get(entry.category) || 0) !== categoryGeneration(entry.category)) {
      requestCoordinator.recordCacheMiss()
      return null
    }
    let data: T
    try {
      data = JSON.parse(entry.value) as T
    } catch (_) {
      void invoke('cache_entry_delete', { key: entry.key, expectedValue: entry.value }).catch(() => undefined)
      requestCoordinator.recordCacheMiss()
      return null
    }
    const result = { data, stale: isExpired(entry), age: ageMs(entry) }
    rememberSession(key, result, entry.category, metadataFromEntry(entry))
    requestCoordinator.recordCacheHit()
    return result
  } catch (_) {
    requestCoordinator.recordCacheMiss()
    return null
  }
}

export async function cacheSet(key: string, value: unknown, options: CacheOptions): Promise<void> {
  const generation = categoryGeneration(options.category)
  const now = Date.now()
  rememberSession(key, { data: value, stale: options.ttlSeconds != null && options.ttlSeconds <= 0, age: 0 }, options.category, {
    createdAt: now,
    expiresAt: options.ttlSeconds == null ? null : now + options.ttlSeconds * 1000,
  })
  refreshErrors.delete(key)
  try {
    // A write started during a clear must wait for it. Writes already in
    // flight when a clear starts are allowed to finish, but the clear waits
    // for them before deleting the category.
    const clearAtEnqueue = categoryClearPromises.get(options.category)
    if (clearAtEnqueue) await clearAtEnqueue
    if (generation !== categoryGeneration(options.category)) return
    const write = invoke('cache_entry_set', {
      key,
      value: JSON.stringify(value),
      category: options.category,
      ttlSeconds: options.ttlSeconds,
    })
    const writes = categoryWrites.get(options.category) || new Set<Promise<unknown>>()
    writes.add(write)
    categoryWrites.set(options.category, writes)
    try { await write }
    finally {
      writes.delete(write)
      if (writes.size === 0 && categoryWrites.get(options.category) === writes) categoryWrites.delete(options.category)
    }
  } catch (error) {
    console.warn('[Cache] set failed:', key, error)
  }
}

export async function cacheGetMany<T>(keys: string[]): Promise<Map<string, CacheResult<T>>> {
  if (keys.length === 0) return new Map()
  const generationsAtReadStart = new Map(categoryGenerations)
  const map = new Map<string, CacheResult<T>>()
  const missingKeys: string[] = []
  for (const key of keys) {
    const memory = sessionCache.get(key)
    if (!memory) {
      missingKeys.push(key)
      continue
    }
    const metadata = sessionMetadata.get(key)
    const now = Date.now()
    const result: CacheResult<T> = {
      ...memory,
      stale: metadata
        ? metadata.expiresAt != null && metadata.expiresAt < now
        : memory.stale,
      age: metadata ? Math.max(0, now - metadata.createdAt) : memory.age,
    } as CacheResult<T>
    rememberSession(key, result, sessionCategories.get(key), metadata)
    map.set(key, result)
    requestCoordinator.recordCacheHit()
  }
  if (missingKeys.length === 0) return map
  try {
    const batches: string[][] = []
    for (let index = 0; index < missingKeys.length; index += CACHE_GET_MANY_BATCH_SIZE) {
      batches.push(missingKeys.slice(index, index + CACHE_GET_MANY_BATCH_SIZE))
    }
    const batchResults = await Promise.allSettled(batches.slice(0, MAX_CACHE_GET_MANY_BATCHES).map((batch) => (
      readCacheBatch(batch)
    )))
    const entries = batchResults.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    const corruptEntries: Array<{ key: string; value: string }> = []
    const categoriesWithClear = new Set(entries
      .map((entry) => entry.category)
      .filter((category) => categoryClearPromises.has(category)))
    await Promise.all([...categoriesWithClear].map((category) => categoryClearPromises.get(category)))
    let validEntries = 0
    for (const entry of entries) {
      if (categoriesWithClear.has(entry.category)
        || (generationsAtReadStart.get(entry.category) || 0) !== categoryGeneration(entry.category)) continue
      try {
        const data = JSON.parse(entry.value) as T
        const result = { data, stale: isExpired(entry), age: ageMs(entry) }
        map.set(entry.key, result)
        rememberSession(entry.key, result, entry.category, metadataFromEntry(entry))
        validEntries += 1
      } catch (_) {
        // A single corrupt row is a cache miss; preserve every other valid
        // result in the batch so unrelated shelves/details can still render.
        corruptEntries.push({ key: entry.key, value: entry.value })
      }
    }
    if (corruptEntries.length) {
      void invoke('cache_entry_delete_many', { entries: corruptEntries }).catch(() => undefined)
    }
    for (let index = 0; index < validEntries; index += 1) requestCoordinator.recordCacheHit()
    for (let index = validEntries; index < missingKeys.length; index += 1) requestCoordinator.recordCacheMiss()
    return map
  } catch (_) {
    for (let index = 0; index < missingKeys.length; index += 1) requestCoordinator.recordCacheMiss()
    return map
  }
}

export async function cacheClearCategory(category: string): Promise<number> {
  // A second caller can share the in-flight clear. Overwriting this promise
  // would let a faster later DELETE release waiting writes while an earlier
  // DELETE is still running, allowing that older clear to erase the new write.
  const existingClear = categoryClearPromises.get(category)
  if (existingClear) return existingClear

  bumpCategoryGeneration(category)
  invalidatePendingCategory(category)
  for (const [key, value] of sessionCategories) {
    if (value === category) {
      sessionCache.delete(key)
      sessionCategories.delete(key)
      sessionMetadata.delete(key)
      refreshedThisSession.delete(key)
      refreshErrors.delete(key)
    }
  }
  const writesAtClear = [...(categoryWrites.get(category) || [])]
  const clear = Promise.allSettled(writesAtClear)
    .then(() => invoke<number>('cache_entry_clear_category', { category }))
    .catch(() => 0)
  categoryClearPromises.set(category, clear)
  try {
    return await clear
  } finally {
    if (categoryClearPromises.get(category) === clear) categoryClearPromises.delete(category)
  }
}

export async function cacheClearAll(): Promise<number> {
  const inMemoryCategories = [
    ...sessionCategories.values(),
    ...pendingCategories.values(),
    ...categoryWrites.keys(),
    ...categoryClearPromises.keys(),
  ]
  for (const category of new Set(inMemoryCategories)) {
    bumpCategoryGeneration(category)
    invalidatePendingCategory(category)
  }
  sessionCache.clear()
  sessionCategories.clear()
  sessionMetadata.clear()
  refreshedThisSession.clear()
  refreshErrors.clear()

  // Cache categories are also created by provider-specific services and are
  // not all listed in CACHE_CATEGORIES. Use the persisted category index so
  // Clear All actually clears every SQLite cache entry, including those
  // dynamic categories.
  const [{ CACHE_CATEGORIES }, stats] = await Promise.all([
    import('./constants'),
    cacheStats(),
  ])
  let total = 0
  const categories = new Set([...Object.values(CACHE_CATEGORIES), ...inMemoryCategories, ...Object.keys(stats.byCategory)])
  for (const category of categories) {
    total += await cacheClearCategory(category)
  }
  return total
}

export async function cacheClearExpired(): Promise<number> {
  const now = Date.now()
  for (const [key, metadata] of sessionMetadata) {
    if (metadata.expiresAt == null || metadata.expiresAt > now) continue
    sessionCache.delete(key)
    sessionCategories.delete(key)
    sessionMetadata.delete(key)
    refreshedThisSession.delete(key)
    refreshErrors.delete(key)
  }
  try {
    return await invoke<number>('cache_entry_clear_expired')
  } catch (_) {
    return 0
  }
}

export async function cacheStats(): Promise<{ totalEntries: number; expiredEntries: number; byCategory: Record<string, number> }> {
  try {
    return await invoke('cache_entry_stats')
  } catch (_) {
    return { totalEntries: 0, expiredEntries: 0, byCategory: {} }
  }
}

const pendingRefreshes = new Map<string, Promise<unknown>>()
const pendingCategories = new Map<string, string>()
const categoryClearPromises = new Map<string, Promise<number>>()
const categoryWrites = new Map<string, Set<Promise<unknown>>>()
const sessionCache = new Map<string, CacheResult<unknown>>()
const sessionCategories = new Map<string, string>()
const sessionMetadata = new Map<string, SessionCacheMetadata>()
const categoryGenerations = new Map<string, number>()
const refreshedThisSession = new Set<string>()
const refreshErrors = new Map<string, { message: string; at: number }>()
let lastRefreshTime = 0

function categoryGeneration(category: string): number {
  return categoryGenerations.get(category) || 0
}

async function waitForCategoryClear(category: string): Promise<void> {
  let pending = categoryClearPromises.get(category)
  while (pending) {
    await pending
    pending = categoryClearPromises.get(category)
  }
}

export function cacheCategoryGeneration(category: string): number {
  return categoryGeneration(category)
}

function bumpCategoryGeneration(category: string): void {
  categoryGenerations.set(category, categoryGeneration(category) + 1)
}

function invalidatePendingCategory(category: string): void {
  for (const [key, pendingCategory] of pendingCategories) {
    if (pendingCategory === category) {
      pendingRefreshes.delete(key)
      pendingCategories.delete(key)
    }
  }
}

// Session cache entries are deliberately small, hot presentation data.  Keep
// it bounded: a long browsing session must not retain every catalog/detail
// payload that happened to be opened. Map insertion order gives us an
// inexpensive LRU implementation without adding a runtime dependency.
const MAX_SESSION_CACHE_ENTRIES = 400
const MAX_REFRESH_ERRORS = 200

function rememberRefreshError(key: string, error: unknown): void {
  refreshErrors.delete(key)
  refreshErrors.set(key, { message: error instanceof Error ? error.message : String(error), at: Date.now() })
  while (refreshErrors.size > MAX_REFRESH_ERRORS) {
    const oldest = refreshErrors.keys().next().value as string | undefined
    if (oldest === undefined) break
    refreshErrors.delete(oldest)
  }
}

function metadataFromEntry(entry: RawCacheEntry): SessionCacheMetadata {
  const createdAt = parseSqliteUtc(entry.created_at)
  const parsedExpiry = entry.expires_at ? parseSqliteUtc(entry.expires_at) : null
  return {
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    expiresAt: parsedExpiry == null ? null : Number.isFinite(parsedExpiry) ? parsedExpiry : 0,
  }
}

function rememberSession<T>(key: string, value: CacheResult<T>, category?: string, metadata?: SessionCacheMetadata): void {
  const previousMetadata = sessionMetadata.get(key)
  sessionCache.delete(key) // refresh recency for an existing key
  sessionCache.set(key, value as CacheResult<unknown>)
  if (metadata) sessionMetadata.set(key, metadata)
  else if (!previousMetadata) sessionMetadata.set(key, { createdAt: Date.now() - Math.max(0, value.age), expiresAt: null })
  if (category) sessionCategories.set(key, category)
  while (sessionCache.size > MAX_SESSION_CACHE_ENTRIES) {
    const oldest = sessionCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    sessionCache.delete(oldest)
    sessionCategories.delete(oldest)
    sessionMetadata.delete(oldest)
    refreshedThisSession.delete(oldest)
    refreshErrors.delete(oldest)
  }
}

export function cacheRuntimeStats() {
  let approximateBytes = 0
  for (const [key, value] of sessionCache) {
    try { approximateBytes += key.length * 2 + JSON.stringify(value.data).length * 2 } catch { /* ignore */ }
  }
  return {
    memoryEntries: sessionCache.size,
    approximateBytes,
    pendingRequests: pendingRefreshes.size,
    lastRefreshTime,
    errorEntries: refreshErrors.size,
    errors: Array.from(refreshErrors.entries()).map(([key, value]) => ({ key, ...value })),
  }
}

export async function cachedFetch<T>(
  key: string,
  fetcher: (context?: { background: boolean }) => Promise<T>,
  options: CacheOptions & {
    onStaleRefreshed?: (fresh: T) => void
    skipRefreshIf?: (stale: T) => boolean
  },
): Promise<T> {
  await waitForCategoryClear(options.category)
  let generation = categoryGeneration(options.category)
  let cached = await cacheGet<T>(key)
  // A category can be cleared while SQLite is answering this read. Ignore the
  // pre-clear value and let a fresh request repopulate it.
  if (generation !== categoryGeneration(options.category) || categoryClearPromises.has(options.category)) {
    cached = null
    await waitForCategoryClear(options.category)
    generation = categoryGeneration(options.category)
  }
  // Older builds could persist failed catalog requests as permanent empty
  // arrays. Treat those poisoned entries as misses so they self-heal without a
  // manual cache clear.
  if (cached && Array.isArray(cached.data) && cached.data.length === 0 && !options.cacheEmptyResults) cached = null
  const needsSessionRefresh = options.revalidate === 'once-per-session' && !refreshedThisSession.has(key)

  if (cached && !cached.stale && !needsSessionRefresh) {
    perfLog(`[PERF] cache-hit category=${options.category} age=${cached.age}ms`)
    return cached.data
  }

  if (cached) {
    perfLog(`[PERF] stale-serve category=${options.category} age=${cached.age}ms`)

    if (!pendingRefreshes.has(key) && !refreshedThisSession.has(key) && !(options.skipRefreshIf?.(cached.data))) {
      refreshedThisSession.add(key)
      const refresh = scheduleTask(options.queue === 'startup' ? startupTaskQueue : taskQueue, {
        id: `cache-refresh:${key}`,
        dedupKey: `cache:${key}:${generation}`,
        priority: options.priority || 'normal',
        execute: async () => {
        const t0 = performance.now()
        try {
          if (generation !== categoryGeneration(options.category)) return
          const fresh = await fetcher({ background: true })
          if (generation !== categoryGeneration(options.category)) return
          if (Array.isArray(fresh) && fresh.length === 0 && Array.isArray(cached.data) && (cached.data as unknown[]).length > 0) {
            perfLog(`[PERF] stale-kept category=${options.category} reason=empty-refresh`)
            return
          }
          // The session cache is updated synchronously by cacheSet. Do not
          // keep the refresh slot or delay UI subscribers on SQLite IPC; a
          // slow native write must not block fresh data from becoming visible.
          void cacheSet(key, fresh, options)
          if (generation !== categoryGeneration(options.category)) return
          lastRefreshTime = Date.now()
          perfLog(`[PERF] stale-refresh category=${options.category} time=${Math.round(performance.now() - t0)}ms`)
          options.onStaleRefreshed?.(fresh)
        } catch (e) {
          if (generation !== categoryGeneration(options.category)) return
          rememberRefreshError(key, e)
          perfLog(`[PERF] stale-kept-on-error category=${options.category}`, e)
        }
        },
      }).catch((error) => {
        // Queue pressure can discard speculative refreshes before they start.
        // Let a later read schedule them again and consume the cancellation so
        // the stale response path never creates an unhandled rejection.
        refreshedThisSession.delete(key)
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          rememberRefreshError(key, error)
        }
      }).finally(() => {
        if (pendingRefreshes.get(key) === refresh) {
          pendingRefreshes.delete(key)
          pendingCategories.delete(key)
        }
      })
      pendingRefreshes.set(key, refresh)
      pendingCategories.set(key, options.category)
    }

    return cached.data
  }

  const existingRequest = pendingRefreshes.get(key) as Promise<T> | undefined
  if (existingRequest) return existingRequest
  if (options.revalidate === 'once-per-session') refreshedThisSession.add(key)
  // Cold loads execute directly. Fetchers often call other cached services;
  // putting outer and inner misses on the same bounded queue lets every slot
  // wait for work that cannot start. Only stale revalidation is backgrounded.
  const request = Promise.resolve().then(async () => {
    const t0 = performance.now()
    try {
      const fresh = await fetcher({ background: false })
      if (generation !== categoryGeneration(options.category)) {
        // A category clear superseded this cold request. Resolve through the
        // current generation so the result is cached again and callers don't
        // keep receiving an unpersisted pre-clear fetch.
        // Remove this request from the coalescing map before retrying. Otherwise
        // the recursive cachedFetch sees its own still-pending promise and
        // creates a promise cycle instead of starting a fresh generation.
        if (pendingRefreshes.get(key) === request) {
          pendingRefreshes.delete(key)
          pendingCategories.delete(key)
        }
        return cachedFetch(key, fetcher, options)
      }
      perfLog(`[PERF] cache-miss category=${options.category} fetchTime=${Math.round(performance.now() - t0)}ms`)
      // Empty cold catalog results are not durable screen data. They may be a
      // legitimate empty response, but persisting them forever also turns a
      // transient provider failure into a permanently empty Home row.
      // Persistence is write-behind. cacheSet updates the session cache before
      // invoking SQLite, so awaiting its IPC write here only delays first paint
      // and can leave a successful addon response behind permanent skeletons if
      // the native cache command stalls.
      if (generation === categoryGeneration(options.category) && (options.cacheEmptyResults || !(Array.isArray(fresh) && fresh.length === 0))) {
        void cacheSet(key, fresh, options)
      }
      lastRefreshTime = Date.now()
      return fresh
    } catch (e) {
      rememberRefreshError(key, e)
      console.error(`[PERF] fetch-error category=${options.category}`, e)
      throw e
    } finally {
      if (pendingRefreshes.get(key) === request) {
        pendingRefreshes.delete(key)
        pendingCategories.delete(key)
      }
    }
  })
  pendingRefreshes.set(key, request)
  pendingCategories.set(key, options.category)
  return request
}
