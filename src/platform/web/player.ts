/** Browser implementation of the shared player service boundary.
 *
 * The desktop implementation remains in `src/services/player.ts`. Keeping
 * these functions at the same import boundary lets shared React components
 * ask about native capabilities without shipping mpv IPC into browser assets.
 */

export interface PlaybackRequest {
  url: string
  title?: string
  startTime?: number
  subtitleUrl?: string
  volume?: number
  hwdecMode?: string
  videoCacheMode?: 'memory' | 'disk' | 'auto'
  mpvCustomArgs?: string
  viewport?: { x: number; y: number; width: number; height: number }
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

type EmbeddedPlayerOwner = 'player' | 'hero-trailer' | `hero-trailer-${string}`

const unsupported = (operation: string): Error => new Error(`${operation} is available only in the Aurales desktop player`)

export function nativePlayerSupported(): boolean { return false }
export async function resolveNativePlayerSupported(): Promise<boolean> { return false }
export function nativeTrailerPlayerSupported(): boolean { return false }
export function getEmbeddedPlayerOwner(): EmbeddedPlayerOwner | null { return null }
export async function stopEmbeddedPlayerIfOwner(_owner: EmbeddedPlayerOwner): Promise<void> {}

export async function launchPlayer(_request: PlaybackRequest): Promise<void> { throw unsupported('Launching an external native player') }
export async function launchEmbeddedPlayer(_request: PlaybackRequest, _owner?: EmbeddedPlayerOwner): Promise<void> { throw unsupported('Embedded mpv playback') }
export async function sendPlayerCommand(_command: string, _args: unknown[] = []): Promise<void> { throw unsupported('Native player commands') }
export async function requestPlayerThumbnail(_time: number): Promise<void> { throw unsupported('Native player thumbnails') }
export async function clearPlayerThumbnail(): Promise<void> {}
export async function startThumbnailGeneration(_request: ThumbnailGenerationRequest): Promise<ThumbnailMetadata | null> { return null }
export async function getThumbnailMetadata(_cacheKey: string): Promise<ThumbnailMetadata | null> { return null }
export async function getOrQueueScrubThumbnail(_request: ScrubThumbnailRequest): Promise<ScrubThumbnailResponse> { throw unsupported('Native scrub thumbnails') }
export async function prefetchThumbnailSprite(_path: string): Promise<void> {}
export async function resizeEmbeddedPlayer(_viewport: NonNullable<PlaybackRequest['viewport']>): Promise<void> { throw unsupported('Native player window sizing') }
export async function stopEmbeddedPlayer(): Promise<void> {}
export async function getPlayerProperty(_property: string): Promise<unknown> { throw unsupported('Native player properties') }
export async function getPlayerSnapshot(): Promise<PlayerSnapshot> {
  return {
    timePos: null,
    duration: null,
    paused: null,
    buffering: null,
    cacheBufferingState: null,
    demuxerCacheDuration: null,
    eofReached: null,
    idleActive: null,
    coreIdle: null,
  }
}
export async function isEmbeddedPlayerRunning(): Promise<boolean> { return false }
export async function downloadSubtitle(_url: string, _fileName: string): Promise<string> { throw unsupported('Native subtitle downloads') }
export async function writeTempSubtitle(_content: string, _extension = 'srt'): Promise<string> { throw unsupported('Native temporary subtitle files') }
export async function readTempSubtitle(_path: string): Promise<string> { throw unsupported('Native temporary subtitle files') }
export async function updateTempSubtitle(_path: string, _content: string): Promise<void> { throw unsupported('Native temporary subtitle files') }
export async function extractEmbeddedSubtitle(_url: string, _subIndex: number): Promise<string> { throw unsupported('Embedded subtitle extraction') }
export async function openRouterChat(_apiKey: string, _requestBody: Record<string, unknown>): Promise<string> { throw unsupported('Desktop OpenRouter transport') }

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function calculateProgress(current: number, total: number): number {
  return total <= 0 ? 0 : (current / total) * 100
}

export function shouldMarkWatched(progress: number): boolean { return progress >= 80 }
