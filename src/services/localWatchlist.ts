import type { SearchResult } from '../types'
import { getActiveProfileId, profileStorageKey, PROFILE_CHANGED_EVENT } from './profiles'
import { enqueueSyncRecord } from './sync/syncQueue'
import { sameWatchlistItem, watchlistIdentity } from './watchlistIdentity'

const STORAGE_KEY = 'aurales_local_watchlist_v1'
type WatchlistIdentityInput = Pick<SearchResult, 'id' | 'type'> & Partial<Pick<SearchResult, 'provider' | 'watchlistIdentityProvider' | 'imdbId' | 'tmdbId' | 'tvdbId' | 'anilistId' | 'malId' | 'sourceAddonId' | 'sourceAddonItemId' | 'addonUrl' | 'sourceConnectionId' | 'sourceItemId'>>

export interface LocalWatchlistItem extends SearchResult {
  addedAt: number
}

let cachedProfileId: string | null = null
let cachedItems: LocalWatchlistItem[] | null = null
const EMPTY_ITEMS: LocalWatchlistItem[] = []
const listeners = new Set<() => void>()

export function localWatchlistKey(item: WatchlistIdentityInput): string {
  return watchlistIdentity(item) || `${item.type}:local:${item.id}`
}

function loadItems(requestedProfileId?: string): LocalWatchlistItem[] {
  if (typeof localStorage === 'undefined') return EMPTY_ITEMS
  const profileId = requestedProfileId || getActiveProfileId()
  if (cachedProfileId === profileId && cachedItems) return cachedItems
  try {
    const storageKey = profileStorageKey(STORAGE_KEY, profileId)
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]')
    cachedProfileId = profileId
    if (!Array.isArray(parsed)) return (cachedItems = [])
    cachedItems = parsed
      // Stremio's cloud library is a separate source. Older versions copied it
      // into this device-only list, so drop those imported records on load.
      .filter((item): item is LocalWatchlistItem => Boolean(item && item.provider !== 'stremio' && typeof item.id === 'string' && typeof item.title === 'string' && (item.type === 'movie' || item.type === 'series')))
      .sort((left, right) => (right.addedAt || 0) - (left.addedAt || 0))
    if (cachedItems.length !== parsed.length) {
      try { localStorage.setItem(storageKey, JSON.stringify(cachedItems)) } catch { /* keep the valid in-memory entries */ }
    }
    return cachedItems
  } catch {
    cachedProfileId = profileId
    return (cachedItems = [])
  }
}

function commit(items: LocalWatchlistItem[], profileId: string): void {
  cachedProfileId = profileId
  cachedItems = items
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(profileStorageKey(STORAGE_KEY, profileId), JSON.stringify(items)) }
    catch (error) { console.warn('[watchlist] could not persist local watchlist', error) }
  }
  listeners.forEach((listener) => listener())
}

export function getLocalWatchlist(): LocalWatchlistItem[] {
  return loadItems()
}

export function isInLocalWatchlist(item: WatchlistIdentityInput): boolean {
  return loadItems().some((entry) => sameWatchlistItem(entry, item))
}

export function addToLocalWatchlist(item: SearchResult): void {
  const profileId = getActiveProfileId()
  const key = localWatchlistKey(item)
  const next: LocalWatchlistItem = {
    ...item,
    provider: 'local',
    watchlistIdentityProvider: item.watchlistIdentityProvider || item.provider,
    addedAt: Date.now(),
  }
  commit([next, ...loadItems(profileId).filter((entry) => !sameWatchlistItem(entry, item))], profileId)
  enqueueSyncRecord('watchlist', key, { operation: 'add', item: next }, profileId)
}

export function removeFromLocalWatchlist(item: WatchlistIdentityInput): void {
  const profileId = getActiveProfileId()
  const key = localWatchlistKey(item)
  commit(loadItems(profileId).filter((entry) => !sameWatchlistItem(entry, item)), profileId)
  enqueueSyncRecord('watchlist', key, { operation: 'remove', media: item }, profileId)
}

export function toggleLocalWatchlist(item: SearchResult): boolean {
  if (isInLocalWatchlist(item)) {
    removeFromLocalWatchlist(item)
    return false
  }
  addToLocalWatchlist(item)
  return true
}

export function subscribeLocalWatchlist(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetLocalWatchlistCacheForTests(): void {
  cachedProfileId = null
  cachedItems = null
}

function invalidateCacheAndNotify(): void {
  cachedProfileId = null
  cachedItems = null
  listeners.forEach((listener) => listener())
}

if (typeof window !== 'undefined') {
  window.addEventListener(PROFILE_CHANGED_EVENT, invalidateCacheAndNotify)
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key?.startsWith(`${STORAGE_KEY}:profile:`)) invalidateCacheAndNotify()
  })
}
