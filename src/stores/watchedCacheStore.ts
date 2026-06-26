import { create } from 'zustand'

export type WatchedKey = string

interface WatchedCacheStore {
  watchedKeys: Set<WatchedKey>
  loading: boolean
  lastRefresh: number
  setWatchedKeys: (keys: Set<WatchedKey>) => void
  addWatchedKeys: (keys: Iterable<WatchedKey>) => void
  removeWatchedKeys: (keys: Iterable<WatchedKey>) => void
  setLoading: (loading: boolean) => void
  isWatched: (ids: WatchedIdInput) => boolean
}

export interface WatchedIdInput {
  id?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
}

function keysForItem(ids: WatchedIdInput): string[] {
  const out: string[] = []
  if (ids.imdbId) out.push(`imdb:${ids.imdbId}`)
  if (ids.tmdbId) out.push(`tmdb:${ids.tmdbId}`)
  if (ids.tvdbId) out.push(`tvdb:${String(ids.tvdbId).replace('tvdb-', '')}`)
  if (ids.malId) out.push(`mal:${ids.malId}`)
  if (ids.anilistId) out.push(`anilist:${ids.anilistId}`)
  if (ids.id) out.push(`id:${ids.id}`)
  return out
}

export function makeWatchedKey(prefix: string, value: string | number): WatchedKey {
  return `${prefix}:${value}`
}

export const useWatchedCacheStore = create<WatchedCacheStore>((set, get) => ({
  watchedKeys: new Set(),
  loading: false,
  lastRefresh: 0,
  setWatchedKeys: (keys) => set({ watchedKeys: keys, lastRefresh: Date.now() }),
  addWatchedKeys: (keys) => set((s) => {
    const next = new Set(s.watchedKeys)
    for (const k of keys) next.add(k)
    return { watchedKeys: next }
  }),
  removeWatchedKeys: (keys) => set((s) => {
    const next = new Set(s.watchedKeys)
    for (const k of keys) next.delete(k)
    return { watchedKeys: next }
  }),
  setLoading: (loading) => set({ loading }),
  isWatched: (ids) => {
    const keys = keysForItem(ids)
    const store = get().watchedKeys
    return keys.some((k) => store.has(k))
  },
}))
