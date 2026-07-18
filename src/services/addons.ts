import type { StremioAddonManifest, SearchResult, StreamResult, SubtitleResult } from '../types'
import { invoke } from '@tauri-apps/api/core'
import { MOCK_ADDON_MANIFEST, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { appMediaToSearchResult, resolveMetadataBatch } from './metadata'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { catalogCacheKey } from './cache/catalogCacheKeys'

export interface InstalledAddon {
  manifest: StremioAddonManifest
  url: string
  enabled: boolean
  /** Local-only label. The manifest identity and name remain untouched. */
  displayName?: string
}

const installedAddons: Map<string, InstalledAddon> = new Map()
const MAX_CATALOG_REQUESTS_PER_ADDON = 1
const ADDON_CATALOG_TIMEOUT_MS = 15_000
const catalogRequestStates = new Map<string, { active: number; waiters: Array<() => void> }>()

async function withAddonRequestSlot<T>(
  addonUrl: string,
  request: () => Promise<T>,
  priority: 'normal' | 'detail' = 'normal',
): Promise<T> {
  let key = baseUrl(addonUrl)
  try {
    // Different configured manifests on the same self-hosted service still
    // share one backend. Limit by origin so separate config paths cannot each
    // open their own burst against that process.
    key = new URL(key).origin
  } catch (_) { /* retain the normalized addon URL */ }
  const state = catalogRequestStates.get(key) || { active: 0, waiters: [] }
  catalogRequestStates.set(key, state)
  if (state.active >= MAX_CATALOG_REQUESTS_PER_ADDON) {
    await new Promise<void>((resolve) => {
      if (priority === 'detail') state.waiters.unshift(resolve)
      else state.waiters.push(resolve)
    })
  }
  state.active += 1
  try {
    return await request()
  } finally {
    state.active -= 1
    const next = state.waiters.shift()
    if (next) next()
    else if (state.active === 0) catalogRequestStates.delete(key)
  }
}

async function fetchAddonResponse(url: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ADDON_CATALOG_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export function syncAddonsFromStore(addons: InstalledAddon[]): void {
  const currentIds = new Set(addons.map((addon) => addon.manifest.id))
  for (const id of installedAddons.keys()) {
    if (!currentIds.has(id)) installedAddons.delete(id)
  }
  for (const addon of addons) {
    installedAddons.set(addon.manifest.id, addon)
  }
}

function addonSupportsResource(manifest: StremioAddonManifest, resourceName: string, type?: string): boolean {
  return manifest.resources.some((r) => {
    if (typeof r === 'string') return r === resourceName
    if (typeof r === 'object' && r !== null) {
      if (r.name !== resourceName) return false
      if (type && r.types && !r.types.includes(type)) return false
      return true
    }
    return false
  })
}

export async function loadAddonManifest(url: string): Promise<StremioAddonManifest> {
  const manifestUrl = url.endsWith('/manifest.json') ? url : `${url.replace(/\/$/, '')}/manifest.json`
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`Failed to load addon manifest: ${res.status}`)
  return await res.json()
}

export function installAddon(manifest: StremioAddonManifest, url: string): void {
  installedAddons.set(manifest.id, { manifest, url, enabled: true })
}

export function uninstallAddon(addonId: string): void {
  installedAddons.delete(addonId)
}

export function getInstalledAddons(): InstalledAddon[] {
  return Array.from(installedAddons.values())
}

export function getAddonById(addonId: string): InstalledAddon | undefined {
  return installedAddons.get(addonId)
}

function baseUrl(addonUrl: string): string {
  return addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
}

function appManagedMetadataEnabled(): boolean {
  return localStorage.getItem('aurales_app_managed_metadata') !== 'false'
}

export function getAddonConfigureUrl(addonUrl: string): string {
  return `${baseUrl(addonUrl)}/configure`
}

function normalizeImageUrl(value: unknown, addonUrl: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || ['poster', 'landscape', 'square'].includes(trimmed)) return undefined

  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) {
    try {
      return new URL(trimmed, `${baseUrl(addonUrl)}/`).toString()
    } catch (_) {
      return undefined
    }
  }
  return undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function parseYear(meta: Record<string, unknown>): number | undefined {
  const value = firstString(meta.releaseInfo, meta.year) || (typeof meta.year === 'number' ? String(meta.year) : undefined)
  const match = value?.match(/\d{4}/)
  return match ? Number(match[0]) : undefined
}

function getImdbId(meta: Record<string, unknown>): string | undefined {
  return firstString(
    meta.imdb_id,
    meta.imdbId,
    typeof meta.id === 'string' && meta.id.startsWith('tt') ? meta.id : undefined,
  )
}

