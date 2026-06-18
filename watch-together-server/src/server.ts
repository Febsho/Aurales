import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'

// ── Types (mirrored from client types.ts) ───────────────────────────────────

interface WatchRoom {
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
}

interface RoomMedia {
  localMediaId: string
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

interface RoomEpisode {
  localEpisodeId: string
  seasonNumber: number
  episodeNumber: number
  absoluteEpisodeNumber?: number
  title: string
  overview?: string
  still?: string
  tvdbEpisodeId?: number
  tmdbEpisodeId?: number
}

interface RoomStream {
  streamId?: string
  addonId?: string
  name?: string
  title?: string
  quality?: string
  infoHash?: string
  fileIdx?: number
  urlHash?: string
  streamFingerprint?: string
}

type PlaybackStatus =
  | 'idle'
  | 'selecting'
  | 'waiting_for_ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'stopped'
  | 'ended'

interface RoomPlaybackState {
  status: PlaybackStatus
  currentTime: number
  duration?: number
  isPlaying: boolean
  lastUpdatedAt: number
  startedAt?: number
  lastActionBy?: string
}

type ParticipantStatus =
  | 'connected'
  | 'disconnected'
  | 'watching'
  | 'buffering'
  | 'choosing_stream'

interface RoomParticipant {
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
}

interface RoomChatMessage {
  id: string
  userId: string
  userName: string
  message: string
  sentAt: number
}

type ServerMessage =
  | { type: 'ROOM_CREATED'; room: WatchRoom; userId: string }
  | { type: 'ROOM_JOINED'; room: WatchRoom; userId: string }
  | { type: 'ROOM_STATE'; room: WatchRoom }
  | { type: 'PARTICIPANT_JOINED'; participant: RoomParticipant }
  | { type: 'PARTICIPANT_LEFT'; userId: string }
  | { type: 'PARTICIPANT_UPDATED'; participant: RoomParticipant }
  | { type: 'MEDIA_UPDATED'; media?: RoomMedia; episode?: RoomEpisode; stream?: RoomStream }
  | { type: 'PLAYBACK_UPDATED'; playback: RoomPlaybackState }
  | { type: 'CHAT_RECEIVED'; message: RoomChatMessage }
  | { type: 'HOST_TRANSFERRED'; newHostUserId: string }
  | { type: 'SYNC_REQUEST'; time: number; isPlaying: boolean; sentAt: number }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'PONG'; serverTime: number }

// ── State ───────────────────────────────────────────────────────────────────

const rooms = new Map<string, WatchRoom>()
const roomsByCode = new Map<string, string>()

interface ConnectionInfo {
  roomId: string
  userId: string
}

const connections = new Map<WebSocket, ConnectionInfo>()
const roomConnections = new Map<string, Map<string, WebSocket>>()
const chatRateLimits = new Map<string, number[]>()
const disconnectTimers = new Map<string, NodeJS.Timeout>()
const emptyRoomTimers = new Map<string, NodeJS.Timeout>()

const MAX_PARTICIPANTS = 20
const MAX_CHAT_MESSAGES = 200
const CHAT_RATE_WINDOW = 10_000
const CHAT_RATE_LIMIT = 5
const DISCONNECT_GRACE_MS = 2 * 60 * 1000
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000

// ── Utilities ───────────────────────────────────────────────────────────────

const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)]
  }
  return roomsByCode.has(code) ? generateCode() : code
}

function generateId(length = 8): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  let id = ''
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

