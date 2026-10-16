import type { SearchResult, WatchProgress } from '../types'
import { mediaIdentity } from './mediaPresentation'
import { getActiveProfileId, getProfileSetting, setProfileSetting } from './profiles'

export type ReleaseType = 'episode' | 'season' | 'movie' | 'anime_episode'
export interface ReleaseEvent {
  id: string
  media: SearchResult
  type: ReleaseType
  seasonNumber?: number
  episodeNumber?: number
  episodeTitle?: string
  releaseDate?: string // provider date-only values stay date-only
  artwork?: string
  relevanceScore: number
  relevanceReasons: string[]
  source: 'tmdb' | 'local'
  status: 'upcoming' | 'available' | 'tba'
}
export interface UpcomingPreferences {
  showOnHome: boolean
  horizonDays: number
  hidden: Record<string, number>
  includeLocalWatchlist: boolean
  includeContinueWatching: boolean
  includeConnectedWatchlists: boolean
  includeConnectedWatching: boolean
}
const KEY = 'aurales_upcoming_preferences_v1'
const HIDDEN_RELEASE_TTL_MS = 180 * 24 * 60 * 60 * 1000
const MAX_HIDDEN_RELEASES = 500
export function getUpcomingPreferences(profileId = getActiveProfileId()): UpcomingPreferences {
  try {
    const value = JSON.parse(getProfileSetting(KEY, profileId) || '{}')
    const rawHidden = value?.hidden && typeof value.hidden === 'object' && !Array.isArray(value.hidden)
      ? Object.entries(value.hidden as Record<string, unknown>)
      : []
    const cutoff = Date.now() - HIDDEN_RELEASE_TTL_MS
    const hiddenEntries = rawHidden
      .filter(([id, timestamp]) => id.length > 0 && typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= cutoff)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, MAX_HIDDEN_RELEASES)
    const hidden = Object.fromEntries(hiddenEntries) as Record<string, number>
    if (hiddenEntries.length !== rawHidden.length) {
      setProfileSetting(KEY, JSON.stringify({ ...value, hidden }), profileId)
    }
    return {
      showOnHome: value.showOnHome !== false,
      horizonDays: [3, 7, 14, 30, 60, 90].includes(value.horizonDays) ? value.horizonDays : 14,
      hidden,
      includeLocalWatchlist: value.includeLocalWatchlist !== false,
      includeContinueWatching: value.includeContinueWatching !== false,
      includeConnectedWatchlists: value.includeConnectedWatchlists !== false,
      includeConnectedWatching: value.includeConnectedWatching !== false,
    }
  } catch {
    return { showOnHome: true, horizonDays: 14, hidden: {}, includeLocalWatchlist: true, includeContinueWatching: true, includeConnectedWatchlists: true, includeConnectedWatching: true }
  }
}
export function setUpcomingPreferences(patch: Partial<UpcomingPreferences>) {
  setProfileSetting(KEY, JSON.stringify({ ...getUpcomingPreferences(), ...patch }))
  window.dispatchEvent(new Event('aurales:upcoming-preferences-changed'))
}
export function hideUpcomingRelease(id: string) { const prefs = getUpcomingPreferences(); setUpcomingPreferences({ hidden: { ...prefs.hidden, [id]: Date.now() } }) }
export function isReleaseInHorizon(event: ReleaseEvent, days: number, now = new Date()): boolean {
  if (!event.releaseDate) return false
  const date = new Date(`${event.releaseDate.slice(0, 10)}T12:00:00`)
  return date >= new Date(now.getFullYear(), now.getMonth(), now.getDate()) && date <= new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59, 59)
}
export function releaseTiming(date?: string, now = new Date()): string {
  if (!date) return 'Coming soon'
  const target = new Date(`${date.slice(0, 10)}T12:00:00`)
  if (!Number.isFinite(target.getTime())) return 'Coming soon'
  // Compare local calendar days at the same hour. Starting at midnight made
  // today's noon release appear half a day away and round up to "In 1 day".
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const days = Math.round((target.getTime() - start.getTime()) / 86400000)
  if (days <= 0) return 'In 0 days'
  return `In ${days} ${days === 1 ? 'day' : 'days'}`
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function upcomingMediaKey(event: ReleaseEvent): string {
  return upcomingIdentity(event.media)
}

function upcomingIdentity(item: Pick<SearchResult, 'id' | 'type' | 'provider' | 'tmdbId' | 'imdbId'>): string {
  if (item.tmdbId != null || item.imdbId) return mediaIdentity(item)
  // Local watchlist rows and playback progress describe the same local item
  // under different UI-facing provider labels. Keep other provider-local IDs
  // namespaced so a coincident ID from another catalog cannot merge with it.
  const provider = item.provider === 'progress' ? 'local' : item.provider.trim().toLowerCase()
  return `${item.type}:${provider}:${item.id}`
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function seasonDateKey(value?: string): string | undefined {
  const key = value?.slice(0, 10)
  return key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : undefined
}

/**
 * A show may return a season announcement plus every scheduled episode. The
 * Upcoming shelf is a "what should I watch next?" view, so retain only one
 * release per title and prefer the next dated episode for active series.
 */
export function keepNextReleasePerTitle(events: ReleaseEvent[], now = new Date()): ReleaseEvent[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const grouped = new Map<string, ReleaseEvent[]>()
  for (const event of events) {
    const key = upcomingMediaKey(event)
    const releases = grouped.get(key)
    if (releases) releases.push(event)
    else grouped.set(key, [event])
  }

  return [...grouped.values()].flatMap((releases) => {
    const datedFuture = releases.filter((event) => event.releaseDate && new Date(`${event.releaseDate.slice(0, 10)}T12:00:00`).getTime() >= today)
    if (datedFuture.length === 0) return []
    const nextEpisode = datedFuture
      .filter((event) => event.type === 'episode' || event.type === 'anime_episode')
      .sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)))[0]
    if (nextEpisode) return [nextEpisode]
    return [datedFuture.sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)))[0]]
  })
}

