import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SearchResult } from '../types'
import type { RankedRecommendation } from '../services/discovery/types'
import { catalogContentFingerprint } from '../services/cache/homeStartupSnapshot'
import { retainDiscoverySnapshot } from '../services/cache/discoverySnapshot'

export type DiscoverTab = 'movies' | 'series' | 'anime'

const DISCOVERY_CACHE_STORAGE_KEY = 'aurales-discovery-generated-v1'
const MAX_DISCOVERY_STORAGE_BYTES = 1_500_000
const MAX_PERSISTED_RANKINGS = 6
const MAX_ITEMS_PER_RANKING = 40

// Discovery catalogs already have the SQLite catalog cache. localStorage is
// only a small startup fallback and must never be allowed to crash rendering
// when WebView's per-origin quota is full.
const resilientDiscoveryStorage = {
  getItem: (name: string) => {
    const value = localStorage.getItem(name)
    if (value && value.length > MAX_DISCOVERY_STORAGE_BYTES) {
      localStorage.removeItem(name)
      return null
    }
    return value
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value)
    } catch (error) {
      // Remove the oversized legacy snapshot first. Persistence is optional;
      // the live Zustand state and SQLite-backed catalogs keep working.
      localStorage.removeItem(name)
      try {
        localStorage.setItem(name, value)
      } catch {
        console.warn('[Discover] Startup snapshot skipped because browser storage is full', error)
      }
    }
  },
  removeItem: (name: string) => localStorage.removeItem(name),
}

function compactRankedSnapshots(snapshots: Record<string, RankedRecommendation[]>) {
  return Object.fromEntries(
    Object.entries(snapshots)
      .slice(-MAX_PERSISTED_RANKINGS)
      .map(([key, items]) => [key, items.slice(0, MAX_ITEMS_PER_RANKING)]),
  )
}

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
  storage: createJSONStorage(() => resilientDiscoveryStorage),
  partialize: (state) => ({
    // Rows are already cached in SQLite and were the main source of quota
    // exhaustion. Keep only a bounded set of final rankings for fast startup.
    cachedRows: {},
    rankedSnapshots: compactRankedSnapshots(state.rankedSnapshots),
  }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<DiscoverStore> | undefined
    const { cachedRows, rankedSnapshots } = retainDiscoverySnapshot(saved)
    return { ...current, cachedRows, rankedSnapshots }
  },
}))
