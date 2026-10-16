import type { HomeRowConfig } from '../../types'

function storageValue(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function parsedAccount(key: string, field: string): string {
  try {
    const value = JSON.parse(storageValue(key) || 'null') as Record<string, unknown> | null
    return value?.[field] != null ? String(value[field]) : ''
  } catch { return '' }
}

export function addonServerScope(value?: string): string {
  if (!value) return 'unresolved'
  // Addon URLs can contain a private token in their path or query. Keep cache
  // namespaces isolated by server without persisting that URL in cache keys.
  let first = 2166136261
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 2246822519)
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`
}

/** Public catalogs are shared; private provider rows are isolated per account. */
export function providerCacheScope(sourceType?: string): string {
  if (sourceType === 'trakt') return parsedAccount('trakt_account', 'username') || 'anonymous'
  if (sourceType === 'simkl') return parsedAccount('simkl_account', 'id') || 'anonymous'
  if (sourceType === 'anilist') return parsedAccount('anilist_account', 'id') || 'anonymous'
  if (sourceType === 'pmdb' || sourceType === 'pmdb-picks') return storageValue('aurales_cw_credential_scope:pmdb') || 'anonymous'
  if (sourceType === 'mdblist') return storageValue('aurales_cw_credential_scope:mdblist') || 'anonymous'
  if (sourceType === 'jellyfin' || sourceType === 'webdav') return 'native-server-v1'
  return 'public'
}

// Single source of truth for home shelf cache keys. The row components and the
// HomePage batch preloader must agree on these formats — a mismatch silently
// disables the instant-paint path for that shelf.

export function simklRowCacheKey(row: HomeRowConfig): string {
  return `home:simkl:${providerCacheScope('simkl')}:${row.providerListId || 'watchlist'}:${row.sortBy || 'default'}`
}

export function providerRowCacheKey(row: HomeRowConfig): string {
  const version = row.sourceType === 'jellyfin' || row.sourceType === 'webdav' ? 'preview-v1:' : ''
  return `home:provider:${version}${row.sourceType}:${providerCacheScope(row.sourceType)}:${row.providerListId}:${row.sortBy || 'default'}`
}

export function addonRowCacheKey(row: HomeRowConfig, resolvedAddonUrl = row.addonUrl): string {
  const metadataMode = storageValue('aurales_app_managed_metadata') === 'false' ? 'addon' : 'aurales'
  return `home:addon:v4:${metadataMode}:${addonServerScope(resolvedAddonUrl)}:${row.addonId}:${row.catalogType}:${row.catalogId}:${JSON.stringify(row.catalogExtra || {})}`
}

export function discoverRowCacheKey(row: HomeRowConfig): string {
  return `home:discover:${row.id}:${JSON.stringify(row.discoverConfig || {})}`
}

export function heroRowCacheKey(row: HomeRowConfig, resolvedAddonUrl = row.addonUrl): string {
  return `home:hero:v4:${JSON.stringify({
    sourceType: row.sourceType || 'addon',
    addonId: row.addonId || '',
    addonServer: addonServerScope(resolvedAddonUrl),
    catalogType: row.catalogType || '',
    catalogId: row.catalogId || '',
    catalogExtra: row.catalogExtra || {},
    providerListId: row.providerListId || '',
    discoverConfig: row.discoverConfig || null,
    sortBy: row.sortBy || 'default',
    accountScope: providerCacheScope(row.sourceType),
    metadataMode: storageValue('aurales_app_managed_metadata') === 'false' ? 'addon' : 'aurales',
  })}`
}

const PROVIDER_SOURCES = ['trakt', 'pmdb', 'pmdb-picks', 'mdblist', 'anilist', 'jellyfin', 'webdav']

/** Cache key for any configured shelf, or null for rows without a sqlite-backed cache. */
export function homeRowCacheKey(row: HomeRowConfig, resolvedAddonUrl = row.addonUrl): string | null {
  if (row.layout === 'hero') return heroRowCacheKey(row, resolvedAddonUrl)
  if (row.layout === 'continue') return null
  if (row.sourceType === 'simkl') return simklRowCacheKey(row)
  if (row.sourceType && PROVIDER_SOURCES.includes(row.sourceType)) return providerRowCacheKey(row)
  if (row.sourceType === 'discover') return discoverRowCacheKey(row)
  if (row.addonId && row.addonId !== 'com.example.mockaddon') return addonRowCacheKey(row, resolvedAddonUrl)
  return null
}
