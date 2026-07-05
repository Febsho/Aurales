import { invoke } from '@tauri-apps/api/core'

export interface PlaybackRequest {
  url: string
  title?: string
  startTime?: number
  subtitleUrl?: string
  volume?: number
  hwdecMode?: string
  cacheBufferSize?: string
  mpvCacheSecs?: number
  mpvNetworkTimeout?: number
  mpvCustomArgs?: string
  viewport?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export async function launchPlayer(request: PlaybackRequest): Promise<void> {
  await invoke('launch_mpv', {
    url: request.url,
    title: request.title || undefined,
    startTime: request.startTime || undefined,
  })
}

export async function launchEmbeddedPlayer(request: PlaybackRequest): Promise<void> {
  await invoke('launch_embedded_mpv', {
    url: request.url,
    title: request.title || undefined,
    startTime: request.startTime || undefined,
    volume: request.volume ?? undefined,
    hwdecMode: request.hwdecMode || undefined,
    cacheBufferSize: request.cacheBufferSize || undefined,
    mpvCacheSecs: request.mpvCacheSecs || undefined,
    mpvNetworkTimeout: request.mpvNetworkTimeout || undefined,
    mpvCustomArgs: request.mpvCustomArgs || undefined,
    x: request.viewport?.x,
    y: request.viewport?.y,
    width: request.viewport?.width,
    height: request.viewport?.height,
  })
}

export async function sendPlayerCommand(command: string, args: unknown[] = []): Promise<void> {
  await invoke('mpv_command', { command, args })
}

export async function requestPlayerThumbnail(time: number): Promise<void> {
  await invoke('request_player_thumbnail', { time })
}

export async function clearPlayerThumbnail(): Promise<void> {
  await invoke('clear_player_thumbnail')
}

export async function resizeEmbeddedPlayer(viewport: NonNullable<PlaybackRequest['viewport']>): Promise<void> {
  await invoke('resize_embedded_mpv', {
    x: viewport.x,
    y: viewport.y,
    width: viewport.width,
    height: viewport.height,
  })
}

export async function stopEmbeddedPlayer(): Promise<void> {
  await invoke('stop_embedded_mpv')
}

export async function getPlayerProperty(property: string): Promise<unknown> {
  return await invoke('mpv_get_property', { property })
}

export async function isEmbeddedPlayerRunning(): Promise<boolean> {
  return await invoke<boolean>('get_embedded_player_running')
}

export async function downloadSubtitle(url: string, fileName: string): Promise<string> {
  return await invoke('download_subtitle', { url, fileName })
}

export async function writeTempSubtitle(content: string, extension = 'srt'): Promise<string> {
  return await invoke('write_temp_subtitle', { content, extension })
}

export async function readTempSubtitle(path: string): Promise<string> {
  return await invoke('read_temp_subtitle', { path })
}

export async function updateTempSubtitle(path: string, content: string): Promise<void> {
  await invoke('update_temp_subtitle', { path, content })
}

export async function openRouterChat(apiKey: string, requestBody: Record<string, unknown>): Promise<string> {
  return await invoke('openrouter_chat', { apiKey, requestBody })
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
