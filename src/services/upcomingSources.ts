import type { SearchResult, WatchProgress } from '../types'
import { useAppStore } from '../stores/appStore'
import { getLocalWatchlist } from './localWatchlist'
import { getSimklWatchStatusList } from './simkl/lists'
import type { SimklWatchlistItem } from './simkl/types'
import { getWatchlist as getTraktWatchlist, getPlaybackProgress as getTraktPlaybackProgress } from './trakt/sync'
import { getAniListContinueWatching } from './anilist'
import type { UpcomingPreferences } from './upcoming'
import { mediaIdentity } from './mediaPresentation'

export interface UpcomingSeeds { watchlist: SearchResult[]; progress: WatchProgress[] }

/** Stable key for the subset of watch progress that changes Upcoming seeds.
 * Playback checkpoints update seconds and timestamps frequently; those values
 * do not change the set or metadata of titles Upcoming has to enrich. */
export function upcomingProgressSignature(progress: Iterable<WatchProgress>): string {
  const seeds: unknown[][] = []
  for (const item of progress) {
    if (item.completed || item.progressSeconds <= 0) continue
    seeds.push([
      item.id,
      item.mediaId,
      item.mediaType,
      item.title,
      item.poster,
      item.backdrop,
      item.tmdbId,
      item.imdbId,
      item.malId,
      item.anilistId,
    ])
  }
  // Progress maps keep their insertion order across immutable store updates.
  // Serialize once instead of serializing every record and sorting the strings.
  return JSON.stringify(seeds)
}

function simklItem(item: SimklWatchlistItem): SearchResult {
  return {
    id: item.tvdbId ? `tvdb-${item.tvdbId}` : item.imdbId || (item.tmdbId ? `tmdb-${item.tmdbId}` : item.id),
    title: item.title, year: item.year, type: item.type === 'movie' ? 'movie' : 'series', provider: 'simkl',
    poster: item.poster, backdrop: item.backdrop, imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId,
  }
}

function traktItems(raw: unknown[], type: 'movie' | 'series'): SearchResult[] {
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const value = entry as { movie?: { title?: string; year?: number; ids?: Record<string, string | number> }; show?: { title?: string; year?: number; ids?: Record<string, string | number> } }
    const media = type === 'movie' ? value.movie : value.show
    if (!media?.title) return []
    return [{ id: String(media.ids?.imdb || media.ids?.tmdb || media.title), title: media.title, year: media.year, type, provider: 'trakt', tmdbId: media.ids?.tmdb, imdbId: typeof media.ids?.imdb === 'string' ? media.ids.imdb : undefined }]
  })
}

function traktPlayback(raw: unknown[]): WatchProgress[] {
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const value = entry as { id?: string | number; type?: string; progress?: number; paused_at?: string; movie?: { title?: string; ids?: Record<string, string | number> }; show?: { title?: string; ids?: Record<string, string | number> }; episode?: { season?: number; number?: number } }
    const movie = value.type === 'movie'; const media = movie ? value.movie : value.show
    if (!media?.title) return []
    return [{ id: `trakt:${value.id || media.ids?.tmdb || media.title}`, mediaId: String(media.ids?.tmdb || media.ids?.imdb || media.title), mediaType: movie ? 'movie' : 'series', title: media.title, tmdbId: media.ids?.tmdb, imdbId: typeof media.ids?.imdb === 'string' ? media.ids.imdb : undefined, season: value.episode?.season, episode: value.episode?.number, progressSeconds: Math.max(1, value.progress || 1), durationSeconds: 100, completed: false, updatedAt: value.paused_at }]
  })
}

