import { webCacheGet, webCacheSet } from '../../src/platform/web/cache'

interface CacheHarnessEntry {
  key: string
  value: string
  category: string
  created_at: string
  expires_at: string | null
  updated_at: string
}

const now = new Date().toISOString()
const harness = {
  async set(key: string, value: string) {
    const entry: CacheHarnessEntry = {
      key,
      value,
      category: 'browser-e2e',
      created_at: now,
      expires_at: null,
      updated_at: now,
    }
    await webCacheSet(entry)
    return true
  },
  async get(key: string) {
    return webCacheGet(key)
  },
}

;(window as Window & { __cacheHarness?: typeof harness }).__cacheHarness = harness
