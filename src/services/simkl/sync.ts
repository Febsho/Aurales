/**
 * Two-way Simkl sync.
 *
 * Conflict strategy:
 *  - Newest updatedAt / watchedAt timestamp wins.
 *  - Local data is never deleted just because Simkl doesn't have it.
 *  - Items are only removed when the user explicitly removes them.
 *  - Partial success is allowed — errors are collected and returned.
 */

import { isSimklMockMode } from './auth'
import { getSimklWatchlist, getSimklWatching, getSimklCompleted, getSimklAnimeWatchlist, addToSimklWatchlist } from './lists'
import { getSimklWatchedMovies, getSimklWatchedEpisodes } from './history'
import type { SimklSyncResult, SimklWatchlistItem } from './types'

const LS_LAST_SYNC = 'simkl_last_sync'
const LS_LOCAL_WATCHLIST = 'simkl_local_watchlist'

// ─── Main sync entry point ─────────────────────────────────────────────────────

export async function syncSimkl(): Promise<SimklSyncResult> {
  if (isSimklMockMode()) return mockSyncResult()

  const errors: string[] = []
  let pulled = 0
  let pushed = 0

  try {
    const pullResult = await pullSimklLists()
    pulled = pullResult.pulled
    errors.push(...pullResult.errors)
  } catch (e) {
    errors.push(`Pull failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const pushResult = await pushLocalChangesToSimkl()
    pushed = pushResult.pushed
    errors.push(...pushResult.errors)
  } catch (e) {
    errors.push(`Push failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  const syncedAt = new Date().toISOString()
  setLastSimklSyncTime(syncedAt)

  return {
    success: errors.length === 0,
    pulled,
    pushed,
    errors,
    syncedAt,
  }
}

// ─── Pull ──────────────────────────────────────────────────────────────────────

export async function pullSimklLists(): Promise<Pick<SimklSyncResult, 'pulled' | 'errors'>> {
  const errors: string[] = []
  let pulled = 0

  const run = async (label: string, fn: () => Promise<SimklWatchlistItem[]>) => {
    try {
      const items = await fn()
      mergeIntoLocalStore(items)
      pulled += items.length
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  await run('watchlist', syncSimklWatchlist)
  await run('watching', () => getSimklWatching())
  await run('completed', syncSimklHistory)
  await run('anime', () => getSimklAnimeWatchlist())

  return { pulled, errors }
}

export async function syncSimklWatchlist(): Promise<SimklWatchlistItem[]> {
  const items = await getSimklWatchlist()
  mergeIntoLocalStore(items)
  return items
}

export async function syncSimklHistory(): Promise<SimklWatchlistItem[]> {
  const [movies, episodes] = await Promise.all([
    getSimklWatchedMovies(),
    getSimklWatchedEpisodes(),
  ])
  const all = [...movies, ...episodes]
  mergeIntoLocalStore(all)
  return all
}

export async function syncSimklProgress(): Promise<void> {
  // TODO: Simkl's v1 public API does not expose per-episode progress endpoint.
  // Progress is inferred from watched_episodes_count vs total_episodes_count.
  // This function is a no-op placeholder for future implementation.
}

// ─── Push ──────────────────────────────────────────────────────────────────────

export async function pushLocalChangesToSimkl(): Promise<Pick<SimklSyncResult, 'pushed' | 'errors'>> {
  const errors: string[] = []
  let pushed = 0

  // Get items that were added locally since the last sync
  const lastSync = getLastSimklSyncTime()
  const localItems = getLocalStore()
  const pending = lastSync
    ? localItems.filter((i) => i.addedAt && i.addedAt > lastSync)
    : []

  for (const item of pending) {
    try {
      await addToSimklWatchlist(
        {
          localId: item.id,
          title: item.title,
          year: item.year,
          imdbId: item.imdbId,
          tmdbId: item.tmdbId,
          tvdbId: item.tvdbId,
          malId: item.malId,
          simklId: item.simklId,
        },
        item.type,
      )
      pushed++
    } catch (e) {
      errors.push(`Push "${item.title}": ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { pushed, errors }
}

// ─── Sync time ─────────────────────────────────────────────────────────────────

export function getLastSimklSyncTime(): string | null {
  return localStorage.getItem(LS_LAST_SYNC)
}

export function setLastSimklSyncTime(time: string): void {
  localStorage.setItem(LS_LAST_SYNC, time)
}

// ─── Local store helpers ───────────────────────────────────────────────────────

function getLocalStore(): SimklWatchlistItem[] {
  try {
    return JSON.parse(localStorage.getItem(LS_LOCAL_WATCHLIST) || '[]') as SimklWatchlistItem[]
  } catch (_) { return [] }
}

function mergeIntoLocalStore(incoming: SimklWatchlistItem[]): void {
  const existing = getLocalStore()
  const byId = new Map(existing.map((i) => [i.id, i]))

  for (const item of incoming) {
    const current = byId.get(item.id)
    if (!current) {
      byId.set(item.id, item)
      continue
    }
    // Newest watchedAt wins
    const incomingTime = item.watchedAt || item.addedAt || ''
    const currentTime  = current.watchedAt || current.addedAt || ''
    if (incomingTime > currentTime) {
      byId.set(item.id, { ...current, ...item })
    }
  }

  localStorage.setItem(LS_LOCAL_WATCHLIST, JSON.stringify(Array.from(byId.values())))
}

// ─── Mock ──────────────────────────────────────────────────────────────────────

function mockSyncResult(): SimklSyncResult {
  const syncedAt = new Date().toISOString()
  setLastSimklSyncTime(syncedAt)
  return {
    success: true,
    pulled: 4,
    pushed: 0,
    errors: [],
    syncedAt,
  }
}
