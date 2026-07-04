import type {
  WatchTogetherEvent,
  ServerMessage,
  RoomMedia,
  RoomEpisode,
  RoomStream,
  RoomSettings,
  DrawStroke,
} from './types'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import { findMatchingLocalStream, createStreamFingerprint } from './streamMatcher'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let lastServerUrl = ''

// Live playback position reported by whichever player component is active.
// The room's stored playback state only changes on discrete events (play,
// pause, seek), so the sync loop must NOT use it as the host position —
// that would rubber-band every guest back to the last event timestamp.
let localPlayback: { time: number; isPlaying: boolean; updatedAt: number } | null = null

export function reportLocalPlayback(time: number, isPlaying: boolean): void {
  if (!Number.isFinite(time)) return
  localPlayback = { time, isPlaying, updatedAt: Date.now() }
}

export function clearLocalPlayback(): void {
  localPlayback = null
}

// Best-known current position: live player position when fresh, otherwise the
// room's event-anchored time extrapolated by elapsed wall-clock.
export function getBestKnownTime(): number {
  if (localPlayback && Date.now() - localPlayback.updatedAt <= 10_000) {
    const elapsed = localPlayback.isPlaying ? (Date.now() - localPlayback.updatedAt) / 1000 : 0
    return localPlayback.time + elapsed
  }
  const pb = getStore().currentRoom?.playback
  if (!pb) return 0
  const elapsed = pb.isPlaying && Number.isFinite(pb.lastUpdatedAt)
    ? Math.max(0, (Date.now() - pb.lastUpdatedAt) / 1000)
    : 0
  return (pb.currentTime ?? 0) + elapsed
}

function getStore() {
  return useWatchTogetherStore.getState()
}

function logDebug(direction: 'in' | 'out', event: string, data?: any) {
  getStore().addDebugLog({ timestamp: Date.now(), direction, event, data })
}

// ── Connection ──────────────────────────────────────────────────────────────

export function connect(serverUrl: string): Promise<void> {
  console.log('[WT DEBUG] connect() called, current ws:', ws ? `readyState=${ws.readyState}` : 'null')
  return new Promise((resolve, reject) => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      console.log('[WT DEBUG] Already connected/connecting, resolving immediately')
      resolve()
      return
    }

    lastServerUrl = serverUrl
    getStore().setConnectionStatus('connecting')

    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        console.log('[WT DEBUG] TIMEOUT after 8s, ws readyState:', ws?.readyState)
        settled = true
        getStore().setConnectionStatus('disconnected')
        if (ws) { try { ws.close() } catch (_) {} }
        ws = null
        reject(new Error('Connection timed out — is the Watch Together server running?'))
      }
    }, 8000)

    console.log('[WT DEBUG] Attempting WebSocket connection to:', serverUrl)
    try {
      ws = new WebSocket(serverUrl)
    } catch (err) {
      console.error('[WT DEBUG] WebSocket constructor threw:', err)
      clearTimeout(timeout)
      settled = true
      getStore().setConnectionStatus('disconnected')
      reject(err)
      return
    }

    ws.onopen = () => {
      console.log('[WT DEBUG] >>> onopen fired!')
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
      } catch (_) {
        logDebug('in', 'PARSE_ERROR', { raw: event.data })
      }
    }

    ws.onclose = (event) => {
      console.log('[WT DEBUG] onclose:', event.code, event.reason)
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
      console.error('[WT DEBUG] onerror:', (event as ErrorEvent).message ?? 'unknown error')
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
  console.log('[WT DEBUG] send():', event.type, 'ws:', ws ? `readyState=${ws.readyState}` : 'null')
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('[WT DEBUG] SEND_FAILED: not connected')
    logDebug('out', 'SEND_FAILED', { event: event.type, reason: 'not connected' })
    return
  }
  logDebug('out', event.type, event)
  ws.send(JSON.stringify(event))
  console.log('[WT DEBUG] sent OK:', JSON.stringify(event))
}

// ── Room actions ────────────────────────────────────────────────────────────

export async function createRoom(name: string): Promise<void> {
  const store = getStore()
  if (store.connectionStatus !== 'connected') {
    await connect(store.serverUrl)
  }
  send({
    type: 'ROOM_JOIN',
    roomCode: '',
    name,
    roomSettings: {
      everyoneCanControl: store.defaultControlMode === 'everyone',
      requireReadyCheck: store.requireReadyCheck,
    },
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
    roomCode: code,
    name,
    clientId: store.currentUserId || undefined,
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
  clearLocalPlayback()
  store.setCurrentRoom(null)
  store.setCurrentUserId(null)
  store.setIsHost(false)
  store.setDrawModeActive(false)
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

// ── Drawing ────────────────────────────────────────────────────────────

export function sendDrawStroke(stroke: DrawStroke): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'DRAW_STROKE',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    stroke,
    sentAt: Date.now(),
  })
}

