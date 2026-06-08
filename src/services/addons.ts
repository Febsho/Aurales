import type { StremioAddonManifest, SearchResult, StreamResult, SubtitleResult } from '../types'
import { MOCK_ADDON_MANIFEST, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'

export interface InstalledAddon {
  manifest: StremioAddonManifest
  url: string
  enabled: boolean
}

const installedAddons: Map<string, InstalledAddon> = new Map()

export function syncAddonsFromStore(addons: InstalledAddon[]): void {
  for (const addon of addons) {
    if (!installedAddons.has(addon.manifest.id)) {
      installedAddons.set(addon.manifest.id, addon)
    }
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

function normalizeImageUrl(value: unknown, addonUrl: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || ['poster', 'landscape', 'square'].includes(trimmed)) return undefined

  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) {
    try {
      return new URL(trimmed, `${baseUrl(addonUrl)}/`).toString()
    } catch {
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

function mapMetaPreview(meta: Record<string, unknown>, type: string, addonUrl: string): SearchResult {
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
    overview: firstString(meta.description, meta.overview),
    rating: meta.imdbRating ? parseFloat(String(meta.imdbRating)) : undefined,
    imdbId: getImdbId(meta),
    provider: 'addon',
    addonUrl,
  }
}

function catalogExtraPath(extra?: Record<string, string>): string {
  if (!extra) return ''
  const parts = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  return parts.length ? `/${parts.join('&')}` : ''
}

export async function getAddonCatalog(
  addonUrl: string,
  type: string,
  catalogId: string,
  extra?: Record<string, string>
): Promise<SearchResult[]> {
  const path = `/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}${catalogExtraPath(extra)}.json`

  try {
    const res = await fetch(`${baseUrl(addonUrl)}${path}`)
    if (!res.ok) throw new Error(`Addon catalog error: ${res.status}`)
    const data = await res.json()
    return ((data.metas || []) as Record<string, unknown>[])
      .map((m) => mapMetaPreview(m, type, addonUrl))
      .filter((m) => m.id)
  } catch {
    return []
  }
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
  } catch {
    return []
  }
}

export async function getAddonMeta(
  addonUrl: string,
  type: string,
  id: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${baseUrl(addonUrl)}/meta/${type}/${encodeURIComponent(id)}.json`)
    if (!res.ok) return null
    const data = await res.json()
    return data.meta || null
  } catch {
    return null
  }
}

export async function getAddonSubtitles(
  addonUrl: string,
  type: string,
  id: string
): Promise<SubtitleResult[]> {
  try {
    const res = await fetch(`${baseUrl(addonUrl)}/subtitles/${type}/${encodeURIComponent(id)}.json`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.subtitles || []) as SubtitleResult[]
  } catch {
    return []
  }
}

export function getStreamAddons(type: string): InstalledAddon[] {
  return Array.from(installedAddons.values()).filter(
    (a) => a.enabled && addonSupportsResource(a.manifest, 'stream', type)
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