function getIdValue(meta: Record<string, unknown>, ...keys: string[]): string | number | undefined {
  const ids = (meta.ids && typeof meta.ids === 'object') ? meta.ids as Record<string, unknown> : {}
  for (const key of keys) {
    const value = meta[key] ?? ids[key]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return undefined
}

function mapMetaPreview(meta: Record<string, unknown>, type: string, addonUrl: string, addonId?: string): SearchResult {
  const poster = normalizeImageUrl(meta.poster, addonUrl)
  const background = normalizeImageUrl(meta.background, addonUrl)
  const banner = normalizeImageUrl(meta.banner, addonUrl)
  const logo = normalizeImageUrl(meta.logo, addonUrl)

  return {
    id: String(meta.id || ''),
    title: firstString(meta.name, meta.title) || 'Unknown',
    type: (firstString(meta.type) || type) as 'movie' | 'series',
    year: parseYear(meta),
    poster,
    backdrop: background || banner || (poster ? undefined : logo),
    logo,
    overview: firstString(meta.description, meta.overview),
    rating: meta.imdbRating ? parseFloat(String(meta.imdbRating)) : undefined,
    imdbId: getImdbId(meta),
    tmdbId: getIdValue(meta, 'tmdb', 'tmdb_id', 'tmdbId'),
    tvdbId: getIdValue(meta, 'tvdb', 'tvdb_id', 'tvdbId'),
    malId: getIdValue(meta, 'mal', 'mal_id', 'malId'),
    anilistId: getIdValue(meta, 'anilist', 'anilist_id', 'anilistId'),
    provider: 'addon',
    addonUrl,
    sourceAddonId: addonId,
    sourceAddonItemId: String(meta.id || ''),
    // Some addons include complete series metadata in catalog responses.
    // Preserve it so details do not request the same episode data again.
    addonMeta: Array.isArray(meta.videos) && meta.videos.length > 0 ? meta : undefined,
  }
}

function catalogExtraPath(extra?: Record<string, string>): string {
  if (!extra) return ''
  const parts = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  return parts.length ? `/${parts.join('&')}` : ''
}

async function fetchAddonCatalog(
  addonUrl: string,
  type: string,
  catalogId: string,
  extra?: Record<string, string>,
  addonId?: string,
): Promise<SearchResult[]> {
  const path = `/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}${catalogExtraPath(extra)}.json`

  try {
    const res = await withAddonRequestSlot(addonUrl, () => fetchAddonResponse(`${baseUrl(addonUrl)}${path}`))
    if (!res.ok) throw new Error(`Addon catalog error: ${res.status}`)
    const data = await res.json()
    const raw = ((data.metas || []) as Record<string, unknown>[]).filter((m) => m.id)
    const previews = raw.map((m) => mapMetaPreview(m, type, addonUrl, addonId))
    // Keep this in sync with appStore.setAppManagedMetadata. The old
    // `orynt_...` key meant the Settings toggle was ignored and every addon
    // catalog synchronously resolved all entries through external providers.
    const managed = appManagedMetadataEnabled()
    if (!managed) return previews

    const resolved = await resolveMetadataBatch(raw.map((meta, index) => ({
      addonId: addonId || addonUrl, addonUrl, addonType: String(meta.type || type), id: String(meta.id || ''),
      title: previews[index].title, year: previews[index].year, imdbId: previews[index].imdbId,
      tmdbId: Number(previews[index].tmdbId) || undefined, tvdbId: Number(previews[index].tvdbId) || undefined,
      anilistId: Number(previews[index].anilistId) || undefined, malId: Number(previews[index].malId) || undefined,
      rawAddonMeta: meta,
    })))
    const bySourceId = new Map(
      resolved
        .filter((item) => item.sourceMetadataProvider !== 'fallback_addon')
        .map((item) => [item.sourceAddonItemId, item])
    )
    return previews.map((preview) => {
      const item = bySourceId.get(preview.sourceAddonItemId)
      return item ? appMediaToSearchResult(item, addonUrl) : preview
    })
  } catch (_) {
    return []
  }
}

export async function getAddonCatalog(
  addonUrl: string,
  type: string,
  catalogId: string,
  extra?: Record<string, string>,
  addonId?: string,
  _forceRefresh = false,
): Promise<SearchResult[]> {
  const key = catalogCacheKey({
    scope: 'catalog',
    id: catalogId,
    mediaType: type,
    provider: addonId || addonUrl,
    source: addonUrl,
    filters: { extra: extra || {}, appManagedMetadata: appManagedMetadataEnabled() },
    version: 2,
  })
  return cachedFetch(key, () => fetchAddonCatalog(addonUrl, type, catalogId, extra, addonId), {
    category: CACHE_CATEGORIES.ADDON_CATALOG,
    ttlSeconds: CACHE_TTLS.ADDON_CATALOG,
    skipRefreshIf: (cached) => cached.length > 0 && typeof navigator !== 'undefined' && !navigator.onLine,
  })
}

export async function getAddonStreams(
  addonUrl: string,
  type: string,
  id: string
): Promise<StreamResult[]> {
  try {
    const res = await fetch(`${baseUrl(addonUrl)}/stream/${type}/${encodeURIComponent(id)}.json`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.streams || []) as StreamResult[]
  } catch (_) {
    return []
  }
}

/**
 * Strict stream fetch used by the preload scheduler. Unlike getAddonStreams,
 * this preserves timeout/network/malformed-response failures so one bad addon
 * can be measured and isolated without being mistaken for a valid empty result.
 */
export async function fetchAddonStreamsStrict(
  addonUrl: string,
  type: string,
  id: string,
  signal?: AbortSignal,
): Promise<StreamResult[]> {
  const res = await fetch(`${baseUrl(addonUrl)}/stream/${type}/${encodeURIComponent(id)}.json`, { signal })
  if (!res.ok) throw new Error(`Addon stream error: ${res.status}`)
  const data = await res.json() as { streams?: unknown }
  if (data.streams != null && !Array.isArray(data.streams)) throw new Error('Malformed streams response')
  return ((data.streams || []) as unknown[]).filter((stream): stream is StreamResult => Boolean(
    stream && typeof stream === 'object' &&
    ['url', 'externalUrl', 'ytId', 'infoHash'].some((key) => typeof (stream as Record<string, unknown>)[key] === 'string')
  ))
}

export async function getAddonMeta(
  addonUrl: string,
  type: string,
  id: string
): Promise<Record<string, unknown> | null> {
  try {
    const source = baseUrl(addonUrl)
    const key = `addon-meta:v1:${source}:${type}:${id}`
    return await cachedFetch<Record<string, unknown>>(key, async () => {
      const res = await withAddonRequestSlot(
        addonUrl,
        () => fetchAddonResponse(`${source}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`),
        'detail',
      )
      if (!res.ok) throw new Error(`Addon meta error: ${res.status}`)
      const data = await res.json()
      if (!data.meta) throw new Error('Addon meta response is empty')
      return data.meta as Record<string, unknown>
    }, {
      category: CACHE_CATEGORIES.DETAIL_PAGE,
      ttlSeconds: CACHE_TTLS.DETAIL_PAGE,
    })
  } catch (_) {
    return null
  }
}

export async function getAddonSubtitles(
  addonUrl: string,
  type: string,
  id: string
): Promise<SubtitleResult[]> {
  const url = `${baseUrl(addonUrl)}/subtitles/${type}/${encodeURIComponent(id)}.json`
  const normalize = (tracks: unknown[]): SubtitleResult[] => tracks
    .filter((track): track is Record<string, unknown> => Boolean(track) && typeof track === 'object')
    .flatMap((track, index): SubtitleResult[] => {
      const rawUrl = String(track.url || track.path || '').trim()
      if (!rawUrl) return []
      const lang = String(track.lang || track.language || track.languageCode || 'und').trim()
      const label = String(track.label || track.title || track.name || '').trim() || undefined
      try {
        return [{
          id: String(track.id || `addon-sub-${index}`),
          url: new URL(rawUrl, `${baseUrl(addonUrl)}/`).toString(),
          lang,
          label,
        }]
      } catch (_) {
        return [{ id: String(track.id || `addon-sub-${index}`), url: rawUrl, lang, label }]
      }
    })
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return normalize(Array.isArray(data.subtitles) ? data.subtitles : [])
  } catch (_) {
    try {
      const body = await invoke<string>('http_get_text', { url })
      const data = JSON.parse(body)
      return normalize(Array.isArray(data.subtitles) ? data.subtitles : [])
    } catch (_) {
      return []
    }
  }
}

export function getStreamAddons(type: string): InstalledAddon[] {
  return Array.from(installedAddons.values()).filter(
    (a) => a.enabled && addonSupportsResource(a.manifest, 'stream', type)
  )
}

export function getSubtitleAddons(type: string): InstalledAddon[] {
  return Array.from(installedAddons.values()).filter(
    (a) => a.enabled && addonSupportsResource(a.manifest, 'subtitles', type)
  )
}

export function getMetaAddons(type: string): InstalledAddon[] {
  return Array.from(installedAddons.values()).filter(
    (a) => a.enabled && addonSupportsResource(a.manifest, 'meta', type)
  )
}

export function getMockAddon(): InstalledAddon {
  return {
    manifest: MOCK_ADDON_MANIFEST,
    url: 'mock://localhost',
    enabled: true,
  }
}

export function getMockCatalog(catalogId: string): SearchResult[] {
  if (catalogId === 'mock-movies') return MOCK_TRENDING
  if (catalogId === 'mock-series') return MOCK_POPULAR_SHOWS
  return []
}