export function sendDrawClear(): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'DRAW_CLEAR',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
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

// ── Room settings (host only) ───────────────────────────────────────────────

export function setRoomSettings(settings: RoomSettings): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  send({
    type: 'ROOM_SETTINGS',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    settings,
  })
  // Optimistic local update so the toggle reacts immediately; the server's
  // ROOM_STATE broadcast is authoritative and will confirm or revert it.
  store.setCurrentRoom({ ...store.currentRoom, ...settings })
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
    if (pb.status !== 'playing' && pb.status !== 'paused') return

    // Only broadcast when we have a fresh live position from the player.
    // Sending the room's stale event-time here is what caused guests to be
    // dragged back to the last play/pause/seek position every few seconds.
    if (!localPlayback || Date.now() - localPlayback.updatedAt > 10_000) return

    const elapsed = localPlayback.isPlaying ? (Date.now() - localPlayback.updatedAt) / 1000 : 0
    sendSyncState(localPlayback.time + elapsed, localPlayback.isPlaying)
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

// ── Auto-resolve stream (host + guest) ─────────────────────────────────────

export async function autoResolveStream(
  media?: RoomMedia,
  episode?: RoomEpisode,
  hostStream?: RoomStream,
): Promise<boolean> {
  const store = getStore()
  const m = media ?? store.currentRoom?.selectedMedia
  const ep = episode ?? store.currentRoom?.selectedEpisode
  if (!m) return false
  store.setSelectedLocalStream(null)
  try {
    logDebug('out', 'AUTO_RESOLVE_START', { media: m.title, hostStream: !!hostStream })
    const match = await findMatchingLocalStream(m, ep, hostStream, store.allowGuestDifferentStream)
    if (match) {
      store.setSelectedLocalStream(match)
      selectStream({
        addonId: match.addonId,
        name: match.addonName,
        title: match.stream.title,
        quality: match.stream.name?.match(/\b(4k|2160p|1080p|720p|480p)\b/i)?.[0] ?? undefined,
        infoHash: match.stream.infoHash,
        fileIdx: match.stream.fileIdx,
        streamFingerprint: createStreamFingerprint(match.stream as any),
      })
      setReady(true)
      logDebug('in', 'AUTO_RESOLVE_OK', { addon: match.addonName, stream: match.stream.name ?? match.stream.title })
      return true
    } else {
      logDebug('in', 'AUTO_RESOLVE_NONE', { media: m.title })
      return false
    }
  } catch (_) {
    store.setSelectedLocalStream(null)
    logDebug('in', 'AUTO_RESOLVE_ERROR', { media: m.title })
    return false
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
      }
      if (msg.room.selectedMedia) {
        autoResolveStream(msg.room.selectedMedia, msg.room.selectedEpisode, msg.room.selectedStream)
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

    case 'MEDIA_UPDATED': {
      store.updateMedia(msg.media, msg.episode, msg.stream)
      // Skip re-resolving when our current stream already matches the host's
      // (the server re-broadcasts media whenever the host picks a stream).
      const current = store.selectedLocalStream
      const alreadyMatched = !!(
        current &&
        msg.stream?.streamFingerprint &&
        createStreamFingerprint({ ...current.stream, addonId: current.addonId } as any) === msg.stream.streamFingerprint
      )
      if (msg.media && !alreadyMatched) {
        autoResolveStream(msg.media, msg.episode, msg.stream)
      }
      break
    }

    case 'PLAYBACK_UPDATED':
      store.updatePlayback(msg.playback)
      if (!store.isHost && msg.playback.status !== 'stopped' && msg.playback.status !== 'idle') {
        window.dispatchEvent(
          new CustomEvent('wt:sync_request', {
            detail: {
              time: msg.playback.currentTime,
              isPlaying: msg.playback.isPlaying,
              sentAt: msg.playback.lastUpdatedAt,
            },
          }),
        )
      }
      break

    case 'CHAT_RECEIVED':
      store.addChatMessage(msg.message)
      break

    case 'DRAW_RECEIVED':
      window.dispatchEvent(
        new CustomEvent('wt:draw_received', {
          detail: { stroke: msg.stroke, senderUserId: msg.senderUserId, senderName: msg.senderName },
        }),
      )
      break

    case 'DRAW_CLEARED':
      window.dispatchEvent(new CustomEvent('wt:draw_cleared', { detail: { senderUserId: msg.senderUserId } }))
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
          roomCode: store.currentRoom.code,
          name: store.defaultNickname || 'Reconnecting...',
          clientId: store.currentUserId,
        })
      }
    } catch (_) {
      attemptReconnect()
    }
  }, delay)
}
