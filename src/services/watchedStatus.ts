import type { SearchResult, WatchProgress } from '../types'
import { getWatchedMovies, getWatchedShows, getTraktShowSeasons, getShowWatchedProgress, type TraktWatchedItem, type TraktSeasonSummary } from './trakt/sync'
import { findExactSimklHistoryItem, getSimklEpisodeExactState, getSimklWatchedEpisodes, getSimklWatchedMovies } from './simkl/history'
import type { SimklWatchlistItem } from './simkl/types'
import { getPMDBWatched, lookupTmdbId, type PMDBWatchedItem } from './pmdb'
import { getMdblistWatched, type MdblistWatchedItem } from './mdblist'
import { getAniListEpisodeExactState, getAniListProgress, getAniListTrackedProgress, resolveAniListMediaId, searchAniListMediaId } from './anilist'
import { mapTvdbEpisodeToAniList, resolveAnimeIds } from './animeLists'
import { cachedFetch, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { mapEpisodeToProviders, isConfidenceSufficient } from './anime-mapping'
import { resolveSimklId } from './simkl/mappings'

export type WatchedSource = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist'

export interface WatchedLookupItem {
  id: string
  type: 'movie' | 'series'
  title?: string
  year?: number
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  simklId?: string | number
  traktId?: string | number
  season?: number
  episode?: number
  seasonEpisodeCount?: number
  absoluteEpisode?: number
  isAnime?: boolean
  appSeasonEpCounts?: { season: number; count: number }[]
}

interface TraktCacheData { movies: TraktWatchedItem[]; shows: TraktWatchedItem[] }
interface SimklCacheData { items: SimklWatchlistItem[] }
interface PmdbCacheData { items: PMDBWatchedItem[] }
interface MdblistCacheData { items: MdblistWatchedItem[] }

export function searchResultToLookup(item: SearchResult): WatchedLookupItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    year: item.year,
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
    anilistId: item.anilistId,
    simklId: item.simklId,
    traktId: item.traktId,
    isAnime: item.isAnime,
    season: item.season,
    episode: item.episode,
  }
}

export function getLocalWatchedStatus(item: WatchedLookupItem, watchProgress: Map<string, WatchProgress>): boolean {
  const ids = normalizedIds(item)
  for (const id of ids) {
    const direct = watchProgress.get(id)
    if (direct?.completed) return true
  }

  if (item.type === 'series' && item.season != null && item.episode != null) {
    for (const id of ids) {
      const ep = watchProgress.get(`${id}:${item.season}:${item.episode}`)
      if (ep?.completed) return true
    }
  }

  for (const [, progress] of watchProgress.entries()) {
    if (!progress.completed) continue
    if (!ids.includes(progress.mediaId) && !ids.includes(String(progress.tmdbId || '')) && !ids.includes(String(progress.imdbId || ''))) continue
    if (item.type === 'movie') return true
    if (item.season == null) return false
    if (item.episode == null) continue
    if (progress.season != null && progress.episode != null && Number(progress.season) === Number(item.season) && Number(progress.episode) === Number(item.episode)) return true
  }
  if (item.type === 'series' && item.season != null && item.episode == null && item.seasonEpisodeCount) {
    const watched = new Set<number>()
    for (const [, progress] of watchProgress.entries()) {
      if (!progress.completed) continue
      if (!ids.includes(progress.mediaId) && !ids.includes(String(progress.tmdbId || '')) && !ids.includes(String(progress.imdbId || ''))) continue
      if (progress.season != null && Number(progress.season) === Number(item.season) && progress.episode != null) watched.add(Number(progress.episode))
    }
    return watched.size >= item.seasonEpisodeCount
  }
  return false
}

export async function isWatchedFromProviders(
  item: WatchedLookupItem,
  sources: WatchedSource[],
  watchProgress: Map<string, WatchProgress>,
): Promise<boolean> {
  if (sources.includes('local') && getLocalWatchedStatus(item, watchProgress)) return true
  const checks = await Promise.all(
    sources
      .filter((source) => source !== 'local')
      .map(async (source) => {
        if (source === 'trakt') return isTraktWatched(item)
        if (source === 'simkl') return isSimklWatched(item)
        if (source === 'pmdb') return isPmdbWatched(item)
        if (source === 'mdblist') return isMdblistWatched(item)
        if (source === 'anilist') return isAniListWatched(item)
        return false
      })
  )
  return checks.some(Boolean)
}

