import { create } from 'zustand'
import type { SearchResult } from '../types'

export type DiscoverTab = 'movies' | 'series' | 'anime'

interface DiscoverStore {
  tab: DiscoverTab
  selectedGenre: number | null
  genreResults: SearchResult[]
  genreLoading: boolean
  activeProvider: string | null
  cachedRows: Record<string, { items: SearchResult[]; timestamp: number }>
  
  setTab: (tab: DiscoverTab) => void
  setSelectedGenre: (genre: number | null) => void
  setGenreResults: (results: SearchResult[]) => void
  setGenreLoading: (loading: boolean) => void
  setActiveProvider: (provider: string | null) => void
  setCachedRow: (rowId: string, items: SearchResult[]) => void
  clearCache: () => void
}

export const useDiscoverStore = create<DiscoverStore>((set) => ({
  tab: 'movies',
  selectedGenre: null,
  genreResults: [],
  genreLoading: false,
  activeProvider: null,
  cachedRows: {},

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
  clearCache: () => set({ cachedRows: {} }),
}))
