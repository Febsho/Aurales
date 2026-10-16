import type {
  AnimeMappingInput,
  AnimeMappingResult,
  TvdbEpisodeMappingInput,
  ProviderEpisodeMapping,
  ProviderProgressMappingInput,
  AnimeMappingCacheKey,
} from './types'
import { isAnimeApiEnabled } from './animeApiClient'
import { resolveFromAnimeApi } from './animeProviderMapper'
import { mapTvdbEpisodeToProviders, isConfidenceSufficient, getOverridesForMedia } from './animeProgressMapper'
import { mapProviderProgressWithAniBridge, mapTvdbEpisodeWithAniBridge } from './anibridgeMappings'
import { cacheCategoryGeneration } from '../cache/sqliteCache'
import { CACHE_CATEGORIES } from '../cache/constants'
import {
  getCachedAnimeMapping,
  saveAnimeMapping,
  getCachedEpisodeMapping,
  saveEpisodeMapping,
  clearAnimeMappingCache,
} from './animeMappingCache'

const pendingResolutions = new Map<string, Promise<AnimeMappingResult | null>>()
let mappingGeneration = 0

function resolutionKey(input: AnimeMappingInput): string {
  return JSON.stringify([
    input.localMediaId,
    input.contentType ?? 'series',
    input.title.trim().toLowerCase(),
    input.year ?? null,
    input.tvdbId ?? null,
    input.tmdbId ?? null,
    input.imdbId ?? null,
    input.anilistId ?? null,
    input.malId ?? null,
    input.simklId ?? null,
    input.traktId ?? null,
    input.seasonNumber ?? null,
    input.episodeNumber ?? null,
    input.absoluteEpisodeNumber ?? null,
  ])
}

function currentMappingGeneration(): string {
  return `${mappingGeneration}:${cacheCategoryGeneration(CACHE_CATEGORIES.ANIME_MAPPING)}`
}

export async function resolveAnimeMappings(input: AnimeMappingInput): Promise<AnimeMappingResult | null> {
  if (!isAnimeApiEnabled()) return null

  const generation = currentMappingGeneration()
  const cacheKey = buildCacheKey(input)
  const cached = await getCachedAnimeMapping(cacheKey)
  if (generation !== currentMappingGeneration()) return resolveAnimeMappings(input)
  if (cached) {
    refreshInBackground(input, generation)
    return cached
  }

  const pendingKey = `${generation}:${resolutionKey(input)}`
  const existing = pendingResolutions.get(pendingKey)
  if (existing) return existing

  const promise: Promise<AnimeMappingResult | null> = resolveFromAnimeApi(input)
    .then(async (result) => {
      if (generation !== currentMappingGeneration()) return resolveAnimeMappings(input)
      if (result) await saveAnimeMapping(result)
      return result
    })
    .catch((e) => {
      console.warn('[anime-mapping] resolution failed:', e)
      return null
    })
    .finally(() => {
      if (pendingResolutions.get(pendingKey) === promise) pendingResolutions.delete(pendingKey)
    })

  pendingResolutions.set(pendingKey, promise)
  return promise
}

