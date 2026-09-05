import type { SearchResult, WatchProgress } from '../types'
import { getProfileSetting, setProfileSetting } from './profiles'

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
export function getUpcomingPreferences(): UpcomingPreferences {
  try {
    const value = JSON.parse(getProfileSetting(KEY) || '{}')
    return {
      showOnHome: value.showOnHome !== false,
      horizonDays: [3, 7, 14, 30, 60, 90].includes(value.horizonDays) ? value.horizonDays : 14,
      hidden: value.hidden || {},
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
  const target = new Date(`${date.slice(0, 10)}T12:00:00`); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const days = Math.round((target.getTime() - start.getTime()) / 86400000)
  if (days <= 0) return 'In 0 days'
  return `In ${days} ${days === 1 ? 'day' : 'days'}`
}

function upcomingMediaKey(event: ReleaseEvent): string {
  const media = event.media
  return `${media.type}:${String(media.tmdbId || media.imdbId || media.id).replace(/^tmdb[-:]/i, '')}`
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
    grouped.set(key, [...(grouped.get(key) || []), event])
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
export async function buildUpcomingEvents(input: { watchlist: SearchResult[]; progress: WatchProgress[]; getShow: (id: string) => Promise<{ seasons: { seasonNumber: number; airDate?: string; name?: string; poster?: string }[]; title: string; backdrop?: string; poster?: string; tmdbId?: string | number }>; getSeason?: (id: string, season: number) => Promise<{ episodes: { episodeNumber: number; seasonNumber: number; name?: string; airDate?: string; still?: string }[] }> }): Promise<ReleaseEvent[]> {
  const mediaKey = (value: string | number | undefined) => String(value || '').replace(/^tmdb[-:]/i, '')
  const active = new Set(input.progress.filter((p) => !p.completed).map((p) => mediaKey(p.tmdbId || p.mediaId)))
  const watched = new Set(input.progress.filter((p) => p.completed).map((p) => mediaKey(p.tmdbId || p.mediaId)))
  const seeds = new Map<string, SearchResult>()
  input.watchlist.forEach((item) => seeds.set(`${item.type}:${item.tmdbId || item.imdbId || item.id}`, item))
  input.progress.forEach((p) => seeds.set(`${p.mediaType === 'movie' ? 'movie' : 'series'}:${p.tmdbId || p.imdbId || p.mediaId}`, { id: p.mediaId, title: p.title || 'Untitled', type: p.mediaType === 'movie' ? 'movie' : 'series', provider: 'local', poster: p.poster, backdrop: p.backdrop, tmdbId: p.tmdbId, imdbId: p.imdbId }))
  const events: ReleaseEvent[] = []
  for (const item of seeds.values()) {
    const key = mediaKey(item.tmdbId || item.imdbId || item.id)
    if (item.type === 'movie') {
      if (item.releaseDate) events.push({ id: `movie:${key}:${item.releaseDate}`, media: item, type: 'movie', releaseDate: item.releaseDate, artwork: item.backdrop || item.poster, relevanceScore: active.has(key) ? 100 : 80, relevanceReasons: [input.watchlist.some((x) => (x.tmdbId || x.imdbId || x.id) === (item.tmdbId || item.imdbId || item.id)) ? 'On your watchlist' : 'From your library'], source: 'local', status: new Date(`${item.releaseDate}T12:00:00`) <= new Date() ? 'available' : 'upcoming' })
      continue
    }
    if (!item.tmdbId) continue
    try {
      const show = await input.getShow(String(item.tmdbId))
      for (const season of show.seasons.filter((s) => s.seasonNumber > 0 && s.airDate)) {
        const reason = active.has(key) ? 'Currently watching' : watched.has(key) ? 'Because you watched this series' : 'On your watchlist'
        events.push({ id: `season:${show.tmdbId || item.tmdbId}:${season.seasonNumber}:${season.airDate}`, media: { ...item, title: show.title, poster: show.poster || item.poster, backdrop: show.backdrop || item.backdrop }, type: 'season', seasonNumber: season.seasonNumber, releaseDate: season.airDate, artwork: show.backdrop || season.poster || item.backdrop || item.poster, relevanceScore: active.has(key) ? 100 : watched.has(key) ? 90 : 80, relevanceReasons: [reason], source: 'tmdb', status: new Date(`${season.airDate}T12:00:00`) <= new Date() ? 'available' : 'upcoming' })
        if (active.has(key) && input.getSeason) {
          const details = await input.getSeason(String(item.tmdbId), season.seasonNumber)
          for (const episode of details.episodes.filter((ep) => ep.airDate)) {
            events.push({ id: `episode:${item.tmdbId}:${episode.seasonNumber}:${episode.episodeNumber}:${episode.airDate}`, media: { ...item, title: show.title, poster: show.poster || item.poster, backdrop: show.backdrop || item.backdrop }, type: 'episode', seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, episodeTitle: episode.name, releaseDate: episode.airDate, artwork: episode.still || show.backdrop || item.backdrop || item.poster, relevanceScore: 120, relevanceReasons: ['Currently watching'], source: 'tmdb', status: new Date(`${episode.airDate}T12:00:00`) <= new Date() ? 'available' : 'upcoming' })
          }
        }
      }
    } catch { /* retain cached/offline items; a failed provider cannot create a release */ }
  }
  const prefs = getUpcomingPreferences()
  return keepNextReleasePerTitle(events.filter((event) => !prefs.hidden[event.id]))
    .sort((a, b) => b.relevanceScore - a.relevanceScore || String(a.releaseDate || '9999').localeCompare(String(b.releaseDate || '9999')))
}
