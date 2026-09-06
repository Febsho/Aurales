import { tvdbProvider } from '../tvdb'
import { isLikelyJapaneseOnly } from './animeTitleResolver'
import type { AppEpisode, AppSeason } from './types'
import type { SeasonDetails } from '../../types'

export interface AnimeSeasonMappingOptions {
  hideUnairedSeasons: boolean
  hideUnairedEpisodes: boolean
  includeSpecials: boolean
  today: string
  /** Fetch this season first so the visible episode rail wins the cold-load race. */
  prioritySeason?: number
  /** Bound page-critical mapping; the provider request may still finish and populate its cache. */
  requestTimeoutMs?: number
}

const DEFAULT_OPTIONS: AnimeSeasonMappingOptions = {
  hideUnairedSeasons: true,
  hideUnairedEpisodes: true,
  includeSpecials: false,
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

async function settleWithin<T>(promise: Promise<T>, timeoutMs?: number): Promise<T | null> {
  if (!timeoutMs || timeoutMs <= 0) return promise.catch(() => null)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function mapTvdbSeasons(
  tvdbId: number,
  summaries: AppSeason[],
  options?: Partial<AnimeSeasonMappingOptions>,
): Promise<AppSeason[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options, today: options?.today || new Date().toISOString().slice(0, 10) }

  const ordered = [...summaries].sort((a, b) => a.seasonNumber - b.seasonNumber)
  const filtered = opts.includeSpecials ? ordered : ordered.filter((s) => s.seasonNumber !== 0)

  const fetchOrder = options?.prioritySeason == null
    ? filtered
    : [...filtered].sort((a, b) => {
      if (a.seasonNumber === options.prioritySeason) return -1
      if (b.seasonNumber === options.prioritySeason) return 1
      return a.seasonNumber - b.seasonNumber
    })

  const seasonsData: RawSeasonData[] = []
  let nextSeason = 0
  // Limit submissions as well as active HTTP calls: a long-running anime
  // must not put dozens of season requests ahead of a newly selected title.
  await Promise.all(Array.from({ length: Math.min(2, fetchOrder.length) }, async () => {
    while (nextSeason < fetchOrder.length) {
      const season = fetchOrder[nextSeason++]
      // The open page awaits this mapping; paused background work must not
      // prevent its Promise.all from completing.
      const priority = 'interactive'
      const getSeason = tvdbProvider.getSeason as (
        showId: string,
        seasonNumber: number,
        requestPriority?: 'interactive' | 'background',
      ) => Promise<SeasonDetails>
      const data = await settleWithin(
        getSeason(`tvdb-${tvdbId}`, season.seasonNumber, priority),
        opts.requestTimeoutMs,
      )
      seasonsData.push({ season, data })
    }
  }))
  // Mapping and absolute episode numbering must remain chronological even
  // though the network requests were scheduled visible-season-first.
  seasonsData.sort((a, b) => a.season.seasonNumber - b.season.seasonNumber)

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

    // A long first season is valid. Only explicit cross-season ownership and
    // duplicate IDs above justify removing episodes, never another season's size.

    const hasAnyAired = episodes.some((e) => e.isReleased)
    if (opts.hideUnairedSeasons && !hasAnyAired) continue

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
