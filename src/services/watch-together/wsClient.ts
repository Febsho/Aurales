import type {
  WatchTogetherEvent,
  ServerMessage,
  RoomMedia,
  RoomEpisode,
  RoomStream,
} from './types'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import { findMatchingLocalStream } from './streamMatcher'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let lastServerUrl = ''

function getStore() {
  return useWatchTogetherStore.getState()
}

function logDebug(direction: 'in' | 'out', event: string, data?: any) {
  getStore().addDebugLog({ timestamp: Date.now(), direction, event, data })
}

// ── Connection ──────────────────────────────────────────────────────────────

export function connect(serverUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      resolve()
      return
    }

    lastServerUrl = serverUrl
    getStore().setConnectionStatus('connecting')

    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        getStore().setConnectionStatus('disconnected')
        if (ws) { try { ws.close() } catch {} }
        ws = null
        reject(new Error('Connection timed out — is the Watch Together server running?'))
      }
    }, 8000)

    try {
      ws = new WebSocket(serverUrl)
    } catch (err) {
      clearTimeout(timeout)
      settled = true
      getStore().setConnectionStatus('disconnected')
      reject(err)
      return
    }

    ws.onopen = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reconnectAttempt = 0
      getStore().setConnectionStatus('connected')
      startPingLoop()
      logDebug('in', 'CONNECTED')
      resolve()
    }

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data)
        logDebug('in', msg.type, msg)
        handleServerMessage(msg)
      } catch {
        logDebug('in', 'PARSE_ERROR', { raw: event.data })
      }
    }

    ws.onclose = (event) => {
      logDebug('in', 'CLOSE', { code: event.code, reason: event.reason })
      stopPingLoop()
      stopSyncLoop()
      ws = null

      if (!settled) {
        settled = true
        clearTimeout(timeout)
        getStore().setConnectionStatus('disconnected')
        reject(new Error('Connection closed before opening'))
        return
      }

      const store = getStore()
      if (store.connectionStatus !== 'disconnected') {
        store.setConnectionStatus('reconnecting')
        attemptReconnect()
      }
    }

    ws.onerror = (event) => {
      logDebug('in', 'ERROR', { message: (event as ErrorEvent).message ?? 'unknown' })
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        getStore().setConnectionStatus('disconnected')
        ws = null
        reject(new Error('Failed to connect to Watch Together server'))
      }
    }
  })
}

export function disconnect(): void {
  clearReconnectTimer()
  stopSyncLoop()
  stopPingLoop()
  getStore().setConnectionStatus('disconnected')
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
}

export function send(event: WatchTogetherEvent): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logDebug('out', 'SEND_FAILED', { event: event.type, reason: 'not connected' })
    return
  }
  logDebug('out', event.type, event)
  ws.send(JSON.stringify(event))
}

// ── Room actions ────────────────────────────────────────────────────────────

export async function createRoom(name: string): Promise<void> {
  const store = getStore()
  if (store.connectionStatus !== 'connected') {
    await connect(store.serverUrl)
  }
  send({
    type: 'ROOM_JOIN',
    roomId: '',
    name,
    createRoom: true,
  })
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Room creation timed out'))
    }, 10_000)
    const unsub = useWatchTogetherStore.subscribe((state, prev) => {
      if (state.currentRoom && !prev.currentRoom) {
        cleanup()
        resolve()
      }
      const newErrors = state.errors.length - (prev.errors?.length ?? 0)
      if (newErrors > 0) {
        cleanup()
        reject(new Error(state.errors[state.errors.length - 1]))
      }
    })
    function cleanup() {
      clearTimeout(timeout)
      unsub()
    }
  })
}

export async function joinRoom(code: string, name: string): Promise<void> {
  const store = getStore()
  if (store.connectionStatus !== 'connected') {
    await connect(store.serverUrl)
  }
  send({
    type: 'ROOM_JOIN',
    roomId: code,
    name,
  })
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Join timed out — room may not exist'))
    }, 10_000)
    const unsub = useWatchTogetherStore.subscribe((state, prev) => {
      if (state.currentRoom && !prev.currentRoom) {
        cleanup()
        resolve()
      }
      const newErrors = state.errors.length - (prev.errors?.length ?? 0)
      if (newErrors > 0) {
        cleanup()
        reject(new Error(state.errors[state.errors.length - 1]))
      }
    })
    function cleanup() {
      clearTimeout(timeout)
      unsub()
    }
  })
}

export function leaveRoom(): void {
  const store = getStore()
  if (store.currentRoom && store.currentUserId) {
    send({
      type: 'ROOM_LEAVE',
      roomId: store.currentRoom.id,
      userId: store.currentUserId,
    })
  }
  stopSyncLoop()
  store.setCurrentRoom(null)
  store.setCurrentUserId(null)
  store.setIsHost(false)
  store.setSelectedLocalStream(null)
  store.setRoomPanelOpen(false)
}

// ── Media & stream actions ──────────────────────────────────────────────────

export function selectMedia(media: RoomMedia, episode?: RoomEpisode, stream?: RoomStream): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'MEDIA_SELECTED',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    media,
    episode,
    stream,
    sentAt: Date.now(),
  })
}

export function selectStream(stream: RoomStream): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'STREAM_SELECTED',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    stream,
    sentAt: Date.now(),
  })
}

export function setReady(ready: boolean): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'READY',
    roomId: store.currentRoom.id,
    userId: store.currentUserId,
    ready,
  })
}

// ── Playback actions ────────────────────────────────────────────────────────

export function play(time: number): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'PLAY',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    time,
    sentAt: Date.now(),
  })
}

export function pause(time: number): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'PAUSE',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    time,
    sentAt: Date.now(),
  })
}

