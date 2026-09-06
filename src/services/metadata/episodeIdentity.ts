import type { EpisodeDetails } from '../../types'

/** Season/episode numbers alone are not identity across anime providers. */
export function matchingEpisode(source: EpisodeDetails, candidates: EpisodeDetails[]): EpisodeDetails | undefined {
  const linked = candidates.filter(candidate =>
    (source.imdbId && source.imdbId === candidate.imdbId)
    || (source.tmdbId != null && String(source.tmdbId) === String(candidate.tmdbId ?? candidate.id))
    || (source.tvdbId != null && candidate.tvdbId != null && String(source.tvdbId) === String(candidate.tvdbId)),
  )
  if (linked.length === 1) return linked[0]
  const day = source.airDate?.slice(0, 10)
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const sameDay = candidates.filter(candidate => candidate.airDate?.slice(0, 10) === day)
  // Batch releases are ambiguous even if both providers happen to number
  // an episode 1. Require an explicit provider link for those cases.
  return sameDay.length === 1 ? sameDay[0] : undefined
}
