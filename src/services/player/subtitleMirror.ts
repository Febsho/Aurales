interface MirrorReadiness {
  isCurrent: () => boolean
  isReady: () => boolean
  readState: () => Promise<{ hasEmbeddedSubtitles: boolean; bufferedSeconds: number | null }>
}

// The second media connection must not compete with cold-start buffering.
// A bounded wait leaves ordinary embedded subtitles available if it expires.
export async function waitForSubtitleMirror({ isCurrent, isReady, readState }: MirrorReadiness): Promise<boolean> {
  for (let attempt = 0; attempt < 30 && isCurrent(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (!isCurrent()) return false
    if (!isReady()) continue
    const state = await readState()
    if (!isCurrent() || !state.hasEmbeddedSubtitles) return false
    if (state.bufferedSeconds !== null && state.bufferedSeconds >= 3) return true
  }
  return false
}
