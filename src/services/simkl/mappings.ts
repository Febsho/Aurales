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

const LS_PREFIX = 'simkl_map_'

export interface MediaRef {
  localId: string           // app's internal ID (e.g. "tt1234567" or "tmdb-12345")
  title: string
  year?: number
  type?: 'movie' | 'show' | 'anime'
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  malId?: number
  anilistId?: number
  simklId?: number          // if already known
}

// ─── Main resolver ─────────────────────────────────────────────────────────────

export async function resolveSimklId(item: MediaRef): Promise<SimklMapping | null> {
  // 1. Check cache
  const cached = getCachedSimklMapping(item.localId)
  if (cached) return cached

  // 2. Direct simklId provided
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

  // 3–5. External IDs
  const byExternal = await searchSimklByExternalIds(item)
  if (byExternal) {
    saveSimklMapping(item.localId, byExternal)
    return byExternal
  }

  // 6. Title + year fuzzy search
  const byTitle = await searchSimklByTitleYear(item)
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

export async function searchSimklByTitleYear(item: MediaRef): Promise<SimklMapping | null> {
  if (!item.title) return null

  const type = item.type === 'show' ? 'show' : item.type === 'anime' ? 'anime' : 'movie'
  const results = await searchSimklItem({ title: item.title, year: item.year, type })

  for (const r of results) {
    const media = r.movie || r.show || r.anime
    if (!media) continue
    if (titleMatches(media.title, item.title) && yearMatches(media.year, item.year)) {
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

export function saveSimklMapping(localMediaId: string, mapping: SimklMapping): void {
  localStorage.setItem(LS_PREFIX + localMediaId, JSON.stringify(mapping))
}

export function getCachedSimklMapping(localMediaId: string): SimklMapping | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + localMediaId)
    if (!raw) return null
    return JSON.parse(raw) as SimklMapping
  } catch (_) { return null }
}

export function clearSimklMapping(localMediaId: string): void {
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
