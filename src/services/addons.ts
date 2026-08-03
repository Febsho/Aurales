import type { StremioAddonManifest, SearchResult, StreamResult, SubtitleResult } from '../types'
import { invoke } from '@tauri-apps/api/core'
import { MOCK_ADDON_MANIFEST, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { catalogCacheKey } from './cache/catalogCacheKeys'
import { coordinatedJson, type RequestPriority } from './network/requestCoordinator'
import { recoverArtworkSource } from './imageCache'

export interface InstalledAddon {
  manifest: StremioAddonManifest
  url: string
  enabled: boolean
  /** Local-only label. The manifest identity and name remain untouched. */
  displayName?: string
}

const installedAddons: Map<string, InstalledAddon> = new Map()
const ADDON_CATALOG_TIMEOUT_MS = 15_000

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
  return coordinatedJson<StremioAddonManifest>(manifestUrl, {}, {
    label: addonLabel(url),
    kind: 'addon',
    dedupeKey: `manifest:${baseUrl(url)}`,
    priority: 'interactive',
    timeoutMs: ADDON_CATALOG_TIMEOUT_MS,
    retry: 'interactive-once',
  })
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

function addonLabel(addonUrl: string): string {
  const installed = [...installedAddons.values()].find((addon) => baseUrl(addon.url) === baseUrl(addonUrl))
  if (installed) return installed.displayName || installed.manifest.name
  try { return new URL(addonUrl).hostname } catch { return 'Addon' }
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
  if (/^https?:\/\//i.test(trimmed)) return recoverArtworkSource(trimmed)
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
  requestContext?: { cancelGroup?: string; priority?: RequestPriority },
): Promise<SearchResult[]> {
  const path = `/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}${catalogExtraPath(extra)}.json`

  try {
    const data = await coordinatedJson<{ metas?: Record<string, unknown>[] }>(`${baseUrl(addonUrl)}${path}`, {}, {
      label: addonLabel(addonUrl),
      kind: 'addon',
      dedupeKey: `catalog:${type}:${catalogId}:${catalogExtraPath(extra)}`,
      priority: requestContext?.priority || 'visible',
      cancelGroup: requestContext?.cancelGroup,
      timeoutMs: ADDON_CATALOG_TIMEOUT_MS,
      retry: 'interactive-once',
    })
    const raw = ((data.metas || []) as Record<string, unknown>[]).filter((m) => m.id)
    const previews = raw.map((m) => mapMetaPreview(m, type, addonUrl, addonId))
    // Catalogs are previews. Resolving every result here used to turn one
    // addon request into dozens of metadata/artwork calls before first paint.
    // Visible cards and detail pages enrich only what the user can see.
    return previews
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
  requestContext?: { cancelGroup?: string; priority?: RequestPriority },
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
  return cachedFetch(key, (cacheContext) => fetchAddonCatalog(addonUrl, type, catalogId, extra, addonId, {
    ...requestContext,
    priority: cacheContext?.background ? 'background' : requestContext?.priority,
  }), {
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
    const data = await coordinatedJson<{ streams?: StreamResult[] }>(`${baseUrl(addonUrl)}/stream/${type}/${encodeURIComponent(id)}.json`, {}, {
      label: addonLabel(addonUrl),
      kind: 'addon',
      dedupeKey: `stream:${type}:${id}`,
      priority: 'playback',
      timeoutMs: 8_000,
      retry: 'interactive-once',
    })
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
  priority: RequestPriority = 'playback',
): Promise<StreamResult[]> {
  const group = signal ? `stream:${type}:${id}:${Math.random().toString(36).slice(2)}` : undefined
  if (signal && group) {
    signal.addEventListener('abort', () => {
      import('./network/requestCoordinator').then(({ cancelRequestGroup }) => cancelRequestGroup(group))
    }, { once: true })
  }
  const data = await coordinatedJson<{ streams?: unknown }>(`${baseUrl(addonUrl)}/stream/${type}/${encodeURIComponent(id)}.json`, {}, {
    label: addonLabel(addonUrl),
    kind: 'addon',
    dedupeKey: `stream:${type}:${id}`,
    priority,
    cancelGroup: group,
    timeoutMs: 8_000,
    retry: priority === 'background' ? 'none' : 'interactive-once',
  })
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
      const data = await coordinatedJson<{ meta?: Record<string, unknown> }>(`${source}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, {}, {
        label: addonLabel(addonUrl),
        kind: 'addon',
        dedupeKey: `meta:${type}:${id}`,
        priority: 'interactive',
        timeoutMs: ADDON_CATALOG_TIMEOUT_MS,
        retry: 'interactive-once',
      })
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
    return await cachedFetch<SubtitleResult[]>(`addon-subtitle:v1:${baseUrl(addonUrl)}:${type}:${id}`, async () => {
      const data = await coordinatedJson<{ subtitles?: unknown[] }>(url, {}, {
        label: addonLabel(addonUrl),
        kind: 'addon',
        dedupeKey: `subtitles:${type}:${id}`,
        priority: 'playback',
        timeoutMs: 8_000,
        retry: 'interactive-once',
      })
      return normalize(Array.isArray(data.subtitles) ? data.subtitles : [])
    }, {
      category: CACHE_CATEGORIES.ADDON_SUBTITLE,
      ttlSeconds: CACHE_TTLS.ADDON_SUBTITLE,
      cacheEmptyResults: true,
    })
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
