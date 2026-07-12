import type { WatchProgress } from '../types'
import { tmdbProvider } from './tmdb'

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

function todayKey(timestamp = Date.now()) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function emptyState(): ViewingActivityState {
  return { version: 1, trackingStartedAt: new Date().toISOString(), completedKeys: {}, records: {} }
}

function readState(): ViewingActivityState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as ViewingActivityState | null
    if (parsed?.version === 1 && parsed.records) return parsed
  } catch (_) { /* use a clean store */ }
  return emptyState()
}

function writeState(state: ViewingActivityState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  window.dispatchEvent(new CustomEvent(EVENT_NAME))
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
  const sessionKey = `${sample.mediaKey}:${sample.season ?? ''}:${sample.episode ?? ''}`
  const previous = sessions.get(sessionKey)
  let watchedSeconds = 0
  if (previous && sample.playing) {
    const wallSeconds = Math.max(0, (now - previous.sampledAt) / 1000)
    const positionDelta = sample.positionSeconds - previous.position
    const seekLimit = Math.max(30, wallSeconds * 2 + 5)
    if (positionDelta > 0 && positionDelta <= seekLimit && wallSeconds <= 90) watchedSeconds = Math.min(positionDelta, wallSeconds + 2)
  }
  sessions.set(sessionKey, { position: sample.positionSeconds, sampledAt: now, completed: sample.completed })
  if (watchedSeconds < 0.5 && (!sample.completed || previous?.completed)) return
  const state = readState()
  upsertRecord(state, sample, watchedSeconds, false)
  writeState(state)
}

export function seedViewingActivity(progress: Map<string, WatchProgress>) {
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

export async function enrichViewingActivityGenres() {
  const state = readState()
  const candidates = [...new Map(Object.values(state.records)
    .filter((record) => record.tmdbId && (record.genres.length === 0 || record.classificationVersion !== 2))
    .map((record) => [record.mediaKey, record])).values()].slice(0, 20)
  if (!candidates.length) return
  let changed = false
  await Promise.all(candidates.map(async (record) => {
    try {
      const contentType = record.season != null || record.mediaType === 'series' ? 'series' : 'movie'
      const details = contentType === 'movie' ? await tmdbProvider.getMovie(`tmdb-${record.tmdbId}`) : await tmdbProvider.getShow(`tmdb-${record.tmdbId}`)
      const anime = details.genres.some((genre) => genre.toLowerCase() === 'animation') && details.originalLanguage === 'ja'
      if (details.genres.length) {
        Object.values(state.records).filter((entry) => entry.mediaKey === record.mediaKey).forEach((entry) => {
          entry.genres = details.genres
          entry.mediaType = anime ? 'anime' : contentType
          entry.classificationVersion = 2
        })
        changed = true
      }
    } catch (_) { /* metadata is optional */ }
  }))
  if (changed) writeState(state)
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
  const state = readState()
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '12m' ? 365 : Infinity
  const cutoff = Number.isFinite(days) ? todayKey(Date.now() - (days - 1) * 86_400_000) : ''
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
    const expected = previous ? todayKey(new Date(`${previous}T12:00:00`).getTime() + 86_400_000) : ''
    running = previous && date === expected ? running + 1 : 1
    longestStreak = Math.max(longestStreak, running)
    previous = date
  }
  let currentStreak = 0
  let cursor = new Date()
  if (!dailyMap.has(todayKey()) && dailyMap.has(todayKey(Date.now() - 86_400_000))) cursor = new Date(Date.now() - 86_400_000)
  while ((dailyMap.get(todayKey(cursor.getTime())) || 0) >= 60) { currentStreak += 1; cursor = new Date(cursor.getTime() - 86_400_000) }
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
