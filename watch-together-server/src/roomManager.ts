import { randomUUID } from 'crypto'
import type {
  WatchRoom,
  RoomParticipant,
  RoomChatMessage,
  RoomPlaybackState,
  RoomMedia,
  RoomEpisode,
  RoomStream,
  RoomSettings,
  ServerConfig,
} from './types.js'

const rooms = new Map<string, WatchRoom>()
const codeToId = new Map<string, string>()

// Disconnected users kept for reconnect grace period
const disconnectedUsers = new Map<string, { roomId: string; participant: RoomParticipant; disconnectedAt: number }>()

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const part = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  let code: string
  do {
    code = `${part(4)}-${part(4)}`
  } while (codeToId.has(code))
  return code
}

function sanitize(str: string, maxLen: number): string {
  return str.replace(/[<>&"']/g, '').trim().slice(0, maxLen)
}

function now(): string {
  return new Date().toISOString()
}

// ── Create ─────────────────────────────────────────────────────────────────

export function createRoom(hostName: string, config: ServerConfig, settings?: RoomSettings): { room: WatchRoom; userId: string } {
  const id = randomUUID()
  const code = generateCode()
  const userId = randomUUID()
  const ts = now()

  const host: RoomParticipant = {
    id: userId,
    name: sanitize(hostName, 32) || 'Host',
    isHost: true,
    isReady: true,
    hasSelectedStream: false,
    hasMediaAvailable: false,
    status: 'connected',
    joinedAt: ts,
    lastSeenAt: ts,
  }

  const room: WatchRoom = {
    id,
    code,
    hostUserId: userId,
    playback: {
      status: 'idle',
      currentTime: 0,
      isPlaying: false,
      lastUpdatedAt: Date.now(),
    },
    participants: [host],
    chat: [],
    everyoneCanControl: settings?.everyoneCanControl ?? false,
    requireReadyCheck: settings?.requireReadyCheck ?? true,
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
  }

  rooms.set(id, room)
  codeToId.set(code, id)
  log('ROOM_CREATED', `id=${id} code=${code} host=${hostName}`)
  return { room, userId }
}

// ── Join ──────────────────────────────────────────────────────────────────

export function joinRoom(
  roomCode: string,
  name: string,
  clientId: string | undefined,
  config: ServerConfig,
): { room: WatchRoom; userId: string; isReconnect: boolean } | { error: string; code: string } {
  const roomId = codeToId.get(roomCode.toUpperCase())
  if (!roomId) {
    // Also try matching by room ID directly (for reconnects)
    const directRoom = rooms.get(roomCode)
    if (!directRoom) return { error: 'Room not found', code: 'ROOM_NOT_FOUND' }
    return joinRoomById(directRoom, name, clientId, config)
  }

  const room = rooms.get(roomId)
  if (!room) {
    codeToId.delete(roomCode.toUpperCase())
    return { error: 'Room not found', code: 'ROOM_NOT_FOUND' }
  }

  return joinRoomById(room, name, clientId, config)
}

function joinRoomById(
  room: WatchRoom,
  name: string,
  clientId: string | undefined,
  config: ServerConfig,
): { room: WatchRoom; userId: string; isReconnect: boolean } | { error: string; code: string } {
  // Check for reconnect via clientId
  if (clientId) {
    const disc = disconnectedUsers.get(clientId)
    if (disc && disc.roomId === room.id) {
      disconnectedUsers.delete(clientId)
      const participant = disc.participant
      participant.status = 'connected'
      participant.lastSeenAt = now()
      participant.name = sanitize(name, 32) || participant.name

      const idx = room.participants.findIndex(p => p.id === participant.id)
      if (idx >= 0) {
        room.participants[idx] = participant
      } else {
        room.participants.push(participant)
      }
      room.lastActivityAt = now()
      log('RECONNECT', `user=${participant.id} room=${room.code}`)
      return { room, userId: participant.id, isReconnect: true }
    }
  }

  // Check existing connected participant with same clientId
  if (clientId) {
    const existing = room.participants.find(p => p.id === clientId && p.status === 'connected')
    if (existing) {
      room.lastActivityAt = now()
      return { room, userId: existing.id, isReconnect: true }
    }
  }

  const connectedCount = room.participants.filter(p => p.status !== 'disconnected').length
  if (connectedCount >= config.maxParticipants) {
    return { error: 'Room is full', code: 'ROOM_FULL' }
  }

  const userId = randomUUID()
  const ts = now()
  const participant: RoomParticipant = {
    id: userId,
    name: sanitize(name, 32) || 'Guest',
    isHost: false,
    isReady: false,
    hasSelectedStream: false,
    hasMediaAvailable: false,
    status: 'connected',
    joinedAt: ts,
    lastSeenAt: ts,
  }

  room.participants.push(participant)
  room.lastActivityAt = now()
  log('JOIN', `user=${userId} name=${name} room=${room.code}`)
  return { room, userId, isReconnect: false }
}

// ── Leave ─────────────────────────────────────────────────────────────────

export function leaveRoom(roomId: string, userId: string): WatchRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null

  room.participants = room.participants.filter(p => p.id !== userId)
  room.lastActivityAt = now()

  // Transfer host if the host left
  if (room.hostUserId === userId && room.participants.length > 0) {
    const newHost = room.participants.find(p => p.status === 'connected') ?? room.participants[0]
    room.hostUserId = newHost.id
    newHost.isHost = true
  }

  log('LEAVE', `user=${userId} room=${room.code} remaining=${room.participants.length}`)

  if (room.participants.length === 0) {
    // Don't delete immediately — give reconnect grace
    // The cleanup timer will handle it
  }

  return room
}

export function markDisconnected(roomId: string, userId: string, config: ServerConfig): WatchRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null

  const participant = room.participants.find(p => p.id === userId)
  if (!participant) return null

  participant.status = 'disconnected'
  participant.lastSeenAt = now()

  disconnectedUsers.set(userId, {
    roomId,
    participant: { ...participant },
    disconnectedAt: Date.now(),
  })

  log('DISCONNECT', `user=${userId} room=${room.code} (grace=${config.reconnectGrace}s)`)
  return room
}

