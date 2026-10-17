/**
 * SIMKL two-phase library sync.
 *
 * A SIMKL activity timestamp is an opaque server cursor, not a wall-clock
 * value. The old `simkl_last_sync` is retained for UI compatibility, but is
 * deliberately never sent as `date_from` during this v2 migration.
 */

import { invoke, isTauri } from '@tauri-apps/api/core'
import { getStoredSimklAccount, isSimklMockMode } from './auth'
import { addToSimklWatchlist } from './lists'
import { normalizeSimklHistoryItems } from './history'
import { simklRequest } from './client'
import type { SimklSyncResult, SimklWatchlistItem } from './types'

const LS_LAST_SYNC = 'simkl_last_sync'
const LS_LOCAL_WATCHLIST = 'simkl_local_watchlist'
const LS_SYNC_STATE_V2 = 'simkl_sync_state_v2'
const EPISODE_PARAMS = 'extended=full&episode_watched_at=yes&include_all_episodes=yes'

interface SimklSyncStateV2 { activitiesAll: string }
interface SimklActivities { all?: string }
interface SimklLocalSnapshot { items: SimklWatchlistItem[]; activitiesAll?: string }

const activeSyncs = new Map<string, Promise<SimklSyncResult>>()

function snapshotKey(): string {
  const profileId = localStorage.getItem('aurales_active_profile_v1') || 'default'
  const accountId = getStoredSimklAccount()?.id || 'anonymous'
  return `simkl_sync_snapshot:v2:${profileId}:${encodeURIComponent(accountId)}`
}

function webSnapshotStorageKeys(cacheKey: string): { items: string; state: string } {
  const scope = cacheKey.startsWith('simkl_sync_snapshot:v2:')
    ? cacheKey.slice('simkl_sync_snapshot:v2:'.length)
    : 'default:anonymous'
  return {
    items: `simkl_local_watchlist_v2:${scope}`,
    state: `simkl_sync_state_v2:${scope}`,
  }
}

function assertSnapshotScope(expectedKey: string): void {
  if (snapshotKey() !== expectedKey) throw new Error('The active profile or Simkl account changed during sync. Run sync again.')
}

export function syncSimkl(): Promise<SimklSyncResult> {
  if (isSimklMockMode()) return Promise.resolve(mockSyncResult())
  const cacheKey = snapshotKey()
  const active = activeSyncs.get(cacheKey)
  if (active) return active

  const sync = runSimklSync(cacheKey).finally(() => {
    if (activeSyncs.get(cacheKey) === sync) activeSyncs.delete(cacheKey)
  })
  activeSyncs.set(cacheKey, sync)
  return sync
}

async function runSimklSync(cacheKey: string): Promise<SimklSyncResult> {
  const errors: string[] = []
  let pulled = 0
  let pushed = 0
  let pullComplete = false
  let pushComplete = false

  try {
    const result = await pullSimklLists(cacheKey)
    pulled = result.pulled
    errors.push(...result.errors)
    pullComplete = result.errors.length === 0
  } catch (error) {
    errors.push(`Pull failed: ${message(error)}`)
  }
  try {
    const result = await pushLocalChangesToSimkl(cacheKey)
    pushed = result.pushed
    errors.push(...result.errors)
    pushComplete = result.errors.length === 0
  } catch (error) {
    errors.push(`Push failed: ${message(error)}`)
  }

  const syncedAt = new Date().toISOString()
  // Display/local-write watermark only; never a SIMKL delta cursor.
  if (pullComplete && pushComplete) setLastSimklSyncTime(syncedAt, cacheKey)
  return { success: errors.length === 0, pulled, pushed, errors, syncedAt }
}

/**
 * Bootstrap sequentially, then persist the exact activity timestamp. Future
 * calls gate on activities and merge a single `date_from` delta.
 */
export async function pullSimklLists(cacheKey = snapshotKey()): Promise<Pick<SimklSyncResult, 'pulled' | 'errors'>> {
  try {
    const state = await getLocalSnapshot(cacheKey)
    assertSnapshotScope(cacheKey)
    if (!state.activitiesAll) return await bootstrapSimklLibrary(cacheKey)
    assertSnapshotScope(cacheKey)
    const activities = await simklRequest<SimklActivities>('/sync/activities')
    assertSnapshotScope(cacheKey)
    const activitiesAll = activities?.all
    if (!activitiesAll) throw new Error('SIMKL activities did not include an all timestamp.')
    if (activitiesAll === state.activitiesAll) return { pulled: 0, errors: [] }

    assertSnapshotScope(cacheKey)
    const raw = await simklRequest<unknown>(`/sync/all-items?date_from=${encodeURIComponent(state.activitiesAll)}&${EPISODE_PARAMS}`)
    assertSnapshotScope(cacheKey)
    const items = normalizeSimklHistoryItems(raw)
    await mergeIntoLocalStore(items, activitiesAll, cacheKey)
    return { pulled: items.length, errors: [] }
  } catch (error) {
    return { pulled: 0, errors: [`library: ${message(error)}`] }
  }
}

