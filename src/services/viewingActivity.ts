import type { WatchProgress } from '../types'
import { tmdbProvider } from './tmdb'
import { getActiveProfileId, profileStorageKey, PROFILE_CHANGED_EVENT } from './profiles'

const STORAGE_KEY = 'aurales_viewing_activity_v1'
const EVENT_NAME = 'aurales:viewing-activity'

export type ActivityMediaType = 'movie' | 'series' | 'anime'

export interface ViewingActivityRecord {
  id: string
  date: string
  mediaKey: string
  title: string
  mediaType: ActivityMediaType
  poster?: string
  tmdbId?: string | number
  season?: number
  episode?: number
  seconds: number
  completions: number
  genres: string[]
  classificationVersion?: number
  estimated: boolean
  updatedAt: string
}

interface ViewingActivityState {
  version: 1
  trackingStartedAt: string
  seededAt?: string
  completedKeys: Record<string, true>
  records: Record<string, ViewingActivityRecord>
}

export interface PlaybackActivitySample {
  mediaKey: string
  title: string
  mediaType: ActivityMediaType
  poster?: string
  tmdbId?: string | number
  season?: number
  episode?: number
  positionSeconds: number
  durationSeconds: number
  playing: boolean
  completed: boolean
  genres?: string[]
  sampledAt?: number
}

export interface ViewingActivitySummary {
  totalSeconds: number
  completions: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  mediaSeconds: Record<ActivityMediaType, number>
  daily: { date: string; seconds: number }[]
  topTitles: { mediaKey: string; title: string; poster?: string; seconds: number; completions: number; mediaType: ActivityMediaType }[]
  topGenres: { genre: string; seconds: number }[]
  recent: ViewingActivityRecord[]
  containsEstimates: boolean
  trackingStartedAt: string
}

const sessions = new Map<string, { position: number; sampledAt: number; completed: boolean }>()
const MAX_PLAYBACK_SESSIONS = 128
const pendingPlaybackSamples = new Map<string, { profileId: string; sample: Omit<PlaybackActivitySample, 'playing' | 'durationSeconds'>; seconds: number }>()
const PLAYBACK_ACTIVITY_FLUSH_MS = 5_000
const genreEnrichmentAttempts = new Map<string, number>()
const GENRE_ENRICHMENT_RETRY_MS = 5 * 60_000
const MAX_GENRE_ENRICHMENT_ATTEMPTS = 1_500
const genreEnrichmentPending = new Map<string, Promise<void>>()
let playbackProfileId = getActiveProfileId()
// The unscoped legacy history is claimed by the profile active when this
// module starts, even if its first flush happens after a profile switch.
const legacyActivityOwnerProfileId = playbackProfileId
let playbackActivityFlushTimer: ReturnType<typeof setTimeout> | undefined
let playbackActivityFlushListenersAttached = false
let flushingPlaybackActivity = false

if (typeof window !== 'undefined') {
  window.addEventListener(PROFILE_CHANGED_EVENT, (event) => {
    const profileId = (event as CustomEvent<{ profileId?: unknown }>).detail?.profileId
    playbackProfileId = typeof profileId === 'string' ? profileId : getActiveProfileId()
  })
}

function todayKey(timestamp = Date.now()) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shiftLocalDays(date: Date, days: number): Date {
  const shifted = new Date(date)
  shifted.setDate(shifted.getDate() + days)
  return shifted
}

function emptyState(): ViewingActivityState {
  return { version: 1, trackingStartedAt: new Date().toISOString(), completedKeys: {}, records: {} }
}

function readState(profileId = getActiveProfileId()): ViewingActivityState {
  try {
    const storageKey = profileStorageKey(STORAGE_KEY, profileId)
    const scoped = localStorage.getItem(storageKey)
    const legacy = scoped == null && profileId === legacyActivityOwnerProfileId
      ? localStorage.getItem(STORAGE_KEY)
      : null
    const parsed = JSON.parse(scoped ?? legacy ?? 'null') as ViewingActivityState | null
    if (parsed?.version === 1 && parsed.records) {
      if (legacy != null) {
        // Claim the old global history for the first profile that reads it.
        // Store it under that profile immediately, even when it was already
        // seeded and no later playback write would otherwise trigger migration.
        try {
          localStorage.setItem(storageKey, JSON.stringify(parsed))
          localStorage.removeItem(STORAGE_KEY)
        } catch (error) {
          console.warn('[activity] could not migrate legacy viewing activity', error)
        }
      }
      return parsed
    }
    if (legacy != null) localStorage.removeItem(STORAGE_KEY)
  } catch (_) { /* use a clean store */ }
  return emptyState()
}

