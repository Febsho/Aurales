import { create } from 'zustand'
import type { HomeRowConfig, WatchProgress, SearchResult } from '../types'
import type { InstalledAddon } from '../services/addons'
import { v4 as uuid } from 'uuid'

interface AppState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void

  // Settings
  tmdbApiKey: string
  tvdbApiKey: string
  traktClientId: string
  traktClientSecret: string
  traktConnected: boolean
  setTmdbApiKey: (key: string) => void
  setTvdbApiKey: (key: string) => void
  setTraktClientId: (key: string) => void
  setTraktClientSecret: (key: string) => void
  setTraktConnected: (connected: boolean) => void

  // Addons
  addons: InstalledAddon[]
  setAddons: (addons: InstalledAddon[]) => void
  addAddon: (addon: InstalledAddon) => void
  removeAddon: (addonId: string) => void

  // Home layout
  homeRows: HomeRowConfig[]
  setHomeRows: (rows: HomeRowConfig[]) => void
  addHomeRow: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  removeHomeRow: (id: string) => void
  updateHomeRow: (id: string, updates: Partial<HomeRowConfig>) => void
  reorderHomeRows: (rows: HomeRowConfig[]) => void
  resetHomeRows: () => void

  // Watch progress
  watchProgress: Map<string, WatchProgress>
  setWatchProgress: (id: string, progress: WatchProgress) => void

  // Recently watched
  recentlyWatched: SearchResult[]
  addRecentlyWatched: (item: SearchResult) => void
}

const DEFAULT_HOME_ROWS: HomeRowConfig[] = [
  { id: 'hero-featured', title: 'Featured', layout: 'hero', enabled: true, order: 0 },
  { id: 'continue-watching', title: 'Continue Watching', layout: 'continue', enabled: true, order: 1 },
  { id: 'trending-movies', title: 'Trending Movies', addonId: 'com.example.mockaddon', catalogType: 'movie', catalogId: 'mock-movies', layout: 'poster', enabled: true, order: 2 },
  { id: 'popular-series', title: 'Popular Series', addonId: 'com.example.mockaddon', catalogType: 'series', catalogId: 'mock-series', layout: 'landscape', enabled: true, order: 3 },
]

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  tmdbApiKey: localStorage.getItem('tmdb_api_key') || '',
  tvdbApiKey: localStorage.getItem('tvdb_api_key') || '',
  traktClientId: localStorage.getItem('trakt_client_id') || '',
  traktClientSecret: localStorage.getItem('trakt_client_secret') || '',
  traktConnected: !!localStorage.getItem('trakt_tokens'),
  setTmdbApiKey: (key) => { localStorage.setItem('tmdb_api_key', key); set({ tmdbApiKey: key }) },
  setTvdbApiKey: (key) => { localStorage.setItem('tvdb_api_key', key); set({ tvdbApiKey: key }) },
  setTraktClientId: (key) => { localStorage.setItem('trakt_client_id', key); set({ traktClientId: key }) },
  setTraktClientSecret: (key) => { localStorage.setItem('trakt_client_secret', key); set({ traktClientSecret: key }) },
  setTraktConnected: (connected) => set({ traktConnected: connected }),

  addons: [],
  setAddons: (addons) => set({ addons }),
  addAddon: (addon) => set((s) => ({ addons: [...s.addons, addon] })),
  removeAddon: (addonId) => set((s) => ({ addons: s.addons.filter((a) => a.manifest.id !== addonId) })),

  homeRows: DEFAULT_HOME_ROWS,
  setHomeRows: (rows) => set({ homeRows: rows }),
  addHomeRow: (row) => set((s) => ({
    homeRows: [...s.homeRows, { ...row, id: uuid(), order: s.homeRows.length }],
  })),
  removeHomeRow: (id) => set((s) => ({
    homeRows: s.homeRows.filter((r) => r.id !== id),
  })),
  updateHomeRow: (id, updates) => set((s) => ({
    homeRows: s.homeRows.map((r) => r.id === id ? { ...r, ...updates } : r),
  })),
  reorderHomeRows: (rows) => set({ homeRows: rows.map((r, i) => ({ ...r, order: i })) }),
  resetHomeRows: () => set({ homeRows: DEFAULT_HOME_ROWS }),

  watchProgress: new Map(),
  setWatchProgress: (id, progress) => set((s) => {
    const map = new Map(s.watchProgress)
    map.set(id, progress)
    return { watchProgress: map }
  }),

  recentlyWatched: [],
  addRecentlyWatched: (item) => set((s) => ({
    recentlyWatched: [item, ...s.recentlyWatched.filter((r) => r.id !== item.id)].slice(0, 20),
  })),
}))