// ── Permission helpers ─────────────────────────────────────────────────────

export function canControlPlayback(room: WatchRoom, senderUserId: string): boolean {
  return room.hostUserId === senderUserId || room.everyoneCanControl
}

export function canChangeMedia(room: WatchRoom, senderUserId: string): boolean {
  return room.hostUserId === senderUserId
}

export function isParticipant(room: WatchRoom, userId: string): boolean {
  return room.participants.some(p => p.id === userId)
}

// ── Media ─────────────────────────────────────────────────────────────────

export function updateMedia(
  roomId: string,
  media: RoomMedia,
  episode?: RoomEpisode,
  stream?: RoomStream,
): WatchRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  room.selectedMedia = media
  room.selectedEpisode = episode
  room.selectedStream = stream
  room.playback = {
    status: 'selecting',
    currentTime: 0,
    isPlaying: false,
    lastUpdatedAt: Date.now(),
  }
  // Reset all participant ready states
  for (const p of room.participants) {
    if (!p.isHost) {
      p.isReady = false
      p.hasSelectedStream = false
    }
  }
  room.lastActivityAt = now()
  room.updatedAt = now()
  log('MEDIA', `room=${room.code} title=${media.title}`)
  return room
}

export function updateStream(roomId: string, userId: string, stream: RoomStream): WatchRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const participant = room.participants.find(p => p.id === userId)
  if (participant) {
    participant.hasSelectedStream = true
    participant.status = 'connected'
    participant.lastSeenAt = now()
  }
  // The host's stream is the room's reference stream — guests match against it.
  if (room.hostUserId === userId) {
    room.selectedStream = stream
  }
  room.lastActivityAt = now()
  return room
}

export function updateRoomSettings(roomId: string, settings: RoomSettings): WatchRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  if (settings.everyoneCanControl != null) room.everyoneCanControl = settings.everyoneCanControl
  if (settings.requireReadyCheck != null) room.requireReadyCheck = settings.requireReadyCheck
  room.updatedAt = now()
  room.lastActivityAt = now()
  return room
}

export function setReady(roomId: string, userId: string, ready: boolean): RoomParticipant | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const participant = room.participants.find(p => p.id === userId)
  if (!participant) return null
  participant.isReady = ready
  participant.lastSeenAt = now()
  room.lastActivityAt = now()
  return participant
}

// ── Playback ──────────────────────────────────────────────────────────────

