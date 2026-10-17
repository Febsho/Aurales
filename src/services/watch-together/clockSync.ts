export interface ServerTimingEstimate {
  roundTripTimeMs: number
  serverClockOffsetMs: number
}

/** NTP-style midpoint estimate using a client send/receive pair. */
export function estimateServerTiming(clientSentAt: number, serverTime: number, clientReceivedAt: number): ServerTimingEstimate {
  const roundTripTimeMs = Math.max(0, clientReceivedAt - clientSentAt)
  const clientMidpoint = clientSentAt + roundTripTimeMs / 2
  return {
    roundTripTimeMs,
    serverClockOffsetMs: serverTime - clientMidpoint,
  }
}

export function serverTimestampToLocal(serverTime: number, serverClockOffsetMs: number): number {
  return serverTime - serverClockOffsetMs
}

export function estimateRoomPosition(
  time: number,
  isPlaying: boolean,
  serverTime: number,
  serverClockOffsetMs: number,
  localNow = Date.now(),
): number {
  if (!isPlaying) return Math.max(0, time)
  const localAnchor = serverTimestampToLocal(serverTime, serverClockOffsetMs)
  return Math.max(0, time + Math.max(0, localNow - localAnchor) / 1000)
}
