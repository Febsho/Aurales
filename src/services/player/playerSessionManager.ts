import { minimalMpvPlayer, type MinimalHwdecMode, type MinimalPlayerState } from './minimalMpvPlayer'

class PlayerSessionManager {
  playIsolated(url: string, options: { title?: string; startTime?: number; hwdecMode?: MinimalHwdecMode } = {}) {
    return minimalMpvPlayer.play(url, options)
  }

  stopIsolated(reason?: string) {
    return minimalMpvPlayer.stop(reason)
  }

  getIsolatedState(): Promise<MinimalPlayerState> {
    return minimalMpvPlayer.getState()
  }
}

export const playerSessionManager = new PlayerSessionManager()
