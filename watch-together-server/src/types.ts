import type { WebSocket } from 'ws'

// ── Room types ─────────────────────────────────────────────────────────────

export interface WatchRoom {
  id: string
  code: string
  hostUserId: string
  title?: string

  selectedMedia?: RoomMedia
  selectedEpisode?: RoomEpisode
  selectedStream?: RoomStream

  playback: RoomPlaybackState
  participants: RoomParticipant[]
  chat: RoomChatMessage[]

  everyoneCanControl: boolean
  requireReadyCheck: boolean
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

export interface RoomMedia {
  localMediaId?: string
  type: 'movie' | 'show' | 'anime'
  title: string
  year?: number
  poster?: string
  backdrop?: string
  overview?: string
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  anilistId?: number
  simklId?: number
  traktId?: number
  sourceAddonId?: string
  sourceAddonItemId?: string
}

export interface RoomEpisode {
  localEpisodeId?: string
  seasonNumber: number
  episodeNumber: number
  absoluteEpisodeNumber?: number
  title?: string
  overview?: string
  still?: string
  tvdbEpisodeId?: number
  tmdbEpisodeId?: number
}

export interface RoomStream {
  streamId?: string
  addonId?: string
  name?: string
  title?: string
  quality?: string
  infoHash?: string
  fileIdx?: number
  streamFingerprint?: string
}

export type PlaybackStatus =
  | 'idle'
  | 'selecting'
  | 'waiting_for_ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'stopped'
  | 'ended'

export interface RoomPlaybackState {
  status: PlaybackStatus
  currentTime: number
  duration?: number
  isPlaying: boolean
  lastUpdatedAt: number
  startedAt?: number
  lastActionBy?: string
}

export type ParticipantStatus =
  | 'connected'
  | 'disconnected'
  | 'watching'
  | 'buffering'
  | 'choosing_stream'

export interface RoomParticipant {
  id: string
  name: string
  avatar?: string
  isHost: boolean
  isReady: boolean
  hasSelectedStream: boolean
  hasMediaAvailable: boolean
  playbackTime?: number
  latencyMs?: number
  status: ParticipantStatus
  joinedAt: string
  lastSeenAt: string
}

export interface RoomChatMessage {
  id: string
  userId: string
  userName: string
  message: string
  sentAt: number
}

export interface DrawStroke {
  id: string
  points: { x: number; y: number }[]
  color: string
  width: number
}

// ── Client → Server events ─────────────────────────────────────────────────

export interface RoomSettings {
  everyoneCanControl?: boolean
  requireReadyCheck?: boolean
}

export type ClientEvent =
  | { type: 'ROOM_JOIN'; roomCode: string; name: string; clientId?: string; roomSettings?: RoomSettings }
  | { type: 'ROOM_LEAVE'; roomId: string; userId: string }
  | { type: 'READY'; roomId: string; userId: string; ready: boolean }
  | { type: 'MEDIA_SELECTED'; roomId: string; senderUserId: string; media: RoomMedia; episode?: RoomEpisode; stream?: RoomStream; sentAt: number }
  | { type: 'STREAM_SELECTED'; roomId: string; senderUserId: string; stream: RoomStream; sentAt: number }
  | { type: 'PLAY'; roomId: string; senderUserId: string; time: number; sentAt: number }
  | { type: 'PAUSE'; roomId: string; senderUserId: string; time: number; sentAt: number }
  | { type: 'SEEK'; roomId: string; senderUserId: string; time: number; sentAt: number }
  | { type: 'STOP'; roomId: string; senderUserId: string; sentAt: number }
  | { type: 'SYNC_STATE'; roomId: string; senderUserId: string; time: number; isPlaying: boolean; sentAt: number }
  | { type: 'BUFFERING'; roomId: string; senderUserId: string; buffering: boolean; time: number; sentAt: number }
  | { type: 'CHAT_MESSAGE'; roomId: string; userId: string; message: string; sentAt: number }
  | { type: 'DRAW_STROKE'; roomId: string; senderUserId: string; stroke: DrawStroke; sentAt: number }
  | { type: 'DRAW_CLEAR'; roomId: string; senderUserId: string; sentAt: number }
  | { type: 'TRANSFER_HOST'; roomId: string; senderUserId: string; newHostUserId: string }
  | { type: 'ROOM_SETTINGS'; roomId: string; senderUserId: string; settings: RoomSettings }
  | { type: 'PING'; sentAt: number }

// ── Server → Client events ─────────────────────────────────────────────────

export type ServerEvent =
  | { type: 'ROOM_CREATED'; room: WatchRoom; userId: string }
  | { type: 'ROOM_JOINED'; room: WatchRoom; userId: string }
  | { type: 'ROOM_STATE'; room: WatchRoom }
  | { type: 'PARTICIPANT_JOINED'; participant: RoomParticipant }
  | { type: 'PARTICIPANT_LEFT'; userId: string }
  | { type: 'PARTICIPANT_UPDATED'; participant: RoomParticipant }
  | { type: 'MEDIA_UPDATED'; media?: RoomMedia; episode?: RoomEpisode; stream?: RoomStream }
  | { type: 'PLAYBACK_UPDATED'; playback: RoomPlaybackState }
  | { type: 'CHAT_RECEIVED'; message: RoomChatMessage }
  | { type: 'DRAW_RECEIVED'; stroke: DrawStroke; senderUserId: string; senderName: string }
  | { type: 'DRAW_CLEARED'; senderUserId: string }
  | { type: 'HOST_TRANSFERRED'; newHostUserId: string }
  | { type: 'SYNC_REQUEST'; time: number; isPlaying: boolean; sentAt: number }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'PONG'; serverTime: number }

// ── Connection tracking ────────────────────────────────────────────────────

export interface ConnectedClient {
  ws: WebSocket
  userId: string
  roomId: string | null
  clientId?: string
  ip: string
  connectedAt: number
  lastPingAt: number
}

// ── Config ─────────────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number
  publicUrl: string
  wsPath: string
  roomEmptyTtl: number
  roomInactiveTtl: number
  reconnectGrace: number
  corsOrigin: string
  trustProxy: boolean
  maxParticipants: number
  maxChatLength: number
  rateLimitRoomsPerMinute: number
  rateLimitMessagesPerMinute: number
}