export function seek(time: number): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'SEEK',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    time,
    sentAt: Date.now(),
  })
}

export function stop(): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'STOP',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    sentAt: Date.now(),
  })
}

// ── Chat ────────────────────────────────────────────────────────────────────

export function sendChatMessage(message: string): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'CHAT_MESSAGE',
    roomId: store.currentRoom.id,
    userId: store.currentUserId,
    message,
    sentAt: Date.now(),
  })
}

// ── Host transfer ───────────────────────────────────────────────────────────

export function transferHost(newHostUserId: string): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'TRANSFER_HOST',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    newHostUserId,
  })
}

// ── Sync & buffering ────────────────────────────────────────────────────────

export function sendSyncState(time: number, isPlaying: boolean): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'SYNC_STATE',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    time,
    isPlaying,
    sentAt: Date.now(),
  })
}

export function sendBuffering(buffering: boolean, time: number): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'BUFFERING',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    buffering,
    time,
    sentAt: Date.now(),
  })
}

export function ping(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'PING', sentAt: Date.now() }))
}

// ── Periodic loops ──────────────────────────────────────────────────────────

export function startSyncLoop(): void {
  stopSyncLoop()
  const intervalMs = getStore().syncInterval * 1000
  syncTimer = setInterval(() => {
    const store = getStore()
    if (!store.isHost || !store.currentRoom) return
    const pb = store.currentRoom.playback
    sendSyncState(pb.currentTime, pb.isPlaying)
  }, intervalMs)
}

export function stopSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

export function startPingLoop(): void {
  stopPingLoop()
  pingTimer = setInterval(ping, 30_000)
}

export function stopPingLoop(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

// ── Auto-resolve guest stream ──────────────────────────────────────────────

async function autoResolveGuestStream(
  media: RoomMedia,
  episode?: RoomEpisode,
  hostStream?: RoomStream,
): Promise<void> {
  const store = getStore()
  try {
    logDebug('out', 'AUTO_RESOLVE_START', { media: media.title, hostStream: !!hostStream })
    const match = await findMatchingLocalStream(media, episode, hostStream)
    if (match) {
      store.setSelectedLocalStream(match)
      setReady(true)
      logDebug('in', 'AUTO_RESOLVE_OK', { addon: match.addonName, stream: match.stream.name ?? match.stream.title })
    } else {
      logDebug('in', 'AUTO_RESOLVE_NONE', { media: media.title })
    }
  } catch {
    logDebug('in', 'AUTO_RESOLVE_ERROR', { media: media.title })
  }
}

// ── Server message handler ──────────────────────────────────────────────────

function handleServerMessage(msg: ServerMessage): void {
  const store = getStore()

  switch (msg.type) {
    case 'ROOM_CREATED':
    case 'ROOM_JOINED': {
      store.setCurrentRoom(msg.room)
      store.setCurrentUserId(msg.userId)
      store.setIsHost(msg.room.hostUserId === msg.userId)
      store.setRoomPanelOpen(true)
      if (msg.room.hostUserId === msg.userId) {
        startSyncLoop()
      } else if (msg.room.selectedMedia) {
        autoResolveGuestStream(msg.room.selectedMedia, msg.room.selectedEpisode, msg.room.selectedStream)
      }
      break
    }

    case 'ROOM_STATE':
      store.setCurrentRoom(msg.room)
      store.setIsHost(msg.room.hostUserId === store.currentUserId)
      break

    case 'PARTICIPANT_JOINED':
      store.updateParticipant(msg.participant)
      break

    case 'PARTICIPANT_LEFT':
      store.removeParticipant(msg.userId)
      break

    case 'PARTICIPANT_UPDATED':
      store.updateParticipant(msg.participant)
      break

    case 'MEDIA_UPDATED':
      store.updateMedia(msg.media, msg.episode, msg.stream)
      if (!store.isHost && msg.media) {
        autoResolveGuestStream(msg.media, msg.episode, msg.stream)
      }
      break

    case 'PLAYBACK_UPDATED':
      store.updatePlayback(msg.playback)
      break

    case 'CHAT_RECEIVED':
      store.addChatMessage(msg.message)
      break

    case 'HOST_TRANSFERRED': {
      if (store.currentRoom) {
        store.setCurrentRoom({ ...store.currentRoom, hostUserId: msg.newHostUserId })
      }
      const nowHost = msg.newHostUserId === store.currentUserId
      store.setIsHost(nowHost)
      if (nowHost) startSyncLoop()
      else stopSyncLoop()
      break
    }

    case 'SYNC_REQUEST':
      window.dispatchEvent(
        new CustomEvent('wt:sync_request', {
          detail: { time: msg.time, isPlaying: msg.isPlaying, sentAt: msg.sentAt },
        }),
      )
      break

    case 'ERROR':
      store.addError(msg.message)
      break

    case 'PONG': {
      const latency = Date.now() - msg.serverTime
      logDebug('in', 'LATENCY', { latencyMs: Math.abs(latency) })
      break
    }
  }
}

// ── Reconnect logic ─────────────────────────────────────────────────────────

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function attemptReconnect(): void {
  clearReconnectTimer()
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30_000)
  reconnectAttempt++
  logDebug('out', 'RECONNECT_SCHEDULED', { attempt: reconnectAttempt, delayMs: delay })

  reconnectTimer = setTimeout(async () => {
    try {
      await connect(lastServerUrl)
      const store = getStore()
      if (store.currentRoom && store.currentUserId) {
        send({
          type: 'ROOM_JOIN',
          roomId: store.currentRoom.id,
          name: store.defaultNickname || 'Reconnecting...',
        })
      }
    } catch {
      attemptReconnect()
    }
  }, delay)
}
