import { tvdbProvider } from '../tvdb'
import { isLikelyJapaneseOnly } from './animeTitleResolver'
import type { AppEpisode, AppSeason } from './types'
import type { SeasonDetails } from '../../types'

export interface AnimeSeasonMappingOptions {
  hideUnairedSeasons: boolean
  hideUnairedEpisodes: boolean
  includeSpecials: boolean
  today: string
}

const DEFAULT_OPTIONS: AnimeSeasonMappingOptions = {
  hideUnairedSeasons: true,
  hideUnairedEpisodes: true,
  includeSpecials: true,
  today: new Date().toISOString().slice(0, 10),
}

function isAired(airDate: string | undefined, today: string): boolean {
  if (!airDate) return true
  return airDate.slice(0, 10) <= today
}

function isPlaceholderEpisode(ep: { name?: string; airDate?: string; overview?: string }): boolean {
  return !ep.name && !ep.airDate && !ep.overview
}

interface RawSeasonData {
  season: AppSeason
  data: SeasonDetails | null
}

export async function mapTvdbSeasons(
  tvdbId: number,
  summaries: AppSeason[],
  options?: Partial<AnimeSeasonMappingOptions>,
): Promise<AppSeason[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options, today: options?.today || new Date().toISOString().slice(0, 10) }

  const ordered = [...summaries].sort((a, b) => a.seasonNumber - b.seasonNumber)
  const filtered = opts.includeSpecials ? ordered : ordered.filter((s) => s.seasonNumber !== 0)

  const seasonsData: RawSeasonData[] = await Promise.all(
    filtered.map(async (season) => {
      const data = await tvdbProvider.getSeason(`tvdb-${tvdbId}`, season.seasonNumber).catch(() => null)
      return { season, data }
    })
  )

  // Collect all TVDB episode IDs that appear in seasons 2+ so we can
  // de-duplicate them from Season 1 when TVDB duplicates episodes across seasons.
  const laterSeasonEpIds = new Set<string>()
  const laterSeasonEpKeys = new Set<string>()
  for (const { season, data } of seasonsData) {
    if (season.seasonNumber <= 1 || !data) continue
    for (const ep of data.episodes) {
      if (ep.id) laterSeasonEpIds.add(ep.id)
      const sn = ep.seasonNumber ?? season.seasonNumber
      const en = ep.episodeNumber
      if (sn != null && en != null) laterSeasonEpKeys.add(`${sn}:${en}`)
    }
  }

  // Detect if Season 1 has an inflated episode count compared to later seasons.
  // If seasons 2+ exist and have episodes, Season 1 should not contain more episodes
  // than a reasonable single-cour or double-cour season (roughly matching later seasons).
  const hasLaterSeasons = seasonsData.some(
    ({ season, data }) => season.seasonNumber > 1 && data && data.episodes.length > 0,
  )

  let absoluteCounter = 0
  const results: AppSeason[] = []

  for (const { season, data } of seasonsData) {
    if (!data || data.episodes.length === 0) {
      if (!opts.hideUnairedSeasons) {
        results.push(season)
      }
      continue
    }

    const seenIds = new Set<string>()
    const episodes: AppEpisode[] = []

    for (const ep of data.episodes) {
      const epSeasonNumber = ep.seasonNumber ?? season.seasonNumber
      const epEpisodeNumber = ep.episodeNumber

      if (epSeasonNumber == null) continue
      if (epEpisodeNumber == null) continue

      // Skip episodes that belong to a different season than the one we're processing.
      // TVDB sometimes returns all episodes in the Season 1 response even if they
      // actually belong to Season 2, 3, etc.
      if (epSeasonNumber !== season.seasonNumber) {
        console.log('[tvdbSeasonMapper] Skipping cross-season episode:', {
          epId: ep.id, name: ep.name,
          epSeason: epSeasonNumber, currentSeason: season.seasonNumber,
        })
        continue
      }

      // If processing Season 1 and this episode's TVDB ID also appears in a later
      // season, skip it from Season 1 to avoid duplicates.
      if (season.seasonNumber === 1 && hasLaterSeasons && ep.id && laterSeasonEpIds.has(ep.id)) {
        console.log('[tvdbSeasonMapper] Removing S1 duplicate (also in later season):', {
          epId: ep.id, name: ep.name, episodeNumber: epEpisodeNumber,
        })
        continue
      }

      const epKey = ep.id || `${epSeasonNumber}-${epEpisodeNumber}-${ep.name}`
      if (seenIds.has(epKey)) continue
      seenIds.add(epKey)

      const airDate = ep.airDate
      const released = isAired(airDate, opts.today)

      if (opts.hideUnairedEpisodes && !released && airDate) continue
      if (isPlaceholderEpisode({ name: ep.name, airDate, overview: ep.overview })) continue

      const isNonSpecial = season.seasonNumber > 0
      if (isNonSpecial) absoluteCounter++

      episodes.push({
        id: `tvdb_${tvdbId}_s${epSeasonNumber}e${epEpisodeNumber}`,
        seasonNumber: epSeasonNumber,
        episodeNumber: epEpisodeNumber,
        absoluteEpisodeNumber: isNonSpecial ? absoluteCounter : undefined,
        title: ep.name || `Episode ${epEpisodeNumber}`,
        overview: ep.overview,
        still: ep.still,
        airDate,
        runtime: ep.runtime,
        tvdbId: ep.tvdbId ? Number(ep.tvdbId) : (Number(ep.id) || undefined),
        isReleased: released,
        debugSource: ep.debugSource || 'tvdb',
        debugResolverStep: ep.debugResolverStep || 'tvdbSeasonMapper.mapTvdbSeasons',
      })
    }

    episodes.sort((a, b) => a.episodeNumber - b.episodeNumber)

    // If this is Season 1, later seasons exist, and Season 1 still has way more
    // episodes than expected, trim episodes whose episode numbers exceed a
    // reasonable season boundary. We find the maximum episode count across later
    // seasons and use that as the upper bound for Season 1.
    if (season.seasonNumber === 1 && hasLaterSeasons && episodes.length > 0) {
      const laterMaxEps = seasonsData
        .filter(({ season: s, data: d }) => s.seasonNumber > 1 && d && d.episodes.length > 0)
        .map(({ data: d }) => d!.episodes.length)
      const avgLaterEps = laterMaxEps.length > 0
        ? Math.ceil(laterMaxEps.reduce((a, b) => a + b, 0) / laterMaxEps.length)
        : 0

      if (avgLaterEps > 0 && episodes.length > avgLaterEps * 1.5) {
        const reasonableMax = Math.max(avgLaterEps + 2, 13)
        const trimmed = episodes.filter((e) => e.episodeNumber <= reasonableMax)
        if (trimmed.length > 0 && trimmed.length < episodes.length) {
          console.log('[tvdbSeasonMapper] Trimming S1 from', episodes.length, 'to', trimmed.length,
            'episodes (later seasons average:', avgLaterEps, ')')
          episodes.length = 0
          episodes.push(...trimmed)
        }
      }
    }

    const hasAnyAired = episodes.some((e) => e.isReleased)
    if (opts.hideUnairedSeasons && !hasAnyAired && episodes.length === 0) continue

    const seasonAirDate = episodes[0]?.airDate || season.airDate
    const seasonReleased = hasAnyAired || isAired(seasonAirDate, opts.today)

    if (opts.hideUnairedSeasons && !seasonReleased) continue

    const rawTitle = data.name || season.title
    let displayTitle: string
    let nativeTitle: string | undefined
    let originalTitle: string | undefined

    if (season.seasonNumber === 0) {
      displayTitle = 'Specials'
    } else if (rawTitle && isLikelyJapaneseOnly(rawTitle)) {
      displayTitle = `Season ${season.seasonNumber}`
      nativeTitle = rawTitle
      originalTitle = rawTitle
    } else {
      displayTitle = rawTitle || `Season ${season.seasonNumber}`
    }

    results.push({
      ...season,
      title: displayTitle,
      originalTitle,
      nativeTitle,
      episodeCount: episodes.length,
      episodes,
      airDate: seasonAirDate,
      isReleased: seasonReleased,
    })
  }

  return results
}
