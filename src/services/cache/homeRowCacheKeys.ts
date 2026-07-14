import type { HomeRowConfig } from '../../types'

function parsedAccount(key: string, field: string): string {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as Record<string, unknown> | null
    return value?.[field] != null ? String(value[field]) : ''
  } catch { return '' }
}

/** Public catalogs are shared; private provider rows are isolated per account. */
export function providerCacheScope(sourceType?: string): string {
  if (sourceType === 'trakt') return parsedAccount('trakt_account', 'username') || 'anonymous'
  if (sourceType === 'simkl') return parsedAccount('simkl_account', 'id') || 'anonymous'
  if (sourceType === 'anilist') return parsedAccount('anilist_account', 'id') || 'anonymous'
  if (sourceType === 'pmdb' || sourceType === 'pmdb-picks') return localStorage.getItem('aurales_cw_credential_scope:pmdb') || 'anonymous'
  if (sourceType === 'mdblist') return localStorage.getItem('aurales_cw_credential_scope:mdblist') || 'anonymous'
  return 'public'
}

// Single source of truth for home shelf cache keys. The row components and the
// HomePage batch preloader must agree on these formats — a mismatch silently
// disables the instant-paint path for that shelf.

export function simklRowCacheKey(row: HomeRowConfig): string {
  return `home:simkl:${providerCacheScope('simkl')}:${row.providerListId || 'watchlist'}:${row.sortBy || 'default'}`
}

export function providerRowCacheKey(row: HomeRowConfig): string {
  return `home:provider:${row.sourceType}:${providerCacheScope(row.sourceType)}:${row.providerListId}:${row.sortBy || 'default'}`
}

export function addonRowCacheKey(row: HomeRowConfig): string {
  return `home:addon:v2:${row.addonId}:${row.catalogType}:${row.catalogId}:${JSON.stringify(row.catalogExtra || {})}`
}

export function discoverRowCacheKey(row: HomeRowConfig): string {
  return `home:discover:${row.id}:${JSON.stringify(row.discoverConfig || {})}`
}

export function heroRowCacheKey(row: HomeRowConfig): string {
  return `home:hero:v2:${JSON.stringify({
    sourceType: row.sourceType || 'addon',
    addonId: row.addonId || '',
    addonUrl: row.addonUrl || '',
    catalogType: row.catalogType || '',
    catalogId: row.catalogId || '',
    catalogExtra: row.catalogExtra || {},
    providerListId: row.providerListId || '',
    discoverConfig: row.discoverConfig || null,
    sortBy: row.sortBy || 'default',
    accountScope: providerCacheScope(row.sourceType),
  })}`
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