function writeState(state: ViewingActivityState, profileId = getActiveProfileId()) {
  const storageKey = profileStorageKey(STORAGE_KEY, profileId)
  localStorage.setItem(storageKey, JSON.stringify(state))
  // The pre-profile key belongs to the first profile that reads it. Persist
  // the scoped copy before deleting it so a quota failure cannot lose history.
  if (profileId === legacyActivityOwnerProfileId) localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { profileId } }))
}

function flushPendingPlaybackSamples(): boolean {
  if (flushingPlaybackActivity) return true
  if (playbackActivityFlushTimer) {
    clearTimeout(playbackActivityFlushTimer)
    playbackActivityFlushTimer = undefined
  }
  if (pendingPlaybackSamples.size === 0) return true
  flushingPlaybackActivity = true
  const pending = [...pendingPlaybackSamples.entries()]
  let persisted = true
  const byProfile = new Map<string, Array<[string, (typeof pending)[number][1]]>>()
  for (const entry of pending) {
    const profileEntries = byProfile.get(entry[1].profileId) || []
    profileEntries.push(entry)
    byProfile.set(entry[1].profileId, profileEntries)
  }
  for (const [profileId, profileEntries] of byProfile) {
    try {
      const state = readState(profileId)
      for (const [, entry] of profileEntries) upsertRecord(state, entry.sample, entry.seconds, false)
      writeState(state, profileId)
      for (const [key, entry] of profileEntries) {
        if (pendingPlaybackSamples.get(key) === entry) pendingPlaybackSamples.delete(key)
      }
    } catch (error) {
      persisted = false
      console.warn('[activity] could not persist playback samples; retaining them for retry', error)
    }
  }
  flushingPlaybackActivity = false
  if (pendingPlaybackSamples.size > 0) schedulePlaybackActivityFlush()
  return persisted
}

function schedulePlaybackActivityFlush() {
  if (typeof window !== 'undefined' && !playbackActivityFlushListenersAttached) {
    playbackActivityFlushListenersAttached = true
    window.addEventListener('pagehide', flushPendingPlaybackSamples)
    window.addEventListener('aurales:flush-pending-profile-state', (event) => {
      const flushers = (event as CustomEvent<{ flushers?: Array<() => boolean> }>).detail?.flushers
      flushers?.push(flushPendingPlaybackSamples)
    })
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPendingPlaybackSamples()
      })
    }
  }
  if (!playbackActivityFlushTimer) {
    playbackActivityFlushTimer = setTimeout(() => {
      playbackActivityFlushTimer = undefined
      flushPendingPlaybackSamples()
    }, PLAYBACK_ACTIVITY_FLUSH_MS)
  }
}

function normalizeMediaType(value: string): ActivityMediaType {
  return value === 'movie' ? 'movie' : value === 'anime' ? 'anime' : 'series'
}

function recordId(date: string, mediaKey: string) {
  return `${date}:${mediaKey}`
}

function completionKey(sample: Pick<PlaybackActivitySample, 'mediaKey' | 'season' | 'episode'>) {
  return `${sample.mediaKey}:${sample.season ?? 'movie'}:${sample.episode ?? 'movie'}`
}

function upsertRecord(state: ViewingActivityState, sample: Omit<PlaybackActivitySample, 'playing' | 'durationSeconds'>, seconds: number, estimated: boolean) {
  const timestamp = sample.sampledAt || Date.now()
  const date = todayKey(timestamp)
  const id = recordId(date, sample.mediaKey)
  const existing = state.records[id]
  let completions = 0
  const doneKey = completionKey(sample)
  if (sample.completed && !state.completedKeys[doneKey]) {
    state.completedKeys[doneKey] = true
    completions = 1
  }
  state.records[id] = {
    id,
    date,
    mediaKey: sample.mediaKey,
    title: sample.title,
    mediaType: normalizeMediaType(sample.mediaType),
    poster: sample.poster || existing?.poster,
    tmdbId: sample.tmdbId || existing?.tmdbId,
    season: sample.season,
    episode: sample.episode,
    seconds: Math.round((existing?.seconds || 0) + Math.max(0, seconds)),
    completions: (existing?.completions || 0) + completions,
    genres: sample.genres?.length ? sample.genres : existing?.genres || [],
    classificationVersion: existing?.classificationVersion,
    estimated: existing ? existing.estimated && estimated : estimated,
    updatedAt: new Date(timestamp).toISOString(),
  }
}

