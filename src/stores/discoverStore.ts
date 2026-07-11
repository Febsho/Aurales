import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SearchResult } from '../types'
import type { RankedRecommendation } from '../services/discovery/types'

export type DiscoverTab = 'movies' | 'series' | 'anime'

const DISCOVERY_CACHE_TTL = 24 * 60 * 60 * 1000
const DISCOVERY_CACHE_STORAGE_KEY = 'aurales-discovery-generated-v1'

interface DiscoverStore {
  tab: DiscoverTab
  selectedGenre: number | null
  genreResults: SearchResult[]
  genreLoading: boolean
  activeProvider: string | null
  cachedRows: Record<string, { items: SearchResult[]; timestamp: number }>
  // Frozen ranking per day/tab/mode so navigating away and back shows the same
  // order instead of reshuffling on every visit
  rankedSnapshots: Record<string, RankedRecommendation[]>

  setTab: (tab: DiscoverTab) => void
  setSelectedGenre: (genre: number | null) => void
  setGenreResults: (results: SearchResult[]) => void
  setGenreLoading: (loading: boolean) => void
  setActiveProvider: (provider: string | null) => void
  setCachedRow: (rowId: string, items: SearchResult[]) => void
  setRankedSnapshot: (key: string, ranked: RankedRecommendation[]) => void
  clearCache: () => void
}

export const useDiscoverStore = create<DiscoverStore>()(persist((set) => ({
  tab: 'movies',
  selectedGenre: null,
  genreResults: [],
  genreLoading: false,
  activeProvider: null,
  cachedRows: {},
  rankedSnapshots: {},

  setTab: (tab) => set({ tab, activeProvider: null }),
  setSelectedGenre: (selectedGenre) => set({ selectedGenre }),
  setGenreResults: (genreResults) => set({ genreResults }),
  setGenreLoading: (genreLoading) => set({ genreLoading }),
  setActiveProvider: (activeProvider) => set({ activeProvider }),
  setCachedRow: (rowId, items) =>
    set((state) => ({
      cachedRows: {
        ...state.cachedRows,
        [rowId]: { items, timestamp: Date.now() },
      },
    })),
  setRankedSnapshot: (key, ranked) =>
    set((state) => ({ rankedSnapshots: { ...state.rankedSnapshots, [key]: ranked } })),
  clearCache: () => set({ cachedRows: {}, rankedSnapshots: {} }),
}), {
  name: DISCOVERY_CACHE_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    cachedRows: state.cachedRows,
    rankedSnapshots: state.rankedSnapshots,
  }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<DiscoverStore> | undefined
    const now = Date.now()
    const currentDay = Math.floor(now / DISCOVERY_CACHE_TTL)
    const cachedRows = Object.fromEntries(
      Object.entries(saved?.cachedRows || {}).filter(([, row]) =>
        row.timestamp > 0 && now - row.timestamp < DISCOVERY_CACHE_TTL
      ),
    )
    const rankedSnapshots = Object.fromEntries(
      Object.entries(saved?.rankedSnapshots || {}).filter(([key]) =>
        key.startsWith(`${currentDay}:`)
      ),
    )
    return { ...current, cachedRows, rankedSnapshots }
  },
}))
