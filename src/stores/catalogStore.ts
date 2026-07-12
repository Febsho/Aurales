import { create } from 'zustand'
import type { SearchResult } from '../types'

interface CatalogCache {
  items: SearchResult[]
  page: number
  hasMore: boolean
  scrollTop: number
  timestamp: number
}

interface CatalogStore {
  cache: Record<string, CatalogCache>
  setCache: (rowId: string, data: Omit<CatalogCache, 'timestamp'>) => void
  getCache: (rowId: string) => CatalogCache | undefined
  clearRowCache: (rowId: string) => void
  clearCache: () => void
}

const CACHE_TTL = 10 * 60 * 1000

export const useCatalogStore = create<CatalogStore>((set, get) => ({
  cache: {},
  setCache: (rowId, data) =>
    set((state) => ({
      cache: {
        ...state.cache,
        [rowId]: { ...data, timestamp: Date.now() },
      },
    })),
  getCache: (rowId) => {
    const entry = get().cache[rowId]
    if (!entry) return undefined
    if (Date.now() - entry.timestamp > CACHE_TTL) return undefined
    return entry
  },
  clearRowCache: (rowId) =>
    set((state) => {
      const cache = { ...state.cache }
      delete cache[rowId]
      return { cache }
    }),
  clearCache: () => set({ cache: {} }),
}))
