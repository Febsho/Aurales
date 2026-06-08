import { invoke } from '@tauri-apps/api/core'

export interface PlaybackRequest {
  url: string
  title?: string
  startTime?: number
  subtitleUrl?: string
}

export async function launchPlayer(request: PlaybackRequest): Promise<void> {
  try {
    await invoke('launch_mpv', {
      url: request.url,
      title: request.title || undefined,
      startTime: request.startTime || undefined,
    })
  } catch (e) {
    console.warn('Tauri invoke failed, trying web fallback:', e)
    window.open(request.url, '_blank')
  }
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function calculateProgress(current: number, total: number): number {
  if (total <= 0) return 0
  return (current / total) * 100
}

export function shouldMarkWatched(progress: number): boolean {
  return progress >= 85
}