export async function batchIsWatchedFromProviders(
  items: WatchedLookupItem[],
  sources: WatchedSource[],
  completedIds: Set<string>,
): Promise<Set<string>> {
  const result = new Set<string>()
  if (items.length === 0) return result

  const toKey = (it: WatchedLookupItem) => `${it.season}:${it.episode}`

  if (sources.includes('local')) {
    for (const item of items) {
      const ids = normalizedIds(item)
      if (ids.some((id) => completedIds.has(id))) { result.add(toKey(item)); continue }
      if (item.type === 'series' && item.season != null && item.episode != null) {
        if (ids.some((id) => completedIds.has(`${id}:${item.season}:${item.episode}`))) result.add(toKey(item))
      }
    }
  }

  const remaining = items.filter((it) => !result.has(toKey(it)))
  if (remaining.length === 0) return result

  const providerSources = sources.filter((s) => s !== 'local')
  if (providerSources.length === 0) return result

  const [traktData, simklData, pmdbData, mdblistData] = await Promise.all([
    providerSources.includes('trakt') ? getTraktCache().catch(() => ({ movies: [], shows: [] } as TraktCacheData)) : null,
    providerSources.includes('simkl') ? getSimklCache().catch(() => ({ items: [] } as SimklCacheData)) : null,
    providerSources.includes('pmdb') ? getPmdbCache().catch(() => ({ items: [] } as PmdbCacheData)) : null,
    providerSources.includes('mdblist') ? getMdblistCache().catch(() => ({ items: [] } as MdblistCacheData)) : null,
  ])

  const checkPromises = remaining.map(async (item) => {
    if (traktData) {
      if (await isTraktWatched(item).catch(() => false)) { result.add(toKey(item)); return }
    }
    if (simklData) {
      if (await isSimklWatched(item).catch(() => false)) { result.add(toKey(item)); return }
    }
    if (pmdbData) {
      if (await isPmdbWatched(item).catch(() => false)) { result.add(toKey(item)); return }
    }
    if (mdblistData) {
      if (await isMdblistWatched(item).catch(() => false)) { result.add(toKey(item)); return }
    }
    if (providerSources.includes('anilist')) {
      if (await isAniListWatched(item).catch(() => false)) { result.add(toKey(item)); return }
    }
  })

  await Promise.all(checkPromises)
  return result
}

/**
 * Resolve the AniList media id for a lookup. Prefers the item's own AniList/MAL
 * id, then falls back to the Fribb map via TVDB/TMDB/IMDB so anime that only
 * carries TVDB/TMDB metadata (the common case in Aurales) still matches. The
 * TVDB/TMDB fallback returns the series' primary (season-1) AniList entry, so
 * callers must only use it where absolute-episode math or season===1 prevents
 * leaking season-1 progress into later seasons.
 */
async function resolveAniListIdForLookup(item: WatchedLookupItem): Promise<number | null> {
  const direct = await resolveAniListMediaId({ anilistId: item.anilistId, malId: item.malId })
  if (direct) return direct
  const tvdbId = item.tvdbId != null ? Number(String(item.tvdbId).replace('tvdb-', '')) : undefined
  const tmdbId = item.tmdbId != null ? Number(String(item.tmdbId).replace('tmdb-', '')) : undefined
  const mapped = await resolveAnimeIds({
    tvdbId: Number.isFinite(tvdbId) ? tvdbId : undefined,
    tmdbId: Number.isFinite(tmdbId) ? tmdbId : undefined,
    imdbId: item.imdbId,
  }).catch(() => null)
  if (mapped?.anilistId || mapped?.malId) {
    const viaMap = await resolveAniListMediaId({ anilistId: mapped.anilistId, malId: mapped.malId })
    if (viaMap) return viaMap
  }
  // Last resort: fuzzy title search — for recent/obscure anime absent from the
  // offline map and when the online mapping services are unavailable.
  if (item.title) return searchAniListMediaId(item.title, typeof item.year === 'number' ? item.year : undefined)
  return null
}

// The TVDB/TMDB→AniList fallback maps to the season-1 entry, so it is only safe
// for episode checks when absolute-episode counts guard the comparison or the
// episode belongs to season 1. Title/season checks use absolute ranges already.
function canUseAniListSeriesFallback(item: WatchedLookupItem): boolean {
  if (item.episode == null) return true
  if (item.season == null || item.season === 1) return true
  return Boolean(item.appSeasonEpCounts && item.appSeasonEpCounts.length > 0)
}

