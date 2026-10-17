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
const MAX_HISTORY_RECORDS = 2_000
const MAX_HISTORY_AGE_MS = 365 * 24 * 60 * 60 * 1000
let historyRevision = 0
let cachedRaw: string | null | undefined
let cachedHistory: Record<string, StreamReliabilityRecord> | undefined
let cachedStorage: Pick<Storage, 'getItem'> | undefined

function normalizedHistory(value: unknown): Record<string, StreamReliabilityRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, StreamReliabilityRecord> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const count = (name: string) => typeof record[name] === 'number' && Number.isFinite(record[name])
      ? Math.max(0, record[name] as number)
      : 0
    const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.max(0, record.updatedAt)
      : 0
    result[key] = {
      success: count('success'),
      failedStart: count('failedStart'),
      unstable: count('unstable'),
      reportedBad: count('reportedBad'),
      preferred: count('preferred'),
      updatedAt,
    }
  }
  return result
}

/** Changes whenever this process records new reliability evidence. */
export function reliabilityHistoryRevision(): number { return historyRevision }

export function streamFingerprint(stream: StreamResult & { addonId?: string }): string {
  if (typeof stream.infoHash === 'string' && stream.infoHash) return `${stream.addonId || 'unknown'}:torrent:${stream.infoHash.toLowerCase()}:${stream.fileIdx || 0}`
  // Signed URLs and addon URLs can contain credentials and are short-lived.
  // A stable origin/path is enough to distinguish direct-source families and
  // prevents secrets from ever becoming durable diagnostic state.
  if (typeof stream.url === 'string' && stream.url) {
    try { const url = new URL(stream.url); return `${stream.addonId || 'unknown'}:url:${url.origin}${url.pathname}` }
    catch { /* fall through to non-URL metadata */ }
  }
  const label = `${stream.name || ''}|${stream.title || ''}|${stream.filename || ''}`.toLowerCase()
  let hash = 2166136261
  for (let i = 0; i < label.length; i += 1) hash = Math.imul(hash ^ label.charCodeAt(i), 16777619)
  return `${stream.addonId || 'unknown'}:label:${(hash >>> 0).toString(16)}`
}

export function loadReliabilityHistory(storage?: Pick<Storage, 'getItem'>): Record<string, StreamReliabilityRecord> {
  let target: Pick<Storage, 'getItem'> | undefined
  try { target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined) }
  catch { return {} }
  if (!target) return {}
  try {
    const raw = target.getItem(STORAGE_KEY)
    if (!storage && target === cachedStorage && cachedHistory && raw === cachedRaw) return cachedHistory
    const history = normalizedHistory(JSON.parse(raw || '{}'))
    if (!storage) {
      if (cachedRaw !== undefined && (target !== cachedStorage || raw !== cachedRaw)) historyRevision += 1
      cachedRaw = raw
      cachedHistory = history
      cachedStorage = target
    }
    return history
  }
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
  let target: Pick<Storage, 'getItem' | 'setItem'> | undefined
  try { target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined) }
  catch (error) { console.warn('[streams] could not access reliability history', error) }
  const history = storage ? loadReliabilityHistory(storage) : loadReliabilityHistory()
  const key = streamFingerprint(stream)
  const next = { ...(history[key] || EMPTY), updatedAt: Date.now() }
  if (event === 'success') next.success += 1
  if (event === 'failed_start') next.failedStart += 1
  if (event === 'unstable') next.unstable += 1
  if (event === 'reported_bad') next.reportedBad += 1
  if (event === 'preferred') next.preferred += 1
  history[key] = next
  const cutoff = Date.now() - MAX_HISTORY_AGE_MS
  for (const [fingerprint, record] of Object.entries(history)) {
    if (!Number.isFinite(record?.updatedAt) || record.updatedAt < cutoff) delete history[fingerprint]
  }
  const oldestFirst = Object.entries(history).sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0))
  for (const [fingerprint] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_HISTORY_RECORDS))) delete history[fingerprint]
  historyRevision += 1
  // Playback must never depend on optional analytics. In particular, a full
  // WebView localStorage quota used to throw here before StreamSelector could
  // start the chosen stream, making every source button appear unresponsive.
  try {
    const serialized = JSON.stringify(history)
    target?.setItem(STORAGE_KEY, serialized)
    if (!storage && target) {
      cachedRaw = serialized
      cachedHistory = history
    }
  } catch (error) {
    if (!storage) { cachedRaw = undefined; cachedHistory = undefined; cachedStorage = undefined }
    console.warn('[streams] could not persist reliability history', error)
  }
  return next
}
