export {
  resolveAnimeMappings,
  mapEpisodeToProviders,
  mapProviderProgressToTvdb,
  clearMappingCache,
  reResolveMapping,
  isConfidenceSufficient,
} from './animeMappingService'

export {
  getAnimeApiBaseUrl,
  setAnimeApiBaseUrl,
  isAnimeApiEnabled,
  setAnimeApiEnabled,
  setAnimeApiMockMode,
} from './animeApiClient'

export {
  getCachedAnimeMapping,
  getCachedEpisodeMapping,
  clearAnimeMappingCache,
  getCachedOverrides,
  saveOverrides,
} from './animeMappingCache'

export type {
  AnimeMappingInput,
  AnimeMappingResult,
  TvdbEpisodeMappingInput,
  ProviderEpisodeMapping,
  ProviderProgressMappingInput,
  AnimeMappingCacheKey,
  AnimeMappingOverride,
  AnimeSeasonMapping,
  AnimeApiEntry,
} from './types'