async function isAniListWatched(item: WatchedLookupItem): Promise<boolean> {
  // AniList tracks both episodic anime and anime movies. Ordinary movies do
  // not belong to AniList and must still be rejected.
  if (item.type !== 'series' && !item.isAnime) return false
  try {
    let exactUnwatchedAt: number | null = null
    if (item.season != null && item.episode == null && item.seasonEpisodeCount && item.appSeasonEpCounts) {
      const mediaId = await resolveAniListIdForLookup(item)
      if (!mediaId) return false
      const entries = await getAniListTrackedProgress()
      const entry = entries.find((e) => e.mediaId === mediaId)
      if (!entry) return false
      const endEpisode = seasonEpToAbsolute(item.season, item.seasonEpisodeCount, item.appSeasonEpCounts)
      return entry.progress >= endEpisode
    }

    if (item.episode == null) {
      const mediaId = await resolveAniListIdForLookup(item)
      if (!mediaId) return false
      const entries = await getAniListTrackedProgress()
      // COMPLETED, or an ongoing entry whose progress already covers all episodes.
      return entries.some((entry) => entry.mediaId === mediaId && (entry.status === 'COMPLETED' || (entry.episodes != null && entry.episodes > 0 && entry.progress >= entry.episodes)))
    }

    if (item.season != null && item.episode != null) {
      const exactStates = normalizedIds(item)
        .map((id) => getAniListEpisodeExactState(id, item.season!, item.episode!))
        .filter((state): state is NonNullable<typeof state> => Boolean(state))
      if (exactStates.some((state) => state.watched !== false)) return true
      if (exactStates.length > 0) {
        exactUnwatchedAt = Math.max(...exactStates.map((state) => Date.parse(state.markedAt) || 0))
      }
    }

    let anilistId = item.anilistId
    // Global absolute episode number (across ALL seasons), independent of the
    // per-cour mapping below. Used to correct long-running single-entry anime.
    const globalAbsolute = item.absoluteEpisode ?? (item.isAnime && item.appSeasonEpCounts && item.season != null
      ? seasonEpToAbsolute(item.season, item.episode, item.appSeasonEpCounts)
      : item.episode)
    let progressEpisode = globalAbsolute

    // Try animeApi mapping first
    if (item.tvdbId != null && item.season != null && item.episode != null) {
      const tvdbId = Number(String(item.tvdbId).replace('tvdb-', ''))
      if (Number.isFinite(tvdbId)) {
        const mapped = await mapTvdbEpisodeToAniList(tvdbId, item.season, item.episode).catch(() => null)
        if (mapped) {
          anilistId = mapped.anilistId
          progressEpisode = mapped.absoluteEpisode
        } else {
          try {
            const apiMapping = await mapEpisodeToProviders({
              localMediaId: item.id,
              tvdbSeriesId: tvdbId,
              tvdbSeasonNumber: item.season,
              tvdbEpisodeNumber: item.episode,
            })
            if (apiMapping?.anilist?.mediaId && apiMapping.anilist.episodeNumber != null && isConfidenceSufficient(apiMapping)) {
              anilistId = apiMapping.anilist.mediaId
              progressEpisode = apiMapping.anilist.episodeNumber
            }
          } catch (_) { /* retain the direct episode fallback */ }
        }
      }
    }

    // If the item carried no AniList/MAL id and TVDB episode mapping missed,
    // resolve the series' AniList id from TVDB/TMDB/IMDB. Absolute-episode math
    // (progressEpisode) keeps later-season episodes from matching season-1 progress.
    if (anilistId == null && item.malId == null && canUseAniListSeriesFallback(item)) {
      anilistId = await resolveAniListIdForLookup(item) ?? undefined
    }

    const entry = await getAniListProgress(
      anilistId != null ? Number(anilistId) : undefined,
      item.malId != null ? Number(item.malId) : undefined,
    )

    // Long-running single AniList entry (e.g. One Piece: id 21, absolute numbering
    // over 1000+ eps split across many TVDB seasons). The mapping above yields a
    // cour-relative number, which a high absolute progress would falsely cover for
    // later seasons — so compare with the global absolute when the matched entry
    // looks continuous (unknown or large episode count, or large progress).
    if (entry && item.season != null && item.season > 1 && item.appSeasonEpCounts && item.appSeasonEpCounts.length > 1 && globalAbsolute != null) {
      const looksContinuous = entry.episodes == null || entry.episodes > 50 || (entry.progress ?? 0) > 50
      if (looksContinuous) progressEpisode = globalAbsolute
    }

    // A COMPLETED (or REPEATING — currently rewatching, so already watched once)
    // entry means every episode of that AniList entry is watched, even when the
    // numeric progress lags at 0 (AniList does this for many movies/OVAs and some
    // completed shows). Requirement: don't require the progress number for COMPLETED.
    let watchedThrough = entry?.progress ?? 0
    if (entry && (entry.status === 'COMPLETED' || entry.status === 'REPEATING')) {
      if (entry.episodes && entry.episodes > 0) {
        watchedThrough = Math.max(watchedThrough, entry.episodes)
      } else if (item.season == null || item.season === 1 || !item.appSeasonEpCounts || item.appSeasonEpCounts.length <= 1) {
        // Single-season / single-entry show with unknown episode count: completed
        // ⇒ this episode is watched. (Multi-season with unknown count stays strict
        // to avoid marking a later season from a season-1 entry.)
        watchedThrough = Math.max(watchedThrough, progressEpisode ?? watchedThrough)
      }
    }

    if (import.meta.env.DEV) console.log(`[anilist-watched] "${item.title ?? item.id}" S${item.season}E${item.episode} → mediaId=${anilistId ?? 'UNRESOLVED'} status=${entry?.status ?? '-'} progress=${entry?.progress ?? '-'}/${entry?.episodes ?? '?'} watchedThrough=${watchedThrough} need=${progressEpisode} verdict=${entry ? (progressEpisode != null && watchedThrough >= progressEpisode) : false}`)
    if (!entry) return false
    // A local unmark only overrides the provider until AniList is changed
    // again. This allows episodes watched directly on AniList to sync back.
    if (exactUnwatchedAt != null && (!entry.updatedAt || exactUnwatchedAt >= entry.updatedAt * 1000)) return false
    if (item.episode == null) return watchedThrough > 0
    if (progressEpisode != null && watchedThrough >= progressEpisode) return true

    // Some aggregate TVDB shows map a season/cour to a different AniList entry
    // than the ID carried by the catalog item. For season 1, also check that
    // direct entry against the selected episode number (never title-level).
    if (item.season === 1 && item.anilistId != null && Number(item.anilistId) !== Number(anilistId)) {
      const direct = await getAniListProgress(Number(item.anilistId), item.malId != null ? Number(item.malId) : undefined)
      if (direct && direct.progress >= item.episode) {
        if (exactUnwatchedAt != null && (!direct.updatedAt || exactUnwatchedAt >= direct.updatedAt * 1000)) return false
        return true
      }
    }
    return false
  } catch (_) {
    return false
  }
}

