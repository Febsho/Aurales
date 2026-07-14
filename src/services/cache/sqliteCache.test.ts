import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows = new Map<string, { key: string; value: string; category: string; created_at: string; expires_at: string | null; updated_at: string }>()
const sqlDate = (time: number) => new Date(time).toISOString().replace('T', ' ').replace('Z', '')

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, any>) => {
    if (command === 'cache_entry_get') return rows.get(args?.key) || null
    if (command === 'cache_entry_set') {
      const now = Date.now()
      rows.set(args!.key, { key: args!.key, value: args!.value, category: args!.category, created_at: sqlDate(now), expires_at: sqlDate(now + args!.ttlSeconds * 1000), updated_at: sqlDate(now) })
      return null
    }
    if (command === 'cache_entry_clear_category') {
      let count = 0
      for (const [key, row] of rows) if (row.category === args?.category) { rows.delete(key); count += 1 }
      return count
    }
    if (command === 'cache_entry_get_many') return (args?.keys || []).map((key: string) => rows.get(key)).filter(Boolean)
    if (command === 'cache_entry_clear_expired') return 0
    if (command === 'cache_entry_stats') return { totalEntries: rows.size, expiredEntries: 0, byCategory: {} }
    return null
  }),
}))

import { cacheClearCategory, cachedFetch } from './sqliteCache'

describe('sqlite catalog cache behavior', () => {
  beforeEach(() => rows.clear())

  it('returns cached data first and refreshes it once at session startup', async () => {
    const key = `fresh-${Math.random()}`
    const now = Date.now()
    rows.set(key, { key, value: JSON.stringify(['cached']), category: 'discover', created_at: sqlDate(now), expires_at: sqlDate(now + 60_000), updated_at: sqlDate(now) })
    const fetcher = vi.fn(async () => ['network'])
    expect(await cachedFetch(key, fetcher, { category: 'discover', ttlSeconds: 60, revalidate: 'once-per-session' })).toEqual(['cached'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not refresh a fresh TTL-only entry', async () => {
    const key = `ttl-${Math.random()}`
    const now = Date.now()
    rows.set(key, { key, value: JSON.stringify(['cached']), category: 'discover', created_at: sqlDate(now), expires_at: sqlDate(now + 60_000), updated_at: sqlDate(now) })
    const fetcher = vi.fn(async () => ['network'])
    expect(await cachedFetch(key, fetcher, { category: 'discover', ttlSeconds: 60 })).toEqual(['cached'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not refetch a once-per-session cache miss after it succeeds', async () => {
    const key = `session-miss-${Math.random()}`
    const fetcher = vi.fn(async () => ['fresh'])
    const options = { category: 'discover', ttlSeconds: 60, revalidate: 'once-per-session' as const }
    expect(await cachedFetch(key, fetcher, options)).toEqual(['fresh'])
    expect(await cachedFetch(key, fetcher, options)).toEqual(['fresh'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('dedupes simultaneous cache misses', async () => {
    const key = `dedupe-${Math.random()}`
    const fetcher = vi.fn(async () => { await Promise.resolve(); return ['shared'] })
    const [a, b] = await Promise.all([
      cachedFetch(key, fetcher, { category: 'discover', ttlSeconds: 60 }),
      cachedFetch(key, fetcher, { category: 'discover', ttlSeconds: 60 }),
    ])
    expect(a).toEqual(b)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps stale cached data when background refresh fails', async () => {
    const key = `stale-${Math.random()}`
    const now = Date.now()
    rows.set(key, { key, value: JSON.stringify(['stale']), category: 'discover', created_at: sqlDate(now - 120_000), expires_at: sqlDate(now - 60_000), updated_at: sqlDate(now) })
    const fetcher = vi.fn(async () => { throw new Error('offline') })
    expect(await cachedFetch(key, fetcher, { category: 'discover', ttlSeconds: 60 })).toEqual(['stale'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidates session and persistent entries by category', async () => {
    const key = `invalidate-${Math.random()}`
    await cachedFetch(key, async () => ['old'], { category: 'discover', ttlSeconds: 60 })
    await cacheClearCategory('discover')
    expect(await cachedFetch(key, async () => ['new'], { category: 'discover', ttlSeconds: 60 })).toEqual(['new'])
  })
})
