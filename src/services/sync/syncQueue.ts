import { v4 as uuid } from 'uuid'
import { getActiveProfileId } from '../profiles'
import { getOutboxRecords, putOutboxRecord } from './outbox'

export const AURALES_SYNC_SCHEMA_VERSION = 1
const DEVICE_KEY = 'aurales_sync_device_v1'

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
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = uuid()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
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
