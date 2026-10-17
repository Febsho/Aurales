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
const MAX_SESSION_ROWS = 160

function rememberRows(
  current: HomeCatalogCache['rows'],
  entries: Record<string, SearchResult[]>,
): HomeCatalogCache['rows'] {
  const next = { ...current }
  const now = Date.now()
  for (const [key, items] of Object.entries(entries)) {
    // Reinsert so recently refreshed shelves remain at the retained end.
    delete next[key]
    next[key] = { items, timestamp: now }
  }
  const keys = Object.keys(next)
  for (let index = 0; index < keys.length - MAX_SESSION_ROWS; index += 1) delete next[keys[index]]
  return next
}

export const useHomeCatalogCache = create<HomeCatalogCache>((set, get) => ({
  rows: {},
  set: (key, items) =>
    set((state) => ({
      rows: rememberRows(state.rows, { [key]: items }),
    })),
  setMany: (entries) =>
    set((state) => ({ rows: rememberRows(state.rows, entries) })),
  get: (key, ttlMs = DEFAULT_TTL) => {
    const entry = get().rows[key]
    if (!entry) return null
    if (Date.now() - entry.timestamp > ttlMs) return null
    return entry.items
  },
  clear: () => set({ rows: {} }),
}))
