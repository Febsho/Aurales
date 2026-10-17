import type { WatchProgress } from '../types'
import { getActiveProfileId, getProfileSetting, PROFILE_CHANGED_EVENT, setProfileSetting } from './profiles'
import { enqueueSyncRecord } from './sync/syncQueue'

export type ContinueWatchingSuppressionReason = 'manual' | 'accidental' | 'stale' | 'completed'
export interface ContinueWatchingSuppression { suppressedAt: number; reason: ContinueWatchingSuppressionReason }
const KEY = 'aurales_continue_watching_suppressions_v1'
const MAX_CONTINUE_WATCHING_SUPPRESSIONS = 1_000
let cachedProfileId: string | null = null
let cachedRaw: string | null = null
let cachedSuppressions: Record<string, ContinueWatchingSuppression> = {}

function load(profileId = getActiveProfileId()): Record<string, ContinueWatchingSuppression> {
  const raw = getProfileSetting(KEY, profileId) || '{}'
  if (profileId === cachedProfileId && raw === cachedRaw) return cachedSuppressions
  cachedProfileId = profileId
  cachedRaw = raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.entries(parsed as Record<string, unknown>)
    : []
  const validEntries = entries.filter((entry): entry is [string, ContinueWatchingSuppression] => {
    const [key, value] = entry
    return key.length > 0 && Boolean(value) && typeof value === 'object'
      && Number.isFinite((value as ContinueWatchingSuppression).suppressedAt)
      && ['manual', 'accidental', 'stale', 'completed'].includes((value as ContinueWatchingSuppression).reason)
  }).sort((a, b) => b[1].suppressedAt - a[1].suppressedAt).slice(0, MAX_CONTINUE_WATCHING_SUPPRESSIONS)
  const normalized = Object.fromEntries(validEntries)
  if (validEntries.length !== entries.length) {
    save(normalized, profileId)
  } else {
    cachedSuppressions = normalized
  }
  return cachedSuppressions
}

function save(value: Record<string, ContinueWatchingSuppression>, profileId = getActiveProfileId()) {
  const raw = JSON.stringify(value)
  setProfileSetting(KEY, raw, profileId)
  cachedProfileId = profileId
  cachedRaw = raw
  cachedSuppressions = value
  enqueueSyncRecord('profile-preferences', 'continue-watching-suppressions', value, profileId)
}

if (typeof window !== 'undefined') {
  window.addEventListener(PROFILE_CHANGED_EVENT, () => {
    cachedProfileId = null
    cachedRaw = null
    cachedSuppressions = {}
  })
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key?.startsWith(`${KEY}:profile:`)) {
      cachedProfileId = null
      cachedRaw = null
      cachedSuppressions = {}
    }
  })
}
type ContinueWatchingIdentity = Pick<WatchProgress, 'mediaId' | 'season' | 'episode'>
  & Partial<Pick<WatchProgress, 'mediaType' | 'imdbId' | 'tmdbId'>>

function legacyContinueWatchingKey(progress: ContinueWatchingIdentity): string {
  return `${progress.mediaId}${progress.season != null && progress.episode != null ? `:${progress.season}:${progress.episode}` : ''}`
}

export function continueWatchingKey(progress: ContinueWatchingIdentity): string {
  const identity = progress.imdbId
    ? `imdb:${progress.imdbId.toLowerCase()}`
    : progress.tmdbId != null
      ? `tmdb:${progress.tmdbId}`
      : progress.mediaId
  const mediaType = progress.mediaType ? `${progress.mediaType}:` : ''
  return `${mediaType}${identity}${progress.season != null && progress.episode != null ? `:${progress.season}:${progress.episode}` : ''}`
}
export function suppressContinueWatching(key: string, reason: ContinueWatchingSuppressionReason = 'manual') { const next = load(); next[key] = { suppressedAt: Date.now(), reason }; save(next) }
export function clearContinueWatchingSuppression(key: string) { const next = load(); if (!(key in next)) return; delete next[key]; save(next) }
export function getContinueWatchingSuppression(key: string) { return load()[key] }
export interface ContinueWatchingPolicy { completionThreshold: number; accidentalSeconds: number; accidentalPercent: number; staleDays: number; stalePercent: number }
export const DEFAULT_CONTINUE_WATCHING_POLICY: ContinueWatchingPolicy = { completionThreshold: 90, accidentalSeconds: 120, accidentalPercent: 3, staleDays: 30, stalePercent: 5 }
export function continueWatchingVisibility(progress: WatchProgress, policy = DEFAULT_CONTINUE_WATCHING_POLICY, now = Date.now()): { visible: boolean; reason?: ContinueWatchingSuppressionReason } {
  const suppressions = load()
  if (suppressions[continueWatchingKey(progress)] || suppressions[legacyContinueWatchingKey(progress)]) return { visible: false, reason: 'manual' }
  const pct = progress.durationSeconds > 0 ? progress.progressSeconds / progress.durationSeconds * 100 : 0
  if (progress.completed || pct >= policy.completionThreshold) return { visible: false, reason: 'completed' }
  const age = now - new Date(progress.updatedAt || 0).getTime()
  if (age >= 86400000 && progress.progressSeconds < policy.accidentalSeconds && pct < policy.accidentalPercent) return { visible: false, reason: 'accidental' }
  if (age >= policy.staleDays * 86400000 && pct < policy.stalePercent) return { visible: false, reason: 'stale' }
  return { visible: true }
}
export function reconcileContinueWatchingSuppression(progress: WatchProgress) {
  reconcileContinueWatchingSuppressions([progress])
}

export function reconcileContinueWatchingSuppressions(progressItems: WatchProgress[], profileId = getActiveProfileId()) {
  const next = load(profileId)
  let changed = false
  for (const progress of progressItems) {
    if (progress.progressSeconds < DEFAULT_CONTINUE_WATCHING_POLICY.accidentalSeconds) continue
    const key = continueWatchingKey(progress)
    const legacyKey = legacyContinueWatchingKey(progress)
    if (key in next) { delete next[key]; changed = true }
    if (legacyKey in next) { delete next[legacyKey]; changed = true }
  }
  if (changed) save(next, profileId)
}
