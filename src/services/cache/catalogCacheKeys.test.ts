import { describe, expect, it } from 'vitest'
import { catalogCacheKey, stableCacheInput } from './catalogCacheKeys'

describe('catalog cache keys', () => {
  it('is stable regardless of object property order', () => {
    expect(stableCacheInput({ b: 2, a: { d: 4, c: 3 } })).toBe(stableCacheInput({ a: { c: 3, d: 4 }, b: 2 }))
  })

  it('changes for critical catalog inputs', () => {
    const base = { scope: 'discover' as const, id: 'trending', region: 'US', language: 'en', filters: { type: 'movie' } }
    expect(catalogCacheKey(base)).not.toBe(catalogCacheKey({ ...base, region: 'DE' }))
    expect(catalogCacheKey(base)).not.toBe(catalogCacheKey({ ...base, language: 'de' }))
  })
})
