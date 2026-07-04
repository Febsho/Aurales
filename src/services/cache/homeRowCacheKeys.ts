import type { HomeRowConfig } from '../../types'

// Single source of truth for home shelf cache keys. The row components and the
// HomePage batch preloader must agree on these formats — a mismatch silently
// disables the instant-paint path for that shelf.

export function simklRowCacheKey(row: HomeRowConfig): string {
  return `home:simkl:${row.providerListId || 'watchlist'}:${row.sortBy || 'default'}`
}

export function providerRowCacheKey(row: HomeRowConfig): string {
  return `home:provider:${row.sourceType}:${row.providerListId}:${row.sortBy || 'default'}`
}

export function addonRowCacheKey(row: HomeRowConfig): string {
  return `home:addon:v2:${row.addonId}:${row.catalogType}:${row.catalogId}:${JSON.stringify(row.catalogExtra || {})}`
}

export function discoverRowCacheKey(row: HomeRowConfig): string {
  return `home:discover:${row.id}:${JSON.stringify(row.discoverConfig || {})}`
}

export function heroRowCacheKey(row: HomeRowConfig): string {
  return `home:hero:${row.sourceType || 'addon'}:${row.addonId || ''}:${row.catalogId || ''}:${row.providerListId || ''}`
}

const PROVIDER_SOURCES = ['trakt', 'pmdb', 'pmdb-picks', 'mdblist', 'anilist']

/** Cache key for any configured shelf, or null for rows without a sqlite-backed cache. */
export function homeRowCacheKey(row: HomeRowConfig): string | null {
  if (row.layout === 'hero') return heroRowCacheKey(row)
  if (row.layout === 'continue') return null
  if (row.sourceType === 'simkl') return simklRowCacheKey(row)
  if (row.sourceType && PROVIDER_SOURCES.includes(row.sourceType)) return providerRowCacheKey(row)
  if (row.sourceType === 'discover') return discoverRowCacheKey(row)
  if (row.addonId && row.addonId !== 'com.example.mockaddon') return addonRowCacheKey(row)
  return null
}
