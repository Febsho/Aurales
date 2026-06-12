/**
 * Simkl watch history — mark watched, fetch history, sync progress.
 */

import { simklRequest, MOCK_WATCHLIST } from './client'
import { isSimklMockMode } from './auth'
import { resolveSimklId, type MediaRef } from './mappings'
import type { SimklWatchlistItem, SimklApiItem, SimklMediaType } from './types'

// ─── Fetch history ─────────────────────────────────────────────────────────────

export async function getSimklWatchedMovies(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) {
    return toHistoryItems(MOCK_WATCHLIST.filter((i) => !!i.movie && i.status === 'completed'))
  }
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/completed?extended=full&date_from=1970-01-01')
    return toHistoryItems(data ?? [])
  } catch { return [] }
}

export async function getSimklWatchedEpisodes(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) {
    return toHistoryItems(MOCK_WATCHLIST.filter((i) => !!i.show && i.status === 'completed'))
  }
  try {
    const data = await simklRequest<SimklApiItem[]>('/sync/all-items/shows/completed?extended=full&date_from=1970-01-01')
    return toHistoryItems(data ?? [])
  } catch { return [] }
}

// ─── Mark watched ──────────────────────────────────────────────────────────────

export async function markMovieWatchedOnSimkl(item: MediaRef, watchedAt?: string): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(item)
  const at = watchedAt || new Date().toISOString()

  if (mapping?.simklId) {
    await simklRequest('/sync/history', {
      method: 'POST',
      body: JSON.stringify({
        movies: [{ ids: { simkl: mapping.simklId }, watched_at: at }],
      }),
    })
    return
  }

  // Fallback: use external IDs
  const ids: Record<string, string | number> = {}
  if (item.imdbId) ids.imdb = item.imdbId
  if (item.tmdbId) ids.tmdb = item.tmdbId
  await simklRequest('/sync/history', {
    method: 'POST',
    body: JSON.stringify({
      movies: [{ title: item.title, year: item.year, ids, watched_at: at }],
    }),
  })
}

export async function markEpisodeWatchedOnSimkl(
  show: MediaRef,
  episode: { season: number; episode: number },
  watchedAt?: string,
): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(show)
  const at = watchedAt || new Date().toISOString()

  if (mapping?.simklId) {
    await simklRequest('/sync/history', {
      method: 'POST',
      body: JSON.stringify({
        shows: [
          {
            ids: { simkl: mapping.simklId },
            seasons: [
              {
                number: episode.season,
                episodes: [{ number: episode.episode, watched_at: at }],
              },
            ],
          },
        ],
      }),
    })
    return
  }

  // Fallback: external IDs
  const ids: Record<string, string | number> = {}
  if (show.imdbId) ids.imdb = show.imdbId
  if (show.tvdbId) ids.tvdb = show.tvdbId
  await simklRequest('/sync/history', {
    method: 'POST',
    body: JSON.stringify({
      shows: [
        {
          title: show.title,
          year: show.year,
          ids,
          seasons: [{ number: episode.season, episodes: [{ number: episode.episode, watched_at: at }] }],
        },
      ],
    }),
  })
}

export async function removeWatchedFromSimkl(item: MediaRef, type: SimklMediaType = 'movie'): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(item)
  if (!mapping?.simklId) return

  const key = type === 'movie' ? 'movies' : type === 'show' ? 'shows' : 'anime'
  await simklRequest('/sync/history/remove', {
    method: 'POST',
    body: JSON.stringify({
      [key]: [{ ids: { simkl: mapping.simklId } }],
    }),
  })
}

export async function removeEpisodeWatchedOnSimkl(
  show: MediaRef,
  episode: { season: number; episode: number },
): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(show)
  const ids: Record<string, string | number> = {}
  if (mapping?.simklId) ids.simkl = mapping.simklId
  if (show.imdbId) ids.imdb = show.imdbId
  if (show.tvdbId) ids.tvdb = show.tvdbId

  await simklRequest('/sync/history/remove', {
    method: 'POST',
    body: JSON.stringify({
      shows: [{
        title: show.title,
        year: show.year,
        ids,
        seasons: [{ number: episode.season, episodes: [{ number: episode.episode }] }],
      }],
    }),
  })
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function toHistoryItems(raw: any): SimklWatchlistItem[] {
  if (!raw) return []
  let items: any[] = []
  if (Array.isArray(raw)) {
    items = raw
  } else if (typeof raw === 'object') {
    if (Array.isArray(raw.movies)) {
      items.push(...raw.movies.map((m: any) => ({ ...m, movie: m.movie || m })))
    }
    if (Array.isArray(raw.shows)) {
      items.push(...raw.shows.map((s: any) => ({ ...s, show: s.show || s })))
    }
    if (Array.isArray(raw.anime)) {
      items.push(...raw.anime.map((a: any) => ({ ...a, anime: a.anime || a })))
    }
    if (Array.isArray(raw.tv)) {
      items.push(...raw.tv.map((t: any) => ({ ...t, show: t.show || t })))
    }
  }

  return items.map((r) => {
    const type: SimklMediaType = r.movie ? 'movie' : r.show ? 'show' : 'anime'
    const media = r.movie || r.show || r.anime
    if (!media) return null
    const ids = media.ids
    if (!ids) return null
    return {
      id: String(ids.simkl || ids.simkl_id || ids.imdb || media.title),
      type,
      title: media.title,
      year: media.year,
      simklId: ids.simkl || ids.simkl_id,
      tmdbId: ids.tmdb,
      tvdbId: ids.tvdb,
      imdbId: ids.imdb,
      malId: ids.mal,
      status: 'completed',
      watchedAt: r.last_watched_at,
      watchedEpisodes: extractWatchedEpisodes(r),
    } satisfies SimklWatchlistItem
  }).filter(Boolean) as SimklWatchlistItem[]
}

function extractWatchedEpisodes(raw: any) {
  const seasons = Array.isArray(raw?.seasons) ? raw.seasons : []
  const episodes: { season: number; episode: number; watchedAt?: string }[] = []
  for (const season of seasons) {
    const seasonNumber = Number(season.number ?? season.season)
    if (!Number.isFinite(seasonNumber)) continue
    const seasonEpisodes = Array.isArray(season.episodes) ? season.episodes : []
    for (const episode of seasonEpisodes) {
      const episodeNumber = Number(episode.number ?? episode.episode)
      if (!Number.isFinite(episodeNumber)) continue
      episodes.push({
        season: seasonNumber,
        episode: episodeNumber,
        watchedAt: episode.watched_at ?? episode.watchedAt ?? raw.last_watched_at,
      })
    }
  }
  return episodes.length ? episodes : undefined
}
