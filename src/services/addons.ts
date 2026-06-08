import type { StremioAddonManifest, SearchResult, StreamResult, SubtitleResult } from '../types'
import { MOCK_ADDON_MANIFEST, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'

export interface InstalledAddon {
  manifest: StremioAddonManifest
  url: string
  enabled: boolean
}

const installedAddons: Map<string, InstalledAddon> = new Map()

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

export async function getAddonCatalog(
  addonUrl: string,
  type: string,
  catalogId: string,
  extra?: Record<string, string>
): Promise<SearchResult[]> {
  let path = `/catalog/${type}/${catalogId}`
  if (extra) {
    const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`)
    if (parts.length) path += `/${parts.join('&')}`
  }
  path += '.json'

  try {
    const res = await fetch(`${baseUrl(addonUrl)}${path}`)
    if (!res.ok) throw new Error(`Addon catalog error: ${res.status}`)
    const data = await res.json()
    return (data.metas || []).map((m: Record<string, unknown>) => ({
      id: m.id as string,
      title: (m.name || m.title || 'Unknown') as string,
      type: (m.type || type) as 'movie' | 'series',
      year: m.releaseInfo ? parseInt(String(m.releaseInfo)) : (m.year ? Number(m.year) : undefined),
      poster: (m.poster || m.posterShape) as string | undefined,
      backdrop: (m.background || m.banner) as string | undefined,
      overview: (m.description || m.overview) as string | undefined,
      rating: m.imdbRating ? parseFloat(String(m.imdbRating)) : undefined,
      imdbId: (m.imdb_id || (typeof m.id === 'string' && (m.id as string).startsWith('tt') ? m.id : undefined)) as string | undefined,
      provider: 'addon',
      addonUrl: addonUrl,
    }))
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
