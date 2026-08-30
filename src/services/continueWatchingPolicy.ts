import type { WatchProgress } from '../types'
import { getProfileSetting, setProfileSetting } from './profiles'
import { enqueueSyncRecord } from './sync/auralesSync'

export type ContinueWatchingSuppressionReason = 'manual' | 'accidental' | 'stale' | 'completed'
export interface ContinueWatchingSuppression { suppressedAt: number; reason: ContinueWatchingSuppressionReason }
const KEY = 'aurales_continue_watching_suppressions_v1'
function load(): Record<string, ContinueWatchingSuppression> { try { return JSON.parse(getProfileSetting(KEY) || '{}') } catch { return {} } }
function save(value: Record<string, ContinueWatchingSuppression>) { setProfileSetting(KEY, JSON.stringify(value)); enqueueSyncRecord('profile-preferences', 'continue-watching-suppressions', value) }
export function continueWatchingKey(progress: Pick<WatchProgress, 'mediaId' | 'season' | 'episode'>): string { return `${progress.mediaId}${progress.season != null && progress.episode != null ? `:${progress.season}:${progress.episode}` : ''}` }
export function suppressContinueWatching(key: string, reason: ContinueWatchingSuppressionReason = 'manual') { const next = load(); next[key] = { suppressedAt: Date.now(), reason }; save(next) }
export function clearContinueWatchingSuppression(key: string) { const next = load(); if (!(key in next)) return; delete next[key]; save(next) }
export function getContinueWatchingSuppression(key: string) { return load()[key] }
export interface ContinueWatchingPolicy { completionThreshold: number; accidentalSeconds: number; accidentalPercent: number; staleDays: number; stalePercent: number }
export const DEFAULT_CONTINUE_WATCHING_POLICY: ContinueWatchingPolicy = { completionThreshold: 90, accidentalSeconds: 120, accidentalPercent: 3, staleDays: 30, stalePercent: 5 }
export function continueWatchingVisibility(progress: WatchProgress, policy = DEFAULT_CONTINUE_WATCHING_POLICY, now = Date.now()): { visible: boolean; reason?: ContinueWatchingSuppressionReason } {
  const key = continueWatchingKey(progress); if (getContinueWatchingSuppression(key)) return { visible: false, reason: 'manual' }
  const pct = progress.durationSeconds > 0 ? progress.progressSeconds / progress.durationSeconds * 100 : 0
  if (progress.completed || pct >= policy.completionThreshold) return { visible: false, reason: 'completed' }
  const age = now - new Date(progress.updatedAt || 0).getTime()
  if (age >= 86400000 && progress.progressSeconds < policy.accidentalSeconds && pct < policy.accidentalPercent) return { visible: false, reason: 'accidental' }
  if (age >= policy.staleDays * 86400000 && pct < policy.stalePercent) return { visible: false, reason: 'stale' }
  return { visible: true }
}
export function reconcileContinueWatchingSuppression(progress: WatchProgress) { if (progress.progressSeconds >= DEFAULT_CONTINUE_WATCHING_POLICY.accidentalSeconds) clearContinueWatchingSuppression(continueWatchingKey(progress)) }
