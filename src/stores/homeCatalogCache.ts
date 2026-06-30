import { create } from 'zustand'
import type { SearchResult } from '../types'

interface HomeCatalogCache {
  rows: Record<string, { items: SearchResult[]; timestamp: number }>
  set: (key: string, items: SearchResult[]) => void
  get: (key: string, ttlMs?: number) => SearchResult[] | null
  clear: () => void
}

const DEFAULT_TTL = 10 * 60 * 1000

export const useHomeCatalogCache = create<HomeCatalogCache>((set, get) => ({
  rows: {},
  set: (key, items) =>
    set((state) => ({
      rows: { ...state.rows, [key]: { items, timestamp: Date.now() } },
    })),
  get: (key, ttlMs = DEFAULT_TTL) => {
    const entry = get().rows[key]
    if (!entry) return null
    if (Date.now() - entry.timestamp > ttlMs) return null
    return entry.items
  },
  clear: () => set({ rows: {} }),
}))
