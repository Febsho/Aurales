import type { StreamResult } from '../../types'
import { streamFingerprint } from './reliabilityHistory'

export type PlaybackHealth = 'STARTING' | 'HEALTHY' | 'STALLED' | 'UNSTABLE' | 'FAILED' | 'RECOVERING'
export type PlaybackFailureReason =
  | 'NETWORK_TIMEOUT' | 'CONNECTION_REFUSED' | 'HTTP_4XX' | 'HTTP_5XX'
  | 'SOURCE_EXPIRED' | 'SOURCE_UNAVAILABLE' | 'ADDON_TIMEOUT' | 'ADDON_ERROR'
  | 'DEBRID_UNCACHED' | 'DEBRID_ERROR' | 'INVALID_STREAM' | 'UNSUPPORTED_FORMAT'
  | 'DECODER_FAILURE' | 'NO_PLAYABLE_FILE' | 'EMPTY_RESPONSE' | 'UNKNOWN'

export interface SourceDiagnostic {
  addonId: string
  sourceFingerprint: string
  state: PlaybackHealth
  latency?: number
  failureReason?: PlaybackFailureReason
  failureCount: number
  lastFailureAt?: number
  retryable: boolean
}

/** Classifies only evidence that exists in the player/addon message. */
export function classifyPlaybackFailure(error?: unknown): PlaybackFailureReason {
  const text = String(error instanceof Error ? error.message : error || '').toLowerCase()
  if (!text) return 'UNKNOWN'
  if (/timed? ?out|timeout|deadline exceeded/.test(text)) return /addon|manifest|catalog/.test(text) ? 'ADDON_TIMEOUT' : 'NETWORK_TIMEOUT'
  if (/connection refused|econnrefused/.test(text)) return 'CONNECTION_REFUSED'
  if (/\b4\d\d\b|forbidden|unauthori[sz]ed|not found|expired|signature/.test(text)) return /expired|signature|token/.test(text) ? 'SOURCE_EXPIRED' : 'HTTP_4XX'
  if (/\b5\d\d\b|bad gateway|service unavailable/.test(text)) return 'HTTP_5XX'
  if (/uncached|not cached/.test(text)) return 'DEBRID_UNCACHED'
  if (/debrid|torbox|real.?debrid|premiumize/.test(text)) return 'DEBRID_ERROR'
  if (/decoder|decode|codec/.test(text)) return 'DECODER_FAILURE'
  if (/unsupported|format/.test(text)) return 'UNSUPPORTED_FORMAT'
  if (/empty response|no results/.test(text)) return 'EMPTY_RESPONSE'
  if (/no playable|no file/.test(text)) return 'NO_PLAYABLE_FILE'
  if (/invalid stream|invalid url|malformed/.test(text)) return 'INVALID_STREAM'
  if (/unavailable|gone|eof|disappear/.test(text)) return 'SOURCE_UNAVAILABLE'
  if (/addon/.test(text)) return 'ADDON_ERROR'
  return 'UNKNOWN'
}

/** Whether automatic recovery should replace this source without another tap. */
export function shouldAutomaticallyRecoverSource(error: unknown, reason = classifyPlaybackFailure(error)): boolean {
  if (['HTTP_4XX', 'SOURCE_EXPIRED', 'SOURCE_UNAVAILABLE', 'UNSUPPORTED_FORMAT', 'DECODER_FAILURE'].includes(reason)) return true
  const text = String(error instanceof Error ? error.message : error || '').toLowerCase()
  return /media_host_not_allowed|source_host_not_allowed|media worker rejected source host|media worker could not fetch this source|media worker could not be reached to check conversion support|could not identify a supported video|automatic conversion attempts failed|browser reports that it cannot play|could not be played by the browser video engine|hls stream could not be played/.test(text)
}

export function isRetryableFailure(reason: PlaybackFailureReason, failures = 0): boolean {
  if (failures >= 2) return false
  return ['NETWORK_TIMEOUT', 'CONNECTION_REFUSED', 'HTTP_5XX', 'ADDON_TIMEOUT', 'SOURCE_EXPIRED', 'UNKNOWN'].includes(reason)
}

export function diagnosticForStream(stream: StreamResult & { addonId?: string }, state: PlaybackHealth, reason?: PlaybackFailureReason, latency?: number, previous?: SourceDiagnostic): SourceDiagnostic {
  const failureCount = previous?.failureCount || 0
  const failed = state === 'FAILED' || state === 'UNSTABLE'
  return {
    addonId: stream.addonId || 'unknown', sourceFingerprint: streamFingerprint(stream), state, latency,
    failureReason: reason, failureCount: failed ? failureCount + 1 : failureCount,
    lastFailureAt: failed ? Date.now() : previous?.lastFailureAt,
    retryable: reason ? isRetryableFailure(reason, failed ? failureCount : failureCount) : true,
  }
}

/** Session-only penalty: never reselect an exact failed source during recovery. */
export function recoveryCandidates<T extends StreamResult & { addonId?: string }>(candidates: T[], failedFingerprints: ReadonlySet<string>, failedAddons: ReadonlyMap<string, number>): T[] {
  return candidates.filter((candidate) => {
    if (failedFingerprints.has(streamFingerprint(candidate))) return false
    return (failedAddons.get(candidate.addonId || 'unknown') || 0) < 2
  })
}
