import { useAppStore } from '../stores/appStore'
import { hasMdblistOAuth } from './mdblist'
import {
  forceRefreshProviderWatched,
  refreshWatchedCache,
  type SyncableWatchedSource,
} from './watchedCacheSync'
import type { WatchedSource } from './watchedStatus'

/**
 * Background sync scheduler driven by the per-provider "Sync Frequency"
 * settings (Progress & Sync tab). Each connected provider gets its own timer
 * that force-refreshes the provider's cached data, so watched checkmarks and
 * continue-watching stay current with changes made on other devices.
 */

type SyncProvider = SyncableWatchedSource | 'anilist'

const FREQ_MS: Record<string, number | undefined> = {
  every_minute: 60_000,
  every_5: 5 * 60_000,
  every_15: 15 * 60_000,
  // 'manual' → no timer
}

const timers = new Map<SyncProvider, ReturnType<typeof setInterval>>()
const syncing = new Set<SyncProvider>()
let unsubscribe: (() => void) | null = null

function providerConnected(provider: SyncProvider): boolean {
  const s = useAppStore.getState()
  switch (provider) {
    case 'trakt': return s.traktConnected
    case 'simkl': return s.simklConnected
    case 'pmdb': return !!s.pmdbApiKey
    case 'mdblist': return !!s.mdblistApiKey || hasMdblistOAuth()
    case 'anilist': return s.anilistConnected
  }
}

function providerFrequency(provider: SyncProvider): string {
  const s = useAppStore.getState()
  switch (provider) {
    case 'trakt': return s.traktSyncFrequency
    case 'simkl': return s.simklSyncFrequency
    case 'pmdb': return s.pmdbSyncFrequency
    case 'mdblist': return s.mdblistSyncFrequency
    case 'anilist': return s.anilistSyncFrequency
  }
}

export async function syncProviderNow(provider: SyncProvider): Promise<void> {
  if (syncing.has(provider)) return
  syncing.add(provider)
  try {
    const store = useAppStore.getState()

    if (provider === 'anilist') {
      // Warms the AniList continue-watching/list caches (same as "Sync Now").
      const { getAniListContinueWatching } = await import('./anilist')
      await getAniListContinueWatching()
      return
    }

    if (provider === 'simkl') {
      // Full Simkl sync (history + lists), then refresh the watched snapshot.
      const { syncSimkl } = await import('./simkl/sync')
      await syncSimkl().catch((e) => console.warn('[ProviderSync] simkl full sync failed:', e))
    }

    await forceRefreshProviderWatched(provider)

    // Rebuild the in-memory watched-key set from the (now fresh) caches.
    await refreshWatchedCache(store.watchedCheckmarkSources as WatchedSource[])

    const stamp = new Date().toLocaleString()
    if (provider === 'pmdb') store.setPmdBLastSyncTime(stamp)
    if (provider === 'mdblist') store.setMdblistLastSyncTime(stamp)
  } catch (e) {
    console.warn(`[ProviderSync] ${provider} sync failed:`, e)
  } finally {
    syncing.delete(provider)
  }
}

function rebuildTimers(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()

  const providers: SyncProvider[] = ['trakt', 'simkl', 'pmdb', 'mdblist', 'anilist']
  for (const provider of providers) {
    if (!providerConnected(provider)) continue
    const ms = FREQ_MS[providerFrequency(provider)]
    if (!ms) continue // manual (or unknown) → no background timer
    timers.set(provider, setInterval(() => { syncProviderNow(provider) }, ms))
  }
}

export function startProviderSyncScheduler(): void {
  stopProviderSyncScheduler()
  rebuildTimers()

  // Rebuild timers when a frequency or connection state changes.
  let prev = snapshot()
  unsubscribe = useAppStore.subscribe(() => {
    const next = snapshot()
    if (next !== prev) {
      prev = next
      rebuildTimers()
    }
  })
}

function snapshot(): string {
  const s = useAppStore.getState()
  return [
    s.traktSyncFrequency, s.traktConnected,
    s.simklSyncFrequency, s.simklConnected,
    s.pmdbSyncFrequency, !!s.pmdbApiKey,
    s.mdblistSyncFrequency, !!s.mdblistApiKey,
    s.anilistSyncFrequency, s.anilistConnected,
  ].join('|')
}

export function stopProviderSyncScheduler(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}
