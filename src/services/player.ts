import { invoke } from '@tauri-apps/api/core'

// The embedded libmpv overlay player is Windows-only (HWND child window +
// D3D11 + WASAPI). On Linux/macOS the in-app HTML5 player is used instead.
export function nativePlayerSupported(): boolean {
  return !!(window as any).__TAURI_INTERNALS__ && navigator.userAgent.includes('Windows')
}

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

export interface PlayerSnapshot {
  timePos: number | null
  duration: number | null
  paused: boolean | null
  buffering: boolean | null
  cacheBufferingState: number | null
  demuxerCacheDuration: number | null
  eofReached: boolean | null
  idleActive: boolean | null
  coreIdle: boolean | null
}

export interface ThumbnailGenerationRequest {
  streamUrl: string
  cacheKey: string
  duration?: number
  fastInterval?: number
  refinedInterval?: number
  thumbnailWidth?: number
  thumbnailHeight?: number
  columns?: number
  rows?: number
  quality?: number
  thumbnailInterval?: number
  maxConcurrentFfmpegWorkers?: number
}

export interface ThumbnailMetadata {
  cacheKey: string
  interval: number
  thumbnailWidth: number
  thumbnailHeight: number
  columns: number
  rows: number
  duration?: number
  thumbnailPaths?: string[]
  sprites: string[]
  spriteThumbnailCounts?: number[]
  thumbnailCount?: number
  status: string
}

export interface ScrubThumbnailRequest {
  mediaId: string
  streamUrl: string
  duration?: number
  time: number
  thumbnailInterval?: number
  thumbnailWidth?: number
  thumbnailHeight?: number
  quality?: number
  maxConcurrentFfmpegWorkers?: number
}

export interface ScrubThumbnailResponse {
  cacheKey: string
  status: 'ready' | 'nearest' | 'generating' | string
  requestedTime: number
  requestedIndex: number
  exactPath?: string
  nearestPath?: string
  nearestIndex?: number
  metadata: ThumbnailMetadata
}

export async function launchPlayer(request: PlaybackRequest): Promise<void> {
  await invoke('launch_mpv', {
    url: request.url,
    title: request.title || undefined,
    startTime: request.startTime || undefined,
  })
}

// Which feature currently owns the (singleton) embedded mpv instance. The
// hero trailer must not stop a player the real playback UI has claimed.
let embeddedPlayerOwner: 'player' | 'hero-trailer' = 'player'

export function getEmbeddedPlayerOwner(): 'player' | 'hero-trailer' {
  return embeddedPlayerOwner
}

export async function stopEmbeddedPlayerIfOwner(owner: 'player' | 'hero-trailer'): Promise<void> {
  if (embeddedPlayerOwner !== owner) return
  await stopEmbeddedPlayer()
}

export async function launchEmbeddedPlayer(request: PlaybackRequest, owner: 'player' | 'hero-trailer' = 'player'): Promise<void> {
  embeddedPlayerOwner = owner
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

export async function startThumbnailGeneration(request: ThumbnailGenerationRequest): Promise<ThumbnailMetadata | null> {
  return await invoke('start_thumbnail_generation', { request })
}

export async function getThumbnailMetadata(cacheKey: string): Promise<ThumbnailMetadata | null> {
  return await invoke('get_thumbnail_metadata', { cacheKey })
}

export async function getOrQueueScrubThumbnail(request: ScrubThumbnailRequest): Promise<ScrubThumbnailResponse> {
  return await invoke('get_or_queue_scrub_thumbnail', { request })
}

export async function prefetchThumbnailSprite(path: string): Promise<void> {
  await invoke('prefetch_thumbnail_sprite', { path })
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

export async function getPlayerSnapshot(): Promise<PlayerSnapshot> {
  return await invoke<PlayerSnapshot>('get_player_snapshot')
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

export async function extractEmbeddedSubtitle(url: string, subIndex: number): Promise<string> {
  return await invoke('extract_embedded_subtitle', { url, subIndex })
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