function seasonEpToAbsolute(season: number, episode: number, seasonCounts: { season: number; count: number }[]): number {
  let abs = 0
  for (const s of seasonCounts) {
    if (s.season >= season) break
    abs += s.count
  }
  return abs + episode
}

function seasonAbsoluteRange(item: WatchedLookupItem): { start: number; end: number } | null {
  if (!item.appSeasonEpCounts || item.season == null || item.seasonEpisodeCount == null) return null
  const start = seasonEpToAbsolute(item.season, 1, item.appSeasonEpCounts)
  const end = seasonEpToAbsolute(item.season, item.seasonEpisodeCount, item.appSeasonEpCounts)
  return { start, end }
}

function traktSeasonToAbsolute(season: number, episode: number, traktSeasons: TraktSeasonSummary[]): number {
  let abs = 0
  for (const s of traktSeasons) {
    if (s.number >= season) break
    abs += s.episodeCount
  }
  return abs + episode
}

async function fetchShowProgress(showId: string | number): Promise<{ number: number; episodes: { number: number; plays: number; lastWatchedAt: string }[] }[]> {
  const progress = await getShowWatchedProgress(String(showId))
  return progress.map((s) => ({
    number: s.number,
    episodes: s.episodes.filter((e) => e.completed).map((e) => ({ number: e.number, plays: 1, lastWatchedAt: '' })),
  }))
}

