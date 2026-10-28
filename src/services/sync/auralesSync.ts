import { applySyncedProfile, clearPendingProfileDeletions, getActiveProfileId, getPendingProfileDeletions, getProfiles, profileStorageKey, type AuralesProfile } from '../profiles'
import { isSyncVaultUnlocked, restoreEncryptedVault, type EncryptedVault } from './encryptedVault'
import { outboxReady, removeOutboxRecords, takeOutboxBatch } from './outbox'
import { runSyncBatch } from './syncBatch'
import {
  AURALES_SYNC_SCHEMA_VERSION,
  enqueueSyncRecord,
  enqueueSyncRecords,
  getDeviceId,
  getSyncOutbox,
  scheduleAutomaticSync,
  type SyncRecord,
} from './syncQueue'
import { sameWatchlistItem as sameWatchlistIdentity, watchlistIdentity as makeWatchlistIdentity, type WatchlistIdentityItem } from '../watchlistIdentity'
import { shouldReloadAfterVaultRestore } from '../../platform/capabilities'

export {
  AURALES_SYNC_SCHEMA_VERSION,
  enqueueSyncRecord,
  getDeviceId,
  getSyncOutbox,
  scheduleAutomaticSync,
}
export type { SyncRecord }

const CONFIG_KEY = 'aurales_sync_config_v1'
export const DEFAULT_SYNC_ENDPOINT = 'https://sync.febsho.me'
const SYNC_PAGE_SIZE = 500

export interface AuralesSyncConfig { endpoint?: string; accessToken?: string; email?: string; deviceName?: string; cursor?: string; lastSyncAt?: string; lastError?: string; autoSync?: boolean }
export function getSyncConfig(): AuralesSyncConfig {
  try { return { ...JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'), endpoint: DEFAULT_SYNC_ENDPOINT } }
  catch { return { endpoint: DEFAULT_SYNC_ENDPOINT } }
}
export function setSyncConfig(config: AuralesSyncConfig): void {
  // A failed write here would abort a sync that had already succeeded on the
  // server, so it is reported rather than thrown.
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getSyncConfig(), ...config })) }
  catch (error) { console.error('[sync] could not persist the sync config', error) }
}
let configuredSyncPending: Promise<void> | null = null
let syncBatchLock: Promise<void> = Promise.resolve()
let automaticSyncRetryAttempt = 0

function shouldRetryAutomaticSync(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/unlock the encrypted settings vault/i.test(message)) return false
  const status = message.match(/(?:failed|http)\s*\(?([1-5]\d\d)\)?/i)?.[1]
  if (!status) return true
  const code = Number(status)
  return code === 408 || code === 425 || code === 429 || code >= 500
}

async function withSyncBatchLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = syncBatchLock
  let release!: () => void
  syncBatchLock = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

