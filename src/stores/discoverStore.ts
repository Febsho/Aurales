import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SearchResult } from '../types'
import type { RankedRecommendation } from '../services/discovery/types'
import { catalogContentFingerprint } from '../services/cache/homeStartupSnapshot'
import { retainDiscoverySnapshot } from '../services/cache/discoverySnapshot'
import type { DailySnapshotMeta } from '../services/discovery/dailySnapshot'

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
    try {
      const value = localStorage.getItem(name)
      if (value && value.length > MAX_DISCOVERY_STORAGE_BYTES) {
        try { localStorage.removeItem(name) } catch { /* startup data is optional */ }
        return null
      }
      return value
    } catch (error) {
      console.warn('[Discover] Startup snapshot could not be read', error)
      return null
    }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value)
    } catch (error) {
      // Remove the oversized legacy snapshot first. Persistence is optional;
      // the live Zustand state and SQLite-backed catalogs keep working.
      try { localStorage.removeItem(name) } catch { /* storage may be disabled */ }
      try {
        localStorage.setItem(name, value)
      } catch {
        console.warn('[Discover] Startup snapshot skipped because browser storage is full', error)
      }
    }
  },
  removeItem: (name: string) => {
    try { localStorage.removeItem(name) } catch (error) {
      console.warn('[Discover] Startup snapshot could not be removed', error)
    }
  },
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
  dailySnapshotMeta: Record<string, DailySnapshotMeta>

  setTab: (tab: DiscoverTab) => void
  setSelectedGenre: (genre: number | null) => void
  setGenreResults: (results: SearchResult[]) => void
  setGenreLoading: (loading: boolean) => void
  setActiveProvider: (provider: string | null) => void
  setCachedRow: (rowId: string, items: SearchResult[]) => void
  setRankedSnapshot: (key: string, ranked: RankedRecommendation[], metadata?: DailySnapshotMeta) => void
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
  dailySnapshotMeta: {},

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
  setRankedSnapshot: (key, ranked, metadata) =>
    set((state) => {
      const previous = state.rankedSnapshots[key]
      const sameRanking = Boolean(previous
        && catalogContentFingerprint(previous.map((entry) => entry.item)) === catalogContentFingerprint(ranked.map((entry) => entry.item)))
      const previousMeta = state.dailySnapshotMeta[key]
      const sameMetadata = !metadata || Boolean(previousMeta
        && previousMeta.dateKey === metadata.dateKey
        && previousMeta.generatedAt === metadata.generatedAt
        && previousMeta.profileFingerprint === metadata.profileFingerprint
        && previousMeta.algorithmVersion === metadata.algorithmVersion)
      if (sameRanking && sameMetadata) return state
      return {
        rankedSnapshots: sameRanking ? state.rankedSnapshots : { ...state.rankedSnapshots, [key]: ranked },
        dailySnapshotMeta: metadata && !sameMetadata ? { ...state.dailySnapshotMeta, [key]: metadata } : state.dailySnapshotMeta,
      }
    }),
  clearCache: () => set({ cachedRows: {}, rankedSnapshots: {}, dailySnapshotMeta: {} }),
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
    dailySnapshotMeta: Object.fromEntries(Object.entries(state.dailySnapshotMeta).filter(([key]) => key in state.rankedSnapshots).slice(-MAX_PERSISTED_RANKINGS)),
  }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<DiscoverStore> | undefined
    const { cachedRows, rankedSnapshots, dailySnapshotMeta } = retainDiscoverySnapshot(saved)
    return { ...current, cachedRows, rankedSnapshots, dailySnapshotMeta }
  },
}))
