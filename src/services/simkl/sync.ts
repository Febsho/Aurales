/**
 * SIMKL two-phase library sync.
 *
 * A SIMKL activity timestamp is an opaque server cursor, not a wall-clock
 * value. The old `simkl_last_sync` is retained for UI compatibility, but is
 * deliberately never sent as `date_from` during this v2 migration.
 */

import { isSimklMockMode } from './auth'
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

export async function syncSimkl(): Promise<SimklSyncResult> {
  if (isSimklMockMode()) return mockSyncResult()
  const errors: string[] = []
  let pulled = 0
  let pushed = 0
  let pullComplete = false
  let pushComplete = false

  try {
    const result = await pullSimklLists()
    pulled = result.pulled
    errors.push(...result.errors)
    pullComplete = result.errors.length === 0
  } catch (error) {
    errors.push(`Pull failed: ${message(error)}`)
  }
  try {
    const result = await pushLocalChangesToSimkl()
    pushed = result.pushed
    errors.push(...result.errors)
    pushComplete = result.errors.length === 0
  } catch (error) {
    errors.push(`Push failed: ${message(error)}`)
  }

  const syncedAt = new Date().toISOString()
  // Display/local-write watermark only; never a SIMKL delta cursor.
  if (pullComplete && pushComplete) setLastSimklSyncTime(syncedAt)
  return { success: errors.length === 0, pulled, pushed, errors, syncedAt }
}

/**
 * Bootstrap sequentially, then persist the exact activity timestamp. Future
 * calls gate on activities and merge a single `date_from` delta.
 */
export async function pullSimklLists(): Promise<Pick<SimklSyncResult, 'pulled' | 'errors'>> {
  const state = getSyncStateV2()
  try {
    if (!state?.activitiesAll) return await bootstrapSimklLibrary()
    const activities = await simklRequest<SimklActivities>('/sync/activities')
    const activitiesAll = activities?.all
    if (!activitiesAll) throw new Error('SIMKL activities did not include an all timestamp.')
    if (activitiesAll === state.activitiesAll) return { pulled: 0, errors: [] }

    const raw = await simklRequest<unknown>(`/sync/all-items?date_from=${encodeURIComponent(state.activitiesAll)}&${EPISODE_PARAMS}`)
    const items = normalizeSimklHistoryItems(raw)
    mergeIntoLocalStore(items)
    setSyncStateV2({ activitiesAll })
    return { pulled: items.length, errors: [] }
  } catch (error) {
    return { pulled: 0, errors: [`library: ${message(error)}`] }
  }
}

async function bootstrapSimklLibrary(): Promise<Pick<SimklSyncResult, 'pulled' | 'errors'>> {
  let pulled = 0
  const errors: string[] = []
  // SIMKL explicitly asks clients not to parallelise initial large payloads.
  for (const type of ['shows', 'movies', 'anime'] as const) {
    try {
      const raw = await simklRequest<unknown>(`/sync/all-items/${type}?${EPISODE_PARAMS}`)
      const items = normalizeSimklHistoryItems(raw)
      mergeIntoLocalStore(items)
      pulled += items.length
    } catch (error) {
      errors.push(`${type}: ${message(error)}`)
      break
    }
  }
  if (errors.length) return { pulled, errors }
  try {
    const activities = await simklRequest<SimklActivities>('/sync/activities')
    if (!activities?.all) throw new Error('SIMKL activities did not include an all timestamp.')
    setSyncStateV2({ activitiesAll: activities.all })
  } catch (error) {
    errors.push(`activities: ${message(error)}`)
  }
  return { pulled, errors }
}

/** Compatibility helpers for older callers. */
export async function syncSimklWatchlist(): Promise<SimklWatchlistItem[]> {
  await pullSimklLists()
  return getLocalStore().filter((item) => item.status === 'plantowatch')
}

export async function syncSimklHistory(): Promise<SimklWatchlistItem[]> {
  await pullSimklLists()
  return getLocalStore().filter((item) => item.status === 'completed' || !!item.watchedEpisodes?.length)
}

export async function syncSimklProgress(): Promise<void> { await pullSimklLists() }

export async function pushLocalChangesToSimkl(): Promise<Pick<SimklSyncResult, 'pushed' | 'errors'>> {
  const errors: string[] = []
  let pushed = 0
  const lastSync = getLastSimklSyncTime()
  const pending = lastSync ? getLocalStore().filter((item) => item.addedAt && item.addedAt > lastSync) : []
  for (const item of pending) {
    try {
      await addToSimklWatchlist({ localId: item.id, title: item.title, year: item.year, imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId, simklId: item.simklId }, item.type)
      pushed++
    } catch (error) {
      errors.push(`Push "${item.title}": ${message(error)}`)
    }
  }
  return { pushed, errors }
}

export function getLastSimklSyncTime(): string | null { return localStorage.getItem(LS_LAST_SYNC) }
export function setLastSimklSyncTime(time: string): void { localStorage.setItem(LS_LAST_SYNC, time) }

/** Current v2 pull snapshot for consumers already refreshed by `syncSimkl`. */
export function getSyncedSimklItems(): SimklWatchlistItem[] { return getLocalStore() }

function getSyncStateV2(): SimklSyncStateV2 | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_SYNC_STATE_V2) || 'null') as SimklSyncStateV2 | null
    return parsed?.activitiesAll ? parsed : null
  } catch { return null }
}

function setSyncStateV2(state: SimklSyncStateV2): void {
  localStorage.setItem(LS_SYNC_STATE_V2, JSON.stringify(state))
}

function getLocalStore(): SimklWatchlistItem[] {
  try { return JSON.parse(localStorage.getItem(LS_LOCAL_WATCHLIST) || '[]') as SimklWatchlistItem[] } catch { return [] }
}

function mergeIntoLocalStore(incoming: SimklWatchlistItem[]): void {
  const byId = new Map(getLocalStore().map((item) => [item.id, item]))
  for (const item of incoming) {
    const current = byId.get(item.id)
    const incomingTime = item.watchedAt || item.addedAt || ''
    const currentTime = current?.watchedAt || current?.addedAt || ''
    if (!current || incomingTime >= currentTime) byId.set(item.id, { ...current, ...item })
  }
  localStorage.setItem(LS_LOCAL_WATCHLIST, JSON.stringify([...byId.values()]))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function mockSyncResult(): SimklSyncResult {
  const syncedAt = new Date().toISOString()
  setLastSimklSyncTime(syncedAt)
  return { success: true, pulled: 4, pushed: 0, errors: [], syncedAt }
}