export function recordPlaybackSample(sample: PlaybackActivitySample) {
  const now = sample.sampledAt || Date.now()
  const sessionKey = `${playbackProfileId}:${sample.mediaKey}:${sample.season ?? ''}:${sample.episode ?? ''}`
  const previous = sessions.get(sessionKey)
  let watchedSeconds = 0
  if (previous && sample.playing) {
    const wallSeconds = Math.max(0, (now - previous.sampledAt) / 1000)
    const positionDelta = sample.positionSeconds - previous.position
    const seekLimit = Math.max(30, wallSeconds * 2 + 5)
    if (positionDelta > 0 && positionDelta <= seekLimit && wallSeconds <= 90) watchedSeconds = Math.min(positionDelta, wallSeconds + 2)
  }
  // Only the active media needs its previous position for delta accounting.
  // Keep a small recent set for quick episode switches without retaining every
  // title played during a long-running app session.
  sessions.delete(sessionKey)
  sessions.set(sessionKey, { position: sample.positionSeconds, sampledAt: now, completed: sample.completed })
  while (sessions.size > MAX_PLAYBACK_SESSIONS) {
    const oldest = sessions.keys().next().value
    if (oldest === undefined) break
    sessions.delete(oldest)
  }
  // In-app video elements can emit timeupdate roughly every 250 ms. Keep
  // fractional deltas in the pending accumulator instead of dropping each
  // sample and resetting the comparison point before it reaches 0.5 seconds.
  if (watchedSeconds <= 0 && (!sample.completed || previous?.completed)) return
  const activitySample: Omit<PlaybackActivitySample, 'playing' | 'durationSeconds'> = sample
  const pendingKey = `${sessionKey}:${todayKey(now)}`
  const pending = pendingPlaybackSamples.get(pendingKey)
  pendingPlaybackSamples.set(pendingKey, {
    profileId: playbackProfileId,
    sample: activitySample,
    seconds: (pending?.seconds || 0) + watchedSeconds,
  })
  if (sample.completed && !previous?.completed) flushPendingPlaybackSamples()
  else schedulePlaybackActivityFlush()
}

export function seedViewingActivity(progress: Map<string, WatchProgress>) {
  flushPendingPlaybackSamples()
  const state = readState()
  if (state.seededAt) return
  for (const item of progress.values()) {
    if (!item.updatedAt || item.progressSeconds <= 5) continue
    const timestamp = new Date(item.updatedAt).getTime()
    if (!Number.isFinite(timestamp)) continue
    const mediaKey = item.mediaId || item.id
    const id = recordId(todayKey(timestamp), mediaKey)
    if (state.records[id] && !state.records[id].estimated) continue
    upsertRecord(state, {
      mediaKey,
      title: item.title || 'Untitled',
      mediaType: normalizeMediaType(item.mediaType),
      poster: item.poster,
      tmdbId: item.tmdbId,
      season: item.season,
      episode: item.episode,
      positionSeconds: item.progressSeconds,
      completed: item.completed,
      sampledAt: timestamp,
    }, Math.min(item.progressSeconds, item.durationSeconds || item.progressSeconds), true)
  }
  state.seededAt = new Date().toISOString()
  writeState(state)
}

export function enrichViewingActivityGenres(): Promise<void> {
  const profileId = getActiveProfileId()
  const pending = genreEnrichmentPending.get(profileId)
  if (pending) return pending
  flushPendingPlaybackSamples()
  const candidates = [...new Map(Object.values(readState().records)
    .filter((record) => record.tmdbId && (record.genres.length === 0 || record.classificationVersion !== 2))
    .map((record) => [record.mediaKey, record])).values()]
  const now = Date.now()
  const retryable = candidates
    .filter((record) => now - (genreEnrichmentAttempts.get(`${profileId}:${record.id}`) || 0) >= GENRE_ENRICHMENT_RETRY_MS)
    .slice(0, 20)
  if (!retryable.length) return Promise.resolve()
  for (const record of retryable) {
    const key = `${profileId}:${record.id}`
    genreEnrichmentAttempts.delete(key)
    genreEnrichmentAttempts.set(key, now)
  }
  while (genreEnrichmentAttempts.size > MAX_GENRE_ENRICHMENT_ATTEMPTS) {
    const oldest = genreEnrichmentAttempts.keys().next().value
    if (oldest === undefined) break
    genreEnrichmentAttempts.delete(oldest)
  }

  const enrichments = new Map<string, { genres: string[]; mediaType: ActivityMediaType }>()
  let cursor = 0
  const worker = async () => {
    while (cursor < retryable.length) {
      const record = retryable[cursor++]
      try {
        const contentType = record.season != null || record.mediaType === 'series' ? 'series' : 'movie'
        const details = contentType === 'movie' ? await tmdbProvider.getMovie(`tmdb-${record.tmdbId}`) : await tmdbProvider.getShow(`tmdb-${record.tmdbId}`)
        const anime = details.genres.some((genre) => genre.toLowerCase() === 'animation') && details.originalLanguage === 'ja'
        if (details.genres.length) {
          enrichments.set(record.mediaKey, { genres: details.genres, mediaType: anime ? 'anime' : contentType })
        }
      } catch (_) { /* metadata is optional */ }
    }
  }
  const request = Promise.all(Array.from({ length: Math.min(4, retryable.length) }, worker)).then(() => {
    if (enrichments.size === 0 || getActiveProfileId() !== profileId) return
    // Merge into the latest state after network requests; playback may have
    // written additional seconds while the genre lookups were in flight.
    flushPendingPlaybackSamples()
    const latestState = readState()
    let changed = false
    for (const [mediaKey, enrichment] of enrichments) {
      for (const entry of Object.values(latestState.records)) {
        if (entry.mediaKey !== mediaKey) continue
        entry.genres = enrichment.genres
        entry.mediaType = enrichment.mediaType
        entry.classificationVersion = 2
        genreEnrichmentAttempts.delete(`${profileId}:${entry.id}`)
        changed = true
      }
    }
    if (changed) writeState(latestState)
  }).finally(() => {
    if (genreEnrichmentPending.get(profileId) === request) genreEnrichmentPending.delete(profileId)
  })
  genreEnrichmentPending.set(profileId, request)
  return request
}

