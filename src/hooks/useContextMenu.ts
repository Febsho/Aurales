import { create } from 'zustand'
import type { SearchResult, EpisodeDetails } from '../types'

export type ContextMenuTarget =
  | { kind: 'media'; item: SearchResult }
  | { kind: 'episode'; item: SearchResult; episode: EpisodeDetails; seasonNumber: number; showImdbId?: string; appSeasonCounts?: { season: number; count: number }[] }
  | { kind: 'season'; item: SearchResult; seasonNumber: number; episodeCount: number; showImdbId?: string; appSeasonCounts?: { season: number; count: number }[] }

export type ProviderKey = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist'

export interface ProviderWatchState {
  provider: ProviderKey
  connected: boolean
  watched: boolean
  loading: boolean
}

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  target: ContextMenuTarget | null
  show: (x: number, y: number, target: ContextMenuTarget) => void
  close: () => void
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  target: null,
  show: (x, y, target) => set({ open: true, x, y, target }),
  close: () => set({ open: false, target: null }),
}))
