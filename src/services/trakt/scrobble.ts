import { traktFetch } from './auth'
import { mapEpisodeToProviders, isConfidenceSufficient } from '../anime-mapping'

interface ScrobblePayload {
  movie?: { ids: { imdb?: string; tmdb?: number; trakt?: number } }
  episode?: { ids: { imdb?: string; tmdb?: number }; season: number; number: number }
  show?: { ids: { imdb?: string; tmdb?: number; trakt?: number } }
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

export async function buildMappedEpisodeScrobble(
  showImdbId: string,
  season: number,
  episode: number,
  progress: number,
  animeMapping?: { localMediaId: string; tvdbId: number },
): Promise<ScrobblePayload> {
  if (animeMapping) {
    try {
      const mapping = await mapEpisodeToProviders({
        localMediaId: animeMapping.localMediaId,
        tvdbSeriesId: animeMapping.tvdbId,
        tvdbSeasonNumber: season,
        tvdbEpisodeNumber: episode,
      })
      if (mapping?.trakt && isConfidenceSufficient(mapping)) {
        return {
          show: { ids: { imdb: showImdbId, trakt: mapping.trakt.id } },
          episode: {
            ids: {},
            season: mapping.trakt.seasonNumber ?? season,
            number: mapping.trakt.episodeNumber ?? episode,
          },
          progress: Math.round(progress * 100) / 100,
        }
      }
    } catch (_) { /* fall through */ }
  }
  return buildEpisodeScrobble(showImdbId, season, episode, progress)
}
