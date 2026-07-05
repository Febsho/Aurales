import type { SearchResult, WatchProgress } from '../types'
import { getWatchedMovies, getWatchedShows, getTraktShowSeasons, getShowWatchedProgress, type TraktWatchedItem, type TraktSeasonSummary } from './trakt/sync'
import { getSimklWatchedEpisodes, getSimklWatchedMovies } from './simkl/history'
import type { SimklWatchlistItem } from './simkl/types'
import { getPMDBWatched, lookupTmdbId, type PMDBWatchedItem } from './pmdb'
import { getMdblistWatched, type MdblistWatchedItem } from './mdblist'
import { getAniListProgress, getAniListTrackedProgress, hasAnyAniListExactEpisodeMarks, isAniListEpisodeMarkedExact, resolveAniListMediaId } from './anilist'
import { mapTvdbEpisodeToAniList } from './animeLists'
import { cachedFetch, cacheSet } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { mapEpisodeToProviders, isConfidenceSufficient } from './anime-mapping'

export type WatchedSource = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist'

export interface WatchedLookupItem {
  id: string
  type: 'movie' | 'series'
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

async function isAniListWatched(item: WatchedLookupItem): Promise<boolean> {
  if (item.type !== 'series') return false
  try {
    if (item.season != null && item.episode == null && item.seasonEpisodeCount && item.appSeasonEpCounts) {
      const mediaId = await resolveAniListMediaId({ anilistId: item.anilistId, malId: item.malId })
      if (!mediaId) return false
      const entries = await getAniListTrackedProgress()
      const entry = entries.find((e) => e.mediaId === mediaId)
      if (!entry) return false
      const endEpisode = seasonEpToAbsolute(item.season, item.seasonEpisodeCount, item.appSeasonEpCounts)
      return entry.progress >= endEpisode
    }

    if (item.episode == null) {
      const mediaId = await resolveAniListMediaId({ anilistId: item.anilistId, malId: item.malId })
      if (!mediaId) return false
      const entries = await getAniListTrackedProgress()
      return entries.some((entry) => entry.mediaId === mediaId && entry.status === 'COMPLETED')
    }

    if (item.season != null && item.episode != null) {
      const exactMatch = normalizedIds(item).some((id) =>
        hasAnyAniListExactEpisodeMarks(id) && isAniListEpisodeMarkedExact(id, item.season!, item.episode!)
      )
      if (exactMatch) return true
    }

    let anilistId = item.anilistId
    let progressEpisode = item.absoluteEpisode ?? (item.isAnime && item.appSeasonEpCounts && item.season != null
      ? seasonEpToAbsolute(item.season, item.episode, item.appSeasonEpCounts)
      : item.episode)

    // Try animeApi mapping first
    if (item.tvdbId != null && item.season != null && item.episode != null) {
      const tvdbId = Number(String(item.tvdbId).replace('tvdb-', ''))
      if (Number.isFinite(tvdbId)) {
        try {
          const apiMapping = await mapEpisodeToProviders({
            localMediaId: item.id,
            tvdbSeriesId: tvdbId,
            tvdbSeasonNumber: item.season,
            tvdbEpisodeNumber: item.episode,
          })
          if (apiMapping?.anilist && isConfidenceSufficient(apiMapping)) {
            anilistId = apiMapping.anilist.mediaId
            progressEpisode = apiMapping.anilist.episodeNumber ?? progressEpisode
          }
        } catch (_) { /* fall through to animeLists */ }

        if (anilistId === item.anilistId) {
          const mapped = await mapTvdbEpisodeToAniList(tvdbId, item.season, item.episode).catch(() => null)
          if (mapped) {
            anilistId = mapped.anilistId
            progressEpisode = mapped.absoluteEpisode
          }
        }
      }
    }

    const entry = await getAniListProgress(
      anilistId != null ? Number(anilistId) : undefined,
      item.malId != null ? Number(item.malId) : undefined,
    )
    if (!entry) return false
    if (item.episode == null) return entry.progress > 0
    return progressEpisode != null && entry.progress >= progressEpisode
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
    const data = await getSimklCache()

    // Pre-resolve anime mapping outside the sync .some() loop
    let mappedSimkl: { season: number; episode: number } | null = null
    let mappedSimklShowId: number | null = null
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

    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.type !== 'movie') return false
      if (item.type === 'series' && entry.type === 'movie') return false
      const idsMatch = matchesFlatIds(item, entry) || (mappedSimklShowId != null && sameNumber(mappedSimklShowId, entry.simklId))
      if (!idsMatch) return false
      if (item.type === 'movie') return true
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
