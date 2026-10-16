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
import { createRoomStream, isSameRoomStream, resolveLocalSourceCandidates } from './streamMatcher'
import type { LocalSourceCandidate, PendingRoomSync } from '../../stores/watchTogetherStore'
import { estimateRoomPosition, estimateServerTiming, serverTimestampToLocal } from './clockSync'
import { getActiveProfile } from '../profiles'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempt = 0
let reconnectControlGeneration = 0
let reconnectAttemptGeneration = 0
let reconnectEnabled = false
let lastServerUrl = ''
let connectionPromise: Promise<void> | null = null
let rejectConnection: ((reason: Error) => void) | null = null
let sourceResolveController: AbortController | null = null
const MAX_WATCH_TOGETHER_MESSAGE_CHARS = 1024 * 1024
const MAX_WATCH_TOGETHER_DEBUG_DATA_CHARS = 8 * 1024

// Live playback position reported by whichever player component is active.
// The room's stored playback state only changes on discrete events (play,
// pause, seek), so the sync loop must NOT use it as the host position —
// that would rubber-band every guest back to the last event timestamp.
let localPlayback: { time: number; isPlaying: boolean; updatedAt: number } | null = null

async function activeProfileAvatar(): Promise<string | undefined> {
  const profile = getActiveProfile()
  if (!profile.avatarRef) return profile.avatar
  try {
    const { getProfileAvatar } = await import('../../data/profileAvatars')
    return getProfileAvatar(profile.avatarRef)?.imageUrl || profile.avatar
  } catch (_) {
    return profile.avatar
  }
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
  let boundedData = data
  if (data !== undefined) {
    try {
      const serialized = JSON.stringify(data)
      if (serialized.length > MAX_WATCH_TOGETHER_DEBUG_DATA_CHARS) {
        boundedData = { truncated: true, preview: serialized.slice(0, MAX_WATCH_TOGETHER_DEBUG_DATA_CHARS) }
      }
    } catch (_) {
      boundedData = { unavailable: 'Debug payload could not be serialized' }
    }
  }
  getStore().addDebugLog({ timestamp: Date.now(), direction, event, data: boundedData })
}

// ── Connection ──────────────────────────────────────────────────────────────

export function connect(serverUrl: string): Promise<void> {
  reconnectControlGeneration++
  reconnectEnabled = true
  return connectToServer(serverUrl)
}

function connectToServer(serverUrl: string): Promise<void> {
  clearReconnectTimer()
  if (lastServerUrl && lastServerUrl !== serverUrl) reconnectAttempt = 0
  if (ws && lastServerUrl === serverUrl) {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
    if (ws.readyState === WebSocket.CONNECTING && connectionPromise) return connectionPromise
  }

  // A saved server URL can change while the old socket is open or connecting.
  // Close that socket before making a new one, and settle any callers waiting
  // for its connection attempt instead of leaving them pending.
  if (ws) {
    rejectConnection?.(new Error('Connection target changed'))
    ws.onclose = null
    ws.onerror = null
    try { ws.close() } catch (_) {}
    ws = null
  }
  stopPingLoop()
  stopSyncLoop()

  lastServerUrl = serverUrl
  const promise = new Promise<void>((resolve, reject) => {
    let socket: WebSocket
    getStore().setConnectionStatus('connecting')

    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return false
      settled = true
      clearTimeout(timeout)
      if (connectionPromise === promise) {
        connectionPromise = null
        rejectConnection = null
      }
      callback()
      return true
    }
    const timeout = setTimeout(() => {
      if (!settled) {
        settle(() => reject(new Error('Connection timed out — is the Watch Together server running?')))
        getStore().setConnectionStatus('disconnected')
        if (ws === socket) {
          try { socket.close() } catch (_) {}
          ws = null
        }
      }
    }, 8000)
    rejectConnection = (reason) => { settle(() => reject(reason)) }

    try {
      socket = new WebSocket(serverUrl)
      ws = socket
    } catch (err) {
      clearTimeout(timeout)
      settled = true
      connectionPromise = null
      rejectConnection = null
      getStore().setConnectionStatus('disconnected')
      reject(err)
      return
    }

    socket.onopen = () => {
      if (ws !== socket || !settle(() => resolve())) return
      reconnectAttempt = 0
      getStore().setConnectionStatus('connected')
      startPingLoop()
      ping()
      logDebug('in', 'CONNECTED')
    }

    socket.onmessage = (event) => {
      if (ws !== socket) return
      if (typeof event.data !== 'string') {
        logDebug('in', 'INVALID_MESSAGE', { reason: 'non-text websocket frame' })
        return
      }
      if (event.data.length > MAX_WATCH_TOGETHER_MESSAGE_CHARS) {
        logDebug('in', 'MESSAGE_TOO_LARGE', { characters: event.data.length })
        return
      }
      try {
        const msg: ServerMessage = JSON.parse(event.data)
        logDebug('in', msg.type, msg)
        handleServerMessage(msg)
      } catch (_) {
        logDebug('in', 'PARSE_ERROR', { characters: event.data.length, preview: event.data.slice(0, 512) })
      }
    }

    socket.onclose = (event) => {
      if (ws !== socket) return
      logDebug('in', 'CLOSE', { code: event.code, reason: event.reason })
      stopPingLoop()
      stopSyncLoop()
      ws = null

      if (!settled) {
        settle(() => reject(new Error('Connection closed before opening')))
        getStore().setConnectionStatus('disconnected')
        return
      }

      const store = getStore()
      if (store.connectionStatus !== 'disconnected' && reconnectEnabled) {
        store.setConnectionStatus('reconnecting')
        attemptReconnect()
      }
    }

    socket.onerror = (event) => {
      if (ws !== socket) return
      logDebug('in', 'ERROR', { message: (event as ErrorEvent).message ?? 'unknown' })
      if (!settled) {
        settle(() => reject(new Error('Failed to connect to Watch Together server')))
        getStore().setConnectionStatus('disconnected')
        try { socket.close() } catch (_) {}
        ws = null
      }
    }
  })
  connectionPromise = promise
  return promise
}

