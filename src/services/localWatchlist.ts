import type { SearchResult } from '../types'

const STORAGE_KEY = 'aurales_local_watchlist_v1'

export interface LocalWatchlistItem extends SearchResult {
  addedAt: number
}

let cachedItems: LocalWatchlistItem[] | null = null
const listeners = new Set<() => void>()

export function localWatchlistKey(item: Pick<SearchResult, 'id' | 'type' | 'imdbId' | 'tmdbId'>): string {
  if (item.tmdbId != null) return `${item.type}:tmdb:${item.tmdbId}`
  if (item.imdbId) return `${item.type}:imdb:${item.imdbId}`
  return `${item.type}:local:${item.id}`
}

function loadItems(): LocalWatchlistItem[] {
  if (cachedItems) return cachedItems
  if (typeof localStorage === 'undefined') return (cachedItems = [])
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return (cachedItems = [])
    cachedItems = parsed
      // Stremio's cloud library is a separate source. Older versions copied it
      // into this device-only list, so drop those imported records on load.
      .filter((item): item is LocalWatchlistItem => Boolean(item && item.provider !== 'stremio' && typeof item.id === 'string' && typeof item.title === 'string' && (item.type === 'movie' || item.type === 'series')))
      .sort((left, right) => (right.addedAt || 0) - (left.addedAt || 0))
    if (cachedItems.length !== parsed.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedItems))
    return cachedItems
  } catch {
    return (cachedItems = [])
  }
}

function commit(items: LocalWatchlistItem[]): void {
  cachedItems = items
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  listeners.forEach((listener) => listener())
}

export function getLocalWatchlist(): LocalWatchlistItem[] {
  return loadItems()
}

export function isInLocalWatchlist(item: Pick<SearchResult, 'id' | 'type' | 'imdbId' | 'tmdbId'>): boolean {
  const key = localWatchlistKey(item)
  return loadItems().some((entry) => localWatchlistKey(entry) === key)
}

export function addToLocalWatchlist(item: SearchResult): void {
  const key = localWatchlistKey(item)
  const next: LocalWatchlistItem = { ...item, provider: 'local', addedAt: Date.now() }
  commit([next, ...loadItems().filter((entry) => localWatchlistKey(entry) !== key)])
}

export function removeFromLocalWatchlist(item: Pick<SearchResult, 'id' | 'type' | 'imdbId' | 'tmdbId'>): void {
  const key = localWatchlistKey(item)
  commit(loadItems().filter((entry) => localWatchlistKey(entry) !== key))
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
  cachedItems = null
}
