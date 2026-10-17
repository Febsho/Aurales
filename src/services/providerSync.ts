import { useAppStore } from '../stores/appStore'
import { getActiveProfileId, profileProviderCacheKey } from './profiles'
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
const syncing = new Map<string, Promise<void>>()
const lastRunAt = new Map<string, number>()
const lastRecoveryAt = new Map<string, number>()
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
  const profileId = getActiveProfileId()
  const runKey = providerSyncKey(provider, profileId)
  const scheduleKey = providerScheduleKey(provider, profileId)
  const pending = syncing.get(runKey)
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
      if (providerSyncKey(provider) !== runKey) return
      setWatchedProviderSnapshot('anilist', keys, store.watchedCheckmarkSources as WatchedSource[])
      return
    }

    if (provider === 'simkl') {
      // Full Simkl sync (history + lists), then refresh the watched snapshot.
      const { syncSimkl } = await import('./simkl/sync')
      await syncSimkl().catch((e) => console.warn('[ProviderSync] simkl full sync failed:', e))
    }

    await forceRefreshProviderWatched(provider)

    // Avoid writing an old account's completion time into a newly active profile.
    if (providerSyncKey(provider) !== runKey) return

    const stamp = new Date().toLocaleString()
    if (provider === 'pmdb') store.setPmdBLastSyncTime(stamp)
    if (provider === 'mdblist') store.setMdblistLastSyncTime(stamp)
  })().catch((e) => {
    console.warn(`[ProviderSync] ${provider} sync failed:`, e)
  }).finally(() => {
    syncing.delete(runKey)
    lastRunAt.set(scheduleKey, Date.now())
  })
  syncing.set(runKey, task)
  return task
}

function providerSyncKey(provider: SyncProvider, profileId = getActiveProfileId()): string {
  return profileProviderCacheKey(`provider-sync:${provider}`, provider, profileId)
}

function providerScheduleKey(provider: SyncProvider, profileId = getActiveProfileId()): string {
  return `${profileId}:${provider}`
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
    const key = providerScheduleKey(provider)
    // SIMKL's sync guide forbids unconditional background polling. Its v2
    // connection is refreshed by the explicit sync button and active app
    // lifecycle events below, where the activity endpoint cheaply gates work.
    if (provider === 'simkl' && !recovery) continue
    const frequency = FREQ_MS[providerFrequency(provider)]
    if (!frequency) continue
    const last = lastRunAt.get(key) ?? now
    if (!lastRunAt.has(key)) lastRunAt.set(key, now)
    const minimumInterval = provider === 'simkl' ? Math.max(frequency, 15 * 60_000) : frequency
    if (now - last < minimumInterval) continue
    if (recovery && now - (lastRecoveryAt.get(key) || 0) < 30_000) continue
    if (recovery) lastRecoveryAt.set(key, now)
    // Stamp before dispatch so repeated focus/online events coalesce while the
    // shared in-flight promise is active.
    lastRunAt.set(key, now)
    void syncProviderNow(provider)
  }
}

export function startProviderSyncScheduler(): void {
  stopProviderSyncScheduler()
  const now = Date.now()
  for (const provider of PROVIDERS) if (providerConnected(provider)) lastRunAt.set(providerScheduleKey(provider), now)
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
      for (const provider of PROVIDERS) {
        const key = providerScheduleKey(provider)
        if (providerConnected(provider) && !lastRunAt.has(key)) lastRunAt.set(key, changedAt)
      }
    }
  })
}

function snapshot(): string {
  const s = useAppStore.getState()
  return [
    getActiveProfileId(),
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
