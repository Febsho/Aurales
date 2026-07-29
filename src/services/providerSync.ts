import { useAppStore } from '../stores/appStore'
import { hasMdblistOAuth } from './mdblist'
import {
  forceRefreshProviderWatched,
  setWatchedProviderSnapshot,
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

const PROVIDERS: SyncProvider[] = ['trakt', 'simkl', 'pmdb', 'mdblist', 'anilist']
const syncing = new Map<SyncProvider, Promise<void>>()
const lastRunAt = new Map<SyncProvider, number>()
const lastRecoveryAt = new Map<SyncProvider, number>()
let schedulerTimer: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null
let recoveryHandler: (() => void) | null = null

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
  const pending = syncing.get(provider)
  if (pending) return pending
  const task = (async () => {
    const store = useAppStore.getState()

    if (provider === 'anilist') {
      // Warms the AniList continue-watching/list caches and refreshes the
      // title-level watched snapshot so completed anime shows as watched.
      const { getAniListContinueWatching, getAniListWatchedTitleKeys, clearAniListProgressCaches } = await import('./anilist')
      clearAniListProgressCaches()
      await getAniListContinueWatching().catch((e) => console.warn('[ProviderSync] anilist continue warm failed:', e))
      const keys = await getAniListWatchedTitleKeys()
      setWatchedProviderSnapshot('anilist', keys, store.watchedCheckmarkSources as WatchedSource[])
      return
    }

    if (provider === 'simkl') {
      // Full Simkl sync (history + lists), then refresh the watched snapshot.
      const { syncSimkl } = await import('./simkl/sync')
      await syncSimkl().catch((e) => console.warn('[ProviderSync] simkl full sync failed:', e))
    }

    await forceRefreshProviderWatched(provider)

    const stamp = new Date().toLocaleString()
    if (provider === 'pmdb') store.setPmdBLastSyncTime(stamp)
    if (provider === 'mdblist') store.setMdblistLastSyncTime(stamp)
  })().catch((e) => {
    console.warn(`[ProviderSync] ${provider} sync failed:`, e)
  }).finally(() => {
    syncing.delete(provider)
    lastRunAt.set(provider, Date.now())
  })
  syncing.set(provider, task)
  return task
}

function appCanSync(): boolean {
  return (typeof navigator === 'undefined' || navigator.onLine)
    && (typeof document === 'undefined' || document.visibilityState === 'visible')
}

function runDueProviders(recovery = false): void {
  if (!appCanSync()) return
  const now = Date.now()
  for (const provider of PROVIDERS) {
    if (!providerConnected(provider)) continue
    const frequency = FREQ_MS[providerFrequency(provider)]
    if (!frequency) continue
    const last = lastRunAt.get(provider) ?? now
    if (!lastRunAt.has(provider)) lastRunAt.set(provider, now)
    if (now - last < frequency) continue
    if (recovery && now - (lastRecoveryAt.get(provider) || 0) < 30_000) continue
    if (recovery) lastRecoveryAt.set(provider, now)
    // Stamp before dispatch so repeated focus/online events coalesce while the
    // shared in-flight promise is active.
    lastRunAt.set(provider, now)
    void syncProviderNow(provider)
  }
}

export function startProviderSyncScheduler(): void {
  stopProviderSyncScheduler()
  const now = Date.now()
  for (const provider of PROVIDERS) if (providerConnected(provider)) lastRunAt.set(provider, now)
  schedulerTimer = setInterval(() => runDueProviders(false), 30_000)
  recoveryHandler = () => runDueProviders(true)
  if (typeof window !== 'undefined') {
    window.addEventListener('online', recoveryHandler)
    window.addEventListener('focus', recoveryHandler)
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', recoveryHandler)

  let prev = snapshot()
  unsubscribe = useAppStore.subscribe(() => {
    const next = snapshot()
    if (next !== prev) {
      prev = next
      const changedAt = Date.now()
      for (const provider of PROVIDERS) if (providerConnected(provider) && !lastRunAt.has(provider)) lastRunAt.set(provider, changedAt)
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
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = null
  if (recoveryHandler && typeof window !== 'undefined') {
    window.removeEventListener('online', recoveryHandler)
    window.removeEventListener('focus', recoveryHandler)
  }
  if (recoveryHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', recoveryHandler)
  recoveryHandler = null
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}
