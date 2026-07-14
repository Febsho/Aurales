import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES } from './cache/constants'

const API_BASE = 'https://api.ids.moe'
const API_KEY = 'ids_HUUATSvhnnYAfCO0LatQIFAyOyApHB0i7UJJVrKdEVk'
const CACHE_TTL = 14 * 24 * 60 * 60 // 14 days
const REQUEST_TIMEOUT_MS = 4_000

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
  const cacheKey = `ids_moe:${platform}:${id}`
  try {
    return await cachedFetch<IdsMoeResult | null>(cacheKey, async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const res = await fetch(`${API_BASE}/ids/${id}?p=${platform}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))
      if (!res.ok) return null
      return await res.json() as IdsMoeResult
    }, { category: CACHE_CATEGORIES.ANIME_MAPPING, ttlSeconds: CACHE_TTL })
  } catch (_) {
    return null
  }
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
  let result: IdsMoeResult | null = null

  if (known.malId) result = await fetchIds(known.malId, 'mal')
  if (!result && known.anilistId) result = await fetchIds(known.anilistId, 'anilist')
  if (!result && known.imdbId) result = await fetchIds(known.imdbId, 'imdb')
  if (!result && known.tmdbId) result = await fetchIds(known.tmdbId, 'tmdb')
  if (!result && known.traktId) result = await fetchIds(known.traktId, 'trakt')
  if (!result && known.simklId) result = await fetchIds(known.simklId, 'simkl')

  return result ? toResolved(result) : null
}
