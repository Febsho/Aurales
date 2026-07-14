/**
 * Simkl playback integration.
 *
 * Scrobbling:
 *   Called from the player at start / pause / stop events.
 *   Uses the real Simkl /scrobble/* endpoints.
 *
 * Playback progress sync:
 *   GET/POST/DELETE /sync/playback for cross-device resume.
 *
 * Throttle: 20-second minimum between scrobble calls (Simkl lock timeout).
 */

import { isSimklMockMode } from './auth'
import { simklRequest } from './client'
import { resolveSimklId, type MediaRef } from './mappings'
import {
  simklScrobbleStart,
  simklScrobblePause,
  simklScrobbleStop,
  buildSimklMovieScrobble,
  buildSimklEpisodeScrobble,
  buildSimklAnimeScrobble,
} from './scrobble'
import type { SimklScrobbleIds, SimklPlaybackProgressItem } from './types'
import { mapEpisodeToProviders, isConfidenceSufficient } from '../anime-mapping'

const THROTTLE_MS = 20_000
let _lastScrobbleCall = 0

export interface PlaybackItem extends MediaRef {
  mediaType: 'movie' | 'show' | 'anime'
  contentType: 'movie' | 'series'
  isAnime: boolean
  season?: number
  episode?: number
}

// ─── Scrobble hooks (called from player) ──────────────────────────────────────

/**
 * Called when playback starts or resumes.
 * Sends a scrobble/start to Simkl with the current progress.
 */
export async function onSimklPlaybackStart(item: PlaybackItem, progress: number): Promise<void> {
  if (isSimklMockMode()) return
  if (!canScrobble()) return

  try {
    const payload = await buildSimklPlaybackPayload(item, progress * 100)
    if (payload) await simklScrobbleStart(payload)
    else if (item.isAnime) console.warn(`[simkl] skipped unsafe anime start mapping for ${item.localId}`)
  } catch (_) {
    // Swallow — playback should not be disrupted by scrobble failures
  }
}

/**
 * Called when playback is paused.
 * Sends a scrobble/pause to Simkl with the current progress.
 */
export async function onSimklPlaybackPause(item: PlaybackItem, progress: number): Promise<void> {
  if (isSimklMockMode()) return
  if (!canScrobble()) return

  try {
    const payload = await buildSimklPlaybackPayload(item, progress * 100)
    if (payload) await simklScrobblePause(payload)
    else if (item.isAnime) console.warn(`[simkl] skipped unsafe anime pause mapping for ${item.localId}`)
  } catch (_) {
    // Swallow
  }
}

/**
 * Called when playback stops (user exits or content ends).
 * Sends a scrobble/stop to Simkl. If progress >= 80%, Simkl auto-marks watched.
 */
export async function onSimklPlaybackStop(item: PlaybackItem, progress: number): Promise<void> {
  if (isSimklMockMode()) return
  // Always send stop, skip throttle check for stop events
  _lastScrobbleCall = Date.now()

  try {
    const payload = await buildSimklPlaybackPayload(item, progress * 100)
    if (payload) {
      await simklScrobbleStop(payload)
      const { invalidateSimklHistoryCaches } = await import('./history')
      await invalidateSimklHistoryCaches().catch(() => {})
    } else if (item.isAnime) console.warn(`[simkl] skipped unsafe anime stop mapping for ${item.localId}`)
  } catch (_) {
    // Swallow
  }
}

// ─── Playback progress sync ────────────────────────────────────────────────────

/** Get all current playback progress items from Simkl. */
export async function getSimklPlaybackProgress(): Promise<SimklPlaybackProgressItem[]> {
  if (isSimklMockMode()) return []
  const { cachedFetch } = await import('../cache/sqliteCache')
  return cachedFetch<SimklPlaybackProgressItem[]>(
    'simkl_playback',
    async () => (await simklRequest<SimklPlaybackProgressItem[]>('/sync/playback')) ?? [],
    { category: 'SIMKL_LISTS', ttlSeconds: 120 },
  )
}

/** Save/update playback progress to Simkl for cross-device resume. */
export async function saveSimklPlaybackProgress(item: PlaybackItem, progress: number): Promise<void> {
  if (isSimklMockMode()) return
  try {
    const payload = await buildSimklPlaybackPayload(item, progress * 100)
    if (payload) {
      await simklScrobbleStart(payload)
      refreshSimklPlaybackCache().catch(() => {})
    } else if (item.isAnime) console.warn(`[simkl] skipped unsafe anime progress mapping for ${item.localId}`)
  } catch (_) {
    // Swallow
  }
}

export async function refreshSimklPlaybackCache(): Promise<SimklPlaybackProgressItem[]> {
  const fresh = (await simklRequest<SimklPlaybackProgressItem[]>('/sync/playback')) ?? []
  const { cacheSet } = await import('../cache/sqliteCache')
  await cacheSet('simkl_playback', fresh, { category: 'SIMKL_LISTS', ttlSeconds: 120 })
  return fresh
}

