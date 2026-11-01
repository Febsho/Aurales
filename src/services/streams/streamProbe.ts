import { invoke } from '@tauri-apps/api/core'
import { probeStreamWithWorker } from '../mediaWorker'

export interface StreamProbeResult {
  ok: boolean
  status: number // 0 = network/timeout error
  contentType?: string
  acceptsRanges: boolean
  contentLength?: number
  sampledBytes?: number
  elapsedMs?: number
  throughputMbps?: number
  finalUrl?: string // post-redirect URL — hand THIS to the player
  probedAt: number
  error?: string
}

interface StreamProbeResponse {
  status: number
  contentType: string | null
  acceptRanges: boolean
  contentLength: number | null
  finalUrl: string
  sampledBytes: number
  elapsedMs: number
}

const PROBE_TIMEOUT_MS = 4_000

// text/html means an expiry/error page pretending to be the video.
const PLAYABLE_CONTENT_TYPES = /^(video\/|audio\/|binary\/|application\/(octet-stream|x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|mp4))/i

function verdict(status: number, contentType?: string): boolean {
  if (status !== 200 && status !== 206 && status !== 416) return false
  if (!contentType) return true
  return PLAYABLE_CONTENT_TYPES.test(contentType.trim())
}

// Returns null when probing is unavailable (web build — arbitrary stream hosts
// don't send CORS headers, so a browser-side probe cannot succeed).
export async function probeStreamUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<StreamProbeResult | null> {
  if (typeof window === 'undefined') return null
  if (!(window as any).__TAURI_INTERNALS__) {
    const response = await probeStreamWithWorker(url, timeoutMs)
    if (!response) return null
    return {
      ok: verdict(response.status, response.contentType),
      status: response.status,
      contentType: response.contentType,
      acceptsRanges: response.acceptRanges,
      contentLength: response.contentLength,
      finalUrl: response.finalUrl,
      sampledBytes: response.sampledBytes,
      elapsedMs: response.elapsedMs,
      throughputMbps: response.elapsedMs > 0 ? (response.sampledBytes * 8) / response.elapsedMs / 1000 : undefined,
      probedAt: Date.now(),
      error: response.error,
    }
  }
  try {
    const response = await invoke<StreamProbeResponse>('http_probe_stream', { url, timeoutMs })
    return {
      ok: verdict(response.status, response.contentType ?? undefined),
      status: response.status,
      contentType: response.contentType ?? undefined,
      acceptsRanges: response.acceptRanges,
      contentLength: response.contentLength ?? undefined,
      finalUrl: response.finalUrl || undefined,
      sampledBytes: response.sampledBytes,
      elapsedMs: response.elapsedMs,
      throughputMbps: response.elapsedMs > 0 ? (response.sampledBytes * 8) / response.elapsedMs / 1000 : undefined,
      probedAt: Date.now(),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      acceptsRanges: false,
      probedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
