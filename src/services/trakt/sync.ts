import { traktFetch } from './auth'
import { cachedFetch } from '../cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../cache/constants'

export interface TraktWatchedItem {
  plays: number
  lastWatchedAt: string
  lastUpdatedAt: string
  movie?: { title: string; year: number; ids: { trakt: number; slug: string; imdb: string; tmdb: number } }
  show?: { title: string; year: number; ids: { trakt: number; slug: string; imdb: string; tmdb: number } }
  seasons?: { number: number; episodes: { number: number; plays: number; lastWatchedAt: string }[] }[]
}

export async function getWatchedMovies(): Promise<TraktWatchedItem[]> {
  const data = await traktFetch('/sync/watched/movies') as Record<string, unknown>[]
  return data.map((item) => ({
    plays: item.plays as number,
    lastWatchedAt: item.last_watched_at as string,
    lastUpdatedAt: item.last_updated_at as string,
    movie: item.movie as TraktWatchedItem['movie'],
  }))
}

export async function getWatchedShows(): Promise<TraktWatchedItem[]> {
  const data = await traktFetch('/sync/watched/shows') as Record<string, unknown>[]
  return data.map((item) => ({
    plays: item.plays as number,
    lastWatchedAt: item.last_watched_at as string,
    lastUpdatedAt: item.last_updated_at as string,
    show: item.show as TraktWatchedItem['show'],
    seasons: item.seasons as TraktWatchedItem['seasons'],
  }))
}

export interface TraktEpisodeProgress {
  number: number
  completed: boolean
}

export interface TraktSeasonProgress {
  number: number
  episodes: TraktEpisodeProgress[]
}

export async function getShowWatchedProgress(showId: string): Promise<TraktSeasonProgress[]> {
  return cachedFetch<TraktSeasonProgress[]>(`watched:trakt:show-progress:${showId}`, async () => {
    const data = await traktFetch(`/shows/${showId}/progress/watched`) as Record<string, unknown>
    const seasons = data.seasons as { number: number; episodes: { number: number; completed: boolean }[] }[]
    return (seasons || []).map((s) => ({
      number: s.number,
      episodes: (s.episodes || []).map((e) => ({ number: e.number, completed: e.completed })),
    }))
  }, {
    category: CACHE_CATEGORIES.WATCHED_STATUS,
    ttlSeconds: CACHE_TTLS.WATCHED_STATUS,
  })
}

export async function getCollection(type: 'movies' | 'shows'): Promise<unknown[]> {
  return await traktFetch(`/sync/collection/${type}`) as unknown[]
}

export async function getWatchlist(type: 'movies' | 'shows'): Promise<unknown[]> {
  return await traktFetch(`/users/me/watchlist/${type}`) as unknown[]
}

export async function getRatings(type: 'movies' | 'shows'): Promise<unknown[]> {
  return await traktFetch(`/users/me/ratings/${type}`) as unknown[]
}

export async function addToHistory(items: { movies?: unknown[]; shows?: unknown[]; episodes?: unknown[] }): Promise<void> {
  await traktFetch('/sync/history', {
    method: 'POST',
    body: JSON.stringify(items),
  })
}

export async function removeFromHistory(items: { movies?: unknown[]; shows?: unknown[]; episodes?: unknown[] }): Promise<void> {
  await traktFetch('/sync/history/remove', {
    method: 'POST',
    body: JSON.stringify(items),
  })
}

export async function markMovieWatched(imdbId: string): Promise<void> {
  await addToHistory({
    movies: [{ ids: { imdb: imdbId }, watched_at: new Date().toISOString() }],
  })
}

export async function markEpisodeWatched(
  showImdbId: string, season: number, episode: number,
  appSeasonCounts?: { season: number; count: number }[],
): Promise<void> {
  let traktSeason = season
  let traktEpisode = episode
  if (appSeasonCounts) {
    const mapped = await convertToTraktNumbering(showImdbId, season, episode, appSeasonCounts)
    if (mapped) { traktSeason = mapped.season; traktEpisode = mapped.episode }
  }
  await addToHistory({
    shows: [{ ids: { imdb: showImdbId }, seasons: [{ number: traktSeason, episodes: [{ number: traktEpisode, watched_at: new Date().toISOString() }] }] }],
  })
}

export async function markMovieUnwatched(imdbId: string): Promise<void> {
  await removeFromHistory({ movies: [{ ids: { imdb: imdbId } }] })
}

export async function markEpisodeUnwatched(
  showImdbId: string, season: number, episode: number,
  appSeasonCounts?: { season: number; count: number }[],
): Promise<void> {
  let traktSeason = season
  let traktEpisode = episode
  if (appSeasonCounts) {
    const mapped = await convertToTraktNumbering(showImdbId, season, episode, appSeasonCounts)
    if (mapped) { traktSeason = mapped.season; traktEpisode = mapped.episode }
  }
  await removeFromHistory({
    shows: [{ ids: { imdb: showImdbId }, seasons: [{ number: traktSeason, episodes: [{ number: traktEpisode }] }] }],
  })
}

export async function markShowUnwatched(showImdbId: string): Promise<void> {
  await removeFromHistory({ shows: [{ ids: { imdb: showImdbId } }] })
}

export async function convertToTraktNumbering(
  showImdbId: string, appSeason: number, appEpisode: number,
  appSeasonCounts: { season: number; count: number }[],
): Promise<{ season: number; episode: number } | null> {
  const traktSeasons = await getTraktShowSeasons(showImdbId).catch(() => [])
  if (traktSeasons.length === 0) return null

  // Convert app (season, episode) to absolute
  let absolute = 0
  for (const s of appSeasonCounts) {
    if (s.season >= appSeason) break
    absolute += s.count
  }
  absolute += appEpisode

  // Convert absolute to Trakt (season, episode)
  let remaining = absolute
  for (const s of traktSeasons) {
    if (remaining <= s.episodeCount) {
      return { season: s.number, episode: remaining }
    }
    remaining -= s.episodeCount
  }
  return null
}

export async function getPlaybackProgress(): Promise<unknown[]> {
  return await traktFetch('/sync/playback') as unknown[]
}

/** Delete a single playback-progress entry (the id returned by /sync/playback). */
export async function removePlaybackItem(id: string | number): Promise<void> {
  await traktFetch(`/sync/playback/${id}`, { method: 'DELETE' })
}

export interface TraktSeasonSummary {
  number: number
  episodeCount: number
}

const traktSeasonCache = new Map<string, { data: TraktSeasonSummary[]; timestamp: number }>()
const TRAKT_SEASON_CACHE_TTL = 30 * 60 * 1000

export async function getTraktShowSeasons(showImdbId: string): Promise<TraktSeasonSummary[]> {
  const cached = traktSeasonCache.get(showImdbId)
  if (cached && Date.now() - cached.timestamp < TRAKT_SEASON_CACHE_TTL) return cached.data

  const raw = await traktFetch(`/shows/${showImdbId}/seasons`) as Record<string, unknown>[]
  const seasons = raw
    .filter((s) => typeof s.number === 'number' && (s.number as number) > 0)
    .map((s) => ({ number: s.number as number, episodeCount: (s.episode_count ?? s.aired_episodes ?? 0) as number }))
    .sort((a, b) => a.number - b.number)

  traktSeasonCache.set(showImdbId, { data: seasons, timestamp: Date.now() })
  return seasons
}
