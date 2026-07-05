import { create } from 'zustand'
import type { SearchResult } from '../types'

interface HomeCatalogCache {
  rows: Record<string, { items: SearchResult[]; timestamp: number }>
  set: (key: string, items: SearchResult[]) => void
  setMany: (entries: Record<string, SearchResult[]>) => void
  get: (key: string, ttlMs?: number) => SearchResult[] | null
  clear: () => void
}

const DEFAULT_TTL = Infinity

export const useHomeCatalogCache = create<HomeCatalogCache>((set, get) => ({
  rows: {},
  set: (key, items) =>
    set((state) => ({
      rows: { ...state.rows, [key]: { items, timestamp: Date.now() } },
    })),
  setMany: (entries) =>
    set((state) => {
      const now = Date.now()
      const next = { ...state.rows }
      for (const [key, items] of Object.entries(entries)) {
        next[key] = { items, timestamp: now }
      }
      return { rows: next }
    }),
  get: (key, ttlMs = DEFAULT_TTL) => {
    const entry = get().rows[key]
    if (!entry) return null
    if (Date.now() - entry.timestamp > ttlMs) return null
    return entry.items
  },
  clear: () => set({ rows: {} }),
}))
