import type { SearchResult, WatchProgress } from '../types'
import { getAniListFullList } from './anilist'
import { getMdblistWatchlistItems } from './mdblist'
import { getSimklWatching, getSimklWatchlist } from './simkl/lists'
import { getWatchlist as getTraktWatchlist } from './trakt/sync'
import { tmdbProvider } from './tmdb'
import { tvdbProvider } from './tvdb'
import { resolveAnimeIds } from './animeLists'
import { applySearchResultArt, resolveArtFromProviders } from './artwork'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'

export interface CalendarEntry {
  id: string
  date: string
  kind: 'movie' | 'episode'
  title: string
  subtitle?: string
  poster?: string
  media: SearchResult
  season?: number
  episode?: number
  watched: boolean
  releaseState: 'past' | 'today' | 'upcoming'
}

export interface CalendarLoadOptions {
  month: Date
  watchProgress: Map<string, WatchProgress>
  traktConnected: boolean
  simklConnected: boolean
  anilistConnected: boolean
  mdblistConnected: boolean
}

export interface CalendarLoadResult {
  entries: CalendarEntry[]
  errors: string[]
}

const toNumber = (value: string | number | undefined) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function toLocalDateKey(value?: string): string | undefined {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1]
}

function monthRange(month: Date) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1)
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return { start: key(start), end: key(end) }
}

function inMonth(date: string | undefined, month: Date) {
  if (!date) return false
  const { start, end } = monthRange(month)
  return date >= start && date <= end
}

