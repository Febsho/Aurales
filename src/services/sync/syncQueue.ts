import { v4 as uuid } from 'uuid'
import { getActiveProfileId } from '../profiles'
import { getOutboxRecords, putOutboxRecord, putOutboxRecords } from './outbox'

export const AURALES_SYNC_SCHEMA_VERSION = 1
const DEVICE_KEY = 'aurales_sync_device_v1'
let memoryDeviceId: string | undefined

export interface SyncRecord {
  recordId: string
  profileId: string
  type: 'profile' | 'progress' | 'watchlist' | 'discovery-feedback' | 'playback-memory' | 'profile-preferences' | 'encrypted-vault'
  payload: unknown
  updatedAt: string
  deviceId: string
  version: number
  schemaVersion: number
  revision?: number
}

export function getDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId
  try {
    const stored = localStorage.getItem(DEVICE_KEY)
    if (stored) {
      memoryDeviceId = stored
      return stored
    }
  } catch {
    // The outbox remains usable when WebView storage is disabled.
  }

  memoryDeviceId = uuid()
  try { localStorage.setItem(DEVICE_KEY, memoryDeviceId) } catch {
    // Keep the same device ID for this process even if it cannot be persisted.
  }
  return memoryDeviceId
}

export function getSyncOutbox(): SyncRecord[] {
  return getOutboxRecords()
}

let scheduledSync: ReturnType<typeof setTimeout> | undefined
export function scheduleAutomaticSync(delayMs = 1200): void {
  if (scheduledSync) clearTimeout(scheduledSync)
  scheduledSync = setTimeout(() => {
    scheduledSync = undefined
    void import('./auralesSync')
      .then(({ syncIfConfigured }) => syncIfConfigured())
      .catch(() => {})
  }, delayMs)
}

/** Local-first, compacted outbox. Network sync stays outside this startup-safe module. */
export function enqueueSyncRecord(
  type: SyncRecord['type'],
  identity: string,
  payload: unknown,
  profileId = getActiveProfileId(),
): SyncRecord {
  const recordId = `${profileId}:${type}:${identity}`
  const record: SyncRecord = {
    recordId,
    profileId,
    type,
    payload,
    updatedAt: new Date().toISOString(),
    deviceId: getDeviceId(),
    version: 1,
    schemaVersion: AURALES_SYNC_SCHEMA_VERSION,
  }
  putOutboxRecord(record)
  if (type !== 'encrypted-vault') scheduleAutomaticSync()
  return record
}

/** Queues a related group without scheduling one persist/notification per item. */
export function enqueueSyncRecords(
  type: SyncRecord['type'],
  entries: Array<{ identity: string; payload: unknown }>,
  profileId = getActiveProfileId(),
): SyncRecord[] {
  if (entries.length === 0) return []
  const deviceId = getDeviceId()
  const updatedAt = new Date().toISOString()
  const records = entries.map(({ identity, payload }): SyncRecord => ({
    recordId: `${profileId}:${type}:${identity}`,
    profileId,
    type,
    payload,
    updatedAt,
    deviceId,
    version: 1,
    schemaVersion: AURALES_SYNC_SCHEMA_VERSION,
  }))
  putOutboxRecords(records)
  if (type !== 'encrypted-vault') scheduleAutomaticSync()
  return records
}
