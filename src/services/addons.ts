import type { StremioAddonManifest, SearchResult, StreamResult, SubtitleResult } from '../types'
import { MOCK_ADDON_MANIFEST, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'

export interface InstalledAddon {
  manifest: StremioAddonManifest
  url: string
  enabled: boolean
}

const installedAddons: Map<string, InstalledAddon> = new Map()

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

export async function getAddonCatalog(
  addonUrl: string,
  type: string,
  catalogId: string,
  extra?: Record<string, string>
): Promise<SearchResult[]> {
  const baseUrl = addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
  let path = `/catalog/${type}/${catalogId}`
  if (extra) {
    const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`)
    if (parts.length) path += `/${parts.join('&')}`
  }
  path += '.json'

  try {
    const res = await fetch(`${baseUrl}${path}`)
    if (!res.ok) throw new Error(`Addon catalog error: ${res.status}`)
    const data = await res.json()
    return (data.metas || []).map((m: Record<string, unknown>) => ({
      id: m.id as string,
      title: m.name as string,
      type: m.type as 'movie' | 'series',
      year: m.releaseInfo ? parseInt(String(m.releaseInfo)) : undefined,
      poster: m.poster as string | undefined,
      backdrop: m.background as string | undefined,
      overview: m.description as string | undefined,
      rating: m.imdbRating ? parseFloat(String(m.imdbRating)) : undefined,
      provider: 'addon',
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
  const baseUrl = addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
  try {
    const res = await fetch(`${baseUrl}/stream/${type}/${id}.json`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.streams || []) as StreamResult[]
  } catch {
    return []
  }
}

export async function getAddonSubtitles(
  addonUrl: string,
  type: string,
  id: string
): Promise<SubtitleResult[]> {
  const baseUrl = addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
  try {
    const res = await fetch(`${baseUrl}/subtitles/${type}/${id}.json`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.subtitles || []) as SubtitleResult[]
  } catch {
    return []
  }
}

export async function getAddonMeta(
  addonUrl: string,
  type: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const baseUrl = addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
  try {
    const res = await fetch(`${baseUrl}/meta/${type}/${id}.json`)
    if (!res.ok) return null
    const data = await res.json()
    return data.meta || null
  } catch {
    return null
  }
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
