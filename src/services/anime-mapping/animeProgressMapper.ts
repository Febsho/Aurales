import type { TvdbEpisodeMappingInput, ProviderEpisodeMapping, AnimeMappingResult, AnimeSeasonMapping, AnimeMappingOverride } from './types'
import { getCachedOverrides } from './animeMappingCache'

const MIN_CONFIDENCE = 0.5

export function mapTvdbEpisodeToProviders(
  input: TvdbEpisodeMappingInput,
  seriesMapping: AnimeMappingResult,
  overrides: AnimeMappingOverride[],
): ProviderEpisodeMapping {
  const now = new Date().toISOString()

  const seasonMapping = findSeasonMapping(seriesMapping, input.tvdbSeasonNumber)
  const providerOverrides = groupOverrides(overrides, input.tvdbSeasonNumber, input.tvdbEpisodeNumber)

  const result: ProviderEpisodeMapping = {
    tvdbSeriesId: input.tvdbSeriesId,
    tvdbSeasonNumber: input.tvdbSeasonNumber,
    tvdbEpisodeNumber: input.tvdbEpisodeNumber,
    tvdbEpisodeId: input.tvdbEpisodeId,
    confidence: seriesMapping.confidence,
    source: Object.keys(providerOverrides).length > 0 ? 'override' : seriesMapping.source,
    updatedAt: now,
  }

  const offset = seasonMapping?.episodeOffset ?? 0
  const mappedEpisode = input.tvdbEpisodeNumber + offset

  if (providerOverrides.anilist) {
    result.anilist = {
      mediaId: Number(providerOverrides.anilist.providerId),
      episodeNumber: providerOverrides.anilist.providerEpisodeNumber ?? mappedEpisode,
    }
  } else if (seasonMapping?.anilistId) {
    result.anilist = {
      mediaId: seasonMapping.anilistId,
      episodeNumber: mappedEpisode,
    }
  } else if (seriesMapping.anilistId) {
    const absEpisode = computeAbsoluteEpisode(seriesMapping, input.tvdbSeasonNumber, input.tvdbEpisodeNumber)
    result.anilist = {
      mediaId: seriesMapping.anilistId,
      episodeNumber: absEpisode,
    }
  }

  if (providerOverrides.mal) {
    result.mal = {
      id: Number(providerOverrides.mal.providerId),
      episodeNumber: providerOverrides.mal.providerEpisodeNumber ?? mappedEpisode,
    }
  } else if (seasonMapping?.malId) {
    result.mal = { id: seasonMapping.malId, episodeNumber: mappedEpisode }
  } else if (seriesMapping.malId) {
    result.mal = {
      id: seriesMapping.malId,
      episodeNumber: computeAbsoluteEpisode(seriesMapping, input.tvdbSeasonNumber, input.tvdbEpisodeNumber),
    }
  }

  if (providerOverrides.simkl) {
    result.simkl = {
      id: Number(providerOverrides.simkl.providerId),
      episodeNumber: providerOverrides.simkl.providerEpisodeNumber ?? mappedEpisode,
      seasonNumber: providerOverrides.simkl.providerSeasonNumber,
    }
  } else if (seasonMapping?.simklId) {
    result.simkl = { id: seasonMapping.simklId, episodeNumber: mappedEpisode }
  } else if (seriesMapping.simklId) {
    result.simkl = {
      id: seriesMapping.simklId,
      episodeNumber: computeAbsoluteEpisode(seriesMapping, input.tvdbSeasonNumber, input.tvdbEpisodeNumber),
    }
  }

  if (providerOverrides.trakt) {
    result.trakt = {
      id: Number(providerOverrides.trakt.providerId),
      seasonNumber: providerOverrides.trakt.providerSeasonNumber ?? input.tvdbSeasonNumber,
      episodeNumber: providerOverrides.trakt.providerEpisodeNumber ?? input.tvdbEpisodeNumber,
    }
  } else if (seasonMapping?.traktId) {
    result.trakt = {
      id: seasonMapping.traktId,
      seasonNumber: seasonMapping.tvdbSeasonNumber ?? input.tvdbSeasonNumber,
      episodeNumber: input.tvdbEpisodeNumber,
    }
  } else if (seriesMapping.traktId) {
    result.trakt = {
      id: seriesMapping.traktId,
      seasonNumber: input.tvdbSeasonNumber,
      episodeNumber: input.tvdbEpisodeNumber,
    }
  }

  if (seasonMapping?.tmdbId) {
    result.tmdb = {
      id: seasonMapping.tmdbId,
      seasonNumber: seasonMapping.tvdbSeasonNumber ?? input.tvdbSeasonNumber,
      episodeNumber: input.tvdbEpisodeNumber,
    }
  } else if (seriesMapping.tmdbId) {
    result.tmdb = {
      id: seriesMapping.tmdbId,
      seasonNumber: input.tvdbSeasonNumber,
      episodeNumber: input.tvdbEpisodeNumber,
    }
  }

  return result
}

export function isConfidenceSufficient(mapping: ProviderEpisodeMapping): boolean {
  return mapping.confidence >= MIN_CONFIDENCE
}

export async function getOverridesForMedia(localMediaId: string): Promise<AnimeMappingOverride[]> {
  return getCachedOverrides(localMediaId)
}

function findSeasonMapping(result: AnimeMappingResult, seasonNumber: number): AnimeSeasonMapping | undefined {
  return result.seasons.find((s) => s.seasonNumber === seasonNumber || s.tvdbSeasonNumber === seasonNumber)
}

function computeAbsoluteEpisode(result: AnimeMappingResult, season: number, episode: number): number {
  let offset = 0
  for (const s of result.seasons) {
    if ((s.seasonNumber ?? s.tvdbSeasonNumber ?? 0) >= season) break
    offset += s.episodeCount ?? 0
  }
  return offset + episode
}

function groupOverrides(
  overrides: AnimeMappingOverride[],
  season: number,
  episode: number,
): Record<string, AnimeMappingOverride> {
  const result: Record<string, AnimeMappingOverride> = {}
  for (const o of overrides) {
    if (o.seasonNumber != null && o.seasonNumber !== season) continue
    if (o.episodeNumber != null && o.episodeNumber !== episode) continue
    result[o.provider] = o
  }
  return result
}
