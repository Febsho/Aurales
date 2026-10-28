import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('shared cache contract in browser mode', () => {
  it('persists and reloads data through IndexedDB using the existing cache API', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.resetModules()
    const firstLoad = await import('./sqliteCache')
    const key = `web-integration:${crypto.randomUUID()}`
    const category = `web-integration:${crypto.randomUUID()}`
    const data = { items: ['Aurales'], count: 1 }
    await firstLoad.cacheSet(key, data, { category, ttlSeconds: 60 })

    vi.resetModules()
    const reloaded = await import('./sqliteCache')
    await expect(reloaded.cacheGet<typeof data>(key)).resolves.toMatchObject({ data, stale: false })
    await reloaded.cacheClearCategory(category)
    await expect(reloaded.cacheGet(key)).resolves.toBeNull()
  })

  it('deletes one entry from IndexedDB and the session cache', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.resetModules()
    const cache = await import('./sqliteCache')
    const key = `web-delete:${crypto.randomUUID()}`
    await cache.cacheSet(key, { stale: true }, { category: 'web-delete-test', ttlSeconds: null })
    await expect(cache.cacheGet(key)).resolves.toMatchObject({ data: { stale: true } })

    await cache.cacheDelete(key)

    await expect(cache.cacheGet(key)).resolves.toBeNull()
  })
})
