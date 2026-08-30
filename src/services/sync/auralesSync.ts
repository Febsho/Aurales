import { v4 as uuid } from 'uuid'
import { applySyncedProfile, clearPendingProfileDeletions, getActiveProfileId, getPendingProfileDeletions, getProfiles, profileStorageKey, type AuralesProfile } from '../profiles'
import { isSyncVaultUnlocked, restoreEncryptedVault, type EncryptedVault } from './encryptedVault'

export const AURALES_SYNC_SCHEMA_VERSION = 1
const DEVICE_KEY = 'aurales_sync_device_v1'
const OUTBOX_KEY = 'aurales_sync_outbox_v1'
const CONFIG_KEY = 'aurales_sync_config_v1'
export const DEFAULT_SYNC_ENDPOINT = 'https://sync.febsho.me'

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
export interface AuralesSyncConfig { endpoint?: string; accessToken?: string; email?: string; deviceName?: string; cursor?: string; lastSyncAt?: string; lastError?: string; autoSync?: boolean }
export function getDeviceId(): string { let id = localStorage.getItem(DEVICE_KEY); if (!id) { id = uuid(); localStorage.setItem(DEVICE_KEY, id) } return id }
export function getSyncConfig(): AuralesSyncConfig {
  try { return { ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'), endpoint: DEFAULT_SYNC_ENDPOINT } }
  catch { return { endpoint: DEFAULT_SYNC_ENDPOINT } }
}
export function setSyncConfig(config: AuralesSyncConfig): void { localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getSyncConfig(), ...config })) }
export function getSyncOutbox(): SyncRecord[] { try { const value = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(value) ? value : [] } catch { return [] } }
let scheduledSync: ReturnType<typeof setTimeout> | undefined
export function scheduleAutomaticSync(delayMs = 1200): void {
  if (scheduledSync) clearTimeout(scheduledSync)
  scheduledSync = setTimeout(() => { scheduledSync = undefined; void syncIfConfigured().catch(() => {}) }, delayMs)
}
/** Local-first, compacted outbox. The caller supplies an identity stable across devices (provider IDs where available). */
export function enqueueSyncRecord(type: SyncRecord['type'], identity: string, payload: unknown, profileId = getActiveProfileId()): SyncRecord {
  const recordId = `${profileId}:${type}:${identity}`
  const record: SyncRecord = { recordId, profileId, type, payload, updatedAt: new Date().toISOString(), deviceId: getDeviceId(), version: 1, schemaVersion: AURALES_SYNC_SCHEMA_VERSION }
  const next = [...getSyncOutbox().filter((item) => item.recordId !== recordId), record].slice(-1000)
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(next))
  if (type !== 'encrypted-vault') scheduleAutomaticSync()
  return record
}
function readProfileArray<T>(key: string, profileId: string): T[] { try { const value = JSON.parse(localStorage.getItem(profileStorageKey(key, profileId)) || '[]'); return Array.isArray(value) ? value : [] } catch { return [] } }
function readProfileObject<T>(key: string, profileId: string): Record<string, T> {
  try {
    const value = JSON.parse(localStorage.getItem(profileStorageKey(key, profileId)) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {}
  } catch { return {} }
}
function writeProfileValue(key: string, profileId: string, value: unknown) { localStorage.setItem(profileStorageKey(key, profileId), JSON.stringify(value)) }
/** Queues the durable local state that existed before Sync was first configured. */
function queueInitialSnapshot(): void {
  for (const profile of getProfiles()) {
    enqueueSyncRecord('profile', profile.id, profile, profile.id)
    const progress = readProfileObject<unknown>('aurales_watch_progress', profile.id)
    for (const [id, value] of Object.entries(progress)) enqueueSyncRecord('progress', id, value, profile.id)
    for (const item of readProfileArray<Record<string, unknown>>('aurales_local_watchlist_v1', profile.id)) {
      const identity = item.tmdbId != null ? `${item.type}:tmdb:${item.tmdbId}` : item.imdbId ? `${item.type}:imdb:${item.imdbId}` : `${item.type}:local:${item.id}`
      enqueueSyncRecord('watchlist', identity, { operation: 'add', item }, profile.id)
    }
    for (const feedback of readProfileArray<Record<string, unknown>>('aurales_discovery_feedback_v1', profile.id)) {
      if (typeof feedback.mediaKey === 'string') enqueueSyncRecord('discovery-feedback', feedback.mediaKey, feedback, profile.id)
    }
    for (const [key, memory] of Object.entries(readProfileObject<unknown>('aurales_stream_playback_memory_v1', profile.id))) enqueueSyncRecord('playback-memory', key, memory, profile.id)
    enqueueSyncRecord('profile-preferences', 'language-playback', {
      preferredAudio: readProfileArray<string>('aurales_preferred_audio', profile.id),
      preferredSubtitles: readProfileArray<string>('aurales_preferred_subtitles', profile.id),
      subtitleMode: localStorage.getItem(profileStorageKey('aurales_subtitle_mode', profile.id)) || 'preferred',
    }, profile.id)
  }
}
/** Applies known durable record types without emitting a new outbox mutation. */
export function applyRemoteRecords(records: SyncRecord[]): void {
  let activeChanged = false
  let profilesChanged = false
  for (const record of records) {
    if (record.schemaVersion && record.schemaVersion !== AURALES_SYNC_SCHEMA_VERSION) continue
    if (record.type === 'profile' && record.payload && typeof record.payload === 'object') { applySyncedProfile(record.payload as AuralesProfile | { id: string; deleted: true }); profilesChanged = true }
    if (record.type === 'progress' && record.payload && typeof record.payload === 'object') {
      const map = readProfileObject<unknown>('aurales_watch_progress', record.profileId)
      map[record.recordId.replace(`${record.profileId}:progress:`, '')] = record.payload
      writeProfileValue('aurales_watch_progress', record.profileId, map)
      activeChanged ||= record.profileId === getActiveProfileId()
    }
    if (record.type === 'watchlist') {
      const items = readProfileArray<Record<string, unknown>>('aurales_local_watchlist_v1', record.profileId); const payload = record.payload as { operation?: string; item?: Record<string, unknown> }; const identity = record.recordId.replace(`${record.profileId}:watchlist:`, ''); const next = payload?.operation === 'remove' ? items.filter((item) => `${item.type}:tmdb:${item.tmdbId}` !== identity && `${item.type}:imdb:${item.imdbId}` !== identity) : payload?.item ? [payload.item, ...items.filter((item) => item.id !== payload.item?.id)] : items; writeProfileValue('aurales_local_watchlist_v1', record.profileId, next); activeChanged ||= record.profileId === getActiveProfileId()
    }
    if (record.type === 'discovery-feedback' && record.payload && typeof record.payload === 'object') { const items = readProfileArray<Record<string, unknown>>('aurales_discovery_feedback_v1', record.profileId); const payload = record.payload as Record<string, unknown>; writeProfileValue('aurales_discovery_feedback_v1', record.profileId, [payload, ...items.filter((item) => item.mediaKey !== payload.mediaKey)]); activeChanged ||= record.profileId === getActiveProfileId() }
    if (record.type === 'playback-memory' && record.payload && typeof record.payload === 'object') {
      const current = readProfileObject<unknown>('aurales_stream_playback_memory_v1', record.profileId)
      current[record.recordId.replace(`${record.profileId}:playback-memory:`, '')] = record.payload
      writeProfileValue('aurales_stream_playback_memory_v1', record.profileId, current)
      activeChanged ||= record.profileId === getActiveProfileId()
    }
    if (record.type === 'profile-preferences' && record.payload && typeof record.payload === 'object') {
      const preferences = record.payload as { preferredAudio?: string[]; preferredSubtitles?: string[]; subtitleMode?: string }
      if (preferences.preferredAudio) writeProfileValue('aurales_preferred_audio', record.profileId, preferences.preferredAudio)
      if (preferences.preferredSubtitles) writeProfileValue('aurales_preferred_subtitles', record.profileId, preferences.preferredSubtitles)
      if (preferences.subtitleMode) localStorage.setItem(profileStorageKey('aurales_subtitle_mode', record.profileId), preferences.subtitleMode)
      activeChanged ||= record.profileId === getActiveProfileId()
    }
    if (record.type === 'encrypted-vault' && record.payload && typeof record.payload === 'object' && isSyncVaultUnlocked()) {
      // Pre-profile releases stored one account vault under a synthetic global
      // profile ID. Restore that legacy backup into the currently selected
      // profile so existing users do not lose their provider setup on upgrade.
      const targetProfileId = record.profileId === '00000000-0000-0000-0000-000000000000' ? getActiveProfileId() : record.profileId
      void restoreEncryptedVault(record.payload as EncryptedVault, targetProfileId).then(() => {
        if (targetProfileId === getActiveProfileId()) window.location.reload()
      }).catch(() => {})
    }
  }
  if (activeChanged || profilesChanged) window.dispatchEvent(new CustomEvent('aurales:profile-changed', { detail: { profileId: getActiveProfileId() } }))
}
export async function syncNow(fetcher: typeof fetch = fetch): Promise<{ uploaded: number; downloaded: number }> {
  const config = getSyncConfig()
  if (!config.endpoint || !config.accessToken) throw new Error('Aurales Sync is not configured')
  if (config.cursor == null) queueInitialSnapshot()
  // On later syncs, the password-derived vault is available only for the
  // current signed-in session. Do not create a new vault before the first
  // pull, which could replace an existing device's backup.
  if (config.cursor != null && isSyncVaultUnlocked()) {
    const { queueEncryptedVault } = await import('./encryptedVault')
    await queueEncryptedVault()
  }
  // The service intentionally bounds requests at 250 records. Keep the rest
  // of a large profile/library snapshot in the local outbox for the next pass.
  const outbox = getSyncOutbox().slice(0, 250)
  const response = await fetcher(`${config.endpoint.replace(/\/$/, '')}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.accessToken}` }, body: JSON.stringify({ schemaVersion: AURALES_SYNC_SCHEMA_VERSION, deviceId: getDeviceId(), deviceName: config.deviceName || 'Aurales Desktop', cursor: config.cursor, records: outbox }) })
  if (!response.ok) { setSyncConfig({ lastError: `Sync failed (${response.status})` }); throw new Error(`Sync failed (${response.status})`) }
  const body = await response.json() as { cursor?: string; records?: SyncRecord[] }
  applyRemoteRecords(body.records || [])
  const sent = new Set(outbox.map((record) => record.recordId))
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(getSyncOutbox().filter((record) => !sent.has(record.recordId))))
  setSyncConfig({ cursor: body.cursor, lastSyncAt: new Date().toISOString(), lastError: undefined })
  return { uploaded: outbox.length, downloaded: body.records?.length || 0 }
}