function readProfileArray<T>(key: string, profileId: string): T[] { try { const value = JSON.parse(localStorage.getItem(profileStorageKey(key, profileId)) || '[]'); return Array.isArray(value) ? value : [] } catch { return [] } }
function readProfileObject<T>(key: string, profileId: string): Record<string, T> {
  try {
    const value = JSON.parse(localStorage.getItem(profileStorageKey(key, profileId)) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {}
  } catch { return {} }
}
function writeProfileValue(key: string, profileId: string, value: unknown) { localStorage.setItem(profileStorageKey(key, profileId), JSON.stringify(value)) }
function reloadAfterVaultRestore(): void {
  // Native builds can reload because the keyring restores the passphrase on
  // startup. Browser sessions keep it only in memory, so the profile-change
  // event must hydrate the existing SPA without discarding the unlock state.
  if (typeof window !== 'undefined' && shouldReloadAfterVaultRestore()) window.location.reload()
}
function watchlistIdentity(item: Record<string, unknown>): string | undefined {
  return makeWatchlistIdentity(item as unknown as WatchlistIdentityItem)
}
/** Queues the durable local state that existed before Sync was first configured. */
function queueInitialSnapshot(): void {
  for (const profile of getProfiles()) {
    enqueueSyncRecord('profile', profile.id, profile, profile.id)
    const progress = readProfileObject<unknown>('aurales_watch_progress', profile.id)
    enqueueSyncRecords('progress', Object.entries(progress).map(([identity, payload]) => ({ identity, payload })), profile.id)
    const watchlistEntries = readProfileArray<Record<string, unknown>>('aurales_local_watchlist_v1', profile.id).map((item) => {
      const identity = watchlistIdentity(item) || `${item.type}:local:${item.id}`
      return { identity, payload: { operation: 'add', item } }
    })
    enqueueSyncRecords('watchlist', watchlistEntries, profile.id)
    const feedbackEntries = readProfileArray<Record<string, unknown>>('aurales_discovery_feedback_v1', profile.id)
      .filter((feedback) => typeof feedback.mediaKey === 'string')
      .map((feedback) => ({
        identity: feedback.kind === 'hide-genre' ? `${feedback.mediaKey}:genre:${feedback.genreId}` : String(feedback.mediaKey),
        payload: feedback,
      }))
    enqueueSyncRecords('discovery-feedback', feedbackEntries, profile.id)
    enqueueSyncRecords('playback-memory', Object.entries(readProfileObject<unknown>('aurales_stream_playback_memory_v1', profile.id))
      .map(([identity, payload]) => ({ identity, payload })), profile.id)
    enqueueSyncRecord('profile-preferences', 'language-playback', {
      preferredAudio: readProfileArray<string>('aurales_preferred_audio', profile.id),
      preferredSubtitles: readProfileArray<string>('aurales_preferred_subtitles', profile.id),
      subtitleMode: localStorage.getItem(profileStorageKey('aurales_subtitle_mode', profile.id)) || 'preferred',
    }, profile.id)
    enqueueSyncRecord(
      'profile-preferences',
      'continue-watching-suppressions',
      readProfileObject('aurales_continue_watching_suppressions_v1', profile.id),
      profile.id,
    )
  }
}
/** Applies known durable record types without emitting a new outbox mutation. */
export async function applyRemoteRecords(records: SyncRecord[]): Promise<boolean> {
  // A cursor is committed only after this function succeeds. Never silently
  // advance past encrypted settings that this session cannot restore: a later
  // unlock would otherwise start after the only copy of those records.
  const hasVaultRecords = records.some((record) =>
    record.type === 'encrypted-vault'
    && record.payload
    && typeof record.payload === 'object'
    && (!record.schemaVersion || record.schemaVersion === AURALES_SYNC_SCHEMA_VERSION),
  )
  if (hasVaultRecords && !isSyncVaultUnlocked()) {
    throw new Error('Unlock the encrypted settings vault before syncing account settings.')
  }

  let activeChanged = false
  let profilesChanged = false
  let activeVaultRestored = false
  const vaultRestores: Promise<unknown>[] = []
  const progressUpdates = new Map<string, Array<{ id: string; payload: unknown }>>()
  const watchlistUpdates = new Map<string, SyncRecord[]>()
  const feedbackUpdates = new Map<string, SyncRecord[]>()
  const playbackMemoryUpdates = new Map<string, Array<{ key: string; payload: unknown }>>()
  const profilePreferenceUpdates = new Map<string, Array<{ id: string; payload: Record<string, unknown> }>>()
  const deletedProfileIds = new Set(records
    .filter((record) => record.type === 'profile' && (record.payload as { deleted?: boolean } | null)?.deleted === true)
    .map((record) => record.profileId))
  for (const record of records) {
    if (record.schemaVersion && record.schemaVersion !== AURALES_SYNC_SCHEMA_VERSION) continue
    // A batch can contain older profile and data records beside a profile
    // tombstone. Only the tombstone itself may be applied for that ID; an
    // older profile upsert later in the batch must not resurrect the profile.
    const isProfileTombstone = record.type === 'profile'
      && (record.payload as { deleted?: boolean } | null)?.deleted === true
    if (deletedProfileIds.has(record.profileId) && !isProfileTombstone) continue
    if (record.type === 'profile' && record.payload && typeof record.payload === 'object') { applySyncedProfile(record.payload as AuralesProfile | { id: string; deleted: true }); profilesChanged = true }
    if (record.type === 'progress' && record.payload && typeof record.payload === 'object') {
      const id = record.recordId.startsWith(`${record.profileId}:progress:`)
        ? record.recordId.slice(`${record.profileId}:progress:`.length)
        : record.recordId
      const updates = progressUpdates.get(record.profileId) || []
      updates.push({ id, payload: record.payload })
      progressUpdates.set(record.profileId, updates)
    }
    if (record.type === 'watchlist') {
      const updates = watchlistUpdates.get(record.profileId) || []
      updates.push(record)
      watchlistUpdates.set(record.profileId, updates)
    }
    if (record.type === 'discovery-feedback' && record.payload && typeof record.payload === 'object') {
      const updates = feedbackUpdates.get(record.profileId) || []
      updates.push(record)
      feedbackUpdates.set(record.profileId, updates)
    }
    if (record.type === 'playback-memory' && record.payload && typeof record.payload === 'object') {
      const key = record.recordId.startsWith(`${record.profileId}:playback-memory:`)
        ? record.recordId.slice(`${record.profileId}:playback-memory:`.length)
        : record.recordId
      const updates = playbackMemoryUpdates.get(record.profileId) || []
      updates.push({ key, payload: record.payload })
      playbackMemoryUpdates.set(record.profileId, updates)
    }
    if (record.type === 'profile-preferences' && record.payload && typeof record.payload === 'object') {
      const preferenceId = record.recordId.replace(`${record.profileId}:profile-preferences:`, '')
      const updates = profilePreferenceUpdates.get(record.profileId) || []
      updates.push({ id: preferenceId, payload: record.payload as Record<string, unknown> })
      profilePreferenceUpdates.set(record.profileId, updates)
      continue
    }
    if (record.type === 'encrypted-vault' && record.payload && typeof record.payload === 'object' && isSyncVaultUnlocked()) {
      // Pre-profile releases stored one account vault under a synthetic global
      // profile ID. Restore that legacy backup into the currently selected
      // profile so existing users do not lose their provider setup on upgrade.
      const targetProfileId = record.profileId === '00000000-0000-0000-0000-000000000000' ? getActiveProfileId() : record.profileId
      vaultRestores.push(restoreEncryptedVault(record.payload as EncryptedVault, targetProfileId).then(() => {
        if (targetProfileId === getActiveProfileId()) activeVaultRestored = true
      }))
    }
  }
  // A vault is a profile-wide snapshot and can be older than the independent
  // records in this page. Restore it first so typed updates and preferences
  // from the same batch always win over stale values inside that snapshot.
  await Promise.all(vaultRestores)
  for (const [profileId, updates] of profilePreferenceUpdates) {
    for (const { id, payload } of updates) {
      if (id === 'continue-watching-suppressions') {
        writeProfileValue('aurales_continue_watching_suppressions_v1', profileId, payload)
        activeChanged ||= profileId === getActiveProfileId()
        continue
      }
      const preferences = payload as { preferredAudio?: string[]; preferredSubtitles?: string[]; subtitleMode?: string }
      if (preferences.preferredAudio) writeProfileValue('aurales_preferred_audio', profileId, preferences.preferredAudio)
      if (preferences.preferredSubtitles) writeProfileValue('aurales_preferred_subtitles', profileId, preferences.preferredSubtitles)
      if (preferences.subtitleMode) localStorage.setItem(profileStorageKey('aurales_subtitle_mode', profileId), preferences.subtitleMode)
      activeChanged ||= profileId === getActiveProfileId()
    }
  }
  // Each profile/type is stored as one JSON value. Merge a server page in
  // memory and write once per value instead of parsing and rewriting the full
  // library for every record in a batch.
  for (const [profileId, updates] of progressUpdates) {
    const progress = readProfileObject<unknown>('aurales_watch_progress', profileId)
    for (const { id, payload } of updates) {
      if ((payload as { deleted?: unknown }).deleted === true) delete progress[id]
      else progress[id] = payload
    }
    writeProfileValue('aurales_watch_progress', profileId, progress)
    activeChanged ||= profileId === getActiveProfileId()
  }
  for (const [profileId, updates] of watchlistUpdates) {
    let items = readProfileArray<Record<string, unknown>>('aurales_local_watchlist_v1', profileId)
    for (const record of updates) {
      const payload = record.payload as { operation?: string; item?: Record<string, unknown>; media?: Record<string, unknown> }
      const identity = record.recordId.replace(`${profileId}:watchlist:`, '')
      items = payload?.operation === 'remove'
        ? items.filter((item) => watchlistIdentity(item) !== identity && !(payload.media && sameWatchlistIdentity(item as unknown as WatchlistIdentityItem, payload.media as unknown as WatchlistIdentityItem)))
        : payload?.item
          ? [payload.item, ...items.filter((item) => watchlistIdentity(item) !== identity && !sameWatchlistIdentity(item as unknown as WatchlistIdentityItem, payload.item! as unknown as WatchlistIdentityItem))]
          : items
    }
    writeProfileValue('aurales_local_watchlist_v1', profileId, items)
    activeChanged ||= profileId === getActiveProfileId()
  }
  for (const [profileId, updates] of feedbackUpdates) {
    let items = readProfileArray<Record<string, unknown>>('aurales_discovery_feedback_v1', profileId)
    for (const record of updates) {
      const payload = record.payload as Record<string, unknown>
      items = payload.kind === 'show-genre'
        ? items.filter((item) => {
          if (item.kind !== 'hide-genre') return true
          if (item.genreId === payload.genreId) return false
          if (item.genreId != null) return true
          const legacyGenres = (item.item as { genreIds?: unknown[] } | undefined)?.genreIds
          return !Array.isArray(legacyGenres) || !legacyGenres.includes(payload.genreId)
        })
        : [payload, ...items.filter((item) => payload.kind === 'hide-genre'
          ? !(item.mediaKey === payload.mediaKey && item.kind === 'hide-genre' && item.genreId === payload.genreId)
          : !(item.mediaKey === payload.mediaKey && item.kind !== 'hide-genre'))]
    }
    writeProfileValue('aurales_discovery_feedback_v1', profileId, items)
    activeChanged ||= profileId === getActiveProfileId()
  }
  for (const [profileId, updates] of playbackMemoryUpdates) {
    const memory = readProfileObject<unknown>('aurales_stream_playback_memory_v1', profileId)
    for (const { key, payload } of updates) {
      if ((payload as { deleted?: unknown }).deleted === true) delete memory[key]
      else memory[key] = payload
    }
    writeProfileValue('aurales_stream_playback_memory_v1', profileId, memory)
    activeChanged ||= profileId === getActiveProfileId()
  }
  // Do not let the next sync snapshot a partially restored vault. In
  // particular, a follow-up batch can queue a fresh encrypted copy as soon as
  // the initial pull returns; that copy must include the completed restore.
  if (activeVaultRestored) activeChanged = true
  if (activeChanged || profilesChanged) window.dispatchEvent(new CustomEvent('aurales:profile-changed', { detail: { profileId: getActiveProfileId() } }))
  return activeVaultRestored
}
async function syncNowUnlocked(fetcher: typeof fetch): Promise<{ uploaded: number; downloaded: number; activeVaultRestored: boolean }> {
  await outboxReady()
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
  // The service bounds a request by both record count and body size. Batching
  // by count alone overflows the body limit as soon as an encrypted vault is
  // queued, so the batch is capped by bytes too. The rest of a large snapshot
  // stays in the outbox for the next pass.
  const outbox = takeOutboxBatch()
  let body: { cursor?: string; records?: SyncRecord[] }
  try {
    body = await runSyncBatch({ endpoint: config.endpoint, accessToken: config.accessToken, schemaVersion: AURALES_SYNC_SCHEMA_VERSION, deviceId: getDeviceId(), deviceName: config.deviceName || 'Aurales Desktop', cursor: config.cursor, records: outbox, mode: 'sync' }, fetcher)
  } catch (error) {
    setSyncConfig({ lastError: error instanceof Error ? error.message : String(error) })
    throw error
  }
  const activeVaultRestored = await applyRemoteRecords(body.records || [])
  removeOutboxRecords(outbox)
  setSyncConfig({ cursor: body.cursor, lastSyncAt: new Date().toISOString(), lastError: undefined })
  return { uploaded: outbox.length, downloaded: body.records?.length || 0, activeVaultRestored }
}

/** Serialize batches so auto-sync and explicit Push/Pull cannot race cursors. */
export function syncNow(fetcher: typeof fetch = fetch): Promise<{ uploaded: number; downloaded: number }> {
  return withSyncBatchLock(async () => {
    const result = await syncNowUnlocked(fetcher)
    if (result.activeVaultRestored) reloadAfterVaultRestore()
    return { uploaded: result.uploaded, downloaded: result.downloaded }
  })
}

/** Explicit Push rebuilds the durable snapshot for every profile, including
 * profiles that existed before this device first enabled Sync. */
async function uploadSyncNowUnlocked(fetcher: typeof fetch): Promise<{ uploaded: number; downloaded: number }> {
  await outboxReady()
  const pendingDeletions = getPendingProfileDeletions()
  for (const deletion of pendingDeletions) enqueueSyncRecord('profile', deletion.id, { id: deletion.id, deleted: true }, deletion.id)
  queueInitialSnapshot()
  const queuedRecordIds = new Set(getSyncOutbox().map((record) => record.recordId))
  const missingDeletion = pendingDeletions.find((deletion) => !queuedRecordIds.has(`${deletion.id}:profile:${deletion.id}`))
  if (missingDeletion) throw new Error('A profile deletion could not fit in the sync queue. It will remain pending for the next upload.')
  let uploaded = 0; let downloaded = 0
  let activeVaultRestored = false
  const drain = async () => {
    let result: { uploaded: number; downloaded: number; activeVaultRestored: boolean }
    do {
      const cursorBefore = getSyncConfig().cursor
      result = await syncNowUnlocked(fetcher)
      uploaded += result.uploaded; downloaded += result.downloaded
      activeVaultRestored ||= result.activeVaultRestored
      // A sync response can be full even when every local outbox entry was
      // acknowledged. Keep advancing its cursor so large remote libraries do
      // not remain partially downloaded until the next manual sync.
      if (getSyncOutbox().length === 0
        && (result.downloaded < SYNC_PAGE_SIZE || getSyncConfig().cursor === cursorBefore)) break
    } while (getSyncOutbox().length > 0 || result.downloaded >= SYNC_PAGE_SIZE)
  }
  await drain()
  if (isSyncVaultUnlocked()) {
    const { queueEncryptedVault } = await import('./encryptedVault')
    // One vault per pass. Each is an encrypted copy of that profile's entire
    // stored state, so queueing every profile's vault before uploading any of
    // them would hold the whole account in the queue at once.
    for (const profile of getProfiles()) { await queueEncryptedVault(profile.id); await drain() }
  }
  if (pendingDeletions.length) clearPendingProfileDeletions(pendingDeletions)
  if (activeVaultRestored) reloadAfterVaultRestore()
  return { uploaded, downloaded }
}

export function uploadSyncNow(fetcher: typeof fetch = fetch): Promise<{ uploaded: number; downloaded: number }> {
  return withSyncBatchLock(() => uploadSyncNowUnlocked(fetcher))
}

/** Pull the complete account state without first uploading local changes.
 * Useful when setting up a fresh device or explicitly restoring a profile. */
async function downloadSyncNowUnlocked(fetcher: typeof fetch): Promise<{ downloaded: number }> {
  const config = getSyncConfig()
  if (!config.endpoint || !config.accessToken) throw new Error('Aurales Sync is not configured')
  let cursor = '0'; let downloaded = 0
  let activeVaultRestored = false
  do {
    let body: { cursor?: string; records?: SyncRecord[] }
    try {
      body = await runSyncBatch({ endpoint: config.endpoint, accessToken: config.accessToken, schemaVersion: AURALES_SYNC_SCHEMA_VERSION, deviceId: getDeviceId(), deviceName: config.deviceName || 'Aurales Desktop', cursor, records: [], mode: 'download' }, fetcher)
    } catch (error) {
      setSyncConfig({ lastError: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const records = body.records || []
    activeVaultRestored ||= await applyRemoteRecords(records)
    downloaded += records.length
    const nextCursor = body.cursor || cursor
    if (records.length < SYNC_PAGE_SIZE || nextCursor === cursor) { cursor = nextCursor; break }
    cursor = nextCursor
  } while (true)
  setSyncConfig({ cursor, lastSyncAt: new Date().toISOString(), lastError: undefined })
  if (activeVaultRestored) reloadAfterVaultRestore()
  return { downloaded }
}

export function downloadSyncNow(fetcher: typeof fetch = fetch): Promise<{ downloaded: number }> {
  return withSyncBatchLock(() => downloadSyncNowUnlocked(fetcher))
}

/** Safe for lifecycle hooks: does nothing until an Aurales account is configured. */
export async function syncIfConfigured(): Promise<void> {
  const config = getSyncConfig()
  if (!config.accessToken || config.autoSync === false) return
  if (configuredSyncPending) return configuredSyncPending
  const cursorBefore = config.cursor
  configuredSyncPending = syncNow()
    .then((result) => {
      automaticSyncRetryAttempt = 0
      // A sync round sends one bounded batch. Keep draining on successful
      // rounds so initial snapshots and full remote pages do not stall until
      // another local edit happens.
      if (getSyncOutbox().length > 0 || (
        result.downloaded >= SYNC_PAGE_SIZE && getSyncConfig().cursor !== cursorBefore
      )) scheduleAutomaticSync(1200)
    })
    .catch((error) => {
      if (shouldRetryAutomaticSync(error)) {
        const delayMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(automaticSyncRetryAttempt, 6)))
        automaticSyncRetryAttempt += 1
        scheduleAutomaticSync(delayMs)
      }
      throw error
    })
    .finally(() => { configuredSyncPending = null })
  return configuredSyncPending
}