function defaultPlayback(): RoomPlaybackState {
  return {
    status: 'idle',
    currentTime: 0,
    isPlaying: false,
    lastUpdatedAt: Date.now(),
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function broadcast(roomId: string, msg: ServerMessage, excludeUserId?: string) {
  const conns = roomConnections.get(roomId)
  if (!conns) return
  const data = JSON.stringify(msg)
  for (const [userId, ws] of conns) {
    if (userId !== excludeUserId && ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

function sendError(ws: WebSocket, code: string, message: string) {
  send(ws, { type: 'ERROR', code, message })
}

function canControl(room: WatchRoom, senderId: string): boolean {
  return room.hostUserId === senderId || room.everyoneCanControl
}

function cleanRoom(room: WatchRoom): WatchRoom {
  return { ...room, chat: room.chat.slice(-MAX_CHAT_MESSAGES) }
}

function scheduleEmptyRoomCleanup(roomId: string) {
  if (emptyRoomTimers.has(roomId)) return
  const timer = setTimeout(() => {
    const room = rooms.get(roomId)
    if (room && room.participants.every(p => p.status === 'disconnected')) {
      destroyRoom(roomId)
    }
    emptyRoomTimers.delete(roomId)
  }, EMPTY_ROOM_GRACE_MS)
  emptyRoomTimers.set(roomId, timer)
}

function cancelEmptyRoomCleanup(roomId: string) {
  const timer = emptyRoomTimers.get(roomId)
  if (timer) {
    clearTimeout(timer)
    emptyRoomTimers.delete(roomId)
  }
}

function destroyRoom(roomId: string) {
  const room = rooms.get(roomId)
  if (room) {
    roomsByCode.delete(room.code)
    rooms.delete(roomId)
    roomConnections.delete(roomId)
    cancelEmptyRoomCleanup(roomId)
    console.log(`[room:destroy] ${room.code} (${roomId})`)
  }
}

// ── Event Handlers ──────────────────────────────────────────────────────────

function handleRoomJoin(ws: WebSocket, event: { type: 'ROOM_JOIN'; roomId: string; name: string; createRoom?: boolean; title?: string }) {
  const existing = connections.get(ws)
  if (existing) {
    sendError(ws, 'ALREADY_IN_ROOM', 'Already in a room. Leave first.')
    return
  }

  let room: WatchRoom | undefined
  let isCreating = false

  if (event.createRoom) {
    const code = generateCode()
    const id = randomUUID()
    const userId = generateId()

    room = {
      id,
      code,
      hostUserId: userId,
      title: event.title,
      playback: defaultPlayback(),
      participants: [],
      chat: [],
      everyoneCanControl: false,
      requireReadyCheck: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const participant: RoomParticipant = {
      id: userId,
      name: event.name,
      isHost: true,
      isReady: false,
      hasSelectedStream: false,
      hasMediaAvailable: false,
      status: 'connected',
    }

    room.participants.push(participant)
    rooms.set(id, room)
    roomsByCode.set(code, id)
    roomConnections.set(id, new Map([[userId, ws]]))
    connections.set(ws, { roomId: id, userId })

    console.log(`[room:create] ${code} (${id}) by "${event.name}" (${userId})`)
    send(ws, { type: 'ROOM_CREATED', room: cleanRoom(room), userId })
    return
  }

  const roomId = roomsByCode.get(event.roomId) ?? (rooms.has(event.roomId) ? event.roomId : undefined)
  if (!roomId) {
    sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
    return
  }

  room = rooms.get(roomId)!

  if (room.participants.filter(p => p.status !== 'disconnected').length >= MAX_PARTICIPANTS) {
    sendError(ws, 'ROOM_FULL', 'Room is full.')
    return
  }

  const disconnected = room.participants.find(
    p => p.name === event.name && p.status === 'disconnected'
  )

  let userId: string
  let participant: RoomParticipant

  if (disconnected) {
    userId = disconnected.id
    disconnected.status = 'connected'
    participant = disconnected

    const timer = disconnectTimers.get(userId)
    if (timer) {
      clearTimeout(timer)
      disconnectTimers.delete(userId)
    }
  } else {
    userId = generateId()
    participant = {
      id: userId,
      name: event.name,
      isHost: false,
      isReady: false,
      hasSelectedStream: false,
      hasMediaAvailable: false,
      status: 'connected',
    }
    room.participants.push(participant)
  }

  cancelEmptyRoomCleanup(roomId)
  room.updatedAt = new Date().toISOString()

  let conns = roomConnections.get(roomId)
  if (!conns) {
    conns = new Map()
    roomConnections.set(roomId, conns)
  }
  conns.set(userId, ws)
  connections.set(ws, { roomId, userId })

  console.log(`[room:join] "${event.name}" (${userId}) -> ${room.code}`)
  send(ws, { type: 'ROOM_JOINED', room: cleanRoom(room), userId })
  broadcast(roomId, { type: 'PARTICIPANT_JOINED', participant }, userId)
}

function handleRoomLeave(ws: WebSocket, event: { type: 'ROOM_LEAVE'; roomId: string; userId: string }) {
  const conn = connections.get(ws)
  if (!conn) return

  performLeave(ws, conn.roomId, conn.userId, false)
}

function performLeave(ws: WebSocket, roomId: string, userId: string, isDisconnect: boolean) {
  const room = rooms.get(roomId)
  if (!room) return

  connections.delete(ws)
  roomConnections.get(roomId)?.delete(userId)

  const participant = room.participants.find(p => p.id === userId)
  if (!participant) return

  if (isDisconnect) {
    participant.status = 'disconnected'
    room.updatedAt = new Date().toISOString()

    broadcast(roomId, { type: 'PARTICIPANT_UPDATED', participant })

    const timer = setTimeout(() => {
      disconnectTimers.delete(userId)
      finalizeLeave(room, roomId, userId)
    }, DISCONNECT_GRACE_MS)
    disconnectTimers.set(userId, timer)
  } else {
    finalizeLeave(room, roomId, userId)
  }
}

function finalizeLeave(room: WatchRoom, roomId: string, userId: string) {
  room.participants = room.participants.filter(p => p.id !== userId)
  room.updatedAt = new Date().toISOString()

  broadcast(roomId, { type: 'PARTICIPANT_LEFT', userId })
  console.log(`[room:leave] ${userId} from ${room.code}`)

  if (room.participants.filter(p => p.status !== 'disconnected').length === 0) {
    if (room.participants.length === 0) {
      destroyRoom(roomId)
    } else {
      scheduleEmptyRoomCleanup(roomId)
    }
    return
  }

  if (room.hostUserId === userId) {
    const next = room.participants.find(p => p.status !== 'disconnected')
    if (next) {
      room.hostUserId = next.id
      next.isHost = true
      const prev = room.participants.find(p => p.id === userId)
      if (prev) prev.isHost = false
      broadcast(roomId, { type: 'HOST_TRANSFERRED', newHostUserId: next.id })
      broadcast(roomId, { type: 'ROOM_STATE', room: cleanRoom(room) })
      console.log(`[room:host-transfer] -> ${next.name} (${next.id}) in ${room.code}`)
    }
  }
}

function handleMediaSelected(ws: WebSocket, event: {
  type: 'MEDIA_SELECTED'; roomId: string; senderUserId: string
  media: RoomMedia; episode?: RoomEpisode; stream?: RoomStream; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
  if (!canControl(room, event.senderUserId)) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can control playback.')
  }

  room.selectedMedia = event.media
  room.selectedEpisode = event.episode
  room.selectedStream = event.stream
  room.playback = {
    status: 'waiting_for_ready',
    currentTime: 0,
    isPlaying: false,
    lastUpdatedAt: event.sentAt,
    lastActionBy: event.senderUserId,
  }

  for (const p of room.participants) {
    if (p.id !== room.hostUserId) {
      p.isReady = false
    }
  }

  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, {
    type: 'MEDIA_UPDATED',
    media: room.selectedMedia,
    episode: room.selectedEpisode,
    stream: room.selectedStream,
  })
  broadcast(event.roomId, { type: 'ROOM_STATE', room: cleanRoom(room) })
}

function handleStreamSelected(ws: WebSocket, event: {
  type: 'STREAM_SELECTED'; roomId: string; senderUserId: string; stream: RoomStream; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')

  const participant = room.participants.find(p => p.id === event.senderUserId)
  if (!participant) return

  participant.hasSelectedStream = true
  participant.status = 'watching'
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PARTICIPANT_UPDATED', participant })
}

function handleReady(ws: WebSocket, event: { type: 'READY'; roomId: string; userId: string; ready: boolean }) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')

  const participant = room.participants.find(p => p.id === event.userId)
  if (!participant) return

  participant.isReady = event.ready
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PARTICIPANT_UPDATED', participant })
}

function handlePlay(ws: WebSocket, event: {
  type: 'PLAY'; roomId: string; senderUserId: string; time: number; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
  if (!canControl(room, event.senderUserId)) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can control playback.')
  }

  room.playback = {
    ...room.playback,
    status: 'playing',
    isPlaying: true,
    currentTime: event.time,
    lastUpdatedAt: event.sentAt,
    lastActionBy: event.senderUserId,
    startedAt: room.playback.startedAt ?? event.sentAt,
  }
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PLAYBACK_UPDATED', playback: room.playback })
}

function handlePause(ws: WebSocket, event: {
  type: 'PAUSE'; roomId: string; senderUserId: string; time: number; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
  if (!canControl(room, event.senderUserId)) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can control playback.')
  }

  room.playback = {
    ...room.playback,
    status: 'paused',
    isPlaying: false,
    currentTime: event.time,
    lastUpdatedAt: event.sentAt,
    lastActionBy: event.senderUserId,
  }
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PLAYBACK_UPDATED', playback: room.playback })
}

function handleSeek(ws: WebSocket, event: {
  type: 'SEEK'; roomId: string; senderUserId: string; time: number; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
  if (!canControl(room, event.senderUserId)) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can control playback.')
  }

  room.playback = {
    ...room.playback,
    currentTime: event.time,
    lastUpdatedAt: event.sentAt,
    lastActionBy: event.senderUserId,
  }
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PLAYBACK_UPDATED', playback: room.playback })
}

function handleStop(ws: WebSocket, event: {
  type: 'STOP'; roomId: string; senderUserId: string; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
  if (!canControl(room, event.senderUserId)) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can control playback.')
  }

  room.playback = {
    status: 'idle',
    currentTime: 0,
    isPlaying: false,
    lastUpdatedAt: event.sentAt,
    lastActionBy: event.senderUserId,
  }
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PLAYBACK_UPDATED', playback: room.playback })
}

function handleSyncState(ws: WebSocket, event: {
  type: 'SYNC_STATE'; roomId: string; senderUserId: string; time: number; isPlaying: boolean; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')
  if (!canControl(room, event.senderUserId)) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can control playback.')
  }

  broadcast(event.roomId, {
    type: 'SYNC_REQUEST',
    time: event.time,
    isPlaying: event.isPlaying,
    sentAt: event.sentAt,
  }, event.senderUserId)
}

function handleBuffering(ws: WebSocket, event: {
  type: 'BUFFERING'; roomId: string; senderUserId: string; buffering: boolean; time: number; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')

  const participant = room.participants.find(p => p.id === event.senderUserId)
  if (!participant) return

  participant.status = event.buffering ? 'buffering' : 'watching'
  participant.playbackTime = event.time
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'PARTICIPANT_UPDATED', participant })
}

function handleChatMessage(ws: WebSocket, event: {
  type: 'CHAT_MESSAGE'; roomId: string; userId: string; message: string; sentAt: number
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')

  const participant = room.participants.find(p => p.id === event.userId)
  if (!participant) return sendError(ws, 'NOT_IN_ROOM', 'Not a participant.')

  const now = Date.now()
  const timestamps = chatRateLimits.get(event.userId) ?? []
  const recent = timestamps.filter(t => now - t < CHAT_RATE_WINDOW)

  if (recent.length >= CHAT_RATE_LIMIT) {
    return sendError(ws, 'RATE_LIMITED', 'Too many messages. Slow down.')
  }

  recent.push(now)
  chatRateLimits.set(event.userId, recent)

  const chatMsg: RoomChatMessage = {
    id: generateId(),
    userId: event.userId,
    userName: participant.name,
    message: event.message,
    sentAt: event.sentAt,
  }

  room.chat.push(chatMsg)
  if (room.chat.length > MAX_CHAT_MESSAGES) {
    room.chat = room.chat.slice(-MAX_CHAT_MESSAGES)
  }
  room.updatedAt = new Date().toISOString()

  broadcast(event.roomId, { type: 'CHAT_RECEIVED', message: chatMsg })
}

function handleTransferHost(ws: WebSocket, event: {
  type: 'TRANSFER_HOST'; roomId: string; senderUserId: string; newHostUserId: string
}) {
  const room = rooms.get(event.roomId)
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'Room not found.')

  if (room.hostUserId !== event.senderUserId) {
    return sendError(ws, 'HOST_ONLY_CONTROL', 'Only the host can transfer host.')
  }

  const newHost = room.participants.find(p => p.id === event.newHostUserId)
  if (!newHost) return sendError(ws, 'USER_NOT_FOUND', 'Target user not in room.')

  const oldHost = room.participants.find(p => p.id === event.senderUserId)
  if (oldHost) oldHost.isHost = false

  newHost.isHost = true
  room.hostUserId = event.newHostUserId
  room.updatedAt = new Date().toISOString()

  console.log(`[room:host-transfer] ${event.senderUserId} -> ${event.newHostUserId} in ${room.code}`)
  broadcast(event.roomId, { type: 'HOST_TRANSFERRED', newHostUserId: event.newHostUserId })
  broadcast(event.roomId, { type: 'ROOM_STATE', room: cleanRoom(room) })
}

// ── WebSocket Server ────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '9876', 10)
const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw: Buffer) => {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw.toString())
    } catch {
      sendError(ws, 'INVALID_JSON', 'Invalid JSON.')
      return
    }

    const type = data.type as string

    if (type === 'PING') {
      send(ws, { type: 'PONG', serverTime: Date.now() })
      return
    }

    switch (type) {
      case 'ROOM_JOIN':
        handleRoomJoin(ws, data as Parameters<typeof handleRoomJoin>[1])
        break
      case 'ROOM_LEAVE':
        handleRoomLeave(ws, data as Parameters<typeof handleRoomLeave>[1])
        break
      case 'MEDIA_SELECTED':
        handleMediaSelected(ws, data as Parameters<typeof handleMediaSelected>[1])
        break
      case 'STREAM_SELECTED':
        handleStreamSelected(ws, data as Parameters<typeof handleStreamSelected>[1])
        break
      case 'READY':
        handleReady(ws, data as Parameters<typeof handleReady>[1])
        break
      case 'PLAY':
        handlePlay(ws, data as Parameters<typeof handlePlay>[1])
        break
      case 'PAUSE':
        handlePause(ws, data as Parameters<typeof handlePause>[1])
        break
      case 'SEEK':
        handleSeek(ws, data as Parameters<typeof handleSeek>[1])
        break
      case 'STOP':
        handleStop(ws, data as Parameters<typeof handleStop>[1])
        break
      case 'SYNC_STATE':
        handleSyncState(ws, data as Parameters<typeof handleSyncState>[1])
        break
      case 'BUFFERING':
        handleBuffering(ws, data as Parameters<typeof handleBuffering>[1])
        break
      case 'CHAT_MESSAGE':
        handleChatMessage(ws, data as Parameters<typeof handleChatMessage>[1])
        break
      case 'TRANSFER_HOST':
        handleTransferHost(ws, data as Parameters<typeof handleTransferHost>[1])
        break
      default:
        sendError(ws, 'UNKNOWN_EVENT', `Unknown event type: ${type}`)
    }
  })

  ws.on('close', () => {
    const conn = connections.get(ws)
    if (conn) {
      performLeave(ws, conn.roomId, conn.userId, true)
    }
  })

  ws.on('error', (err: Error) => {
    console.error('[ws:error]', err.message)
    const conn = connections.get(ws)
    if (conn) {
      performLeave(ws, conn.roomId, conn.userId, true)
    }
  })
})

console.log(`[watch-together] server listening on ws://localhost:${PORT}`)
