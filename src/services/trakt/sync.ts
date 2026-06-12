import { traktFetch } from './auth'

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

export async function markEpisodeWatched(showImdbId: string, season: number, episode: number): Promise<void> {
  await addToHistory({
    episodes: [{ ids: { imdb: showImdbId }, seasons: [{ number: season, episodes: [{ number: episode }] }], watched_at: new Date().toISOString() }],
  })
}

export async function markMovieUnwatched(imdbId: string): Promise<void> {
  await removeFromHistory({ movies: [{ ids: { imdb: imdbId } }] })
}

export async function markEpisodeUnwatched(showImdbId: string, season: number, episode: number): Promise<void> {
  await removeFromHistory({
    shows: [{ ids: { imdb: showImdbId }, seasons: [{ number: season, episodes: [{ number: episode }] }] }],
  })
}

export async function markShowUnwatched(showImdbId: string): Promise<void> {
  await removeFromHistory({ shows: [{ ids: { imdb: showImdbId } }] })
}

export async function getPlaybackProgress(): Promise<unknown[]> {
  return await traktFetch('/sync/playback') as unknown[]
}