async function bootstrapSimklLibrary(cacheKey: string): Promise<Pick<SimklSyncResult, 'pulled' | 'errors'>> {
  let pulled = 0
  const errors: string[] = []
  // SIMKL explicitly asks clients not to parallelise initial large payloads.
  for (const type of ['shows', 'movies', 'anime'] as const) {
    try {
      assertSnapshotScope(cacheKey)
      const raw = await simklRequest<unknown>(`/sync/all-items/${type}?${EPISODE_PARAMS}`)
      assertSnapshotScope(cacheKey)
      const items = normalizeSimklHistoryItems(raw)
      await mergeIntoLocalStore(items, undefined, cacheKey)
      pulled += items.length
    } catch (error) {
      errors.push(`${type}: ${message(error)}`)
      break
    }
  }
  if (errors.length) return { pulled, errors }
  try {
    assertSnapshotScope(cacheKey)
    const activities = await simklRequest<SimklActivities>('/sync/activities')
    assertSnapshotScope(cacheKey)
    if (!activities?.all) throw new Error('SIMKL activities did not include an all timestamp.')
    const snapshot = await getLocalSnapshot(cacheKey)
    await setLocalSnapshot({ ...snapshot, activitiesAll: activities.all }, cacheKey)
  } catch (error) {
    errors.push(`activities: ${message(error)}`)
  }
  return { pulled, errors }
}

/** Compatibility helpers for older callers. */
export async function syncSimklWatchlist(): Promise<SimklWatchlistItem[]> {
  await pullSimklLists()
  return (await getLocalStore()).filter((item) => item.status === 'plantowatch')
}

export async function syncSimklHistory(): Promise<SimklWatchlistItem[]> {
  await pullSimklLists()
  return (await getLocalStore()).filter((item) => item.status === 'completed' || !!item.watchedEpisodes?.length)
}

export async function syncSimklProgress(): Promise<void> { await pullSimklLists() }

export async function pushLocalChangesToSimkl(cacheKey = snapshotKey()): Promise<Pick<SimklSyncResult, 'pushed' | 'errors'>> {
  const errors: string[] = []
  let pushed = 0
  const lastSync = getLastSimklSyncTime(cacheKey)
  const pending = lastSync ? (await getLocalStore(cacheKey)).filter((item) => item.addedAt && item.addedAt > lastSync) : []
  for (const item of pending) {
    try {
      assertSnapshotScope(cacheKey)
      await addToSimklWatchlist({ localId: item.id, title: item.title, year: item.year, imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId, simklId: item.simklId }, item.type)
      assertSnapshotScope(cacheKey)
      pushed++
    } catch (error) {
      errors.push(`Push "${item.title}": ${message(error)}`)
    }
  }
  return { pushed, errors }
}

function lastSyncStorageKey(cacheKey: string): string {
  const scope = cacheKey.startsWith('simkl_sync_snapshot:v2:')
    ? cacheKey.slice('simkl_sync_snapshot:v2:'.length)
    : 'default:anonymous'
  return `simkl_last_sync_v2:${scope}`
}

export function getLastSimklSyncTime(cacheKey = snapshotKey()): string | null {
  const key = lastSyncStorageKey(cacheKey)
  const scoped = localStorage.getItem(key)
  if (scoped) return scoped
  // The previous format had one global watermark. Assign it to the current
  // profile/account once, then prevent it from suppressing other profiles.
  const legacy = localStorage.getItem(LS_LAST_SYNC)
  if (!legacy) return null
  localStorage.setItem(key, legacy)
  localStorage.removeItem(LS_LAST_SYNC)
  return legacy
}

export function setLastSimklSyncTime(time: string, cacheKey = snapshotKey()): void {
  localStorage.setItem(lastSyncStorageKey(cacheKey), time)
  localStorage.removeItem(LS_LAST_SYNC)
}

/** Current v2 pull snapshot for consumers already refreshed by `syncSimkl`. */
export async function getSyncedSimklItems(): Promise<SimklWatchlistItem[]> { return getLocalStore() }

/** Return null until a full pull has established its activity cursor. An empty
 * item list after that cursor is valid and must not trigger another full pull. */
export async function getSimklSyncedSnapshot(): Promise<SimklWatchlistItem[] | null> {
  const snapshot = await getLocalSnapshot()
  return snapshot.activitiesAll ? snapshot.items : null
}

function getLegacySyncStateV2(): SimklSyncStateV2 | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_SYNC_STATE_V2) || 'null') as SimklSyncStateV2 | null
    return parsed?.activitiesAll ? parsed : null
  } catch { return null }
}

function getLegacyLocalStore(): SimklWatchlistItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_LOCAL_WATCHLIST) || '[]')
    return Array.isArray(parsed) ? parsed as SimklWatchlistItem[] : []
  } catch { return [] }
}

