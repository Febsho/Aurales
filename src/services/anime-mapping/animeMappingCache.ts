import { cacheGet, cacheSet, cacheClearCategory } from '../cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../cache/constants'
import type { AnimeMappingResult, ProviderEpisodeMapping, AnimeMappingCacheKey, AnimeMappingOverride } from './types'

function seriesCacheKey(key: AnimeMappingCacheKey): string | null {
  if (key.localMediaId) return `anime-map:local:${key.localMediaId}`
  if (key.tvdbId) return `anime-map:tvdb:${key.tvdbId}`
  if (key.anilistId) return `anime-map:anilist:${key.anilistId}`
  if (key.malId) return `anime-map:mal:${key.malId}`
  return null
}

function episodeCacheKey(tvdbSeriesId: number, season: number, episode: number): string {
  return `anime-ep-map:${tvdbSeriesId}:${season}:${episode}`
}

function overrideCacheKey(localMediaId: string): string {
  return `anime-override:${localMediaId}`
}

export async function getCachedAnimeMapping(key: AnimeMappingCacheKey): Promise<AnimeMappingResult | null> {
  const cacheKey = seriesCacheKey(key)
  if (!cacheKey) return null
  const result = await cacheGet<AnimeMappingResult>(cacheKey)
  return result?.data ?? null
}

export async function saveAnimeMapping(mapping: AnimeMappingResult): Promise<void> {
  const isAiring = !mapping.updatedAt
  const ttl = isAiring ? CACHE_TTLS.ANIME_MAPPING_AIRING : CACHE_TTLS.ANIME_MAPPING_FINISHED
  const opts = { category: CACHE_CATEGORIES.ANIME_MAPPING, ttlSeconds: ttl }

  const keys: AnimeMappingCacheKey[] = [{ localMediaId: mapping.localMediaId }]
  if (mapping.tvdbId) keys.push({ tvdbId: mapping.tvdbId })
  if (mapping.anilistId) keys.push({ anilistId: mapping.anilistId })
  if (mapping.malId) keys.push({ malId: mapping.malId })

  await Promise.all(
    keys.map((k) => {
      const cacheKey = seriesCacheKey(k)
      return cacheKey ? cacheSet(cacheKey, mapping, opts) : Promise.resolve()
    }),
  )
}

export async function getCachedEpisodeMapping(
  tvdbSeriesId: number,
  season: number,
  episode: number,
): Promise<ProviderEpisodeMapping | null> {
  const key = episodeCacheKey(tvdbSeriesId, season, episode)
  const result = await cacheGet<ProviderEpisodeMapping>(key)
  return result?.data ?? null
}

export async function saveEpisodeMapping(mapping: ProviderEpisodeMapping): Promise<void> {
  const key = episodeCacheKey(mapping.tvdbSeriesId, mapping.tvdbSeasonNumber, mapping.tvdbEpisodeNumber)
  await cacheSet(key, mapping, {
    category: CACHE_CATEGORIES.ANIME_MAPPING,
    ttlSeconds: CACHE_TTLS.ANIME_MAPPING_FINISHED,
  })
}

export async function getCachedOverrides(localMediaId: string): Promise<AnimeMappingOverride[]> {
  const key = overrideCacheKey(localMediaId)
  const result = await cacheGet<AnimeMappingOverride[]>(key)
  return result?.data ?? []
}

export async function saveOverrides(localMediaId: string, overrides: AnimeMappingOverride[]): Promise<void> {
  const key = overrideCacheKey(localMediaId)
  await cacheSet(key, overrides, {
    category: CACHE_CATEGORIES.ANIME_MAPPING,
    ttlSeconds: CACHE_TTLS.ANIME_MAPPING_FINISHED,
  })
}

export async function clearAnimeMappingCache(): Promise<number> {
  return cacheClearCategory(CACHE_CATEGORIES.ANIME_MAPPING)
}