export function updatePlayback(roomId: string, playback: Partial<RoomPlaybackState>): RoomPlaybackState | null {
  const room = rooms.get(roomId)
  if (!room) return null
  Object.assign(room.playback, playback, { lastUpdatedAt: Date.now() })
  room.lastActivityAt = now()
  return room.playback
}

// ── Chat ──────────────────────────────────────────────────────────────────

export function addChatMessage(
  roomId: string,
  userId: string,
  message: string,
  maxLen: number,
): RoomChatMessage | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const participant = room.participants.find(p => p.id === userId)
  if (!participant) return null

  const chatMsg: RoomChatMessage = {
    id: randomUUID(),
    userId,
    userName: participant.name,
    message: sanitize(message, maxLen),
    sentAt: Date.now(),
  }
  room.chat.push(chatMsg)
  // Keep last 200 messages
  if (room.chat.length > 200) room.chat = room.chat.slice(-200)
  room.lastActivityAt = now()
  return chatMsg
}

// ── Host transfer ─────────────────────────────────────────────────────────

export function transferHost(roomId: string, newHostUserId: string): WatchRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const newHost = room.participants.find(p => p.id === newHostUserId)
  if (!newHost) return null

  for (const p of room.participants) p.isHost = false
  newHost.isHost = true
  room.hostUserId = newHostUserId
  room.lastActivityAt = now()
  log('HOST_TRANSFER', `room=${room.code} newHost=${newHostUserId}`)
  return room
}

// ── Participant updates ───────────────────────────────────────────────────

export function updateParticipantStatus(
  roomId: string,
  userId: string,
  updates: Partial<Pick<RoomParticipant, 'status' | 'playbackTime' | 'hasSelectedStream' | 'hasMediaAvailable'>>,
): RoomParticipant | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const participant = room.participants.find(p => p.id === userId)
  if (!participant) return null
  Object.assign(participant, updates, { lastSeenAt: now() })
  room.lastActivityAt = now()
  return participant
}

// ── Lookup ────────────────────────────────────────────────────────────────

export function getRoom(roomId: string): WatchRoom | undefined {
  return rooms.get(roomId)
}

export function getRoomByCode(code: string): WatchRoom | undefined {
  const id = codeToId.get(code.toUpperCase())
  return id ? rooms.get(id) : undefined
}

export function getRoomCount(): number {
  return rooms.size
}

export function getParticipantCount(): number {
  let count = 0
  for (const room of rooms.values()) {
    count += room.participants.filter(p => p.status !== 'disconnected').length
  }
  return count
}

// ── Cleanup ───────────────────────────────────────────────────────────────

export function cleanupRooms(config: ServerConfig): number {
  const now = Date.now()
  let removed = 0

  for (const [id, room] of rooms) {
    const connectedCount = room.participants.filter(p => p.status !== 'disconnected').length
    const lastActivity = new Date(room.lastActivityAt).getTime()
    const emptyTooLong = connectedCount === 0 && (now - lastActivity) > config.roomEmptyTtl * 1000
    const inactiveTooLong = (now - lastActivity) > config.roomInactiveTtl * 1000

    if (emptyTooLong || inactiveTooLong) {
      rooms.delete(id)
      codeToId.delete(room.code)
      removed++
      log('CLEANUP', `room=${room.code} reason=${emptyTooLong ? 'empty' : 'inactive'}`)
    }
  }

  // Clean disconnected users past grace period
  for (const [userId, disc] of disconnectedUsers) {
    if ((now - disc.disconnectedAt) > config.reconnectGrace * 1000) {
      disconnectedUsers.delete(userId)
      const room = rooms.get(disc.roomId)
      if (room) {
        room.participants = room.participants.filter(p => p.id !== userId)
        if (room.participants.length === 0) {
          // Will be cleaned next cycle by empty TTL
        } else if (room.hostUserId === userId) {
          const newHost = room.participants.find(p => p.status === 'connected') ?? room.participants[0]
          room.hostUserId = newHost.id
          newHost.isHost = true
        }
      }
    }
  }

  return removed
}

// ── Serialization (strip internal fields for HTTP responses) ──────────────

export function roomToPublic(room: WatchRoom): Omit<WatchRoom, 'chat'> & { participantCount: number } {
  const { chat: _, ...rest } = room
  return {
    ...rest,
    participantCount: room.participants.filter(p => p.status !== 'disconnected').length,
  }
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`)
}
