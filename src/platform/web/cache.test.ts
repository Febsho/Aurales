import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  webCacheClearCategory,
  webCacheClearExpired,
  webCacheGet,
  webCacheGetMany,
  webCacheSet,
  webCacheStats,
} from './cache'

const entry = (key: string, category: string, expires_at: string | null = null) => ({
  key,
  value: JSON.stringify({ key }),
  category,
  created_at: new Date().toISOString(),
  expires_at,
  updated_at: new Date().toISOString(),
})

describe('browser IndexedDB cache adapter', () => {
  it('persists entries and reads batches by their existing cache keys', async () => {
    const category = `cache-test:${crypto.randomUUID()}`
    const first = entry(`${category}:a`, category)
    const second = entry(`${category}:b`, category)
    await webCacheSet(first)
    await webCacheSet(second)

    expect(await webCacheGet(first.key)).toEqual(first)
    expect(await webCacheGetMany([first.key, second.key])).toEqual([first, second])
    expect((await webCacheStats()).byCategory[category]).toBe(2)
    await webCacheClearCategory(category)
    expect(await webCacheGet(first.key)).toBeNull()
  })

  it('expires entries using the same persisted expiry timestamp', async () => {
    const category = `expiry-test:${crypto.randomUUID()}`
    const expired = entry(`${category}:expired`, category, new Date(Date.now() - 1000).toISOString())
    const current = entry(`${category}:current`, category, new Date(Date.now() + 60_000).toISOString())
    await webCacheSet(expired)
    await webCacheSet(current)

    expect(await webCacheClearExpired()).toBe(1)
    expect(await webCacheGet(expired.key)).toBeNull()
    expect(await webCacheGet(current.key)).toEqual(current)
    await webCacheClearCategory(category)
  })
})