async function isTraktWatchedWithData(item: WatchedLookupItem, data: TraktCacheData): Promise<boolean> {
  if (item.type === 'movie') {
    return data.movies.some((entry) => matchesIds(item, entry.movie?.ids))
  }

  const matchedEntry = data.shows.find((entry) => matchesIds(item, entry.show?.ids))
  if (!matchedEntry) return false
  if (item.season == null) return false

  // If seasons data is missing (Trakt API no longer returns it in bulk), fetch per-show progress
  let seasons = matchedEntry.seasons
  if (!seasons || seasons.length === 0) {
    const showId = matchedEntry.show?.ids?.imdb || matchedEntry.show?.ids?.trakt || matchedEntry.show?.ids?.tmdb
    if (showId) {
      seasons = await fetchShowProgress(showId).catch(() => undefined as any)
    }
  }
  if (!seasons || seasons.length === 0) return false

  if (item.episode == null) {
    if (!item.seasonEpisodeCount) return false
    if (item.isAnime && item.appSeasonEpCounts && matchedEntry.show?.ids?.imdb) {
      const range = seasonAbsoluteRange(item)
      const traktSeasons = await getTraktShowSeasons(matchedEntry.show.ids.imdb).catch(() => [])
      if (range && traktSeasons.length > 0) {
        const watched = new Set<number>()
        for (const season of seasons) {
          for (const ep of season.episodes) {
            if (ep.plays <= 0) continue
            const absolute = traktSeasonToAbsolute(Number(season.number), Number(ep.number), traktSeasons)
            if (absolute >= range.start && absolute <= range.end) watched.add(absolute)
          }
        }
        return watched.size >= item.seasonEpisodeCount
      }
    }
    const season = seasons.find((s) => Number(s.number) === Number(item.season))
    return season ? new Set(season.episodes.filter((ep) => ep.plays > 0).map((ep) => Number(ep.number))).size >= item.seasonEpisodeCount : false
  }

  // Direct season/episode match
  const directMatch = seasons.some((season) =>
    Number(season.number) === Number(item.season) && season.episodes.some((ep) => Number(ep.number) === Number(item.episode) && ep.plays > 0)
  )
  if (directMatch) return true

  // For anime, try absolute episode mapping (Trakt may have different season structure)
  if (item.isAnime && item.appSeasonEpCounts && matchedEntry.show?.ids?.imdb) {
    const traktSeasons = await getTraktShowSeasons(matchedEntry.show.ids.imdb).catch(() => [])
    if (traktSeasons.length > 0) {
      const myAbsolute = seasonEpToAbsolute(item.season, item.episode, item.appSeasonEpCounts)
      const absoluteMatch = seasons.some((season) =>
        season.episodes.some((ep) => {
          if (ep.plays <= 0) return false
          return traktSeasonToAbsolute(season.number, ep.number, traktSeasons) === myAbsolute
        })
      )
      if (absoluteMatch) return true
    }
  }

  // For anime, try anime-mapping API to check with mapped trakt ID
  if (item.isAnime && item.tvdbId != null && item.season != null && item.episode != null) {
    try {
      const tvdbId = Number(String(item.tvdbId).replace('tvdb-', ''))
      if (Number.isFinite(tvdbId)) {
        const apiMapping = await mapEpisodeToProviders({
          localMediaId: item.id,
          tvdbSeriesId: tvdbId,
          tvdbSeasonNumber: item.season,
          tvdbEpisodeNumber: item.episode,
        })
        if (apiMapping?.trakt?.id && isConfidenceSufficient(apiMapping)) {
          const mappedTraktId = apiMapping.trakt.id
          const mappedSeason = apiMapping.trakt.seasonNumber ?? item.season
          const mappedEpisode = apiMapping.trakt.episodeNumber ?? item.episode
          const altEntry = data.shows.find((entry) => entry.show?.ids?.trakt === mappedTraktId)
          let altSeasons = altEntry?.seasons
          if (altEntry && (!altSeasons || altSeasons.length === 0)) {
            const altShowId = altEntry.show?.ids?.imdb || altEntry.show?.ids?.trakt || altEntry.show?.ids?.tmdb
            if (altShowId) altSeasons = await fetchShowProgress(altShowId).catch(() => undefined as any)
          }
          if (altSeasons) {
            const found = altSeasons.some((season) =>
              Number(season.number) === Number(mappedSeason) && season.episodes.some((ep) => Number(ep.number) === Number(mappedEpisode) && ep.plays > 0)
            )
            if (found) return true
          }
        }
      }
    } catch (_) { /* fall through */ }
  }

  return false
}

async function fetchFreshTraktData(): Promise<TraktCacheData> {
  const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
  const data = { movies, shows }
  await cacheSet('watched:trakt', data, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
  return data
}

async function isTraktWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    let data = await getTraktCache()

    // Validate cache shape — old app versions or corrupt cache may store wrong format
    if (!data || !Array.isArray(data.movies) || !Array.isArray(data.shows)) {
      console.warn('[Trakt] Cache has wrong shape, force-refetching')
      data = await fetchFreshTraktData()
    }

    const result = await isTraktWatchedWithData(item, data)

    return result
  } catch (err) {
    console.error('[Trakt] isTraktWatched error:', err)
    return false
  }
}

