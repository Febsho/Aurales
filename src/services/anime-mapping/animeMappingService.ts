import type {
  AnimeMappingInput,
  AnimeMappingResult,
  TvdbEpisodeMappingInput,
  ProviderEpisodeMapping,
  ProviderProgressMappingInput,
  AnimeMappingOverride,
  AnimeMappingCacheKey,
} from './types'
import { isAnimeApiEnabled } from './animeApiClient'
import { resolveFromAnimeApi } from './animeProviderMapper'
import { mapTvdbEpisodeToProviders, isConfidenceSufficient, getOverridesForMedia } from './animeProgressMapper'
import { mapProviderProgressWithAniBridge, mapTvdbEpisodeWithAniBridge } from './anibridgeMappings'
import {
  getCachedAnimeMapping,
  saveAnimeMapping,
  getCachedEpisodeMapping,
  saveEpisodeMapping,
  clearAnimeMappingCache,
} from './animeMappingCache'

const pendingResolutions = new Map<string, Promise<AnimeMappingResult | null>>()

export async function resolveAnimeMappings(input: AnimeMappingInput): Promise<AnimeMappingResult | null> {
  if (!isAnimeApiEnabled()) return null

  const cacheKey = buildCacheKey(input)
  const cached = await getCachedAnimeMapping(cacheKey)
  if (cached) {
    refreshInBackground(input)
    return cached
  }

  const pendingKey = input.localMediaId
  const existing = pendingResolutions.get(pendingKey)
  if (existing) return existing

  const promise = resolveFromAnimeApi(input)
    .then(async (result) => {
      if (result) await saveAnimeMapping(result)
      return result
    })
    .catch((e) => {
      console.warn('[anime-mapping] resolution failed:', e)
      return null
    })
    .finally(() => pendingResolutions.delete(pendingKey))

  pendingResolutions.set(pendingKey, promise)
  return promise
}

export async function mapEpisodeToProviders(input: TvdbEpisodeMappingInput): Promise<ProviderEpisodeMapping | null> {
  if (!isAnimeApiEnabled()) return null

  const anibridge = await mapTvdbEpisodeWithAniBridge(input).catch(() => null)
  if (anibridge) {
    await saveEpisodeMapping(anibridge).catch(() => {})
    return anibridge
  }

  const cached = await getCachedEpisodeMapping(input.tvdbSeriesId, input.tvdbSeasonNumber, input.tvdbEpisodeNumber)
  if (cached) return cached

  const seriesMapping = await resolveAnimeMappings({
    localMediaId: input.localMediaId,
    title: '',
    tvdbId: input.tvdbSeriesId,
  })
  if (!seriesMapping) return null

  const overrides = await getOverridesForMedia(input.localMediaId)
  const mapping = mapTvdbEpisodeToProviders(input, seriesMapping, overrides)

  if (isConfidenceSufficient(mapping)) {
    await saveEpisodeMapping(mapping).catch(() => {})
  }

  return mapping
}

export async function mapProviderProgressToTvdb(input: ProviderProgressMappingInput): Promise<{
  tvdbSeriesId: number
  seasonNumber: number
  episodeNumber: number
} | null> {
  if (!isAnimeApiEnabled()) return null

  const anibridge = await mapProviderProgressWithAniBridge(input).catch(() => null)
  if (anibridge) return anibridge

  const cacheKey: AnimeMappingCacheKey = {}
  if (input.provider === 'anilist') cacheKey.anilistId = Number(input.providerId)
  else if (input.provider === 'mal') cacheKey.malId = Number(input.providerId)

  const cached = await getCachedAnimeMapping(cacheKey)
  if (!cached?.tvdbId) return null

  for (const season of cached.seasons) {
    const providerIdKey = `${input.provider}Id` as keyof typeof season
    const seasonProviderId = season[providerIdKey]
    if (seasonProviderId && Number(seasonProviderId) === Number(input.providerId)) {
      const offset = season.episodeOffset ?? 0
      return {
        tvdbSeriesId: cached.tvdbId,
        seasonNumber: season.seasonNumber,
        episodeNumber: input.providerEpisode - offset,
      }
    }
  }

  return {
    tvdbSeriesId: cached.tvdbId,
    seasonNumber: 1,
    episodeNumber: input.providerEpisode,
  }
}

export async function clearMappingCache(): Promise<number> {
  return clearAnimeMappingCache()
}

export async function reResolveMapping(input: AnimeMappingInput): Promise<AnimeMappingResult | null> {
  const result = await resolveFromAnimeApi(input)
  if (result) await saveAnimeMapping(result)
  return result
}

export { isConfidenceSufficient } from './animeProgressMapper'

function buildCacheKey(input: AnimeMappingInput): AnimeMappingCacheKey {
  if (input.localMediaId) return { localMediaId: input.localMediaId }
  if (input.tvdbId) return { tvdbId: input.tvdbId }
  if (input.anilistId) return { anilistId: input.anilistId }
  if (input.malId) return { malId: input.malId }
  return { localMediaId: input.localMediaId }
}

function refreshInBackground(input: AnimeMappingInput): void {
  const key = `bg:${input.localMediaId}`
  if (pendingResolutions.has(key)) return

  const promise = resolveFromAnimeApi(input)
    .then(async (result) => {
      if (result) await saveAnimeMapping(result)
      return result
    })
    .catch(() => null)
    .finally(() => pendingResolutions.delete(key))

  pendingResolutions.set(key, promise)
}
