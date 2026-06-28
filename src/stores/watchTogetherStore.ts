import { create } from 'zustand'
import type {
  WatchRoom,
  RoomParticipant,
  RoomChatMessage,
  RoomPlaybackState,
  RoomMedia,
  RoomEpisode,
  RoomStream,
} from '../services/watch-together/types'
import type { StreamResult } from '../types'

// ── localStorage helpers ────────────────────────────────────────────────────

const LS_PREFIX = 'aurales_wt_'

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key)
    return raw !== null ? JSON.parse(raw) : fallback
  } catch (_) {
    return fallback
  }
}

function lsSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value))
  } catch (_) {
    // quota exceeded — silently ignore
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

interface DebugLogEntry {
  timestamp: number
  direction: 'in' | 'out'
  event: string
  data?: any
}

export interface WatchTogetherState {
  // Room
  currentRoom: WatchRoom | null
  currentUserId: string | null
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
  roomPanelOpen: boolean

  // Local state
  selectedLocalStream: { stream: StreamResult; addonId: string; addonName: string } | null
  isHost: boolean
  errors: string[]
  debugLog: DebugLogEntry[]

  // Settings (persisted)
  serverUrl: string
  defaultNickname: string
  defaultControlMode: 'host_only' | 'everyone'
  requireReadyCheck: boolean
  showChat: boolean
  autoCopyInvite: boolean
  driftThreshold: number
  syncInterval: number
  allowGuestDifferentStream: boolean

  // Actions
  setCurrentRoom: (room: WatchRoom | null) => void
  setCurrentUserId: (id: string | null) => void
  setConnectionStatus: (status: WatchTogetherState['connectionStatus']) => void
  setRoomPanelOpen: (open: boolean) => void
  toggleRoomPanel: () => void
  setSelectedLocalStream: (stream: WatchTogetherState['selectedLocalStream']) => void
  setIsHost: (host: boolean) => void
  addError: (error: string) => void
  clearErrors: () => void
  addDebugLog: (entry: DebugLogEntry) => void
  clearDebugLog: () => void

  // Settings actions
  setServerUrl: (url: string) => void
  setDefaultNickname: (name: string) => void
  setDefaultControlMode: (mode: 'host_only' | 'everyone') => void
  setRequireReadyCheck: (val: boolean) => void
  setShowChat: (val: boolean) => void
  setAutoCopyInvite: (val: boolean) => void
  setDriftThreshold: (val: number) => void
  setSyncInterval: (val: number) => void
  setAllowGuestDifferentStream: (val: boolean) => void

  // Convenience
  updateParticipant: (participant: RoomParticipant) => void
  removeParticipant: (userId: string) => void
  addChatMessage: (message: RoomChatMessage) => void
  updatePlayback: (playback: RoomPlaybackState) => void
  updateMedia: (media?: RoomMedia, episode?: RoomEpisode, stream?: RoomStream) => void
}

// ── Store ───────────────────────────────────────────────────────────────────

const MAX_DEBUG_LOG = 200

export const useWatchTogetherStore = create<WatchTogetherState>((set, get) => ({
  // Room
  currentRoom: null,
  currentUserId: null,
  connectionStatus: 'disconnected',
  roomPanelOpen: false,

  // Local state
  selectedLocalStream: null,
  isHost: false,
  errors: [],
  debugLog: [],

  // Settings (loaded from localStorage)
  serverUrl: lsGet('serverUrl', 'wss://aurales.febsho.me/ws'),
  defaultNickname: lsGet('defaultNickname', ''),
  defaultControlMode: lsGet<'host_only' | 'everyone'>('defaultControlMode', 'host_only'),
  requireReadyCheck: lsGet('requireReadyCheck', true),
  showChat: lsGet('showChat', true),
  autoCopyInvite: lsGet('autoCopyInvite', true),
  driftThreshold: lsGet('driftThreshold', 2),
  syncInterval: lsGet('syncInterval', 5),
  allowGuestDifferentStream: lsGet('allowGuestDifferentStream', false),

  // Actions
  setCurrentRoom: (room) => set({ currentRoom: room }),
  setCurrentUserId: (id) => set({ currentUserId: id }),
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setRoomPanelOpen: (open) => set({ roomPanelOpen: open }),
  toggleRoomPanel: () => set((s) => ({ roomPanelOpen: !s.roomPanelOpen })),
  setSelectedLocalStream: (stream) => set({ selectedLocalStream: stream }),
  setIsHost: (host) => set({ isHost: host }),

  addError: (error) =>
    set((s) => ({ errors: [...s.errors, error] })),
  clearErrors: () => set({ errors: [] }),

  addDebugLog: (entry) =>
    set((s) => {
      const log = [...s.debugLog, entry]
      return { debugLog: log.length > MAX_DEBUG_LOG ? log.slice(-MAX_DEBUG_LOG) : log }
    }),
  clearDebugLog: () => set({ debugLog: [] }),

  // Settings actions (persist on change)
  setServerUrl: (url) => {
    lsSet('serverUrl', url)
    set({ serverUrl: url })
  },
  setDefaultNickname: (name) => {
    lsSet('defaultNickname', name)
    set({ defaultNickname: name })
  },
  setDefaultControlMode: (mode) => {
    lsSet('defaultControlMode', mode)
    set({ defaultControlMode: mode })
  },
  setRequireReadyCheck: (val) => {
    lsSet('requireReadyCheck', val)
    set({ requireReadyCheck: val })
  },
  setShowChat: (val) => {
    lsSet('showChat', val)
    set({ showChat: val })
  },
  setAutoCopyInvite: (val) => {
    lsSet('autoCopyInvite', val)
    set({ autoCopyInvite: val })
  },
  setDriftThreshold: (val) => {
    lsSet('driftThreshold', val)
    set({ driftThreshold: val })
  },
  setSyncInterval: (val) => {
    lsSet('syncInterval', val)
    set({ syncInterval: val })
  },
  setAllowGuestDifferentStream: (val) => {
    lsSet('allowGuestDifferentStream', val)
    set({ allowGuestDifferentStream: val })
  },

  // Convenience actions
  updateParticipant: (participant) =>
    set((s) => {
      if (!s.currentRoom) return s
      const idx = s.currentRoom.participants.findIndex((p) => p.id === participant.id)
      const participants =
        idx >= 0
          ? s.currentRoom.participants.map((p) => (p.id === participant.id ? participant : p))
          : [...s.currentRoom.participants, participant]
      return { currentRoom: { ...s.currentRoom, participants } }
    }),

  removeParticipant: (userId) =>
    set((s) => {
      if (!s.currentRoom) return s
      return {
        currentRoom: {
          ...s.currentRoom,
          participants: s.currentRoom.participants.filter((p) => p.id !== userId),
        },
      }
    }),

  addChatMessage: (message) =>
    set((s) => {
      if (!s.currentRoom) return s
      return {
        currentRoom: {
          ...s.currentRoom,
          chat: [...s.currentRoom.chat, message],
        },
      }
    }),

  updatePlayback: (playback) =>
    set((s) => {
      if (!s.currentRoom) return s
      return { currentRoom: { ...s.currentRoom, playback } }
    }),

  updateMedia: (media, episode, stream) =>
    set((s) => {
      if (!s.currentRoom) return s
      return {
        currentRoom: {
          ...s.currentRoom,
          selectedMedia: media ?? s.currentRoom.selectedMedia,
          selectedEpisode: episode ?? s.currentRoom.selectedEpisode,
          selectedStream: stream ?? s.currentRoom.selectedStream,
        },
      }
    }),
}))
