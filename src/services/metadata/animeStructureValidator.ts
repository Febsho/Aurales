import type { AppSeason, AnimeStructureValidation } from './types'

export function validateAnimeTvdbStructure(
  seasons: AppSeason[],
  expectedMultiSeason = false,
): AnimeStructureValidation {
  const nonSpecialSeasons = seasons.filter((s) => s.seasonNumber > 0)
  const totalEpisodeCount = nonSpecialSeasons.reduce((sum, s) => sum + s.episodes.length, 0)
  const seasonCount = nonSpecialSeasons.length

  let suspiciousSingleSeasonFlattening = false
  let reason: string | undefined

  if (
    nonSpecialSeasons.length === 1 &&
    nonSpecialSeasons[0].seasonNumber === 1 &&
    nonSpecialSeasons[0].episodes.length > 13 &&
    expectedMultiSeason
  ) {
    const eps = nonSpecialSeasons[0].episodes
    const hasLateEpisodes = eps.some(
      (e) => e.episodeNumber >= 13 || (e.absoluteEpisodeNumber != null && e.absoluteEpisodeNumber >= 13),
    )
    if (hasLateEpisodes) {
      suspiciousSingleSeasonFlattening = true
      reason = 'Single season with 13+ episodes where multi-season expected from relations'
    }
  }

  if (
    nonSpecialSeasons.length === 1 &&
    nonSpecialSeasons[0].episodes.length > 24 &&
    expectedMultiSeason
  ) {
    suspiciousSingleSeasonFlattening = true
    reason = reason || 'Single season with 24+ episodes where multi-season expected'
  }

  return {
    valid: !suspiciousSingleSeasonFlattening,
    reason,
    suspiciousSingleSeasonFlattening,
    hasMultipleRealSeasons: nonSpecialSeasons.length > 1,
    seasonCount,
    totalEpisodeCount,
    score: scoreAnimeStructure(seasons, expectedMultiSeason),
  }
}

export function scoreAnimeStructure(
  seasons: AppSeason[],
  expectedMultiSeason = false,
): number {
  const nonSpecial = seasons.filter((s) => s.seasonNumber > 0)
  let score = 0

  if (nonSpecial.length > 1 && expectedMultiSeason) score += 50
  if (nonSpecial.some((s) => s.episodes.some((e) => e.isReleased))) score += 30
  if (nonSpecial.some((s) => s.seasonNumber >= 2)) score += 20

  const episodesResetPerSeason = nonSpecial.every((s) => {
    if (s.episodes.length === 0) return true
    return s.episodes[0]?.episodeNumber <= 2
  })
  if (episodesResetPerSeason && nonSpecial.length > 1) score += 20

  if (seasons.some((s) => s.seasonNumber === 0)) score += 10

  if (nonSpecial.length === 1 && nonSpecial[0].episodes.length > 13) score -= 50

  const allAbsoluteMatch = nonSpecial.every((s) =>
    s.episodes.every((e) => e.absoluteEpisodeNumber != null && e.episodeNumber === e.absoluteEpisodeNumber),
  )
  if (allAbsoluteMatch && nonSpecial.length === 1) score -= 40

  const unreleasedDominate = nonSpecial.filter((s) =>
    s.episodes.length > 0 && s.episodes.every((e) => !e.isReleased),
  ).length > nonSpecial.length / 2
  if (unreleasedDominate) score -= 30

  const noAirDates = nonSpecial.every((s) =>
    s.episodes.every((e) => !e.airDate) && !s.airDate,
  )
  if (noAirDates && nonSpecial.length <= 1) score -= 20

  return score
}

export function debugAnimeMapping(input: {
  localMediaId?: string
  title?: string
  originalTitle?: string
  year?: number
  anilistId?: number
  malId?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
  matchedTvdbSeriesId?: number
  matchedTvdbSeriesName?: string
  tvdbOrderType?: string
  seasons?: AppSeason[]
}): void {
  const seasons = input.seasons || []
  const nonSpecial = seasons.filter((s) => s.seasonNumber > 0)
  const seasonNumbers = nonSpecial.map((s) => s.seasonNumber)
  const episodeCountsBySeason: Record<number, number> = {}
  for (const s of nonSpecial) {
    episodeCountsBySeason[s.seasonNumber] = s.episodes.length
  }

  const firstEpisodes = nonSpecial
    .flatMap((s) => s.episodes)
    .slice(0, 10)
    .map((e) => ({
      title: e.title,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      absoluteEpisodeNumber: e.absoluteEpisodeNumber,
      airDate: e.airDate,
      source: e.debugSource,
    }))

  console.log('[ANIME MATCH DEBUG]', {
    localMediaId: input.localMediaId,
    title: input.title,
    originalTitle: input.originalTitle,
    year: input.year,
    anilistId: input.anilistId,
    malId: input.malId,
    tvdbId: input.tvdbId,
    tmdbId: input.tmdbId,
    imdbId: input.imdbId,
    matchedTvdbSeriesId: input.matchedTvdbSeriesId || input.tvdbId,
    matchedTvdbSeriesName: input.matchedTvdbSeriesName,
    tvdbOrderType: input.tvdbOrderType || 'official/aired',
    seasonNumbers,
    episodeCountsBySeason,
    firstEpisodes,
  })

  const validation = validateAnimeTvdbStructure(seasons)
  console.log('[ANIME MATCH DEBUG] Structure validation:', validation)
}