export async function mapEpisodeToProviders(input: TvdbEpisodeMappingInput): Promise<ProviderEpisodeMapping | null> {
  const generation = currentMappingGeneration()
  const anibridge = await mapTvdbEpisodeWithAniBridge(input).catch(() => null)
  if (generation !== currentMappingGeneration()) return mapEpisodeToProviders(input)
  const local = await import('../animeLists')
    .then(({ mapTvdbEpisodeToAnimeProvidersLocal }) => mapTvdbEpisodeToAnimeProvidersLocal(
      input.tvdbSeriesId,
      input.tvdbSeasonNumber,
      input.tvdbEpisodeNumber,
    ))
    .catch(() => null)
  if (generation !== currentMappingGeneration()) return mapEpisodeToProviders(input)

  if (anibridge || local) {
    const now = new Date().toISOString()
    const merged: ProviderEpisodeMapping = {
      tvdbSeriesId: input.tvdbSeriesId,
      tvdbSeasonNumber: input.tvdbSeasonNumber,
      tvdbEpisodeNumber: input.tvdbEpisodeNumber,
      tvdbEpisodeId: input.tvdbEpisodeId,
      anilist: anibridge?.anilist ?? (local?.anilistId ? { mediaId: local.anilistId, episodeNumber: local.episode } : undefined),
      mal: anibridge?.mal ?? (local?.malId ? { id: local.malId, episodeNumber: local.episode } : undefined),
      simkl: local?.simklId ? { id: local.simklId, seasonNumber: 1, episodeNumber: local.episode } : undefined,
      trakt: anibridge?.trakt ?? (local?.traktId ? { id: local.traktId, seasonNumber: local.season, episodeNumber: input.tvdbEpisodeNumber } : undefined),
      tmdb: anibridge?.tmdb ?? (local?.tmdbId ? {
        id: local.tmdbId,
        seasonNumber: local.tmdbSeason ?? local.season,
        episodeNumber: local.tmdbEpisode ?? input.tvdbEpisodeNumber,
      } : undefined),
      confidence: anibridge ? anibridge.confidence : 0.85,
      source: anibridge ? anibridge.source : 'animeLists',
      updatedAt: now,
    }
    if (generation === currentMappingGeneration()) await saveEpisodeMapping(merged).catch(() => {})
    if (generation !== currentMappingGeneration()) return mapEpisodeToProviders(input)
    return merged
  }

  if (!isAnimeApiEnabled()) return null

  const cached = await getCachedEpisodeMapping(input.tvdbSeriesId, input.tvdbSeasonNumber, input.tvdbEpisodeNumber)
  if (generation !== currentMappingGeneration()) return mapEpisodeToProviders(input)
  if (cached) return cached

  const seriesMapping = await resolveAnimeMappings({
    localMediaId: input.localMediaId,
    title: '',
    tvdbId: input.tvdbSeriesId,
  })
  if (generation !== currentMappingGeneration()) return mapEpisodeToProviders(input)
  if (!seriesMapping) return null

  const overrides = await getOverridesForMedia(input.localMediaId)
  const mapping = mapTvdbEpisodeToProviders(input, seriesMapping, overrides)

  if (isConfidenceSufficient(mapping)) {
    if (generation === currentMappingGeneration()) await saveEpisodeMapping(mapping).catch(() => {})
  }

  if (generation !== currentMappingGeneration()) return mapEpisodeToProviders(input)
  return mapping
}

export async function mapProviderProgressToTvdb(input: ProviderProgressMappingInput): Promise<{
  tvdbSeriesId: number
  seasonNumber: number
  episodeNumber: number
} | null> {
  if (!isAnimeApiEnabled()) return null

  const generation = currentMappingGeneration()
  const anibridge = await mapProviderProgressWithAniBridge(input).catch(() => null)
  if (generation !== currentMappingGeneration()) return mapProviderProgressToTvdb(input)
  if (anibridge) return anibridge

  const cacheKey: AnimeMappingCacheKey = {}
  if (input.provider === 'anilist') cacheKey.anilistId = Number(input.providerId)
  else if (input.provider === 'mal') cacheKey.malId = Number(input.providerId)

  const cached = await getCachedAnimeMapping(cacheKey)
  if (generation !== currentMappingGeneration()) return mapProviderProgressToTvdb(input)
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
  mappingGeneration += 1
  pendingResolutions.clear()
  return clearAnimeMappingCache()
}

export async function reResolveMapping(input: AnimeMappingInput): Promise<AnimeMappingResult | null> {
  const generation = currentMappingGeneration()
  const result = await resolveFromAnimeApi(input)
  if (result && generation === currentMappingGeneration()) await saveAnimeMapping(result)
  return result
}

export { isConfidenceSufficient } from './animeProgressMapper'

function buildCacheKey(input: AnimeMappingInput): AnimeMappingCacheKey {
  if (input.localMediaId) return { localMediaId: input.localMediaId, contentType: input.contentType }
  if (input.tvdbId) return { tvdbId: input.tvdbId, contentType: input.contentType }
  if (input.anilistId) return { anilistId: input.anilistId, contentType: input.contentType }
  if (input.malId) return { malId: input.malId, contentType: input.contentType }
  return { localMediaId: input.localMediaId, contentType: input.contentType }
}

function refreshInBackground(input: AnimeMappingInput, generation: string): void {
  const key = `${generation}:${resolutionKey(input)}`
  if (pendingResolutions.has(key)) return

  const promise: Promise<AnimeMappingResult | null> = resolveFromAnimeApi(input)
    .then(async (result) => {
      if (result && generation === currentMappingGeneration()) await saveAnimeMapping(result)
      return result
    })
    .catch(() => null)
    .finally(() => {
      if (pendingResolutions.get(key) === promise) pendingResolutions.delete(key)
    })

  pendingResolutions.set(key, promise)
}