function localTodayKey() {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

function getReleaseState(date: string): CalendarEntry['releaseState'] {
  const today = localTodayKey()
  return date === today ? 'today' : date < today ? 'past' : 'upcoming'
}

function progressMatches(item: SearchResult, progress: WatchProgress, season?: number, episode?: number) {
  if (!progress.completed) return false
  if (season != null && episode != null && (progress.season !== season || progress.episode !== episode)) return false
  const values = [item.id, item.imdbId, item.tmdbId, item.tvdbId, item.anilistId, item.malId].filter(Boolean).map(String)
  const progressValues = [progress.mediaId, progress.imdbId, progress.tmdbId, progress.anilistId, progress.malId].filter(Boolean).map(String)
  return values.some((value) => progressValues.includes(value) || progress.id === value || progress.id.startsWith(`${value}:`))
    || Boolean(item.title && progress.title && item.title.toLowerCase() === progress.title.toLowerCase())
}

function isWatched(item: SearchResult, progress: Map<string, WatchProgress>, season?: number, episode?: number) {
  return [...progress.values()].some((entry) => progressMatches(item, entry, season, episode))
}

function dedupe(items: SearchResult[]) {
  const map = new Map<string, SearchResult>()
  for (const item of items) {
    const key = item.tmdbId ? `tmdb:${item.tmdbId}` : item.tvdbId ? `tvdb:${item.tvdbId}` : item.imdbId ? `imdb:${item.imdbId}` : item.anilistId ? `anilist:${item.anilistId}` : `${item.type}:${item.title}:${item.year || ''}`
    if (!map.has(key)) map.set(key, item)
  }
  return [...map.values()]
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const worker = async () => {
    while (index < items.length) {
      const item = items[index++]
      results.push(await mapper(item))
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function localItems(progress: Map<string, WatchProgress>): SearchResult[] {
  return dedupe([...progress.values()]
    .filter((item) => item.progressSeconds > 5 && !item.completed)
    .map((item) => ({
      id: item.mediaId,
      title: item.title || 'Untitled',
      type: item.mediaType === 'movie' ? 'movie' as const : 'series' as const,
      provider: 'local',
      poster: item.poster,
      backdrop: item.backdrop,
      tmdbId: item.tmdbId,
      imdbId: item.imdbId,
      anilistId: item.anilistId,
      malId: item.malId,
    })))
}

function traktItems(raw: unknown[], type: 'movie' | 'series'): SearchResult[] {
  return raw.flatMap((entry) => {
    const record = entry as { movie?: { title?: string; year?: number; ids?: Record<string, string | number> }; show?: { title?: string; year?: number; ids?: Record<string, string | number> } }
    const media = type === 'movie' ? record.movie : record.show
    if (!media?.title) return []
    return [{ id: String(media.ids?.imdb || media.ids?.tmdb || media.title), title: media.title, year: media.year, type, provider: 'trakt', tmdbId: media.ids?.tmdb, imdbId: typeof media.ids?.imdb === 'string' ? media.ids.imdb : undefined }]
  })
}

async function getTrackedItems(options: CalendarLoadOptions, errors: string[]): Promise<SearchResult[]> {
  const sources: Promise<SearchResult[]>[] = [Promise.resolve(localItems(options.watchProgress))]
  if (options.traktConnected) {
    sources.push(Promise.all([getTraktWatchlist('movies'), getTraktWatchlist('shows')]).then(([movies, shows]) => [...traktItems(movies, 'movie'), ...traktItems(shows, 'series')]))
  }
  if (options.simklConnected) {
    sources.push(Promise.all([getSimklWatchlist(), getSimklWatching()]).then((lists) => lists.flat().map((item) => ({
      id: item.imdbId || (item.tmdbId ? `tmdb-${item.tmdbId}` : item.id), title: item.title, year: item.year,
      type: item.type === 'movie' ? 'movie' as const : 'series' as const, provider: 'simkl', poster: item.poster,
      backdrop: item.backdrop, tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId, malId: item.malId, isAnime: item.type === 'anime',
    }))))
  }
  if (options.anilistConnected) {
    sources.push(getAniListFullList().then((entries) => entries
      .filter((entry) => entry.status === 'CURRENT' || entry.status === 'PLANNING')
      .map((entry) => ({ id: `anilist-${entry.mediaId}`, title: entry.title, year: entry.seasonYear, type: 'series' as const, provider: 'anilist', poster: entry.poster, backdrop: entry.backdrop, anilistId: entry.mediaId, malId: entry.idMal, isAnime: true }))))
  }
  if (options.mdblistConnected) sources.push(getMdblistWatchlistItems())

  const settled = await Promise.allSettled(sources)
  return dedupe(settled.flatMap((result) => {
    if (result.status === 'fulfilled') return result.value
    errors.push(result.reason instanceof Error ? result.reason.message : 'A calendar source failed to load')
    return []
  }))
}

async function entriesForItem(item: SearchResult, month: Date, progress: Map<string, WatchProgress>): Promise<CalendarEntry[]> {
  const artwork = await resolveArtFromProviders(
    item.type === 'series' ? 'series' : 'movie',
    { tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId },
    item.isAnime,
  ).catch(() => undefined)
  const displayItem = applySearchResultArt(artwork ? { ...item, ...artwork } : item)

  if (displayItem.type === 'movie') {
    let date = toLocalDateKey(displayItem.releaseDate)
    if (!date && displayItem.tmdbId) date = toLocalDateKey((await tmdbProvider.getMovie(`tmdb-${displayItem.tmdbId}`)).releaseDate)
    return inMonth(date, month) && date ? [{ id: `movie:${displayItem.id}:${date}`, date, kind: 'movie', title: displayItem.title, subtitle: 'Movie release', poster: displayItem.poster, media: displayItem, watched: isWatched(displayItem, progress), releaseState: getReleaseState(date) }] : []
  }

  let tmdbId = toNumber(displayItem.tmdbId)
  let tvdbId = toNumber(displayItem.tvdbId)
  if (!tmdbId && !tvdbId && (displayItem.anilistId || displayItem.malId)) {
    const mapped = await resolveAnimeIds({ anilistId: toNumber(displayItem.anilistId), malId: toNumber(displayItem.malId) }).catch(() => null)
    tmdbId = mapped?.tmdbId
    tvdbId = mapped?.tvdbId
  }
  if (!tmdbId && !tvdbId) return []
  const provider = tmdbId ? tmdbProvider : tvdbProvider
  const showId = tmdbId ? `tmdb-${tmdbId}` : `tvdb-${tvdbId}`
  const show = await provider.getShow(showId)
  const seasons = show.seasons.filter((season) => season.seasonNumber > 0)
  const seasonDetails = await mapLimit(seasons, 4, (season) => provider.getSeason(showId, season.seasonNumber).catch(() => null))
  return seasonDetails.flatMap((season) => season ? season.episodes.flatMap((episode) => {
    const date = toLocalDateKey(episode.airDate)
    if (!date || !inMonth(date, month)) return []
    return [{
      id: `episode:${showId}:${episode.seasonNumber}:${episode.episodeNumber}:${date}`,
      date,
      kind: 'episode' as const,
      title: displayItem.title,
      subtitle: `S${episode.seasonNumber} E${episode.episodeNumber}${episode.name ? ` · ${episode.name}` : ''}`,
      poster: displayItem.poster || episode.still || show.poster,
      media: { ...displayItem, tmdbId: displayItem.tmdbId || show.tmdbId, tvdbId: displayItem.tvdbId || show.tvdbId, imdbId: displayItem.imdbId || show.imdbId },
      season: episode.seasonNumber,
      episode: episode.episodeNumber,
      watched: isWatched(displayItem, progress, episode.seasonNumber, episode.episodeNumber),
      releaseState: getReleaseState(date),
    }]
  }) : [])
}

function calendarCacheKey(options: CalendarLoadOptions) {
  const progress = [...options.watchProgress.values()]
    .map((item) => `${item.id}:${item.updatedAt || ''}:${item.completed ? 1 : 0}:${Math.floor(item.progressSeconds)}`)
    .sort()
    .join('|')
  return `library:calendar:v2:${monthRange(options.month).start.slice(0, 7)}:${options.traktConnected ? 1 : 0}${options.simklConnected ? 1 : 0}${options.anilistConnected ? 1 : 0}${options.mdblistConnected ? 1 : 0}:${progress}`
}

async function buildLibraryCalendar(options: CalendarLoadOptions): Promise<CalendarLoadResult> {
  const errors: string[] = []
  const items = await getTrackedItems(options, errors)
  const batches = await mapLimit(items, 4, (item) => entriesForItem(item, options.month, options.watchProgress).catch((error) => {
    errors.push(error instanceof Error ? error.message : `Could not load ${item.title}`)
    return [] as CalendarEntry[]
  }))
  const entries = batches.flat().sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
  return { entries, errors }
}

export async function loadLibraryCalendar(options: CalendarLoadOptions): Promise<CalendarLoadResult> {
  return cachedFetch(calendarCacheKey(options), () => buildLibraryCalendar(options), {
    category: CACHE_CATEGORIES.LIBRARY_CALENDAR,
    ttlSeconds: CACHE_TTLS.LIBRARY_CALENDAR,
  })
}
