import type { HomeRowConfig, SearchResult } from '../../types'
import { homeRowCacheKey } from './homeRowCacheKeys'

const STORAGE_PREFIX = 'aurales_home_shelf_startup_v1:profile:'
const MAX_ROWS = 3
const MAX_ITEMS = 12

interface ShelfSnapshot {
  version: 1
  rows: Record<string, SearchResult[]>
}

function storageKey(): string {
  return `${STORAGE_PREFIX}${localStorage.getItem('aurales_active_profile_v1') || 'default'}`
}

function readState(): ShelfSnapshot {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) || 'null') as ShelfSnapshot | null
    return value?.version === 1 && value.rows && typeof value.rows === 'object' ? value : { version: 1, rows: {} }
  } catch {
    return { version: 1, rows: {} }
  }
}

export function readHomeShelfStartupSnapshot(key: string | null): SearchResult[] | null {
  if (!key) return null
  const items = readState().rows[key]
  if (!Array.isArray(items)) return null
  const valid = items.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && (item.type === 'movie' || item.type === 'series'))
  return valid.length ? valid.slice(0, MAX_ITEMS) : null
}

export function writeHomeShelfStartupSnapshots(rows: HomeRowConfig[], getItems: (key: string) => SearchResult[] | null): void {
  const previous = readState().rows
  const next: ShelfSnapshot['rows'] = {}
  for (const row of rows.filter((item) => item.enabled && item.layout !== 'hero' && item.layout !== 'continue').sort((a, b) => a.order - b.order).slice(0, MAX_ROWS)) {
    const key = homeRowCacheKey(row)
    if (!key) continue
    const items = getItems(key) || previous[key]
    if (!Array.isArray(items) || !items.length) continue
    next[key] = items.slice(0, MAX_ITEMS).map((item) => ({
      id: item.id, title: item.title, type: item.type, provider: item.provider,
      year: item.year, poster: item.poster, backdrop: item.backdrop, logo: item.logo,
      overview: item.overview, rating: item.rating, runtime: item.runtime,
      releaseDate: item.releaseDate, genres: item.genres, genreIds: item.genreIds,
      imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId,
      malId: item.malId, anilistId: item.anilistId, isAnime: item.isAnime,
      originalLanguage: item.originalLanguage, addonUrl: item.addonUrl,
      sourceAddonId: item.sourceAddonId, sourceAddonItemId: item.sourceAddonItemId,
    }))
  }
  try { localStorage.setItem(storageKey(), JSON.stringify({ version: 1, rows: next } satisfies ShelfSnapshot)) } catch { /* SQLite remains authoritative if local storage is full. */ }
}

export function clearHomeShelfStartupSnapshots(): void {
  try { localStorage.removeItem(storageKey()) } catch { /* Local storage unavailable. */ }
}
