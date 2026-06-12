import { invoke } from '@tauri-apps/api/core'

export type MinimalHwdecMode = 'auto-safe' | 'no'

export interface MinimalPlayerState {
  running: boolean
  sessionId: string | null
  pid: number | null
  streamHash: string | null
  startedAtMs: number | null
}

interface MinimalPlayerInfo {
  sessionId: string
  pid: number
  streamHash: string
}

interface PlayOptions {
  title?: string
  startTime?: number
  hwdecMode?: MinimalHwdecMode
}

class MinimalMpvPlayer {
  private process: { pid: number } | null = null
  private sessionId: string | null = null
  private streamUrl: string | null = null
  private startPromise: Promise<MinimalPlayerInfo> | null = null

  private trace(action: string): void {
    console.debug(`[PLAYER CONTROL] ${action}`, new Error().stack)
  }

  async play(url: string, options: PlayOptions = {}): Promise<MinimalPlayerInfo> {
    this.trace('play')
    if (this.streamUrl === url && (this.process || this.startPromise)) {
      console.debug('[PLAYER DEBUG] duplicate play ignored for the active stream')
      if (this.startPromise) return this.startPromise
      return {
        sessionId: this.sessionId ?? 'active-minimal-session',
        pid: this.process?.pid ?? 0,
        streamHash: 'active',
      }
    }

    this.streamUrl = url
    this.startPromise = invoke<MinimalPlayerInfo>('launch_minimal_mpv', {
      url,
      title: options.title,
      startTime: options.startTime,
      hwdecMode: options.hwdecMode ?? 'auto-safe',
    })

    try {
      const info = await this.startPromise
      this.sessionId = info.sessionId
      this.process = { pid: info.pid }
      return info
    } catch (error) {
      this.process = null
      this.sessionId = null
      this.streamUrl = null
      throw error
    } finally {
      this.startPromise = null
    }
  }

  async stop(reason = 'user-request'): Promise<void> {
    this.trace(`stop:${reason}`)
    await invoke('stop_minimal_mpv', { reason })
    this.process = null
    this.sessionId = null
    this.streamUrl = null
  }

  async pause(): Promise<void> {
    this.trace('pause')
    await invoke('minimal_mpv_command', { command: 'set_property', args: ['pause', true] })
  }

  async resume(): Promise<void> {
    this.trace('resume')
    await invoke('minimal_mpv_command', { command: 'set_property', args: ['pause', false] })
  }

  async seek(seconds: number): Promise<void> {
    this.trace(`seek:${seconds}`)
    await invoke('minimal_mpv_command', { command: 'seek', args: [seconds, 'relative'] })
  }

  async getState(): Promise<MinimalPlayerState> {
    return invoke<MinimalPlayerState>('get_minimal_player_state')
  }
}

export const minimalMpvPlayer = new MinimalMpvPlayer()