function unique(items: SearchResult[]) {
  const byIdentity = new Map<string, SearchResult>()
  for (const item of items) {
    // A title alone is not a stable identity: remakes and reboots can share
    // names while representing distinct watchlist entries.
    const hasProviderId = item.tmdbId != null || Boolean(item.imdbId)
      || item.tvdbId != null || item.malId != null || item.anilistId != null
    const identity = hasProviderId
      ? mediaIdentity(item)
      : `title:${item.title}:${item.year ?? ''}`
    const key = `${item.type}:${identity.toLowerCase()}`
    const existing = byIdentity.get(key)
    if (!existing) {
      byIdentity.set(key, item)
      continue
    }
    // Provider requests finish in network-dependent order. Keep the first
    // source's display identity, but fill holes from later duplicates so a
    // sparse response cannot hide artwork or IDs already known elsewhere.
    byIdentity.set(key, {
      ...existing,
      year: existing.year ?? item.year,
      poster: existing.poster || item.poster,
      backdrop: existing.backdrop || item.backdrop,
      logo: existing.logo || item.logo,
      overview: existing.overview || item.overview,
      rating: existing.rating ?? item.rating,
      runtime: existing.runtime ?? item.runtime,
      releaseDate: existing.releaseDate || item.releaseDate,
      imdbId: existing.imdbId || item.imdbId,
      tmdbId: existing.tmdbId ?? item.tmdbId,
      tvdbId: existing.tvdbId ?? item.tvdbId,
      malId: existing.malId ?? item.malId,
      anilistId: existing.anilistId ?? item.anilistId,
    })
  }
  return [...byIdentity.values()]
}

/** Load only the services enabled for Upcoming. Provider failures are intentionally non-fatal. */
export async function loadUpcomingSeeds(preferences: UpcomingPreferences): Promise<UpcomingSeeds> {
  const state = useAppStore.getState()
  const jobs: Promise<{ watchlist: SearchResult[]; progress: WatchProgress[] }>[] = []
  if (preferences.includeConnectedWatchlists && state.traktConnected) jobs.push(
    Promise.all([getTraktWatchlist('movies'), getTraktWatchlist('shows')])
      .then(([movies, shows]) => ({ watchlist: [...traktItems(movies, 'movie'), ...traktItems(shows, 'series')], progress: [] }))
      .catch(() => ({ watchlist: [], progress: [] })),
  )
  if (preferences.includeConnectedWatchlists && state.simklConnected) jobs.push(
    getSimklWatchStatusList('watchlist')
      .then((items) => ({ watchlist: items.map(simklItem), progress: [] }))
      .catch(() => ({ watchlist: [], progress: [] })),
  )
  if (preferences.includeConnectedWatching && state.simklConnected) jobs.push(
    getSimklWatchStatusList('watching')
      .then((items) => ({
        watchlist: [],
        progress: items.map((item) => ({ id: `simkl:${item.id}`, mediaId: String(item.tmdbId || item.imdbId || item.id), mediaType: item.type === 'movie' ? 'movie' : 'series', title: item.title, poster: item.poster, backdrop: item.backdrop, tmdbId: item.tmdbId, imdbId: item.imdbId, progressSeconds: 1, durationSeconds: 100, completed: false, updatedAt: item.addedAt })),
      }))
      .catch(() => ({ watchlist: [], progress: [] })),
  )
  if (preferences.includeConnectedWatching && state.traktConnected) jobs.push(
    getTraktPlaybackProgress()
      .then((items) => ({ watchlist: [], progress: traktPlayback(items) }))
      .catch(() => ({ watchlist: [], progress: [] })),
  )
  if (preferences.includeConnectedWatching && state.anilistConnected) jobs.push(
    getAniListContinueWatching()
      .then((items) => ({ watchlist: [], progress: items.map((item) => ({ ...item, completed: false })) }))
      .catch(() => ({ watchlist: [], progress: [] })),
  )
  const sources = await Promise.all(jobs)
  const watchlist: SearchResult[] = preferences.includeLocalWatchlist ? [...getLocalWatchlist()] : []
  const progress = preferences.includeContinueWatching
    ? [...state.watchProgress.values()].filter((item) => !item.completed && item.progressSeconds > 0)
    : []
  for (const source of sources) {
    watchlist.push(...source.watchlist)
    progress.push(...source.progress)
  }
  return { watchlist: unique(watchlist), progress }
}
