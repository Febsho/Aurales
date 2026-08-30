import type {
  WatchTogetherEvent,
  ServerMessage,
  RoomMedia,
  RoomEpisode,
  RoomStream,
  RoomSettings,
  LocalSourceStatus,
} from './types'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import { resolveLocalSourceCandidates } from './streamMatcher'
import type { LocalSourceCandidate, PendingRoomSync } from '../../stores/watchTogetherStore'
import { estimateRoomPosition, estimateServerTiming, serverTimestampToLocal } from './clockSync'
import { getActiveProfile } from '../profiles'
import { getProfileAvatar } from '../../data/profileAvatars'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let lastServerUrl = ''
let sourceResolveController: AbortController | null = null

// Live playback position reported by whichever player component is active.
// The room's stored playback state only changes on discrete events (play,
// pause, seek), so the sync loop must NOT use it as the host position —
// that would rubber-band every guest back to the last event timestamp.
let localPlayback: { time: number; isPlaying: boolean; updatedAt: number } | null = null

function activeProfileAvatar(): string | undefined {
  return getProfileAvatar(getActiveProfile().avatarRef)?.imageUrl
}

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
  const store = getStore()
  const pb = store.currentRoom?.playback
  if (!pb) return 0
  return estimateRoomPosition(
    pb.currentTime ?? 0,
    pb.isPlaying,
    pb.serverTime ?? pb.lastUpdatedAt,
    pb.serverTime == null ? 0 : store.serverClockOffsetMs,
  )
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
      ping()
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
    avatar: activeProfileAvatar(),
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
    avatar: activeProfileAvatar(),
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
  sourceResolveController?.abort()
  sourceResolveController = null
  clearLocalPlayback()
  store.setCurrentRoom(null)
  store.setCurrentUserId(null)
  store.setIsHost(false)
  store.clearLocalSource()
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

export function sendLocalSourceStatus(status: LocalSourceStatus, errorCode?: string): void {
  const store = getStore()
  if (!store.currentRoom || !store.currentUserId) return
  store.setLocalSourceStatus(status, errorCode ?? null)
  send({
    type: 'LOCAL_SOURCE_STATUS',
    roomId: store.currentRoom.id,
    senderUserId: store.currentUserId,
    status,
    errorCode,
    sentAt: Date.now(),
  })
}

export function useManualLocalSource(candidate: LocalSourceCandidate): void {
  sourceResolveController?.abort()
  sourceResolveController = null
  getStore().setManualLocalSource(candidate)
  sendLocalSourceStatus('ready')
  setReady(true)
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
  _hostStream?: RoomStream,
): Promise<boolean> {
  const store = getStore()
  const m = media ?? store.currentRoom?.selectedMedia
  const ep = episode ?? store.currentRoom?.selectedEpisode
  if (!m) return false
  sourceResolveController?.abort()
  sourceResolveController = new AbortController()
  const signal = sourceResolveController.signal
  const generation = store.beginSourceResolution()
  sendLocalSourceStatus('resolving')
  try {
    logDebug('out', 'AUTO_RESOLVE_START', { media: m.title, generation })
    const candidates = await resolveLocalSourceCandidates(m, ep, signal)
    if (signal.aborted) return false
    if (!getStore().setLocalSourceCandidates(generation, candidates)) return false
    const match = candidates[0]
    if (match) {
      sendLocalSourceStatus('ready')
      setReady(true)
      logDebug('in', 'AUTO_RESOLVE_OK', { addon: match.addonName, count: candidates.length, stream: match.stream.name ?? match.stream.title })
      return true
    } else {
      sendLocalSourceStatus('failed', 'SOURCE_UNAVAILABLE')
      setReady(false)
      logDebug('in', 'AUTO_RESOLVE_NONE', { media: m.title })
      return false
    }
  } catch (_) {
    if (signal.aborted) return false
    if (getStore().sourceResolutionGeneration !== generation) return false
    store.setLocalSourceCandidates(generation, [])
    sendLocalSourceStatus('failed', 'SOURCE_RESOLUTION_FAILED')
    setReady(false)
    logDebug('in', 'AUTO_RESOLVE_ERROR', { media: m.title })
    return false
  }
}

function publishSync(sync: PendingRoomSync): void {
  const store = getStore()
  if (!store.queuePendingSync(sync)) return
  const localServerTimestamp = serverTimestampToLocal(sync.serverTime, store.serverClockOffsetMs)
  window.dispatchEvent(new CustomEvent('wt:sync_request', {
    detail: {
      time: sync.time,
      isPlaying: sync.isPlaying,
      sentAt: localServerTimestamp,
      sequence: sync.sequence,
    },
  }))
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
      const previousMedia = store.currentRoom?.selectedMedia
      const previousEpisode = store.currentRoom?.selectedEpisode
      const mediaChanged = Boolean(msg.media) && (
        previousMedia?.localMediaId !== msg.media?.localMediaId ||
        previousEpisode?.seasonNumber !== msg.episode?.seasonNumber ||
        previousEpisode?.episodeNumber !== msg.episode?.episodeNumber
      )
      store.updateMedia(msg.media, msg.episode, msg.stream)
      if (msg.media && mediaChanged) {
        autoResolveStream(msg.media, msg.episode)
      }
      break
    }

    case 'PLAYBACK_UPDATED':
      store.updatePlayback(msg.playback)
      // A discrete control may originate from any authorized participant.
      // Apply the authoritative echo on hosts and guests alike; the sender's
      // player already has the same state, so processing its echo is harmless.
      if (msg.playback.status !== 'stopped' && msg.playback.status !== 'idle') {
        publishSync({
          time: msg.playback.currentTime,
          isPlaying: msg.playback.isPlaying,
          serverTime: msg.playback.serverTime ?? msg.playback.lastUpdatedAt,
          sequence: msg.playback.sequence ?? msg.playback.lastUpdatedAt,
        })
      }
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
      publishSync({
        time: msg.time,
        isPlaying: msg.isPlaying,
        serverTime: msg.serverTime ?? msg.sentAt ?? Date.now(),
        sequence: msg.sequence ?? msg.serverTime ?? msg.sentAt ?? Date.now(),
      })
      break

    case 'ERROR':
      store.addError(msg.message)
      break

    case 'PONG': {
      const receivedAt = Date.now()
      if (typeof msg.clientSentAt !== 'number') {
        const legacyLatency = Math.max(0, receivedAt - msg.serverTime)
        store.updateServerTiming(0, legacyLatency)
        logDebug('in', 'LATENCY', { latencyMs: legacyLatency, legacyServer: true })
        break
      }
      const timing = estimateServerTiming(msg.clientSentAt, msg.serverTime, receivedAt)
      store.updateServerTiming(timing.serverClockOffsetMs, timing.roundTripTimeMs)
      logDebug('in', 'LATENCY', { latencyMs: timing.roundTripTimeMs, serverClockOffsetMs: timing.serverClockOffsetMs })
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
          avatar: activeProfileAvatar(),
          clientId: store.currentUserId,
        })
      }
    } catch (_) {
      attemptReconnect()
    }
  }, delay)
}
