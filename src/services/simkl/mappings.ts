/**
 * ID-mapping layer.
 *
 * Priority order for resolving a local media item to a Simkl ID:
 *   1. Direct simklId from addon or prior cache
 *   2. IMDb ID
 *   3. TVDB ID
 *   4. TMDB ID
 *   5. MAL ID (anime)
 *   6. Title + year fuzzy search fallback
 *
 * Successful mappings are stored in localStorage (keyed by local media ID)
 * so repeated lookups avoid extra network requests.
 *
 * TODO: migrate storage to SQLite via Tauri invoke for persistence across
 * localStorage clears.
 */

import { resolveSimklMapping, searchSimklItem } from './client'
import type { SimklMapping } from './types'

const LS_PREFIX = 'simkl_map_v2_'
const LEGACY_PREFIX = 'simkl_map_'
const MIGRATION_KEY = 'simkl_map_v2_migrated'

export interface MediaRef {
  localId: string           // app's internal ID (e.g. "tt1234567" or "tmdb-12345")
  title: string
  year?: number
  type?: 'movie' | 'show' | 'anime'
  /** App structure, kept separate from the provider's anime category. */
  contentType?: 'movie' | 'series'
  isAnime?: boolean
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  malId?: number
  anilistId?: number
  simklId?: number          // if already known
  /** Alternate season/cour IDs belonging to the same local series. */
  simklIds?: number[]
}

// ─── Main resolver ─────────────────────────────────────────────────────────────

export interface SimklResolveOptions {
  allowTitleFallback?: boolean
  /** Permit only an exact normalized title and compatible year match. */
  allowExactTitleFallback?: boolean
}

export async function resolveSimklId(item: MediaRef, options: SimklResolveOptions = {}): Promise<SimklMapping | null> {
  // A direct provider ID is authoritative. Anime episode mapping can point at
  // a different SIMKL entry than a previously cached show/title mapping (for
  // split cours, seasons, specials, and movies), so never let the local-ID
  // cache override it.
  if (item.simklId) {
    const mapping: SimklMapping = {
      simklId: item.simklId,
      imdbId: item.imdbId,
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId,
      malId: item.malId,
      type: item.type ?? 'movie',
      title: item.title,
      year: item.year,
    }
    saveSimklMapping(item.localId, mapping)
    return mapping
  }

  // Reuse a cached mapping only when no authoritative provider ID was supplied.
  const cached = getCachedSimklMapping(item.localId)
  if (cached) return cached

  // External IDs
  const byExternal = await searchSimklByExternalIds(item)
  if (byExternal) {
    saveSimklMapping(item.localId, byExternal)
    return byExternal
  }

  // 6. Title + year fuzzy search
  if (options.allowTitleFallback === false && !options.allowExactTitleFallback) return null
  const byTitle = await searchSimklByTitleYear(item, { exactYear: options.allowExactTitleFallback === true })
  if (byTitle) {
    saveSimklMapping(item.localId, byTitle)
    return byTitle
  }

  return null
}

// ─── External ID search ────────────────────────────────────────────────────────

export async function searchSimklByExternalIds(item: MediaRef): Promise<SimklMapping | null> {
  return resolveSimklMapping({
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
  })
}

// ─── Title + year fuzzy search ─────────────────────────────────────────────────

export async function searchSimklByTitleYear(item: MediaRef, options: { exactYear?: boolean } = {}): Promise<SimklMapping | null> {
  if (!item.title) return null

  // Simkl can classify anime films under either its anime or movie index.
  const types = item.isAnime && item.contentType === 'movie'
    ? (['anime', 'movie'] as const)
    : ([item.type === 'show' ? 'show' : item.type === 'anime' ? 'anime' : 'movie'] as const)
  const results = (await Promise.all(types.map((type) =>
    searchSimklItem({ title: item.title, year: item.year, type }).catch(() => [])
  ))).flat()

  for (const r of results) {
    const media = r.movie || r.show || r.anime
    if (!media) continue
    const yearMatchesRequest = options.exactYear
      ? exactYearMatches(media.year, item.year)
      : yearMatches(media.year, item.year)
    if (titleMatches(media.title, item.title) && yearMatchesRequest) {
      const rType = r.movie ? 'movie' : r.show ? 'show' : 'anime'
      return {
        simklId: media.ids.simkl || media.ids.simkl_id,
        imdbId: media.ids.imdb,
        tmdbId: media.ids.tmdb,
        tvdbId: media.ids.tvdb,
        malId: media.ids.mal,
        type: rType,
        title: media.title,
        year: media.year,
      }
    }
  }
  return null
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

function clearLegacyMappingsOnce(): void {
  if (localStorage.getItem(MIGRATION_KEY) === 'true') return
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(LEGACY_PREFIX) && !key.startsWith(LS_PREFIX)) keys.push(key)
  }
  keys.forEach((key) => localStorage.removeItem(key))
  localStorage.setItem(MIGRATION_KEY, 'true')
}

export function saveSimklMapping(localMediaId: string, mapping: SimklMapping): void {
  clearLegacyMappingsOnce()
  localStorage.setItem(LS_PREFIX + localMediaId, JSON.stringify(mapping))
}

export function getCachedSimklMapping(localMediaId: string): SimklMapping | null {
  clearLegacyMappingsOnce()
  try {
    const raw = localStorage.getItem(LS_PREFIX + localMediaId)
    if (!raw) return null
    return JSON.parse(raw) as SimklMapping
  } catch (_) { return null }
}

export function clearSimklMapping(localMediaId: string): void {
  clearLegacyMappingsOnce()
  localStorage.removeItem(LS_PREFIX + localMediaId)
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function titleMatches(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm(a) === norm(b)
}

function yearMatches(a?: number, b?: number): boolean {
  if (!a || !b) return true // no year → accept
  return Math.abs(a - b) <= 1 // ±1 year tolerance
}

function exactYearMatches(a?: number, b?: number): boolean {
  if (!a || !b) return true
  return a === b
}
