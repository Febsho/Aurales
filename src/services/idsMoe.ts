import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES } from './cache/constants'
import { readBoundedResponseJson } from './network/boundedResponse'

const API_BASE = 'https://api.ids.moe'
const API_KEY = 'ids_HUUATSvhnnYAfCO0LatQIFAyOyApHB0i7UJJVrKdEVk'
const CACHE_TTL = 14 * 24 * 60 * 60 // 14 days
const REQUEST_TIMEOUT_MS = 4_000
const FAILURE_RETRY_MS = 60_000
const MAX_FAILED_KEYS = 500
const MAX_IDS_MOE_RESPONSE_BYTES = 1024 * 1024
const pendingRequests = new Map<string, Promise<IdsMoeResult | null>>()
const failedAt = new Map<string, number>()

function rememberFailure(key: string): void {
  failedAt.delete(key)
  failedAt.set(key, Date.now())
  while (failedAt.size > MAX_FAILED_KEYS) {
    const oldest = failedAt.keys().next().value
    if (!oldest) break
    failedAt.delete(oldest)
  }
}

interface IdsMoeResult {
  title?: string
  myanimelist?: number | null
  anilist?: number | null
  anidb?: number | null
  kitsu?: number | null
  imdb?: string | null
  themoviedb?: number | null
  themoviedb_type?: 'movie' | 'tv' | null
  themoviedb_season?: number | null
  trakt?: number | null
  trakt_type?: 'movies' | 'shows' | null
  trakt_season?: number | null
  simkl?: number | null
  livechart?: number | null
}

export interface ResolvedAnimeIds {
  anilistId?: number
  malId?: number
  tmdbId?: number
  tmdbType?: 'movie' | 'tv'
  tmdbSeason?: number
  imdbId?: string
  traktId?: number
  traktType?: 'movies' | 'shows'
  traktSeason?: number
  simklId?: number
  kitsuId?: number
  anidbId?: number
}

type Platform = 'mal' | 'anilist' | 'imdb' | 'tmdb' | 'trakt' | 'simkl' | 'kitsu' | 'anidb'

async function fetchIds(id: string | number, platform: Platform): Promise<IdsMoeResult | null> {
  // v2 avoids legacy 14-day cached nulls written by older builds after HTTP
  // failures were incorrectly returned as successful empty mappings.
  const cacheKey = `ids_moe:v2:${platform}:${id}`
  const lastFailure = failedAt.get(cacheKey)
  if (lastFailure && Date.now() - lastFailure < FAILURE_RETRY_MS) return null
  const pending = pendingRequests.get(cacheKey)
  if (pending) return pending

  const request = (async () => {
    try {
      const result = await cachedFetch<IdsMoeResult | null>(cacheKey, async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const res = await fetch(`${API_BASE}/ids/${id}?p=${platform}`, {
          headers: { 'Authorization': `Bearer ${API_KEY}` },
          signal: controller.signal,
        })
        if (!res.ok) {
          await res.body?.cancel()
          throw new Error(`IDs.moe returned HTTP ${res.status}`)
        }
        const data = await readBoundedResponseJson<IdsMoeResult | null>(res, MAX_IDS_MOE_RESPONSE_BYTES, 'IDs.moe response')
        if (!data) throw new Error('IDs.moe returned no mapping')
        const hasResolvedId = [
          data.myanimelist, data.anilist, data.anidb, data.kitsu, data.imdb,
          data.themoviedb, data.trakt, data.simkl, data.livechart,
        ].some((value) => value != null && value !== '')
        if (!hasResolvedId) throw new Error('IDs.moe returned no resolved IDs')
        return data
      } finally {
        clearTimeout(timeout)
      }
      }, { category: CACHE_CATEGORIES.ANIME_MAPPING, ttlSeconds: CACHE_TTL })
      if (result) failedAt.delete(cacheKey)
      else rememberFailure(cacheKey)
      return result
    } catch (_) {
      rememberFailure(cacheKey)
      return null
    }
  })().finally(() => pendingRequests.delete(cacheKey))
  pendingRequests.set(cacheKey, request)
  return request
}

function toResolved(r: IdsMoeResult): ResolvedAnimeIds {
  return {
    anilistId: r.anilist ?? undefined,
    malId: r.myanimelist ?? undefined,
    tmdbId: r.themoviedb ?? undefined,
    tmdbType: r.themoviedb_type ?? undefined,
    tmdbSeason: r.themoviedb_season ?? undefined,
    imdbId: r.imdb ?? undefined,
    traktId: r.trakt ?? undefined,
    traktType: r.trakt_type ?? undefined,
    traktSeason: r.trakt_season ?? undefined,
    simklId: r.simkl ?? undefined,
    kitsuId: r.kitsu ?? undefined,
    anidbId: r.anidb ?? undefined,
  }
}

export async function resolveViaIdsMoe(known: {
  anilistId?: number
  malId?: number
  tmdbId?: number
  imdbId?: string
  traktId?: number
  simklId?: number
}): Promise<ResolvedAnimeIds | null> {
  // Each endpoint returns the complete cross-provider record. Retrying the
  // same title through every known alias turns one unavailable service into a
  // 16–24 second serial wait and multiplies traffic across episode cards.
  // Prefer the anime-native identifier and let a later explicit retry try
  // again after the short negative-cache window.
  const candidate: [string | number, Platform] | undefined = known.malId
    ? [known.malId, 'mal']
    : known.anilistId
      ? [known.anilistId, 'anilist']
      : known.imdbId
        ? [known.imdbId, 'imdb']
        : known.tmdbId
          ? [known.tmdbId, 'tmdb']
          : known.traktId
            ? [known.traktId, 'trakt']
            : known.simklId
              ? [known.simklId, 'simkl']
              : undefined
  const result = candidate ? await fetchIds(candidate[0], candidate[1]) : null

  return result ? toResolved(result) : null
}