export function subscribeViewingActivity(listener: () => void) {
  window.addEventListener(EVENT_NAME, listener)
  return () => window.removeEventListener(EVENT_NAME, listener)
}

function effectiveMediaType(record: ViewingActivityRecord): ActivityMediaType {
  if (record.mediaType !== 'anime' || record.genres.length === 0) return record.mediaType
  const animation = record.genres.some((genre) => genre.toLowerCase() === 'animation')
  return animation ? 'anime' : record.season != null ? 'series' : 'movie'
}

export function summarizeViewingActivity(range: '7d' | '30d' | '12m' | 'all' = '30d', media: 'all' | ActivityMediaType = 'all'): ViewingActivitySummary {
  flushPendingPlaybackSamples()
  const state = readState()
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '12m' ? 365 : Infinity
  let cutoff = ''
  if (Number.isFinite(days)) {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - (days - 1))
    cutoff = todayKey(cutoffDate.getTime())
  }
  const records = Object.values(state.records)
    .map((record) => ({ ...record, mediaType: effectiveMediaType(record) }))
    .filter((record) => record.date >= cutoff && (media === 'all' || record.mediaType === media))
  const dailyMap = new Map<string, number>()
  const titleMap = new Map<string, ViewingActivitySummary['topTitles'][number]>()
  const genreMap = new Map<string, number>()
  const mediaSeconds: ViewingActivitySummary['mediaSeconds'] = { movie: 0, series: 0, anime: 0 }
  for (const record of records) {
    dailyMap.set(record.date, (dailyMap.get(record.date) || 0) + record.seconds)
    mediaSeconds[record.mediaType] += record.seconds
    const title = titleMap.get(record.mediaKey) || { mediaKey: record.mediaKey, title: record.title, poster: record.poster, seconds: 0, completions: 0, mediaType: record.mediaType }
    title.seconds += record.seconds
    title.completions += record.completions
    titleMap.set(record.mediaKey, title)
    record.genres.forEach((genre) => genreMap.set(genre, (genreMap.get(genre) || 0) + record.seconds))
  }
  const activeDates = [...dailyMap.entries()].filter(([, seconds]) => seconds >= 60).map(([date]) => date).sort()
  let longestStreak = 0
  let running = 0
  let previous = ''
  for (const date of activeDates) {
    const expected = previous ? todayKey(shiftLocalDays(new Date(`${previous}T12:00:00`), 1).getTime()) : ''
    running = previous && date === expected ? running + 1 : 1
    longestStreak = Math.max(longestStreak, running)
    previous = date
  }
  let currentStreak = 0
  let cursor = new Date()
  const yesterday = shiftLocalDays(cursor, -1)
  if (!dailyMap.has(todayKey()) && dailyMap.has(todayKey(yesterday.getTime()))) cursor = yesterday
  while ((dailyMap.get(todayKey(cursor.getTime())) || 0) >= 60) { currentStreak += 1; cursor = shiftLocalDays(cursor, -1) }
  return {
    totalSeconds: records.reduce((sum, record) => sum + record.seconds, 0),
    completions: records.reduce((sum, record) => sum + record.completions, 0),
    activeDays: activeDates.length,
    currentStreak,
    longestStreak,
    mediaSeconds,
    daily: [...dailyMap].map(([date, seconds]) => ({ date, seconds })).sort((a, b) => a.date.localeCompare(b.date)),
    topTitles: [...titleMap.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 8),
    topGenres: [...genreMap].map(([genre, seconds]) => ({ genre, seconds })).sort((a, b) => b.seconds - a.seconds).slice(0, 6),
    recent: records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12),
    containsEstimates: records.some((record) => record.estimated),
    trackingStartedAt: state.trackingStartedAt,
  }
}
