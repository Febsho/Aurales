import { readBoundedResponseJson } from '../network/boundedResponse'
import type { SeasonSummary, ShowDetails } from '../../types'

const API_BASE_URL = 'https://metadata.anibridge.eliasbenb.dev/api/metadata'
const MAX_RESPONSE_BYTES = 1024 * 1024
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface AniBridgeSeasonScope {
  id?: { descriptor?: string }
  titles?: { display?: string; main?: string }
  release?: { start_date?: string | null }
  units?: number
}

interface AniBridgeMetadataResponse {
  metadata?: {
    id?: { provider?: string; provider_id?: string; descriptor?: string }
    scopes?: Record<string, AniBridgeSeasonScope>
  }
}

const seasonCache = new Map<number, { expiresAt: number; seasons: SeasonSummary[] }>()
const pending = new Map<number, Promise<SeasonSummary[]>>()

/**
 * AniBridge's public metadata API exposes TVDB season scopes independently of
 * the episode mapping dump. This repairs titles whose TVDB/Fribb summaries are
 * flattened while keeping TVDB's season numbers authoritative.
 */
export async function getAniBridgeTvdbSeasonScopes(tvdbId: number): Promise<SeasonSummary[]> {
  if (!Number.isSafeInteger(tvdbId) || tvdbId <= 0) return []
  const cached = seasonCache.get(tvdbId)
  if (cached && cached.expiresAt > Date.now()) return cached.seasons
  const existing = pending.get(tvdbId)
  if (existing) return existing

  const request = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const descriptor = `tvdb_show:${tvdbId}`
      const response = await fetch(`${API_BASE_URL}/${encodeURIComponent(descriptor)}`, { signal: controller.signal })
      if (!response.ok) return []
      const payload = await readBoundedResponseJson<AniBridgeMetadataResponse>(response, MAX_RESPONSE_BYTES, 'AniBridge season metadata')
      const metadata = payload.metadata
      if (metadata?.id?.provider !== 'tvdb_show' || metadata.id.provider_id !== String(tvdbId)) return []

      const seasons = Object.entries(metadata.scopes || {}).flatMap(([scope, value]): SeasonSummary[] => {
        const match = /^s(\d+)$/.exec(scope)
        const seasonNumber = match ? Number(match[1]) : NaN
        if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) return []
        if (value.id?.descriptor !== `${descriptor}:${scope}`) return []
        const episodeCount = Number(value.units)
        const airDate = typeof value.release?.start_date === 'string' ? value.release.start_date : undefined
        const providerTitle = value.titles?.display || value.titles?.main
        return [{
          seasonNumber,
          name: providerTitle || `Season ${seasonNumber}`,
          airDate,
          episodeCount: Number.isSafeInteger(episodeCount) && episodeCount > 0 ? episodeCount : 0,
        }]
      }).sort((left, right) => left.seasonNumber - right.seasonNumber)

      if (seasons.length) seasonCache.set(tvdbId, { seasons, expiresAt: Date.now() + CACHE_TTL_MS })
      return seasons
    } finally {
      clearTimeout(timeout)
    }
  })().finally(() => {
    if (pending.get(tvdbId) === request) pending.delete(tvdbId)
  })
  pending.set(tvdbId, request)
  return request
}

export function mergeAniBridgeTvdbSeasons(show: ShowDetails, bridged: SeasonSummary[]): ShowDetails {
  if (!bridged.length) return show
  const merged = new Map(show.seasons.map((season) => [season.seasonNumber, season]))
  for (const scope of bridged) {
    const current = merged.get(scope.seasonNumber)
    if (!current) {
      merged.set(scope.seasonNumber, scope)
      continue
    }
    // TVDB retains preferred names/artwork; AniBridge fills absent counts and
    // release dates and contributes real season numbers omitted by TVDB.
    merged.set(scope.seasonNumber, {
      ...scope,
      ...current,
      episodeCount: current.episodeCount > 0 ? current.episodeCount : scope.episodeCount,
      airDate: current.airDate || scope.airDate,
    })
  }
  const seasons = [...merged.values()].sort((left, right) => left.seasonNumber - right.seasonNumber)
  return {
    ...show,
    seasons,
    numberOfSeasons: seasons.filter((season) => season.seasonNumber > 0).length,
    numberOfEpisodes: show.numberOfEpisodes ?? seasons.reduce((total, season) => total + season.episodeCount, 0),
  }
}
