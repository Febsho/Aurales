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

function loadPersistedAddons(): InstalledAddon[] {
  try {
    const raw = localStorage.getItem('orynt_addons')
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

function persistAddons(addons: InstalledAddon[]): void {
  localStorage.setItem('orynt_addons', JSON.stringify(addons))
}

function loadPersistedHomeRows(): HomeRowConfig[] | null {
  try {
    const raw = localStorage.getItem('orynt_home_rows')
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return null
}

function persistHomeRows(rows: HomeRowConfig[]): void {
  localStorage.setItem('orynt_home_rows', JSON.stringify(rows))
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

  addons: loadPersistedAddons(),
  setAddons: (addons) => { persistAddons(addons); set({ addons }) },
  addAddon: (addon) => set((s) => {
    const next = [...s.addons, addon]
    persistAddons(next)
    return { addons: next }
  }),
  removeAddon: (addonId) => set((s) => {
    const next = s.addons.filter((a) => a.manifest.id !== addonId)
    persistAddons(next)
    return { addons: next }
  }),

  homeRows: loadPersistedHomeRows() || DEFAULT_HOME_ROWS,
  setHomeRows: (rows) => { persistHomeRows(rows); set({ homeRows: rows }) },
  addHomeRow: (row) => set((s) => {
    const next = [...s.homeRows, { ...row, id: uuid(), order: s.homeRows.length }]
    persistHomeRows(next)
    return { homeRows: next }
  }),
  removeHomeRow: (id) => set((s) => {
    const next = s.homeRows.filter((r) => r.id !== id)
    persistHomeRows(next)
    return { homeRows: next }
  }),
  updateHomeRow: (id, updates) => set((s) => {
    const next = s.homeRows.map((r) => r.id === id ? { ...r, ...updates } : r)
    persistHomeRows(next)
    return { homeRows: next }
  }),
  reorderHomeRows: (rows) => {
    const next = rows.map((r, i) => ({ ...r, order: i }))
    persistHomeRows(next)
    set({ homeRows: next })
  },
  resetHomeRows: () => { persistHomeRows(DEFAULT_HOME_ROWS); set({ homeRows: DEFAULT_HOME_ROWS }) },

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
