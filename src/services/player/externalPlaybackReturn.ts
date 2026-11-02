import type { WatchProgress } from '../../types'

const STORAGE_PREFIX = 'aurales.externalPlayback.'
const RETURN_PARAM = 'aurales_external_playback'

export interface ExternalPlaybackReturn {
  progress: WatchProgress
  activity?: {
    mediaKey: string
    title: string
    mediaType: 'movie' | 'series' | 'anime'
    poster?: string
    tmdbId?: string | number
    season?: number
    episode?: number
  }
}

function makeToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createExternalPlaybackReturnUrl(payload: ExternalPlaybackReturn): string {
  const token = makeToken()
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${token}`, JSON.stringify({ ...payload, savedAt: Date.now() }))
  } catch {
    // The external player can still launch if browser storage is unavailable.
    return ''
  }
  const callback = new URL(window.location.href)
  callback.searchParams.set(RETURN_PARAM, token)
  return callback.toString()
}

export function consumeExternalPlaybackReturn(href: string): ExternalPlaybackReturn | null {
  const callback = new URL(href)
  const token = callback.searchParams.get(RETURN_PARAM)
  if (!token || !/^[\w-]{8,80}$/.test(token)) return null
  callback.searchParams.delete(RETURN_PARAM)
  callback.searchParams.delete('lastPlayedUrl')
  const positionRaw = callback.searchParams.get('position')
  callback.searchParams.delete('position')
  window.history.replaceState(window.history.state, '', `${callback.pathname}${callback.search}${callback.hash}`)

  const storageKey = `${STORAGE_PREFIX}${token}`
  let payload: ExternalPlaybackReturn & { savedAt?: number }
  try {
    const raw = localStorage.getItem(storageKey)
    localStorage.removeItem(storageKey)
    if (!raw) return null
    payload = JSON.parse(raw) as ExternalPlaybackReturn & { savedAt?: number }
  } catch {
    return null
  }
  if (!payload?.progress || !payload.progress.id || Date.now() - (payload.savedAt ?? 0) > 24 * 60 * 60_000) return null

  const externalPosition = Number(positionRaw)
  const position = Number.isFinite(externalPosition) && externalPosition >= 0
    ? externalPosition
    : payload.progress.progressSeconds
  const duration = payload.progress.durationSeconds
  const completed = duration > 0 && position / duration >= 0.8
  return {
    ...payload,
    progress: {
      ...payload.progress,
      progressSeconds: Math.floor(position),
      completed,
      updatedAt: new Date().toISOString(),
    },
  }
}
