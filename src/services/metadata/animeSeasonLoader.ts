import { invoke } from '@tauri-apps/api/core'
import type { SeasonDetails } from '../../types'
import { getTvdbApiKey } from '../apiKeys'
import { cacheGet, cacheSet } from '../cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../cache/constants'
import { tvdbProvider } from '../tvdb'

interface NativeAnimeSeasonResponse {
  data: SeasonDetails
  stale: boolean
  cacheStatus: 'hit' | 'miss'
}

const groups = new Map<string, { key: string; generation: number }>()

function staleError(): DOMException {
  return new DOMException('Anime season request was superseded', 'AbortError')
}

function begin(group: string, key: string): number {
  const current = groups.get(group)
  const generation = current?.key === key ? current.generation : (current?.generation || 0) + 1
  groups.set(group, { key, generation })
  return generation
}

function ensureCurrent(group: string, key: string, generation: number): void {
  const current = groups.get(group)
  if (!current || current.key !== key || current.generation !== generation) throw staleError()
}

function nativeCancelled(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return /detail request was (superseded|cancelled)/i.test(message)
}

function cacheKey(tvdbId: string, season: number): string {
  return `tvdb_season:english-v2:${tvdbId}:${season}`
}

async function invokeNative(
  tvdbId: string,
  season: number,
  key: string,
  group: string,
  priority: 'interactive' | 'visible' | 'background',
  forceRefresh: boolean,
): Promise<NativeAnimeSeasonResponse> {
  return invoke('load_anime_season', {
    request: {
      tvdbId,
      season,
      apiKey: getTvdbApiKey(),
      cacheKey: key,
      cancelGroup: group,
      priority,
      forceRefresh,
      timeoutMs: 15_000,
    },
  })
}

/** Canonical TVDB season operation used by anime detail pages. */
export async function loadAnimeSeason(
  tvdbId: string | number,
  season: number,
  options: { cancelGroup?: string; priority?: 'interactive' | 'visible' | 'background' } = {},
): Promise<SeasonDetails> {
  const id = String(tvdbId).replace(/^tvdb[-:]/i, '')
  const key = cacheKey(id, season)
  const group = options.cancelGroup || 'detail:anime-season:visible'
  const generation = begin(group, key)
  const cached = await cacheGet<SeasonDetails>(key)
  if (cached) {
    ensureCurrent(group, key, generation)
    if (cached.stale) {
      void invokeNative(id, season, key, `background:${key}`, 'background', true)
        .then((response) => cacheSet(key, response.data, {
          category: CACHE_CATEGORIES.TVDB_SEASON,
          ttlSeconds: CACHE_TTLS.TVDB_SEASON,
        }))
        .catch(() => undefined)
    }
    return cached.data
  }

  try {
    const response = await invokeNative(id, season, key, group, options.priority || 'interactive', false)
    if (response.stale) throw staleError()
    ensureCurrent(group, key, generation)
    return response.data
  } catch (error) {
    if ((error instanceof DOMException && error.name === 'AbortError') || nativeCancelled(error)) throw staleError()
    const getSeason = tvdbProvider.getSeason as (
      showId: string,
      seasonNumber: number,
      priority?: 'interactive' | 'visible' | 'background',
    ) => Promise<SeasonDetails>
    const fallback = await getSeason(`tvdb-${id}`, season, options.priority === 'background' ? 'background' : 'interactive')
    ensureCurrent(group, key, generation)
    return fallback
  }
}
