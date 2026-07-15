import { invoke } from '@tauri-apps/api/core'
import { scheduleTask, startupTaskQueue, taskQueue, type TaskPriority } from './backgroundTaskQueue'

// [PERF] logs are dev-only — they add noise and cost in production builds
const perfLog: (...args: unknown[]) => void = import.meta.env.DEV ? console.log : () => {}
// SQLite is a first-paint optimization, not a prerequisite for network work.
// A healthy local read completes in a few milliseconds; if the Tauri command
// stalls, move on quickly so nested row/catalog caches cannot stack seconds of
// waiting before the addon request even starts.
const CACHE_READ_TIMEOUT_MS = 250

interface RawCacheEntry {
  key: string
  value: string
  category: string
  created_at: string
  expires_at: string | null
  updated_at: string
}

export interface CacheResult<T> {
  data: T
  stale: boolean
  age: number
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

function isExpired(entry: RawCacheEntry): boolean {
  if (!entry.expires_at) return false
  return new Date(entry.expires_at + 'Z').getTime() < Date.now()
}

function ageMs(entry: RawCacheEntry): number {
  return Date.now() - new Date(entry.created_at + 'Z').getTime()
}

export async function cacheGet<T>(key: string): Promise<CacheResult<T> | null> {
  const memory = sessionCache.get(key)
  if (memory) return memory as CacheResult<T>
  try {
    const entry = await Promise.race([
      invoke<RawCacheEntry | null>('cache_entry_get', { key }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CACHE_READ_TIMEOUT_MS)),
    ])
    if (!entry) return null
    const data = JSON.parse(entry.value) as T
    const result = { data, stale: isExpired(entry), age: ageMs(entry) }
    sessionCache.set(key, result)
    sessionCategories.set(key, entry.category)
    return result
  } catch (_) {
    return null
  }
}

export async function cacheSet(key: string, value: unknown, options: CacheOptions): Promise<void> {
  sessionCache.set(key, { data: value, stale: false, age: 0 })
  sessionCategories.set(key, options.category)
  refreshErrors.delete(key)
  try {
    await invoke('cache_entry_set', {
      key,
      value: JSON.stringify(value),
      category: options.category,
      ttlSeconds: options.ttlSeconds,
    })
  } catch (e) {
    console.warn('[Cache] set failed:', key, e)
  }
}

export async function cacheGetMany<T>(keys: string[]): Promise<Map<string, CacheResult<T>>> {
  if (keys.length === 0) return new Map()
  try {
    const entries = await Promise.race([
      invoke<RawCacheEntry[]>('cache_entry_get_many', { keys }),
      new Promise<RawCacheEntry[]>((resolve) => setTimeout(() => resolve([]), CACHE_READ_TIMEOUT_MS)),
    ])
    const map = new Map<string, CacheResult<T>>()
    for (const entry of entries) {
      const data = JSON.parse(entry.value) as T
      map.set(entry.key, { data, stale: isExpired(entry), age: ageMs(entry) })
      sessionCache.set(entry.key, map.get(entry.key)!)
      sessionCategories.set(entry.key, entry.category)
    }
    return map
  } catch (_) {
    return new Map()
  }
}

export async function cacheClearCategory(category: string): Promise<number> {
  for (const [key, value] of sessionCategories) {
    if (value === category) {
      sessionCache.delete(key)
      sessionCategories.delete(key)
      refreshedThisSession.delete(key)
      refreshErrors.delete(key)
    }
  }
  try {
    return await invoke<number>('cache_entry_clear_category', { category })
  } catch (_) {
    return 0
  }
}

export async function cacheClearAll(): Promise<number> {
  sessionCache.clear()
  sessionCategories.clear()
  refreshedThisSession.clear()
  refreshErrors.clear()
  const { CACHE_CATEGORIES } = await import('./constants')
  let total = 0
  for (const category of Object.values(CACHE_CATEGORIES)) {
    total += await cacheClearCategory(category)
  }
  return total
}

export async function cacheClearExpired(): Promise<number> {
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
const sessionCache = new Map<string, CacheResult<unknown>>()
const sessionCategories = new Map<string, string>()
const refreshedThisSession = new Set<string>()
const refreshErrors = new Map<string, { message: string; at: number }>()
let lastRefreshTime = 0

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
  fetcher: () => Promise<T>,
  options: CacheOptions & {
    onStaleRefreshed?: (fresh: T) => void
    skipRefreshIf?: (stale: T) => boolean
  },
): Promise<T> {
  let cached = await cacheGet<T>(key)
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
        dedupKey: `cache:${key}`,
        priority: options.priority || 'normal',
        execute: async () => {
        const t0 = performance.now()
        try {
          const fresh = await fetcher()
          if (Array.isArray(fresh) && fresh.length === 0 && Array.isArray(cached.data) && (cached.data as unknown[]).length > 0) {
            perfLog(`[PERF] stale-kept category=${options.category} reason=empty-refresh`)
            return
          }
          await cacheSet(key, fresh, options)
          lastRefreshTime = Date.now()
          perfLog(`[PERF] stale-refresh category=${options.category} time=${Math.round(performance.now() - t0)}ms`)
          options.onStaleRefreshed?.(fresh)
        } catch (e) {
          refreshErrors.set(key, { message: e instanceof Error ? e.message : String(e), at: Date.now() })
          perfLog(`[PERF] stale-kept-on-error category=${options.category}`, e)
        }
        },
      }).finally(() => pendingRefreshes.delete(key))
      pendingRefreshes.set(key, refresh)
    }

    return cached.data
  }

  const existingRequest = pendingRefreshes.get(key) as Promise<T> | undefined
  if (existingRequest) return existingRequest
  if (options.revalidate === 'once-per-session') refreshedThisSession.add(key)
  // Cold loads execute directly. Fetchers often call other cached services;
  // putting outer and inner misses on the same bounded queue lets every slot
  // wait for work that cannot start. Only stale revalidation is backgrounded.
  const request = (async () => {
    const t0 = performance.now()
    try {
      const fresh = await fetcher()
      perfLog(`[PERF] cache-miss category=${options.category} fetchTime=${Math.round(performance.now() - t0)}ms`)
      // Empty cold catalog results are not durable screen data. They may be a
      // legitimate empty response, but persisting them forever also turns a
      // transient provider failure into a permanently empty Home row.
      // Persistence is write-behind. cacheSet updates the session cache before
      // invoking SQLite, so awaiting its IPC write here only delays first paint
      // and can leave a successful addon response behind permanent skeletons if
      // the native cache command stalls.
      if (options.cacheEmptyResults || !(Array.isArray(fresh) && fresh.length === 0)) void cacheSet(key, fresh, options)
      lastRefreshTime = Date.now()
      return fresh
    } catch (e) {
      refreshErrors.set(key, { message: e instanceof Error ? e.message : String(e), at: Date.now() })
      console.error(`[PERF] fetch-error category=${options.category}`, e)
      throw e
    } finally {
      pendingRefreshes.delete(key)
    }
  })()
  pendingRefreshes.set(key, request)
  return request
}
