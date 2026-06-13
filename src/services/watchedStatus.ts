import type { SearchResult, WatchProgress } from '../types'
import { getWatchedMovies, getWatchedShows, getTraktShowSeasons, type TraktWatchedItem, type TraktSeasonSummary } from './trakt/sync'
import { getSimklWatchedEpisodes, getSimklWatchedMovies } from './simkl/history'
import type { SimklWatchlistItem } from './simkl/types'
import { getPMDBWatched, type PMDBWatchedItem } from './pmdb'
import { getAniListProgress, getAniListTrackedProgress, resolveAniListMediaId } from './anilist'
import { mapTvdbEpisodeToAniList } from './animeLists'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'

export type WatchedSource = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist'

export interface WatchedLookupItem {
  id: string
  type: 'movie' | 'series'
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  season?: number
  episode?: number
  absoluteEpisode?: number
  isAnime?: boolean
  appSeasonEpCounts?: { season: number; count: number }[]
}

interface TraktCacheData { movies: TraktWatchedItem[]; shows: TraktWatchedItem[] }
interface SimklCacheData { items: SimklWatchlistItem[] }
interface PmdbCacheData { items: PMDBWatchedItem[] }

export function searchResultToLookup(item: SearchResult): WatchedLookupItem {
  return {
    id: item.id,
    type: item.type,
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
    anilistId: item.anilistId,
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
    if (item.season == null || item.episode == null) return true
    if (progress.season === item.season && progress.episode === item.episode) return true
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
        if (source === 'anilist') return isAniListWatched(item)
        return false
      })
  )
  return checks.some(Boolean)
}

async function isAniListWatched(item: WatchedLookupItem): Promise<boolean> {
  if (item.type !== 'series') return false
  try {
    if (item.episode == null) {
      const mediaId = await resolveAniListMediaId({ anilistId: item.anilistId, malId: item.malId })
      if (!mediaId) return false
      const entries = await getAniListTrackedProgress()
      return entries.some((entry) => entry.mediaId === mediaId && entry.progress > 0)
    }

    let anilistId = item.anilistId
    let progressEpisode = item.absoluteEpisode ?? item.episode

    if (item.tvdbId != null && item.season != null && item.episode != null) {
      const tvdbId = Number(String(item.tvdbId).replace('tvdb-', ''))
      if (Number.isFinite(tvdbId)) {
        const mapped = await mapTvdbEpisodeToAniList(tvdbId, item.season, item.episode).catch(() => null)
        if (mapped) {
          anilistId = mapped.anilistId
          progressEpisode = mapped.absoluteEpisode
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
  } catch {
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

function traktSeasonToAbsolute(season: number, episode: number, traktSeasons: TraktSeasonSummary[]): number {
  let abs = 0
  for (const s of traktSeasons) {
    if (s.number >= season) break
    abs += s.episodeCount
  }
  return abs + episode
}

async function isTraktWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getTraktCache()
    if (item.type === 'movie') {
      return data.movies.some((entry) => matchesIds(item, entry.movie?.ids))
    }

    const matchedEntry = data.shows.find((entry) => matchesIds(item, entry.show?.ids))
    if (!matchedEntry) return false
    if (item.season == null || item.episode == null) return true

    // Direct season/episode match
    const directMatch = matchedEntry.seasons?.some((season) =>
      season.number === item.season && season.episodes.some((ep) => ep.number === item.episode && ep.plays > 0)
    ) ?? false
    if (directMatch) return true

    // For anime, try absolute episode mapping (Trakt may have different season structure)
    if (item.isAnime && item.appSeasonEpCounts && matchedEntry.show?.ids?.imdb && matchedEntry.seasons) {
      const traktSeasons = await getTraktShowSeasons(matchedEntry.show.ids.imdb).catch(() => [])
      if (traktSeasons.length > 0) {
        const myAbsolute = seasonEpToAbsolute(item.season, item.episode, item.appSeasonEpCounts)
        return matchedEntry.seasons.some((season) =>
          season.episodes.some((ep) => {
            if (ep.plays <= 0) return false
            return traktSeasonToAbsolute(season.number, ep.number, traktSeasons) === myAbsolute
          })
        )
      }
    }

    return false
  } catch {
    return false
  }
}

async function isSimklWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getSimklCache()
    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.type !== 'movie') return false
      if (item.type === 'series' && entry.type === 'movie') return false
      if (!matchesFlatIds(item, entry)) return false
      if (item.type === 'movie') return true
      if (item.season == null || item.episode == null) return true
      if (!entry.watchedEpisodes || entry.watchedEpisodes.length === 0) return false
      return entry.watchedEpisodes.some((episode) =>
        (episode.season === item.season && episode.episode === item.episode) ||
        (item.isAnime && item.absoluteEpisode != null && episode.season === 1 && episode.episode === item.absoluteEpisode)
      )
    })
  } catch {
    return false
  }
}

async function isPmdbWatched(item: WatchedLookupItem): Promise<boolean> {
  try {
    const data = await getPmdbCache()
    return data.items.some((entry) => {
      if (item.type === 'movie' && entry.media_type !== 'movie') return false
      if (item.type === 'series' && entry.media_type !== 'tv') return false
      if (!sameNumber(item.tmdbId, entry.tmdb_id)) return false
      if (item.type === 'movie') return true
      if (item.season == null || item.episode == null) return true
      return (
        (entry.season === item.season && entry.episode === item.episode) ||
        (item.isAnime && item.absoluteEpisode != null && entry.season === 1 && entry.episode === item.absoluteEpisode)
      )
    })
  } catch {
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

function normalizedIds(item: WatchedLookupItem): string[] {
  return [item.id, item.imdbId, item.tmdbId ? `tmdb-${item.tmdbId}` : undefined, item.tmdbId, item.tvdbId ? `tvdb-${item.tvdbId}` : undefined, item.tvdbId, item.malId ? `mal-${item.malId}` : undefined, item.anilistId ? `anilist-${item.anilistId}` : undefined]
    .filter((id): id is string | number => id != null && id !== '')
    .map(String)
}

function matchesIds(item: WatchedLookupItem, ids?: Record<string, unknown>): boolean {
  if (!ids) return false
  return (
    sameString(item.imdbId, ids.imdb) ||
    sameNumber(item.tmdbId, ids.tmdb) ||
    sameNumber(item.tvdbId, ids.tvdb)
  )
}

function matchesFlatIds(item: WatchedLookupItem, ids: { imdbId?: unknown; tmdbId?: unknown; tvdbId?: unknown; malId?: unknown }): boolean {
  return (
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
  const left = Number(a)
  const right = Number(b)
  return Number.isFinite(left) && Number.isFinite(right) && left === right
}