async function isSimklWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    if (item.type === 'series' && item.season != null && item.episode != null) {
      const { isSimklEpisodePending } = await import('./simkl/history')
      if (isSimklEpisodePending(item.id, Number(item.season), Number(item.episode))) return true
    }
    const data = await getSimklCache()

    // Pre-resolve anime mapping outside the sync .some() loop
    let mappedSimkl: { season: number; episode: number } | null = null
    let mappedSimklShowId: number | null = null
    let mappedSimklType: 'movie' | 'show' | 'anime' | null = null
    if (item.isAnime && item.title) {
      const exactMapping = await resolveSimklId({
        localId: item.id,
        title: item.title,
        year: item.year,
        type: 'anime',
        contentType: item.type === 'movie' ? 'movie' : 'series',
        isAnime: true,
        imdbId: item.imdbId,
        tmdbId: item.tmdbId != null ? Number(String(item.tmdbId).replace(/^tmdb[-:]/i, '')) : undefined,
        tvdbId: item.tvdbId != null ? Number(String(item.tvdbId).replace(/^tvdb[-:]/i, '')) : undefined,
        malId: item.malId != null ? Number(item.malId) : undefined,
        anilistId: item.anilistId != null ? Number(item.anilistId) : undefined,
        simklId: item.simklId != null ? Number(item.simklId) : undefined,
      }, { allowTitleFallback: false, allowExactTitleFallback: true }).catch(() => null)
      if (exactMapping?.simklId) {
        mappedSimklShowId = exactMapping.simklId
        mappedSimklType = exactMapping.type
      }
    }
    if (item.isAnime && item.tvdbId != null && item.season != null && item.episode != null) {
      try {
        const tvdbId = Number(String(item.tvdbId).replace('tvdb-', ''))
        if (Number.isFinite(tvdbId)) {
          const apiMapping = await mapEpisodeToProviders({
            localMediaId: item.id,
            tvdbSeriesId: tvdbId,
            tvdbSeasonNumber: item.season,
            tvdbEpisodeNumber: item.episode,
          })
          if (apiMapping?.simkl && isConfidenceSufficient(apiMapping)) {
            mappedSimklShowId = apiMapping.simkl.id
            mappedSimkl = {
              season: apiMapping.simkl.seasonNumber ?? 1,
              episode: apiMapping.simkl.episodeNumber ?? item.episode,
            }
          }
        }
      } catch (_) { /* fall through */ }
    }

    if (item.type === 'series' && item.season != null && item.episode != null) {
      const exactSeason = mappedSimkl?.season ?? item.season
      const exactEpisode = mappedSimkl?.episode ?? item.episode
      const exactState = getSimklEpisodeExactState(item.id, exactSeason, exactEpisode)
      if (exactState != null) return exactState
    }

    return data.items.some((entry) => {
      const historyTitleMatch = item.type === 'movie' && item.isAnime
        ? findExactSimklHistoryItem({
            title: item.title ?? '',
            year: item.year,
            contentType: 'movie',
            isAnime: true,
          }, [entry]) != null
        : false
      if (item.type === 'movie' && entry.type !== (mappedSimklType ?? 'movie') && !historyTitleMatch) return false
      if (item.type === 'series' && entry.type === 'movie') return false
      const idsMatch = matchesFlatIds(item, entry) || historyTitleMatch || (mappedSimklShowId != null && sameNumber(mappedSimklShowId, entry.simklId))
      if (!idsMatch) return false
      if (item.type === 'movie') {
        if (entry.type === 'anime') {
          return entry.status === 'completed' || Boolean(entry.watchedEpisodes?.some((episode) => Number(episode.episode) === 1))
        }
        return entry.status === 'completed'
      }
      if (item.season == null) return false
      if (!entry.watchedEpisodes || entry.watchedEpisodes.length === 0) return false
      if (item.episode == null) {
        if (!item.seasonEpisodeCount) return false
        if (item.isAnime && item.appSeasonEpCounts) {
          const range = seasonAbsoluteRange(item)
          if (range) {
            const watched = new Set(entry.watchedEpisodes
              .filter((episode) => Number(episode.season) === 1 && Number(episode.episode) >= range.start && Number(episode.episode) <= range.end)
              .map((episode) => Number(episode.episode)))
            if (watched.size >= item.seasonEpisodeCount) return true
          }
        }
        const watched = new Set(entry.watchedEpisodes.filter((episode) => Number(episode.season) === Number(item.season)).map((episode) => Number(episode.episode)))
        return watched.size >= item.seasonEpisodeCount
      }
      const absoluteEpisode = item.absoluteEpisode ?? (item.isAnime && item.appSeasonEpCounts && item.season != null
        ? seasonEpToAbsolute(Number(item.season), Number(item.episode), item.appSeasonEpCounts)
        : undefined)

      return entry.watchedEpisodes.some((episode) =>
        (Number(episode.season) === Number(item.season) && Number(episode.episode) === Number(item.episode)) ||
        (item.isAnime && absoluteEpisode != null && Number(episode.season) === 1 && Number(episode.episode) === Number(absoluteEpisode)) ||
        (mappedSimkl != null && Number(episode.season) === Number(mappedSimkl.season) && Number(episode.episode) === Number(mappedSimkl.episode))
      )
    })
  } catch (_) {
    return false
  }
}

