/**
 * Simkl watch history — mark watched, fetch history, sync progress.
 */

import { simklRequest, MOCK_WATCHLIST } from './client'
import { isSimklMockMode } from './auth'
import { resolveSimklId, type MediaRef } from './mappings'
import { cachedFetch } from '../cache/sqliteCache'
import type { SimklWatchlistItem, SimklApiItem, SimklMediaType } from './types'

const EXACT_EPISODE_PREFIX = 'simkl_episode_state_v1:'
const EXACT_EPISODE_TTL_MS = 10 * 60 * 1000

export function getSimklEpisodeExactState(localId: string, season: number, episode: number): boolean | undefined {
  try {
    const raw = localStorage.getItem(`${EXACT_EPISODE_PREFIX}${localId}:${season}:${episode}`)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { watched: boolean; updatedAt: number }
    if (Date.now() - parsed.updatedAt > EXACT_EPISODE_TTL_MS) {
      localStorage.removeItem(`${EXACT_EPISODE_PREFIX}${localId}:${season}:${episode}`)
      return undefined
    }
    return parsed.watched
  } catch (_) { return undefined }
}

function setSimklEpisodeExactState(localId: string, season: number, episode: number, watched: boolean): void {
  localStorage.setItem(`${EXACT_EPISODE_PREFIX}${localId}:${season}:${episode}`, JSON.stringify({ watched, updatedAt: Date.now() }))
}

const SIMKL_PENDING_EPISODES_KEY = 'simkl_pending_episode_marks_v1'
const SIMKL_PENDING_TTL_MS = 24 * 60 * 60 * 1000

type PendingSimklEpisode = { localId: string; season: number; episode: number; markedAt: number }

function readPendingSimklEpisodes(): PendingSimklEpisode[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIMKL_PENDING_EPISODES_KEY) || '[]') as PendingSimklEpisode[]
    const cutoff = Date.now() - SIMKL_PENDING_TTL_MS
    return Array.isArray(parsed) ? parsed.filter((mark) => mark.markedAt >= cutoff) : []
  } catch (_) {
    return []
  }
}

function writePendingSimklEpisodes(marks: PendingSimklEpisode[]): void {
  try { localStorage.setItem(SIMKL_PENDING_EPISODES_KEY, JSON.stringify(marks)) } catch (_) { /* storage unavailable */ }
}

export function markSimklEpisodePending(localId: string, season: number, episode: number): void {
  const marks = readPendingSimklEpisodes().filter((mark) => !(mark.localId === localId && mark.season === season && mark.episode === episode))
  marks.push({ localId, season, episode, markedAt: Date.now() })
  writePendingSimklEpisodes(marks)
}

export function unmarkSimklEpisodePending(localId: string, season: number, episode: number): void {
  writePendingSimklEpisodes(readPendingSimklEpisodes().filter((mark) => !(mark.localId === localId && mark.season === season && mark.episode === episode)))
}

export function isSimklEpisodePending(localId: string, season: number, episode: number): boolean {
  return readPendingSimklEpisodes().some((mark) => mark.localId === localId && mark.season === season && mark.episode === episode)
}

export async function invalidateSimklHistoryCaches(): Promise<void> {
  const { cacheClearCategory } = await import('../cache/sqliteCache')
  await Promise.all([
    cacheClearCategory('SIMKL_LISTS'),
    cacheClearCategory('simkl_list'),
  ])
  const { invalidateWatchedStatusCache } = await import('../watchedCacheSync')
  await invalidateWatchedStatusCache().catch(() => {})
}

// ─── Fetch history ─────────────────────────────────────────────────────────────

async function fetchSimklWatchedMovies(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) {
    return toHistoryItems(MOCK_WATCHLIST.filter((i) => !!i.movie && i.status === 'completed'))
  }
  const data = await simklRequest<SimklApiItem[]>('/sync/all-items/movies/completed?extended=full&date_from=1970-01-01')
  return toHistoryItems(data ?? [])
}

export async function getSimklWatchedMovies(forceRefresh = false): Promise<SimklWatchlistItem[]> {
  if (forceRefresh) return fetchSimklWatchedMovies()
  return cachedFetch<SimklWatchlistItem[]>(
    'simkl_history:movies',
    fetchSimklWatchedMovies,
    { category: 'SIMKL_LISTS', ttlSeconds: 300 },
  )
}