/** Remove a playback progress item from Simkl. */
export async function removeSimklPlaybackProgress(id: number): Promise<void> {
  if (isSimklMockMode()) return
  try {
    await simklRequest(`/sync/playback/${id}`, { method: 'DELETE' })
    // The playback list is served from the sqlite cache (120s TTL) — drop the
    // deleted entry there too, or the item reappears until the cache expires.
    const { cacheGet, cacheSet } = await import('../cache/sqliteCache')
    const cached = await cacheGet<SimklPlaybackProgressItem[]>('simkl_playback')
    if (cached?.data) {
      await cacheSet(
        'simkl_playback',
        cached.data.filter((entry) => Number(entry.id) !== id),
        { category: 'SIMKL_LISTS', ttlSeconds: 120 },
      )
    }
  } catch (_) {
    // Swallow
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function canScrobble(): boolean {
  const now = Date.now()
  if (now - _lastScrobbleCall < THROTTLE_MS) return false
  _lastScrobbleCall = now
  return true
}

export async function buildSimklPlaybackPayload(item: PlaybackItem, progressPct: number) {
  const resolved = await resolveIds(item)
  if (!resolved) return null
  const { ids, providerType } = resolved
  const meta = { title: item.title, year: item.year }

  if (item.isAnime && item.contentType === 'series') {
    if (item.tvdbId && item.localId && item.season != null && item.episode != null) {
      try {
        const mapping = await mapEpisodeToProviders({
          localMediaId: item.localId,
          tvdbSeriesId: item.tvdbId,
          tvdbSeasonNumber: item.season,
          tvdbEpisodeNumber: item.episode,
        })
        if (mapping?.simkl && isConfidenceSufficient(mapping)) {
          const mappedIds: SimklScrobbleIds = { ...ids }
          if (mapping.simkl.id) mappedIds.simkl = mapping.simkl.id
          const epNum = mapping.simkl.episodeNumber ?? item.episode
          if (providerType === 'show') {
            return buildSimklEpisodeScrobble(mappedIds, mapping.simkl.seasonNumber ?? item.season ?? 1, epNum, progressPct, meta)
          }
          if (providerType !== 'anime') return null
          return buildSimklAnimeScrobble(mappedIds, epNum, progressPct, meta)
        }
      } catch (_) { /* fall through */ }
    }
    if (providerType !== 'anime' || item.episode == null) return null
    return buildSimklAnimeScrobble(ids, item.episode, progressPct, meta)
  }

  if (item.isAnime && item.contentType === 'movie') {
    if (providerType === 'movie') return buildSimklMovieScrobble(ids, progressPct, meta)
    if (providerType === 'anime') return buildSimklAnimeScrobble(ids, 1, progressPct, meta)
    return null
  }

  if (item.contentType === 'series' && item.season != null && item.episode != null) {
    return buildSimklEpisodeScrobble(ids, item.season, item.episode, progressPct, meta)
  }

  return buildSimklMovieScrobble(ids, progressPct, meta)
}

async function resolveIds(item: PlaybackItem): Promise<{ ids: SimklScrobbleIds; providerType: 'movie' | 'show' | 'anime' } | null> {
  const ids: SimklScrobbleIds = {}

  // Use pre-existing IDs from the item
  if (item.simklId) ids.simkl = item.simklId
  if (item.imdbId) ids.imdb = item.imdbId
  if (item.tmdbId) ids.tmdb = item.tmdbId
  if (item.tvdbId) ids.tvdb = item.tvdbId
  if (item.malId) ids.mal = item.malId

  // Only skip network lookup if we already have the internal Simkl ID!
  if (ids.simkl) {
    return { ids, providerType: item.type ?? (item.isAnime ? 'anime' : item.contentType === 'series' ? 'show' : 'movie') }
  }

  // Try to resolve via the mapping layer
  try {
    const mapping = await resolveSimklId(item, {
      allowTitleFallback: !item.isAnime,
      allowExactTitleFallback: item.isAnime && item.contentType === 'movie',
    })
    if (mapping) {
      if (mapping.simklId) ids.simkl = mapping.simklId
      if (mapping.imdbId) ids.imdb = mapping.imdbId
      if (mapping.tmdbId) ids.tmdb = mapping.tmdbId
      if (mapping.tvdbId) ids.tvdb = mapping.tvdbId
      if (mapping.malId) ids.mal = mapping.malId
      return { ids, providerType: mapping.type }
    }
  } catch (_) {
    // Mapping lookup failed — proceed with whatever we have
  }

  if (item.isAnime) return null
  return { ids, providerType: item.contentType === 'series' ? 'show' : 'movie' }
}