// PMDB entries are keyed by TMDB id only. Items coming from TVDB-sourced
// pages usually lack a TMDB id, so resolve (and memoize) it — otherwise PMDB
// always reports "unwatched" there.
const tmdbIdResolveCache = new Map<string, number | null>()

async function resolveTmdbIdForLookup(item: WatchedLookupItem): Promise<number | undefined> {
  if (item.tmdbId != null) {
    const n = Number(String(item.tmdbId).replace('tmdb-', ''))
    return Number.isFinite(n) ? n : undefined
  }
  const preferred = item.type === 'movie' ? 'movie' : 'tv'
  const cacheKey = `${item.imdbId ?? ''}:${item.tvdbId ?? ''}:${preferred}`
  if (!item.imdbId && item.tvdbId == null) return undefined
  if (tmdbIdResolveCache.has(cacheKey)) return tmdbIdResolveCache.get(cacheKey) ?? undefined

  let resolved: number | null = null
  try {
    if (item.imdbId) {
      const mapping = await lookupTmdbId('imdb', item.imdbId, preferred)
      if (mapping) resolved = mapping.tmdbId
    }
    if (resolved == null && item.tvdbId != null) {
      const mapping = await lookupTmdbId('tvdb', String(item.tvdbId).replace('tvdb-', ''), preferred)
      if (mapping) resolved = mapping.tmdbId
    }
  } catch (_) { /* leave unresolved */ }
  tmdbIdResolveCache.set(cacheKey, resolved)
  return resolved ?? undefined
}

async function isPmdbWatched(rawItem: WatchedLookupItem): Promise<boolean> {
  try {
    let item = rawItem
    if (item.tmdbId == null) {
      const resolved = await resolveTmdbIdForLookup(item)
      if (resolved == null) return false
      item = { ...item, tmdbId: resolved }
    }
    const data = await getPmdbCache()

    // For anime, try resolving the correct TMDB ID + season/episode via anime-mapping API
    if (item.isAnime && item.tvdbId != null && item.season != null && item.episode != null) {
      try {
        const tvdbId = Number(String(item.tvdbId).replace('tvdb-', ''))
        if (Number.isFinite(tvdbId)) {
          const apiMapping = await mapEpisodeToProviders({
            localMediaId: item.id,
            tvdbSeriesId: tvdbId,
            tvdbSeasonNumber: item.season,
            tvdbEpisodeNumber: item.episode,
          })
          if (apiMapping?.tmdb?.id && isConfidenceSufficient(apiMapping)) {
            const mappedTmdbId = apiMapping.tmdb.id
            const mappedSeason = apiMapping.tmdb.seasonNumber ?? item.season
            const mappedEpisode = apiMapping.tmdb.episodeNumber ?? item.episode
            const found = data.items.some((entry) =>
              entry.media_type === 'tv' &&
              sameNumber(mappedTmdbId, entry.tmdb_id) &&
              entry.season === mappedSeason &&
              entry.episode === mappedEpisode
            )
            if (found) return true
          }
        }
      } catch (_) { /* fall through to standard check */ }
    }

    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.media_type !== 'movie') return false
      if (item.type === 'series' && entry.media_type !== 'tv') return false
      if (!sameNumber(item.tmdbId, entry.tmdb_id)) return false
      if (item.type === 'movie') return true
      if (item.season == null) return false
      if (item.episode == null) {
        if (!item.seasonEpisodeCount) return false
        if (item.isAnime && item.appSeasonEpCounts) {
          const range = seasonAbsoluteRange(item)
          if (range) {
            const watched = new Set(data.items
              .filter((watchedItem) =>
                watchedItem.media_type === 'tv' &&
                sameNumber(watchedItem.tmdb_id, item.tmdbId) &&
                Number(watchedItem.season) === 1 &&
                watchedItem.episode != null &&
                Number(watchedItem.episode) >= range.start &&
                Number(watchedItem.episode) <= range.end
              )
              .map((watchedItem) => Number(watchedItem.episode))
              .filter((episode): episode is number => episode != null))
            if (watched.size >= item.seasonEpisodeCount) return true
          }
        }
        const watched = new Set(data.items
          .filter((watchedItem) => watchedItem.media_type === 'tv' && sameNumber(watchedItem.tmdb_id, item.tmdbId) && Number(watchedItem.season) === Number(item.season))
          .map((watchedItem) => Number(watchedItem.episode))
          .filter((episode): episode is number => episode != null))
        return watched.size >= item.seasonEpisodeCount
      }
      return (
        (Number(entry.season) === Number(item.season) && Number(entry.episode) === Number(item.episode)) ||
        (item.isAnime && item.absoluteEpisode != null && Number(entry.season) === 1 && Number(entry.episode) === Number(item.absoluteEpisode))
      )
    })
  } catch (_) {
    return false
  }
}

