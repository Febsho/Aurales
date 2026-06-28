import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { Server } from 'http'
import type { ClientEvent, ServerEvent, ConnectedClient, ServerConfig } from './types.js'
import {
  createRoom,
  joinRoom,
  leaveRoom,
  markDisconnected,
  canControlPlayback,
  canChangeMedia,
  isParticipant,
  updateMedia,
  updateStream,
  setReady,
  updatePlayback,
  addChatMessage,
  transferHost,
  updateParticipantStatus,
  getRoom,
} from './roomManager.js'
import { checkRateLimit } from './rateLimit.js'

const clients = new Map<WebSocket, ConnectedClient>()

export function setupWebSocket(server: Server, config: ServerConfig): WebSocketServer {
  const wss = new WebSocketServer({ server, path: config.wsPath })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = config.trustProxy
      ? (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown'
      : req.socket.remoteAddress ?? 'unknown'

    const client: ConnectedClient = {
      ws,
      userId: '',
      roomId: null,
      ip,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
    }
    clients.set(ws, client)
    log('WS_CONNECT', `ip=${ip}`)

    ws.on('message', (data) => {
      try {
        const event: ClientEvent = JSON.parse(data.toString())
        client.lastPingAt = Date.now()
        handleEvent(ws, client, event, config)
      } catch {
        sendTo(ws, { type: 'ERROR', code: 'INVALID_MESSAGE', message: 'Invalid JSON' })
      }
    })

    ws.on('close', () => {
      handleDisconnect(ws, client, config)
      clients.delete(ws)
    })

    ws.on('error', () => {
      handleDisconnect(ws, client, config)
      clients.delete(ws)
    })
  })

  // Heartbeat: close stale connections every 60s
  setInterval(() => {
    const now = Date.now()
    for (const [ws, client] of clients) {
      if (now - client.lastPingAt > 90_000) {
        log('HEARTBEAT_TIMEOUT', `user=${client.userId} ip=${client.ip}`)
        ws.terminate()
      }
    }
  }, 60_000)

  log('WS_READY', `path=${config.wsPath}`)
  return wss
}

function handleEvent(ws: WebSocket, client: ConnectedClient, event: ClientEvent, config: ServerConfig): void {
  switch (event.type) {
    case 'PING':
      sendTo(ws, { type: 'PONG', serverTime: event.sentAt })
      return

    case 'ROOM_JOIN':
      handleJoin(ws, client, event, config)
      return

    case 'ROOM_LEAVE':
      handleLeave(ws, client, event)
      return

    case 'READY':
      handleReady(ws, client, event)
      return

    case 'MEDIA_SELECTED':
      handleMediaSelected(ws, client, event, config)
      return

    case 'STREAM_SELECTED':
      handleStreamSelected(ws, client, event)
      return

    case 'PLAY':
      handlePlayback(ws, client, event, config)
      return

    case 'PAUSE':
      handlePlayback(ws, client, event, config)
      return

    case 'SEEK':
      handlePlayback(ws, client, event, config)
      return

    case 'STOP':
      handlePlayback(ws, client, event, config)
      return

    case 'SYNC_STATE':
      handleSyncState(ws, client, event)
      return

    case 'BUFFERING':
      handleBuffering(ws, client, event)
      return

    case 'CHAT_MESSAGE':
      handleChat(ws, client, event, config)
      return

    case 'TRANSFER_HOST':
      handleTransferHost(ws, client, event)
      return

    default:
      sendTo(ws, { type: 'ERROR', code: 'UNKNOWN_EVENT', message: 'Unknown event type' })
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleJoin(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'ROOM_JOIN' }>,
  config: ServerConfig,
): void {
  const name = (event.name || '').trim().slice(0, 32) || 'Guest'

  // Create new room if roomCode is empty
  if (!event.roomCode) {
    if (!checkRateLimit(`room:${client.ip}`, config.rateLimitRoomsPerMinute)) {
      sendTo(ws, { type: 'ERROR', code: 'RATE_LIMITED', message: 'Too many room creations. Try again later.' })
      return
    }
    const { room, userId } = createRoom(name, config)
    client.userId = userId
    client.roomId = room.id
    client.clientId = event.clientId
    sendTo(ws, { type: 'ROOM_CREATED', room, userId })
    return
  }

  // Join existing room
  const result = joinRoom(event.roomCode, name, event.clientId ?? (client.userId || undefined), config)

  if ('error' in result) {
    sendTo(ws, { type: 'ERROR', code: result.code, message: result.error })
    return
  }

  client.userId = result.userId
  client.roomId = result.room.id
  client.clientId = event.clientId
  sendTo(ws, { type: 'ROOM_JOINED', room: result.room, userId: result.userId })

  if (!result.isReconnect) {
    const participant = result.room.participants.find(p => p.id === result.userId)
    if (participant) {
      broadcastToRoom(result.room.id, { type: 'PARTICIPANT_JOINED', participant }, result.userId)
    }
  } else {
    broadcastToRoom(result.room.id, { type: 'ROOM_STATE', room: result.room })
  }
}

function handleLeave(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'ROOM_LEAVE' }>,
): void {
  const room = leaveRoom(event.roomId, event.userId)
  client.roomId = null
  client.userId = ''

  if (room) {
    broadcastToRoom(room.id, { type: 'PARTICIPANT_LEFT', userId: event.userId })
    if (room.participants.length > 0) {
      broadcastToRoom(room.id, { type: 'ROOM_STATE', room })
    }
  }
}

