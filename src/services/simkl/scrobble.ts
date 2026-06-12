/**
 * Simkl real-time scrobble.
 *
 * Uses the /scrobble/start, /scrobble/pause, /scrobble/stop endpoints.
 * Progress is a float 0-100. Simkl auto-marks as watched when stop is
 * called with progress >= 80%.
 *
 * Rate limit: one scrobble per user at a time, 20-second lock timeout.
 */

import { simklRequest } from './client'
import { isSimklMockMode } from './auth'
import type { SimklScrobblePayload, SimklScrobbleResponse, SimklScrobbleIds } from './types'

export async function simklScrobbleStart(payload: SimklScrobblePayload): Promise<SimklScrobbleResponse | null> {
  if (isSimklMockMode()) return { result: 'success', action: 'start' }
  return simklRequest<SimklScrobbleResponse>('/scrobble/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function simklScrobblePause(payload: SimklScrobblePayload): Promise<SimklScrobbleResponse | null> {
  if (isSimklMockMode()) return { result: 'success', action: 'pause' }
  return simklRequest<SimklScrobbleResponse>('/scrobble/pause', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function simklScrobbleStop(payload: SimklScrobblePayload): Promise<SimklScrobbleResponse | null> {
  if (isSimklMockMode()) return { result: 'success', action: 'stop' }
  return simklRequest<SimklScrobbleResponse>('/scrobble/stop', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

// ─── Payload builders ─────────────────────────────────────────────────────────

/** Build a scrobble payload for a movie. Progress is 0–100. */
export function buildSimklMovieScrobble(
  ids: SimklScrobbleIds,
  progress: number,
  meta?: { title?: string; year?: number },
): SimklScrobblePayload {
  return {
    movie: { title: meta?.title, year: meta?.year, ids },
    progress: clampProgress(progress),
  }
}

/** Build a scrobble payload for a TV show episode. Progress is 0–100. */
export function buildSimklEpisodeScrobble(
  showIds: SimklScrobbleIds,
  season: number,
  episode: number,
  progress: number,
  meta?: { title?: string; year?: number },
): SimklScrobblePayload {
  return {
    show: { title: meta?.title, year: meta?.year, ids: showIds },
    episode: { season, number: episode },
    progress: clampProgress(progress),
  }
}

/** Build a scrobble payload for an anime episode. Progress is 0–100. */
export function buildSimklAnimeScrobble(
  animeIds: SimklScrobbleIds,
  episode: number,
  progress: number,
  meta?: { title?: string; year?: number },
): SimklScrobblePayload {
  return {
    anime: { title: meta?.title, year: meta?.year, ids: animeIds },
    episode: { number: episode },
    progress: clampProgress(progress),
  }
}

function clampProgress(p: number): number {
  return Math.round(Math.max(0, Math.min(100, p)) * 100) / 100
}
