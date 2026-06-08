import { traktFetch } from './auth'

interface ScrobblePayload {
  movie?: { ids: { imdb?: string; tmdb?: number } }
  episode?: { ids: { imdb?: string; tmdb?: number }; season: number; number: number }
  show?: { ids: { imdb?: string; tmdb?: number } }
  progress: number
}

export async function scrobbleStart(payload: ScrobblePayload): Promise<void> {
  await traktFetch('/scrobble/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function scrobblePause(payload: ScrobblePayload): Promise<void> {
  await traktFetch('/scrobble/pause', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function scrobbleStop(payload: ScrobblePayload): Promise<void> {
  await traktFetch('/scrobble/stop', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function buildMovieScrobble(imdbId: string, progress: number): ScrobblePayload {
  return {
    movie: { ids: { imdb: imdbId } },
    progress: Math.round(progress * 100) / 100,
  }
}

export function buildEpisodeScrobble(
  showImdbId: string,
  season: number,
  episode: number,
  progress: number
): ScrobblePayload {
  return {
    show: { ids: { imdb: showImdbId } },
    episode: { ids: {}, season, number: episode },
    progress: Math.round(progress * 100) / 100,
  }
}