function handleReady(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'READY' }>,
): void {
  const participant = setReady(event.roomId, event.userId, event.ready)
  if (participant) {
    broadcastToRoom(event.roomId, { type: 'PARTICIPANT_UPDATED', participant })
  }
}

function handleMediaSelected(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'MEDIA_SELECTED' }>,
  config: ServerConfig,
): void {
  const room = getRoom(event.roomId)
  if (!room) return

  if (!canChangeMedia(room, event.senderUserId)) {
    sendTo(ws, { type: 'ERROR', code: 'HOST_ONLY_CONTROL', message: 'Only the host can select media' })
    return
  }

  updateMedia(event.roomId, event.media, event.episode, event.stream)
  broadcastToRoom(event.roomId, {
    type: 'MEDIA_UPDATED',
    media: event.media,
    episode: event.episode,
    stream: event.stream,
  })
}

function handleStreamSelected(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'STREAM_SELECTED' }>,
): void {
  const participant = updateParticipantStatus(event.roomId, event.senderUserId, {
    hasSelectedStream: true,
    status: 'connected',
  })
  if (participant) {
    broadcastToRoom(event.roomId, { type: 'PARTICIPANT_UPDATED', participant })
  }
}

function handlePlayback(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'PLAY' | 'PAUSE' | 'SEEK' | 'STOP' }>,
  config: ServerConfig,
): void {
  const room = getRoom(event.roomId)
  if (!room) return

  if (!canControlPlayback(room, event.senderUserId)) {
    sendTo(ws, { type: 'ERROR', code: 'HOST_ONLY_CONTROL', message: 'Only the host can control playback' })
    return
  }

  let playback: ReturnType<typeof updatePlayback>

  switch (event.type) {
    case 'PLAY':
      playback = updatePlayback(event.roomId, {
        status: 'playing',
        currentTime: event.time,
        isPlaying: true,
        startedAt: Date.now(),
        lastActionBy: event.senderUserId,
      })
      break
    case 'PAUSE':
      playback = updatePlayback(event.roomId, {
        status: 'paused',
        currentTime: event.time,
        isPlaying: false,
        lastActionBy: event.senderUserId,
      })
      break
    case 'SEEK':
      playback = updatePlayback(event.roomId, {
        currentTime: event.time,
        lastActionBy: event.senderUserId,
      })
      break
    case 'STOP':
      playback = updatePlayback(event.roomId, {
        status: 'stopped',
        currentTime: 0,
        isPlaying: false,
        lastActionBy: event.senderUserId,
      })
      break
  }

  if (playback) {
    broadcastToRoom(event.roomId, { type: 'PLAYBACK_UPDATED', playback })
    // Also send SYNC_REQUEST to non-host participants for immediate sync
    if (event.type !== 'STOP') {
      broadcastToRoom(event.roomId, {
        type: 'SYNC_REQUEST',
        time: 'time' in event ? event.time : 0,
        isPlaying: event.type === 'PLAY',
        sentAt: Date.now(),
      }, event.senderUserId)
    }
  }
}

