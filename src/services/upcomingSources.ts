import type { SearchResult, WatchProgress } from '../types'
import { useAppStore } from '../stores/appStore'
import { getLocalWatchlist } from './localWatchlist'
import { getSimklWatchStatusList } from './simkl/lists'
import type { SimklWatchlistItem } from './simkl/types'
import { getWatchlist as getTraktWatchlist, getPlaybackProgress as getTraktPlaybackProgress } from './trakt/sync'
import { getAniListContinueWatching } from './anilist'
import type { UpcomingPreferences } from './upcoming'

export interface UpcomingSeeds { watchlist: SearchResult[]; progress: WatchProgress[] }

function simklItem(item: SimklWatchlistItem): SearchResult {
  return {
    id: item.tvdbId ? `tvdb-${item.tvdbId}` : item.imdbId || (item.tmdbId ? `tmdb-${item.tmdbId}` : item.id),
    title: item.title, year: item.year, type: item.type === 'movie' ? 'movie' : 'series', provider: 'simkl',
    poster: item.poster, backdrop: item.backdrop, imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId,
  }
}

function traktItems(raw: unknown[], type: 'movie' | 'series'): SearchResult[] {
  return raw.flatMap((entry) => {
    const value = entry as { movie?: { title?: string; year?: number; ids?: Record<string, string | number> }; show?: { title?: string; year?: number; ids?: Record<string, string | number> } }
    const media = type === 'movie' ? value.movie : value.show
    if (!media?.title) return []
    return [{ id: String(media.ids?.imdb || media.ids?.tmdb || media.title), title: media.title, year: media.year, type, provider: 'trakt', tmdbId: media.ids?.tmdb, imdbId: typeof media.ids?.imdb === 'string' ? media.ids.imdb : undefined }]
  })
}

function traktPlayback(raw: unknown[]): WatchProgress[] {
  return raw.flatMap((entry) => {
    const value = entry as { id?: string | number; type?: string; progress?: number; paused_at?: string; movie?: { title?: string; ids?: Record<string, string | number> }; show?: { title?: string; ids?: Record<string, string | number> }; episode?: { season?: number; number?: number } }
    const movie = value.type === 'movie'; const media = movie ? value.movie : value.show
    if (!media?.title) return []
    return [{ id: `trakt:${value.id || media.ids?.tmdb || media.title}`, mediaId: String(media.ids?.tmdb || media.ids?.imdb || media.title), mediaType: movie ? 'movie' : 'series', title: media.title, tmdbId: media.ids?.tmdb, imdbId: typeof media.ids?.imdb === 'string' ? media.ids.imdb : undefined, season: value.episode?.season, episode: value.episode?.number, progressSeconds: Math.max(1, value.progress || 1), durationSeconds: 100, completed: false, updatedAt: value.paused_at }]
  })
}

function unique(items: SearchResult[]) {
  const seen = new Set<string>()
  return items.filter((item) => { const key = String(item.tmdbId || item.imdbId || `${item.type}:${item.title}`).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true })
}

/** Load only the services enabled for Upcoming. Provider failures are intentionally non-fatal. */
export async function loadUpcomingSeeds(preferences: UpcomingPreferences): Promise<UpcomingSeeds> {
  const state = useAppStore.getState()
  const watchlist: SearchResult[] = preferences.includeLocalWatchlist ? [...getLocalWatchlist()] : []
  const progress = preferences.includeContinueWatching ? [...state.watchProgress.values()].filter((item) => !item.completed && item.progressSeconds > 0) : []
  const jobs: Promise<void>[] = []
  if (preferences.includeConnectedWatchlists && state.traktConnected) jobs.push(Promise.all([getTraktWatchlist('movies'), getTraktWatchlist('shows')]).then(([movies, shows]) => { watchlist.push(...traktItems(movies, 'movie'), ...traktItems(shows, 'series')) }).catch(() => undefined))
  if (preferences.includeConnectedWatchlists && state.simklConnected) jobs.push(getSimklWatchStatusList('watchlist').then((items) => { watchlist.push(...items.map(simklItem)) }).catch(() => undefined))
  if (preferences.includeConnectedWatching && state.simklConnected) jobs.push(getSimklWatchStatusList('watching').then((items) => { progress.push(...items.map((item) => ({ id: `simkl:${item.id}`, mediaId: String(item.tmdbId || item.imdbId || item.id), mediaType: item.type === 'movie' ? 'movie' : 'series', title: item.title, poster: item.poster, backdrop: item.backdrop, tmdbId: item.tmdbId, imdbId: item.imdbId, progressSeconds: 1, durationSeconds: 100, completed: false, updatedAt: item.addedAt }))) }).catch(() => undefined))
  if (preferences.includeConnectedWatching && state.traktConnected) jobs.push(getTraktPlaybackProgress().then((items) => { progress.push(...traktPlayback(items)) }).catch(() => undefined))
  if (preferences.includeConnectedWatching && state.anilistConnected) jobs.push(getAniListContinueWatching().then((items) => { progress.push(...items.map((item) => ({ ...item, completed: false }))) }).catch(() => undefined))
  await Promise.all(jobs)
  return { watchlist: unique(watchlist), progress }
}