async function getLocalSnapshot(cacheKey = snapshotKey()): Promise<SimklLocalSnapshot> {
  if (!isTauri()) {
    const keys = webSnapshotStorageKeys(cacheKey)
    let items: SimklWatchlistItem[] = []
    let activitiesAll: string | undefined
    try {
      const parsed = JSON.parse(localStorage.getItem(keys.items) || '[]')
      if (Array.isArray(parsed)) items = parsed as SimklWatchlistItem[]
    } catch { /* restore legacy data below */ }
    try {
      const parsed = JSON.parse(localStorage.getItem(keys.state) || 'null') as SimklSyncStateV2 | null
      activitiesAll = parsed?.activitiesAll
    } catch { /* restore legacy data below */ }

    const hasLegacyState = localStorage.getItem(LS_LOCAL_WATCHLIST) != null || localStorage.getItem(LS_SYNC_STATE_V2) != null
    if (hasLegacyState) {
      const merged = new Map(getLegacyLocalStore().map((item) => [item.id, item]))
      for (const item of items) merged.set(item.id, item)
      const snapshot: SimklLocalSnapshot = {
        items: [...merged.values()],
        activitiesAll: activitiesAll || getLegacySyncStateV2()?.activitiesAll,
      }
      await setLocalSnapshot(snapshot, cacheKey)
      localStorage.removeItem(LS_LOCAL_WATCHLIST)
      localStorage.removeItem(LS_SYNC_STATE_V2)
      return snapshot
    }
    return { items, activitiesAll }
  }
  const entry = await invoke<{ value: string } | null>('cache_entry_get', { key: cacheKey })
  if (entry) {
    const snapshot = JSON.parse(entry.value) as SimklLocalSnapshot
    if (!Array.isArray(snapshot.items)) throw new Error('Stored SIMKL snapshot is invalid.')
    // A previous run may have completed the native write but closed before
    // removing the large legacy copy. Preserve any older items absent from
    // the native copy before freeing the WebView quota.
    if (localStorage.getItem(LS_LOCAL_WATCHLIST) != null || localStorage.getItem(LS_SYNC_STATE_V2) != null) {
      const byId = new Map(getLegacyLocalStore().map((item) => [item.id, item]))
      for (const item of snapshot.items) byId.set(item.id, item)
      const legacyCursor = getLegacySyncStateV2()?.activitiesAll
      if (byId.size > snapshot.items.length || (!snapshot.activitiesAll && legacyCursor)) {
        snapshot.items = [...byId.values()]
        snapshot.activitiesAll ||= legacyCursor
        await setLocalSnapshot(snapshot, cacheKey)
      }
      localStorage.removeItem(LS_LOCAL_WATCHLIST)
      localStorage.removeItem(LS_SYNC_STATE_V2)
    }
    return snapshot
  }
  const legacy: SimklLocalSnapshot = { items: getLegacyLocalStore(), activitiesAll: getLegacySyncStateV2()?.activitiesAll }
  if (localStorage.getItem(LS_LOCAL_WATCHLIST) != null || localStorage.getItem(LS_SYNC_STATE_V2) != null) {
    // Never discard the old library until the native write has succeeded.
    await setLocalSnapshot(legacy, cacheKey)
    localStorage.removeItem(LS_LOCAL_WATCHLIST)
    localStorage.removeItem(LS_SYNC_STATE_V2)
  }
  return legacy
}

async function setLocalSnapshot(snapshot: SimklLocalSnapshot, cacheKey = snapshotKey()): Promise<void> {
  if (isTauri()) {
    await invoke('cache_entry_set', {
      key: cacheKey,
      value: JSON.stringify(snapshot),
      category: 'simkl_sync_snapshot',
      ttlSeconds: null,
    })
  } else {
    const keys = webSnapshotStorageKeys(cacheKey)
    localStorage.setItem(keys.items, JSON.stringify(snapshot.items))
    if (snapshot.activitiesAll) localStorage.setItem(keys.state, JSON.stringify({ activitiesAll: snapshot.activitiesAll }))
    else localStorage.removeItem(keys.state)
  }
}

async function getLocalStore(cacheKey = snapshotKey()): Promise<SimklWatchlistItem[]> {
  return (await getLocalSnapshot(cacheKey)).items
}

async function mergeIntoLocalStore(incoming: SimklWatchlistItem[], activitiesAll?: string, cacheKey = snapshotKey()): Promise<void> {
  assertSnapshotScope(cacheKey)
  const currentSnapshot = await getLocalSnapshot(cacheKey)
  assertSnapshotScope(cacheKey)
  const byId = new Map(currentSnapshot.items.map((item) => [item.id, item]))
  for (const item of incoming) {
    const current = byId.get(item.id)
    const incomingTime = item.watchedAt || item.addedAt || ''
    const currentTime = current?.watchedAt || current?.addedAt || ''
    if (!current || incomingTime >= currentTime) byId.set(item.id, { ...current, ...item })
  }
  await setLocalSnapshot({ items: [...byId.values()], activitiesAll: activitiesAll ?? currentSnapshot.activitiesAll }, cacheKey)
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function mockSyncResult(): SimklSyncResult {
  const syncedAt = new Date().toISOString()
  setLastSimklSyncTime(syncedAt)
  return { success: true, pulled: 4, pushed: 0, errors: [], syncedAt }
}