/** Explicit Push rebuilds the durable snapshot for every profile, including
 * profiles that existed before this device first enabled Sync. */
export async function uploadSyncNow(fetcher: typeof fetch = fetch): Promise<{ uploaded: number; downloaded: number }> {
  const pendingDeletions = getPendingProfileDeletions()
  for (const deletion of pendingDeletions) enqueueSyncRecord('profile', deletion.id, { id: deletion.id, deleted: true }, deletion.id)
  queueInitialSnapshot()
  if (isSyncVaultUnlocked()) {
    const { queueEncryptedVault } = await import('./encryptedVault')
    for (const profile of getProfiles()) await queueEncryptedVault(profile.id)
  }
  let uploaded = 0; let downloaded = 0
  do {
    const result = await syncNow(fetcher)
    uploaded += result.uploaded; downloaded += result.downloaded
  } while (getSyncOutbox().length > 0)
  if (pendingDeletions.length) clearPendingProfileDeletions()
  return { uploaded, downloaded }
}

/** Pull the complete account state without first uploading local changes.
 * Useful when setting up a fresh device or explicitly restoring a profile. */
export async function downloadSyncNow(fetcher: typeof fetch = fetch): Promise<{ downloaded: number }> {
  const config = getSyncConfig()
  if (!config.endpoint || !config.accessToken) throw new Error('Aurales Sync is not configured')
  let cursor = '0'; let downloaded = 0
  do {
    const response = await fetcher(`${config.endpoint.replace(/\/$/, '')}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.accessToken}` }, body: JSON.stringify({ schemaVersion: AURALES_SYNC_SCHEMA_VERSION, deviceId: getDeviceId(), deviceName: config.deviceName || 'Aurales Desktop', cursor, records: [] }) })
    if (!response.ok) { setSyncConfig({ lastError: `Download failed (${response.status})` }); throw new Error(`Download failed (${response.status})`) }
    const body = await response.json() as { cursor?: string; records?: SyncRecord[] }
    const records = body.records || []
    applyRemoteRecords(records); downloaded += records.length
    const nextCursor = body.cursor || cursor
    if (records.length < 500 || nextCursor === cursor) { cursor = nextCursor; break }
    cursor = nextCursor
  } while (true)
  setSyncConfig({ cursor, lastSyncAt: new Date().toISOString(), lastError: undefined })
  return { downloaded }
}

/** Safe for lifecycle hooks: does nothing until an Aurales account is configured. */
export async function syncIfConfigured(): Promise<void> {
  const config = getSyncConfig()
  if (!config.accessToken || config.autoSync === false) return
  await syncNow()
}
