import { invoke } from '@tauri-apps/api/core'

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
  content_type: string | null
  accept_ranges: boolean
  content_length: number | null
  final_url: string
  sampled_bytes: number
  elapsed_ms: number
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
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return null
  try {
    const response = await invoke<StreamProbeResponse>('http_probe_stream', { url, timeoutMs })
    return {
      ok: verdict(response.status, response.content_type ?? undefined),
      status: response.status,
      contentType: response.content_type ?? undefined,
      acceptsRanges: response.accept_ranges,
      contentLength: response.content_length ?? undefined,
      finalUrl: response.final_url || undefined,
      sampledBytes: response.sampled_bytes,
      elapsedMs: response.elapsed_ms,
      throughputMbps: response.elapsed_ms > 0 ? (response.sampled_bytes * 8) / response.elapsed_ms / 1000 : undefined,
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