async function fetchSimklWatchedEpisodes(): Promise<SimklWatchlistItem[]> {
  if (isSimklMockMode()) {
    return toHistoryItems(MOCK_WATCHLIST.filter((i) => !!i.show && i.status === 'completed'))
  }
  const statuses = ['watching', 'completed', 'hold', 'dropped']
  const responses = await Promise.all(
    statuses.flatMap((status) => (['shows', 'anime'] as const).map((type) =>
      simklRequest<SimklApiItem[]>(
        `/sync/all-items/${type}/${status}?extended=full&include_all_episodes=yes&episode_watched_at=yes&date_from=1970-01-01`
      ).then((items) => (items || []).map((item) => ({ ...item, status }))).catch(() => [])
    ))
  )
  const merged = new Map<string, SimklWatchlistItem>()
  for (const item of responses.flatMap((data) => toHistoryItems(data ?? []))) {
    const key = `${item.type}:${item.simklId || item.imdbId || item.tvdbId || item.id}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, item)
      continue
    }
    const episodes = [...(existing.watchedEpisodes || []), ...(item.watchedEpisodes || [])]
    const uniqueEpisodes = new Map(episodes.map((episode) => [`${episode.season}:${episode.episode}`, episode]))
    merged.set(key, { ...existing, watchedEpisodes: [...uniqueEpisodes.values()] })
  }
  return [...merged.values()]
}

export async function getSimklWatchedEpisodes(forceRefresh = false): Promise<SimklWatchlistItem[]> {
  if (forceRefresh) return fetchSimklWatchedEpisodes()
  return cachedFetch<SimklWatchlistItem[]>(
    'simkl_history:episodes',
    fetchSimklWatchedEpisodes,
    { category: 'SIMKL_LISTS', ttlSeconds: 300 },
  )
}

/**
 * Resolve against the signed-in user's own history when Simkl's public ID
 * search has no record. This is deliberately strict so similarly named anime
 * cannot inherit each other's watched state.
 */
export function findExactSimklHistoryItem(
  item: Pick<MediaRef, 'title' | 'year' | 'contentType' | 'isAnime'>,
  history: SimklWatchlistItem[],
): SimklWatchlistItem | null {
  if (!item.isAnime || item.contentType !== 'movie' || !item.title) return null
  const title = normalizeHistoryTitle(item.title)
  return history.find((entry) => {
    if (entry.type !== 'anime' && entry.type !== 'movie') return false
    if (normalizeHistoryTitle(entry.title) !== title) return false
    return !item.year || !entry.year || Number(item.year) === Number(entry.year)
  }) ?? null
}

async function resolveFromOwnHistory(item: MediaRef): Promise<SimklWatchlistItem | null> {
  const [movies, anime] = await Promise.all([
    getSimklWatchedMovies(),
    getSimklWatchedEpisodes(),
  ])
  return findExactSimklHistoryItem(item, [...movies, ...anime])
}

// ─── Mark watched ──────────────────────────────────────────────────────────────

export async function markMovieWatchedOnSimkl(item: MediaRef, watchedAt?: string): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(item, {
    allowTitleFallback: !item.isAnime,
    allowExactTitleFallback: item.isAnime && item.contentType === 'movie',
  })
  const at = watchedAt || new Date().toISOString()
  const historyMatch = !mapping?.simklId ? await resolveFromOwnHistory(item) : null

  // It is already present in the user's watched history; no write is needed.
  if (historyMatch && (historyMatch.status === 'completed' || historyMatch.type === 'anime')) return

  if (mapping?.simklId) {
    const body = mapping.type === 'anime'
      ? { anime: [{ ids: { simkl: mapping.simklId }, seasons: [{ number: 1, episodes: [{ number: 1, watched_at: at }] }] }] }
      : mapping.type === 'movie'
        ? { movies: [{ ids: { simkl: mapping.simklId }, watched_at: at }] }
        : null
    if (!body) throw new Error('Resolved Simkl item is not a movie')
    await simklRequest('/sync/history', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    await invalidateSimklHistoryCaches()
    return
  }

  if (item.isAnime) throw new Error('No exact Simkl mapping for this anime movie')
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
  await invalidateSimklHistoryCaches()
}

export async function markEpisodeWatchedOnSimkl(
  show: MediaRef,
  episode: { season: number; episode: number },
  watchedAt?: string,
): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(show, { allowTitleFallback: !show.isAnime })
  const at = watchedAt || new Date().toISOString()
  const mediaKey = (show.type === 'anime' || mapping?.type === 'anime') ? 'anime' : 'shows'

  if (mapping?.simklId) {
    await simklRequest('/sync/history', {
      method: 'POST',
      body: JSON.stringify({
        [mediaKey]: [
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
    setSimklEpisodeExactState(show.localId, episode.season, episode.episode, true)
    await invalidateSimklHistoryCaches()
    return
  }

  // Fallback: external IDs
  const ids: Record<string, string | number> = {}
  if (show.imdbId) ids.imdb = show.imdbId
  if (show.tvdbId) ids.tvdb = show.tvdbId
  if (show.tmdbId) ids.tmdb = show.tmdbId
  if (show.malId) ids.mal = show.malId
  if (show.simklId) ids.simkl = show.simklId
  await simklRequest('/sync/history', {
    method: 'POST',
    body: JSON.stringify({
      [mediaKey]: [
        {
          title: show.title,
          year: show.year,
          ids,
          seasons: [{ number: episode.season, episodes: [{ number: episode.episode, watched_at: at }] }],
        },
      ],
    }),
  })
  setSimklEpisodeExactState(show.localId, episode.season, episode.episode, true)
  await invalidateSimklHistoryCaches()
}

export async function removeWatchedFromSimkl(item: MediaRef, type: SimklMediaType = 'movie'): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(item, {
    allowTitleFallback: !item.isAnime,
    allowExactTitleFallback: item.isAnime && item.contentType === 'movie',
  })
  const historyMatch = !mapping?.simklId ? await resolveFromOwnHistory(item) : null
  const simklId = mapping?.simklId ?? historyMatch?.simklId
  if (!simklId) return

  const resolvedType = item.isAnime ? (mapping?.type ?? historyMatch?.type ?? type) : type
  const key = resolvedType === 'movie' ? 'movies' : resolvedType === 'show' ? 'shows' : 'anime'
  await simklRequest('/sync/history/remove', {
    method: 'POST',
    body: JSON.stringify({
      [key]: [{ ids: { simkl: simklId } }],
    }),
  })
  await invalidateSimklHistoryCaches()
}

export async function removeEpisodeWatchedOnSimkl(
  show: MediaRef,
  episode: { season: number; episode: number },
): Promise<void> {
  if (isSimklMockMode()) return

  const mapping = await resolveSimklId(show, { allowTitleFallback: !show.isAnime })
  const mediaKey = (show.type === 'anime' || mapping?.type === 'anime') ? 'anime' : 'shows'
  const ids: Record<string, string | number> = {}
  if (mapping?.simklId) ids.simkl = mapping.simklId
  if (show.imdbId) ids.imdb = show.imdbId
  if (show.tvdbId) ids.tvdb = show.tvdbId
  if (show.tmdbId) ids.tmdb = show.tmdbId
  if (show.malId) ids.mal = show.malId
  if (show.simklId) ids.simkl = show.simklId

  await simklRequest('/sync/history/remove', {
    method: 'POST',
    body: JSON.stringify({
      [mediaKey]: [{
        title: show.title,
        year: show.year,
        ids,
        seasons: [{ number: episode.season, episodes: [{ number: episode.episode }] }],
      }],
    }),
  })
  setSimklEpisodeExactState(show.localId, episode.season, episode.episode, false)
  await invalidateSimklHistoryCaches()
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
    const type: SimklMediaType = r.movie ? 'movie' : (r.show || r.tv) ? 'show' : 'anime'
    const media = r.movie || r.show || r.tv || r.anime
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
      status: (r.status || 'completed') as SimklWatchlistItem['status'],
      watchedAt: r.last_watched_at,
      watchedEpisodes: extractWatchedEpisodes(r),
      watchedEpisodesCount: r.watched_episodes_count,
      totalEpisodesCount: r.total_episodes_count,
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

function normalizeHistoryTitle(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '')
}