export function disconnect(): void {
  reconnectControlGeneration++
  reconnectEnabled = false
  clearReconnectTimer()
  stopSyncLoop()
  stopPingLoop()
  rejectConnection?.(new Error('Connection cancelled'))
  connectionPromise = null
  rejectConnection = null
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
  const avatar = await activeProfileAvatar()
  send({
    type: 'ROOM_JOIN',
    roomCode: '',
    name,
    avatar,
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
      if (state.errors !== prev.errors && state.errors.length > 0) {
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
  const avatar = await activeProfileAvatar()
  send({
    type: 'ROOM_JOIN',
    roomCode: code,
    name,
    avatar,
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
      if (state.errors !== prev.errors && state.errors.length > 0) {
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
  if (getStore().isHost) selectStream(createRoomStream({ ...candidate.stream, addonId: candidate.addonId }))
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
  // A one-second position beacon keeps normal drift below the correction
  // threshold without making the room server carry video traffic.
  const intervalMs = Math.max(500, getStore().syncInterval * 1000)
  const broadcastPosition = () => {
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
  }
  broadcastPosition()
  syncTimer = setInterval(broadcastPosition, intervalMs)
}

// Settings are available while the host is already in a room. Restart the
// timer immediately when the interval changes instead of silently retaining
// the value captured at room join.
useWatchTogetherStore.subscribe((state, previous) => {
  if (state.syncInterval !== previous.syncInterval && state.isHost && state.currentRoom) {
    startSyncLoop()
  }
})

export function stopSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

export function startPingLoop(): void {
  stopPingLoop()
  pingTimer = setInterval(ping, 10_000)
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
  sourceResolveController?.abort()
  sourceResolveController = new AbortController()
  const signal = sourceResolveController.signal
  const generation = store.beginSourceResolution()
  sendLocalSourceStatus('resolving')
  try {
    logDebug('out', 'AUTO_RESOLVE_START', { media: m.title, generation })
    const candidates = await resolveLocalSourceCandidates(m, ep, signal)
    if (signal.aborted) return false
    const isHostNow = getStore().isHost
    // The host publishes a non-sensitive release fingerprint. Put an exact
    // local match first; other valid sources remain fallbacks in case a peer
    // does not have that addon or its link has expired.
    const orderedCandidates = !isHostNow && hostStream
      ? (() => {
          const exact = candidates.filter((candidate) => isSameRoomStream({ ...candidate.stream, addonId: candidate.addonId }, hostStream))
          // Keep every verified source as a fallback. A guest may not have the
          // host addon, and a source URL can expire independently per device.
          return exact.length ? [...exact, ...candidates.filter((candidate) => !exact.includes(candidate))] : candidates
        })()
      : candidates
    if (!getStore().setLocalSourceCandidates(generation, orderedCandidates)) return false
    const match = orderedCandidates[0]
    if (match) {
      // Publish the host's release after it has passed local resolution. This
      // lets guests select the same release without ever exposing its URL.
      if (isHostNow) selectStream(createRoomStream({ ...match.stream, addonId: match.addonId }))
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
  // A queued server broadcast can arrive after ROOM_LEAVE. Do not dispatch a
  // room correction into a player that is now playing outside Watch Together.
  if (!store.currentRoom) return
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
      const roomChanged = store.currentRoom?.id !== msg.room.id
      // A room can change while source discovery is still awaiting addon
      // responses. Invalidate it before publishing the new room so a late
      // result cannot select a stream in the wrong room.
      sourceResolveController?.abort()
      sourceResolveController = null
      stopSyncLoop()
      if (roomChanged) {
        clearLocalPlayback()
        store.clearLocalSource()
      }
      store.setCurrentRoom(msg.room)
      store.setCurrentUserId(msg.userId)
      store.setIsHost(msg.room.hostUserId === msg.userId)
      store.setRoomPanelOpen(true)
      if (msg.room.hostUserId === msg.userId) {
        startSyncLoop()
      } else {
        stopSyncLoop()
      }
      if (msg.room.selectedMedia) {
        autoResolveStream(msg.room.selectedMedia, msg.room.selectedEpisode, msg.room.selectedStream)
      }
      break
    }

    case 'ROOM_STATE':
      // Ignore delayed broadcasts after leaving, or from a room that has
      // already been replaced by another join.
      if (!store.currentRoom || store.currentRoom.id !== msg.room.id) break
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
      const streamChanged = msg.stream?.streamFingerprint !== store.currentRoom?.selectedStream?.streamFingerprint
        || msg.stream?.infoHash !== store.currentRoom?.selectedStream?.infoHash
      store.updateMedia(msg.media, msg.episode, msg.stream)
      // A host can select the same title again after stopping/cancelling it.
      // The media identity is then unchanged, but the server has reset the
      // room's ready state and the old local source may have expired.  The
      // initial selection deliberately has no stream; treat it as a fresh
      // selection on every client so both peers resolve and see the restart.
      if (msg.media && (mediaChanged || !msg.stream || (streamChanged && !store.isHost))) {
        autoResolveStream(msg.media, msg.episode, msg.stream)
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
  if (!reconnectEnabled) return
  clearReconnectTimer()
  const generation = reconnectControlGeneration
  const attemptGeneration = ++reconnectAttemptGeneration
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30_000)
  reconnectAttempt++
  logDebug('out', 'RECONNECT_SCHEDULED', { attempt: reconnectAttempt, delayMs: delay })

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (!reconnectEnabled || generation !== reconnectControlGeneration || attemptGeneration !== reconnectAttemptGeneration) return
    try {
      await connectToServer(lastServerUrl)
      if (!reconnectEnabled || generation !== reconnectControlGeneration || attemptGeneration !== reconnectAttemptGeneration) return
      const store = getStore()
      if (store.currentRoom && store.currentUserId) {
        const roomId = store.currentRoom.id
        const roomCode = store.currentRoom.code
        const userId = store.currentUserId
        const name = store.defaultNickname || 'Reconnecting...'
        const avatar = await activeProfileAvatar()
        const latest = getStore()
        // Avatar resolution can outlive the room/session that initiated the
        // rejoin. Never send a stale ROOM_JOIN after leave, room replacement,
        // disconnect, or a newer reconnect attempt.
        if (!reconnectEnabled
          || generation !== reconnectControlGeneration
          || attemptGeneration !== reconnectAttemptGeneration
          || ws?.readyState !== WebSocket.OPEN
          || latest.currentRoom?.id !== roomId
          || latest.currentUserId !== userId) return
        send({
          type: 'ROOM_JOIN',
          roomCode,
          name,
          avatar,
          clientId: userId,
        })
      }
    } catch (_) {
      if (reconnectEnabled && generation === reconnectControlGeneration) attemptReconnect()
    }
  }, delay)
}