/** Normalize existing provider metadata into release events; never invent a date. */
export async function buildUpcomingEvents(input: { watchlist: SearchResult[]; progress: WatchProgress[]; preferences?: UpcomingPreferences; getShow: (id: string) => Promise<{ seasons: { seasonNumber: number; airDate?: string; name?: string; poster?: string }[]; title: string; backdrop?: string; poster?: string; tmdbId?: string | number }>; getSeason?: (id: string, season: number) => Promise<{ episodes: { episodeNumber: number; seasonNumber: number; name?: string; airDate?: string; still?: string }[] }> }): Promise<ReleaseEvent[]> {
  const progressKey = (progress: WatchProgress) => upcomingIdentity({ id: progress.mediaId, type: progress.mediaType === 'movie' ? 'movie' : 'series', provider: 'local', tmdbId: progress.tmdbId, imdbId: progress.imdbId })
  const activeProgress = input.progress.filter((p) => !p.completed)
  const active = new Set(activeProgress.map(progressKey))
  const watched = new Set(input.progress.filter((p) => p.completed).map(progressKey))
  const watchlistIds = new Set(input.watchlist.map((item) => item.tmdbId || item.imdbId || item.id))
  const activeSeasonByTitle = new Map<string, { season: number; updatedAt: number }>()
  for (const progress of activeProgress) {
    if (!Number.isInteger(progress.season) || (progress.season ?? 0) <= 0) continue
    const key = progressKey(progress)
    const updatedAt = Date.parse(progress.updatedAt || '') || 0
    const current = activeSeasonByTitle.get(key)
    if (!current || updatedAt >= current.updatedAt) activeSeasonByTitle.set(key, { season: progress.season!, updatedAt })
  }
  const seeds = new Map<string, SearchResult>()
  input.watchlist.forEach((item) => seeds.set(upcomingIdentity(item), item))
  input.progress.forEach((p) => {
    const item: SearchResult = { id: p.mediaId, title: p.title || 'Untitled', type: p.mediaType === 'movie' ? 'movie' : 'series', provider: 'local', poster: p.poster, backdrop: p.backdrop, tmdbId: p.tmdbId, imdbId: p.imdbId }
    seeds.set(upcomingIdentity(item), item)
  })
  const eventsBySeed = await mapLimit([...seeds.values()], 4, async (item) => {
    const itemEvents: ReleaseEvent[] = []
    const key = upcomingIdentity(item)
    if (item.type === 'movie') {
      if (item.releaseDate) itemEvents.push({ id: `movie:${key}:${item.releaseDate}`, media: item, type: 'movie', releaseDate: item.releaseDate, artwork: item.backdrop || item.poster, relevanceScore: active.has(key) ? 100 : 80, relevanceReasons: [watchlistIds.has(item.tmdbId || item.imdbId || item.id) ? 'On your watchlist' : 'From your library'], source: 'local', status: new Date(`${item.releaseDate}T12:00:00`) <= new Date() ? 'available' : 'upcoming' })
      return itemEvents
    }
    if (!item.tmdbId) return itemEvents
    try {
      const show = await input.getShow(String(item.tmdbId))
      const seasons = show.seasons.filter((season) => season.seasonNumber > 0)
      const today = localDateKey(new Date())
      const latestAiredSeason = seasons
        .filter((season) => {
          const date = seasonDateKey(season.airDate)
          return date && date < today
        })
        .sort((a, b) => b.seasonNumber - a.seasonNumber)[0]?.seasonNumber
      const currentSeason = activeSeasonByTitle.get(key)?.season ?? latestAiredSeason
      const reason = active.has(key) ? 'Currently watching' : watched.has(key) ? 'Because you watched this series' : 'On your watchlist'
      const media = { ...item, title: show.title, poster: show.poster || item.poster, backdrop: show.backdrop || item.backdrop }
      for (const season of seasons) {
        if (season.airDate) {
          itemEvents.push({ id: `season:${show.tmdbId || item.tmdbId}:${season.seasonNumber}:${season.airDate}`, media, type: 'season', seasonNumber: season.seasonNumber, releaseDate: season.airDate, artwork: show.backdrop || season.poster || item.backdrop || item.poster, relevanceScore: active.has(key) ? 100 : watched.has(key) ? 90 : 80, relevanceReasons: [reason], source: 'tmdb', status: new Date(`${season.airDate}T12:00:00`) <= new Date() ? 'available' : 'upcoming' })
        }
      }
      const getSeason = input.getSeason
      if (active.has(key) && getSeason) {
        const episodeSeasons = seasons.filter((season) => {
          const seasonDate = seasonDateKey(season.airDate)
          return !seasonDate || seasonDate >= today || season.seasonNumber === currentSeason
        })
        // TMDB metadata requests are globally limited by the request coordinator.
        // Starting up to four seasons together fills that pool without allowing
        // one active show to wait through a long sequence of network round trips.
        const episodeEvents = await mapLimit(episodeSeasons, 4, async (season) => {
          try {
            const details = await getSeason(String(item.tmdbId), season.seasonNumber)
            return details.episodes.filter((episode) => episode.airDate).map((episode) => ({
              id: `episode:${item.tmdbId}:${episode.seasonNumber}:${episode.episodeNumber}:${episode.airDate}`,
              media,
              type: 'episode' as const,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
              episodeTitle: episode.name,
              releaseDate: episode.airDate,
              artwork: episode.still || show.backdrop || item.backdrop || item.poster,
              relevanceScore: 120,
              relevanceReasons: ['Currently watching'],
              source: 'tmdb' as const,
              status: new Date(`${episode.airDate}T12:00:00`) <= new Date() ? 'available' as const : 'upcoming' as const,
            }))
          } catch { /* keep the season event when episode metadata is unavailable */ }
          return []
        })
        itemEvents.push(...episodeEvents.flat())
      }
    } catch { /* retain cached/offline items; a failed provider cannot create a release */ }
    return itemEvents
  })
  const events = eventsBySeed.flat()
  const prefs = input.preferences || getUpcomingPreferences()
  return keepNextReleasePerTitle(events.filter((event) => !prefs.hidden[event.id]))
    .sort((a, b) => b.relevanceScore - a.relevanceScore || String(a.releaseDate || '9999').localeCompare(String(b.releaseDate || '9999')))
}