async function isMdblistWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getMdblistCache()
    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.media_type !== 'movie') return false
      if (item.type === 'series' && entry.media_type !== 'show') return false
      const matches =
        sameString(item.imdbId, entry.imdb_id) ||
        sameNumber(item.tmdbId, entry.tmdb_id) ||
        sameNumber(item.tvdbId, entry.tvdb_id)
      if (!matches) return false
      if (item.type === 'movie') return true
      if (item.season == null) return false
      if (item.episode == null) return true
      return Number(entry.season) === Number(item.season) && Number(entry.episode) === Number(item.episode)
    })
  } catch (_) {
    return false
  }
}

async function getTraktCache(): Promise<TraktCacheData> {
  return cachedFetch<TraktCacheData>('watched:trakt', async () => {
    const [movies, shows] = await Promise.all([getWatchedMovies(), getWatchedShows()])
    return { movies, shows }
  }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
}

async function getSimklCache(): Promise<SimklCacheData> {
  return cachedFetch<SimklCacheData>('watched:simkl', async () => {
    const [movies, episodes] = await Promise.all([getSimklWatchedMovies(), getSimklWatchedEpisodes()])
    return { items: [...movies, ...episodes] }
  }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
}

async function getPmdbCache(): Promise<PmdbCacheData> {
  return cachedFetch<PmdbCacheData>('watched:pmdb', async () => {
    const items = await getPMDBWatched()
    return { items }
  }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
}

async function getMdblistCache(): Promise<MdblistCacheData> {
  return cachedFetch<MdblistCacheData>('watched:mdblist', async () => {
    const items = await getMdblistWatched()
    return { items }
  }, { category: CACHE_CATEGORIES.WATCHED_STATUS, ttlSeconds: CACHE_TTLS.WATCHED_STATUS })
}

function normalizedIds(item: WatchedLookupItem): string[] {
  return [item.id, item.imdbId, item.tmdbId ? `tmdb-${item.tmdbId}` : undefined, item.tmdbId, item.tvdbId ? `tvdb-${item.tvdbId}` : undefined, item.tvdbId, item.malId ? `mal-${item.malId}` : undefined, item.anilistId ? `anilist-${item.anilistId}` : undefined]
    .filter((id): id is string | number => id != null && id !== '')
    .map(String)
}

function matchesIds(item: WatchedLookupItem, ids?: Record<string, unknown>): boolean {
  if (!ids) return false
  return (
    sameNumber(item.traktId, ids.trakt) ||
    sameString(item.imdbId, ids.imdb) ||
    sameNumber(item.tmdbId, ids.tmdb) ||
    sameNumber(item.tvdbId, ids.tvdb)
  )
}

function matchesFlatIds(item: WatchedLookupItem, ids: { imdbId?: unknown; tmdbId?: unknown; tvdbId?: unknown; malId?: unknown; simklId?: unknown }): boolean {
  return (
    sameNumber(item.simklId, ids.simklId) ||
    sameString(item.imdbId, ids.imdbId) ||
    sameNumber(item.tmdbId, ids.tmdbId) ||
    sameNumber(item.tvdbId, ids.tvdbId) ||
    sameNumber(item.malId, ids.malId)
  )
}
function sameString(a: unknown, b: unknown): boolean {
  return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase())
}

function sameNumber(a: unknown, b: unknown): boolean {
  const clean = (val: unknown) => {
    if (val == null) return NaN
    if (typeof val === 'number') return val
    const num = Number(String(val).replace(/^(tmdb|tvdb|mal|anilist)-/i, ''))
    return Number.isFinite(num) ? num : NaN
  }
  const left = clean(a)
  const right = clean(b)
  return Number.isFinite(left) && Number.isFinite(right) && left === right
}
