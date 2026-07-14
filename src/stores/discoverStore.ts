import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SearchResult } from '../types'
import type { RankedRecommendation } from '../services/discovery/types'
import { catalogContentFingerprint } from '../services/cache/homeStartupSnapshot'
import { retainDiscoverySnapshot } from '../services/cache/discoverySnapshot'

export type DiscoverTab = 'movies' | 'series' | 'anime'

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
    set((state) => {
      const previous = state.cachedRows[rowId]
      if (previous && catalogContentFingerprint(previous.items) === catalogContentFingerprint(items)) return state
      return { cachedRows: { ...state.cachedRows, [rowId]: { items, timestamp: Date.now() } } }
    }),
  setRankedSnapshot: (key, ranked) =>
    set((state) => {
      const previous = state.rankedSnapshots[key]
      if (previous && catalogContentFingerprint(previous.map((entry) => entry.item)) === catalogContentFingerprint(ranked.map((entry) => entry.item))) return state
      return { rankedSnapshots: { ...state.rankedSnapshots, [key]: ranked } }
    }),
  clearCache: () => set({ cachedRows: {}, rankedSnapshots: {} }),
}), {
  name: DISCOVERY_CACHE_STORAGE_KEY,
  version: 2,
  migrate: (persisted) => persisted as DiscoverStore,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    cachedRows: state.cachedRows,
    rankedSnapshots: state.rankedSnapshots,
  }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<DiscoverStore> | undefined
    const { cachedRows, rankedSnapshots } = retainDiscoverySnapshot(saved)
    return { ...current, cachedRows, rankedSnapshots }
  },
}))
