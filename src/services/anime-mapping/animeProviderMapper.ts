import type { AnimeApiEntry, AnimeMappingResult, AnimeSeasonMapping, AnimeMappingInput } from './types'
import { lookupByTvdbSeries, lookupByAniList, lookupByMal, lookupBySimkl, lookupByTrakt } from './animeApiClient'

export async function resolveFromAnimeApi(input: AnimeMappingInput): Promise<AnimeMappingResult | null> {
  let entries: AnimeApiEntry[] | null = null
  let singleEntry: AnimeApiEntry | null = null

  if (input.tvdbId) {
    entries = await lookupByTvdbSeries(input.tvdbId)
  }

  if (!entries?.length && input.anilistId) {
    singleEntry = await lookupByAniList(input.anilistId)
  }
  if (!entries?.length && !singleEntry && input.malId) {
    singleEntry = await lookupByMal(input.malId)
  }
  if (!entries?.length && !singleEntry && input.simklId) {
    singleEntry = await lookupBySimkl(input.simklId)
  }
  if (!entries?.length && !singleEntry && input.traktId) {
    singleEntry = await lookupByTrakt(input.traktId)
  }

  if (singleEntry) entries = [singleEntry]
  if (!entries?.length) return null

  return buildMappingResult(input, entries)
}

function buildMappingResult(input: AnimeMappingInput, entries: AnimeApiEntry[]): AnimeMappingResult {
  const primary = entries[0]
  const now = new Date().toISOString()

  const seasons: AnimeSeasonMapping[] = entries.map((entry, idx) => {
    const seasonNum = entry.trakt_season ?? (idx + 1)
    return {
      localMediaId: input.localMediaId,
      seasonNumber: seasonNum,
      tvdbSeriesId: entry.thetvdb ?? input.tvdbId,
      tvdbSeasonNumber: seasonNum,
      anilistId: entry.anilist,
      malId: entry.myanimelist,
      simklId: entry.simkl,
      traktId: entry.trakt,
      tmdbId: entry.themoviedb,
      title: entry.title,
      episodeOffset: 0,
    }
  })

  const confidence = computeConfidence(primary, input)

  return {
    localMediaId: input.localMediaId,
    tvdbId: primary.thetvdb ?? input.tvdbId,
    tmdbId: primary.themoviedb ?? input.tmdbId,
    anilistId: primary.anilist ?? input.anilistId,
    malId: primary.myanimelist ?? input.malId,
    simklId: primary.simkl ?? input.simklId,
    traktId: primary.trakt ?? input.traktId,
    kitsuId: primary.kitsu != null ? String(primary.kitsu) : undefined,
    anidbId: primary.anidb,
    animePlanetId: primary.animeplanet,
    seasons,
    confidence,
    source: 'animeApi',
    raw: entries.length === 1 ? primary : entries,
    updatedAt: now,
  }
}

function computeConfidence(entry: AnimeApiEntry, input: AnimeMappingInput): number {
  let score = 0.5
  let matches = 0

  if (entry.thetvdb && input.tvdbId && entry.thetvdb === input.tvdbId) matches++
  if (entry.anilist && input.anilistId && entry.anilist === input.anilistId) matches++
  if (entry.myanimelist && input.malId && entry.myanimelist === input.malId) matches++
  if (entry.themoviedb && input.tmdbId && entry.themoviedb === input.tmdbId) matches++
  if (entry.simkl && input.simklId && entry.simkl === input.simklId) matches++
  if (entry.trakt && input.traktId && entry.trakt === input.traktId) matches++

  if (matches >= 3) score = 1.0
  else if (matches === 2) score = 0.9
  else if (matches === 1) score = 0.7
  else score = 0.4

  return score
}