function handleSyncState(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'SYNC_STATE' }>,
): void {
  const room = getRoom(event.roomId)
  if (!room) return

  updatePlayback(event.roomId, {
    currentTime: event.time,
    isPlaying: event.isPlaying,
  })

  // Forward sync to all other participants
  broadcastToRoom(event.roomId, {
    type: 'SYNC_REQUEST',
    time: event.time,
    isPlaying: event.isPlaying,
    sentAt: event.sentAt,
  }, event.senderUserId)
}

function handleBuffering(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'BUFFERING' }>,
): void {
  const participant = updateParticipantStatus(event.roomId, event.senderUserId, {
    status: event.buffering ? 'buffering' : 'watching',
    playbackTime: event.time,
  })
  if (participant) {
    broadcastToRoom(event.roomId, { type: 'PARTICIPANT_UPDATED', participant }, event.senderUserId)
  }
}

function handleChat(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'CHAT_MESSAGE' }>,
  config: ServerConfig,
): void {
  if (!checkRateLimit(`chat:${client.userId}`, config.rateLimitMessagesPerMinute)) {
    sendTo(ws, { type: 'ERROR', code: 'RATE_LIMITED', message: 'Too many messages. Slow down.' })
    return
  }

  const msg = addChatMessage(event.roomId, event.userId, event.message, config.maxChatLength)
  if (msg) {
    broadcastToRoom(event.roomId, { type: 'CHAT_RECEIVED', message: msg })
  }
}

function handleTransferHost(
  ws: WebSocket,
  client: ConnectedClient,
  event: Extract<ClientEvent, { type: 'TRANSFER_HOST' }>,
): void {
  const room = getRoom(event.roomId)
  if (!room) return

  if (room.hostUserId !== event.senderUserId) {
    sendTo(ws, { type: 'ERROR', code: 'HOST_ONLY_CONTROL', message: 'Only the host can transfer host' })
    return
  }

  const updated = transferHost(event.roomId, event.newHostUserId)
  if (updated) {
    broadcastToRoom(event.roomId, { type: 'HOST_TRANSFERRED', newHostUserId: event.newHostUserId })
    broadcastToRoom(event.roomId, { type: 'ROOM_STATE', room: updated })
  }
}

function handleDisconnect(ws: WebSocket, client: ConnectedClient, config: ServerConfig): void {
  if (client.roomId && client.userId) {
    markDisconnected(client.roomId, client.userId, config)
    const room = getRoom(client.roomId)
    if (room) {
      const participant = room.participants.find(p => p.id === client.userId)
      if (participant) {
        broadcastToRoom(client.roomId, { type: 'PARTICIPANT_UPDATED', participant })
      }
    }
  }
  log('WS_DISCONNECT', `user=${client.userId || 'anon'} ip=${client.ip}`)
}

// ── Broadcast ─────────────────────────────────────────────────────────────

function broadcastToRoom(roomId: string, event: ServerEvent, excludeUserId?: string): void {
  const data = JSON.stringify(event)
  for (const [ws, client] of clients) {
    if (client.roomId === roomId && ws.readyState === WebSocket.OPEN) {
      if (excludeUserId && client.userId === excludeUserId) continue
      ws.send(data)
    }
  }
}

function sendTo(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event))
  }
}

export function getConnectedClientCount(): number {
  return clients.size
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`)
}
