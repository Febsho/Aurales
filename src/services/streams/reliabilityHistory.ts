import type { StreamResult } from '../../types'

export type StreamReliabilityEvent = 'success' | 'failed_start' | 'unstable' | 'reported_bad' | 'preferred'

export interface StreamReliabilityRecord {
  success: number
  failedStart: number
  unstable: number
  reportedBad: number
  preferred: number
  updatedAt: number
}

const STORAGE_KEY = 'aurales_stream_reliability_v1'
const EMPTY: StreamReliabilityRecord = { success: 0, failedStart: 0, unstable: 0, reportedBad: 0, preferred: 0, updatedAt: 0 }

export function streamFingerprint(stream: StreamResult & { addonId?: string }): string {
  if (stream.infoHash) return `${stream.addonId || 'unknown'}:torrent:${stream.infoHash.toLowerCase()}:${stream.fileIdx || 0}`
  if (stream.url) return `${stream.addonId || 'unknown'}:url:${stream.url}`
  const label = `${stream.name || ''}|${stream.title || ''}|${stream.filename || ''}`.toLowerCase()
  let hash = 2166136261
  for (let i = 0; i < label.length; i += 1) hash = Math.imul(hash ^ label.charCodeAt(i), 16777619)
  return `${stream.addonId || 'unknown'}:label:${(hash >>> 0).toString(16)}`
}

export function loadReliabilityHistory(storage?: Pick<Storage, 'getItem'>): Record<string, StreamReliabilityRecord> {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!target) return {}
  try { return JSON.parse(target.getItem(STORAGE_KEY) || '{}') }
  catch { return {} }
}

export function getReliability(stream: StreamResult & { addonId?: string }, history = loadReliabilityHistory()): StreamReliabilityRecord {
  return history[streamFingerprint(stream)] || EMPTY
}

export function recordReliabilityEvent(
  stream: StreamResult & { addonId?: string },
  event: StreamReliabilityEvent,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): StreamReliabilityRecord {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  const history = loadReliabilityHistory(target)
  const key = streamFingerprint(stream)
  const next = { ...(history[key] || EMPTY), updatedAt: Date.now() }
  if (event === 'success') next.success += 1
  if (event === 'failed_start') next.failedStart += 1
  if (event === 'unstable') next.unstable += 1
  if (event === 'reported_bad') next.reportedBad += 1
  if (event === 'preferred') next.preferred += 1
  history[key] = next
  target?.setItem(STORAGE_KEY, JSON.stringify(history))
  return next
}
