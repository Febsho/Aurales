let lastCorrectionTime = 0

export function shouldCorrectDrift(
  localTime: number,
  roomPlayback: { currentTime: number; isPlaying: boolean; lastUpdatedAt: number },
  threshold: number,
  cooldownMs: number,
): { shouldSeek: boolean; targetTime: number } {
  const elapsedMs = Number.isFinite(roomPlayback.lastUpdatedAt)
    ? Math.max(0, Date.now() - roomPlayback.lastUpdatedAt)
    : 0
  const estimatedRoomTime = roomPlayback.isPlaying
    ? roomPlayback.currentTime + elapsedMs / 1000
    : roomPlayback.currentTime

  const drift = Math.abs(localTime - estimatedRoomTime)
  const cooldownPassed = Date.now() - lastCorrectionTime > cooldownMs

  if (drift > threshold && cooldownPassed) {
    return { shouldSeek: true, targetTime: estimatedRoomTime }
  }

  return { shouldSeek: false, targetTime: estimatedRoomTime }
}

export function markCorrectionApplied(): void {
  lastCorrectionTime = Date.now()
}

export function resetDriftState(): void {
  lastCorrectionTime = 0
}
