import type { ScoredStream, SmartScoreContext, SmartStream } from './streams/smartScoring'
import { readBoundedResponseJson } from './network/boundedResponse'

export interface MediaWorkerConfig {
  baseUrl: string
  apiKey: string
}

export interface MediaWorkerCapabilities {
  streamRanking: boolean
  mediaDirectProxy: boolean
  pmdbProxy: boolean
  mdblistProxy?: boolean
  traktProxy?: boolean
  torboxProxy?: boolean
  auralesSyncProxy?: boolean
  mediaRemux: boolean
  audioTranscode: boolean
  videoTranscode: boolean
}

export type MediaConversionMode = 'remux' | 'audioAac' | 'h264Aac'

export type MediaConversionStatus =
  | { jobId: string; status: 'processing' }
  | { jobId: string; status: 'failed'; error: string }
  | { jobId: string; status: 'ready'; mode: MediaConversionMode; bytes: number; url: string }

export async function createMediaSession(url: string, signal?: AbortSignal): Promise<{ url: string; expiresAt: number }> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/media/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url }),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await response.json() as { url?: unknown; expiresAt?: unknown }
  if (typeof data.url !== 'string' || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
    throw new Error('Media worker returned an invalid playback session.')
  }
  return { url: validateMediaSessionUrl(data.url, config.baseUrl), expiresAt: data.expiresAt }
}

export async function startMediaConversion(url: string, mode: MediaConversionMode, signal?: AbortSignal): Promise<string> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/media/conversions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ url, mode }),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await response.json() as { jobId?: unknown; status?: unknown }
  if (typeof data.jobId !== 'string' || !/^[a-f\d]{32}$/i.test(data.jobId) || data.status !== 'processing') {
    throw new Error('Media worker returned an invalid conversion job.')
  }
  return data.jobId
}

export async function getMediaConversionStatus(jobId: string, signal?: AbortSignal): Promise<MediaConversionStatus> {
  if (!/^[a-f\d]{32}$/i.test(jobId)) throw new Error('Invalid media conversion job ID.')
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/media/conversions/${jobId}`, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await response.json() as Record<string, unknown>
  if (data.jobId !== jobId || !['processing', 'ready', 'failed'].includes(String(data.status))) {
    throw new Error('Media worker returned an invalid conversion status.')
  }
  if (data.status === 'processing') return { jobId, status: 'processing' }
  if (data.status === 'failed') return { jobId, status: 'failed', error: typeof data.error === 'string' ? data.error : 'conversion_failed' }
  if (typeof data.bytes !== 'number' || !Number.isFinite(data.bytes) || typeof data.mode !== 'string' || !['remux', 'audioAac', 'h264Aac'].includes(data.mode) || typeof data.url !== 'string') {
    throw new Error('Media worker returned an invalid conversion result.')
  }
  return {
    jobId,
    status: 'ready',
    mode: data.mode as MediaConversionMode,
    bytes: data.bytes,
    url: validateMediaSessionUrl(data.url, config.baseUrl),
  }
}

export interface MediaWorkerProbeResult {
  status: number
  contentType?: string
  acceptRanges: boolean
  contentLength?: number
  sampledBytes: number
  elapsedMs: number
  finalUrl?: string
  error?: string
}

export interface ProviderProxyResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * Relay a PMDB API call through the user's configured worker when browser CORS
 * prevents direct access. The worker route is fixed to publicmetadb.com and
 * the PMDB key is forwarded only to that upstream origin.
 */
export async function proxyPmdbRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  providerApiKey: string,
  body?: string,
  signal?: AbortSignal,
): Promise<ProviderProxyResponse> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/providers/pmdb`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, path, apiKey: providerApiKey, body: body ?? null }),
    signal: signal ?? AbortSignal.timeout(32_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await readBoundedResponseJson<Partial<ProviderProxyResponse>>(
    response,
    32 * 1024 * 1024,
    'PMDB worker response',
  )
  if (!Number.isInteger(data.status) || typeof data.ok !== 'boolean' || typeof data.body !== 'string') {
    throw new Error('Media worker returned an invalid PMDB response.')
  }
  return { status: data.status as number, ok: data.ok, body: data.body }
}

/** Relay an MDBList API or OAuth call through the trusted configured worker. */
export async function proxyMdblistRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  credentials: { bearerToken?: string; apiKey?: string },
  body?: string,
  contentType = 'application/json',
  signal?: AbortSignal,
): Promise<ProviderProxyResponse> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/providers/mdblist`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, path, ...credentials, body: body ?? null, contentType }),
    signal: signal ?? AbortSignal.timeout(32_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await readBoundedResponseJson<Partial<ProviderProxyResponse>>(
    response,
    32 * 1024 * 1024,
    'MDBList worker response',
  )
  if (!Number.isInteger(data.status) || typeof data.ok !== 'boolean' || typeof data.body !== 'string') {
    throw new Error('Media worker returned an invalid MDBList response.')
  }
  return { status: data.status as number, ok: data.ok, body: data.body }
}

/** Relay Trakt browser requests only to its fixed API origin. */
export async function proxyTraktRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  signal?: AbortSignal,
): Promise<ProviderProxyResponse> {
  const target = new URL(url)
  if (target.origin !== 'https://api.trakt.tv' || target.username || target.password || target.hash) {
    throw new Error('Trakt worker requests must use the fixed HTTPS Trakt API origin.')
  }
  const allowedHeaders = new Set(['content-type', 'trakt-api-key', 'trakt-api-version', 'authorization'])
  const safeHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (!allowedHeaders.has(normalized) || value.length > 4096 || /[\r\n]/.test(value)) {
      throw new Error('Trakt worker request contains an unsupported header.')
    }
    safeHeaders[normalized] = value
  }
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/providers/trakt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, path: `${target.pathname}${target.search}`, headers: safeHeaders, body: body ?? null }),
    signal: signal ?? AbortSignal.timeout(32_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await readBoundedResponseJson<Partial<ProviderProxyResponse>>(
    response,
    32 * 1024 * 1024,
    'Trakt worker response',
  )
  if (!Number.isInteger(data.status) || typeof data.ok !== 'boolean' || typeof data.body !== 'string') {
    throw new Error('Media worker returned an invalid Trakt response.')
  }
  return { status: data.status as number, ok: data.ok, body: data.body }
}

/** Relay TorBox API calls through the user's authenticated, fixed-origin worker. */
export async function proxyTorboxRequest(
  method: 'GET' | 'POST',
  path: string,
  token?: string,
  body?: string,
  contentType = 'application/json',
  signal?: AbortSignal,
): Promise<ProviderProxyResponse> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/providers/torbox`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method, path, token: token || null, body: body ?? null, contentType }),
    signal: signal ?? AbortSignal.timeout(32_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await readBoundedResponseJson<Partial<ProviderProxyResponse>>(response, 20 * 1024 * 1024, 'TorBox worker response')
  if (!Number.isInteger(data.status) || typeof data.ok !== 'boolean' || typeof data.body !== 'string') {
    throw new Error('Media worker returned an invalid TorBox response.')
  }
  return { status: data.status as number, ok: data.ok, body: data.body }
}

/** Relay the existing Aurales Sync auth or batch API through this device's trusted worker. */
export async function proxyAuralesSyncRequest(
  path: '/v1/auth/login' | '/v1/auth/register' | '/v1/sync',
  body: string,
  bearerToken?: string,
  signal?: AbortSignal,
): Promise<ProviderProxyResponse> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/providers/aurales-sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ method: 'POST', path, bearerToken: bearerToken ?? null, body }),
    signal: signal ?? AbortSignal.timeout(35_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await readBoundedResponseJson<Partial<ProviderProxyResponse>>(response, 40 * 1024 * 1024, 'Aurales Sync worker response')
  if (!Number.isInteger(data.status) || typeof data.ok !== 'boolean' || typeof data.body !== 'string') {
    throw new Error('Media worker returned an invalid Aurales Sync response.')
  }
  return { status: data.status as number, ok: data.ok, body: data.body }
}

export async function probeStreamWithWorker(
  url: string,
  timeoutMs = 4_000,
  signal?: AbortSignal,
): Promise<MediaWorkerProbeResult | null> {
  const config = getMediaWorkerConfig()
  if (!config) return null
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/v1/media/probe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url, timeoutMs }),
      signal: signal ?? AbortSignal.timeout(Math.min(35_000, Math.max(8_000, timeoutMs + 5_000))),
    })
  } catch {
    return null
  }
  if (response.status === 503) return null
  if (response.status === 403) {
    return { status: 0, acceptRanges: false, sampledBytes: 0, elapsedMs: 0, error: 'This source host is not allowed by the configured media worker.' }
  }
  if (!response.ok) return null
  const data = await response.json() as Partial<MediaWorkerProbeResult>
  if (!Number.isInteger(data.status) || typeof data.acceptRanges !== 'boolean' || !Number.isFinite(data.sampledBytes) || !Number.isFinite(data.elapsedMs)) {
    return null
  }
  return {
    status: data.status as number,
    contentType: typeof data.contentType === 'string' ? data.contentType : undefined,
    acceptRanges: data.acceptRanges,
    contentLength: Number.isFinite(data.contentLength) ? data.contentLength : undefined,
    sampledBytes: data.sampledBytes as number,
    elapsedMs: data.elapsedMs as number,
    finalUrl: typeof data.finalUrl === 'string' ? data.finalUrl : undefined,
  }
}

const CONFIG_KEY = 'aurales_media_worker_secret_v1'

export function getMediaWorkerConfig(): MediaWorkerConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') as Partial<MediaWorkerConfig> | null
    if (!parsed || typeof parsed.baseUrl !== 'string' || typeof parsed.apiKey !== 'string') return null
    return parsed.baseUrl && parsed.apiKey ? { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey } : null
  } catch {
    return null
  }
}

export function saveMediaWorkerConfig(config: MediaWorkerConfig | null): void {
  if (!config) {
    localStorage.removeItem(CONFIG_KEY)
    return
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (config.apiKey.length < 32) throw new Error('Worker API key must contain at least 32 characters.')
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ baseUrl, apiKey: config.apiKey }))
}

export async function getMediaWorkerCapabilities(signal?: AbortSignal): Promise<MediaWorkerCapabilities> {
  const config = requireConfig()
  const response = await fetch(`${config.baseUrl}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  return await response.json() as MediaWorkerCapabilities
}

export async function rankStreamsWithWorker(
  streams: SmartStream[],
  context: SmartScoreContext,
  signal?: AbortSignal,
): Promise<ScoredStream[] | null> {
  const config = getMediaWorkerConfig()
  if (!config) return null
  const response = await fetch(`${config.baseUrl}/v1/streams/rank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ streams, context }),
    signal: signal ?? AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(workerError(response.status))
  const data = await response.json() as { candidates?: Array<{ stream: SmartStream; score: number; reasons: string[]; fingerprint: string }> }
  if (!Array.isArray(data.candidates) || data.candidates.length !== streams.length) {
    throw new Error('Media worker returned an invalid stream ranking response.')
  }
  return data.candidates.map((candidate) => {
    if (!candidate.stream || !Number.isFinite(candidate.score) || !Array.isArray(candidate.reasons) || typeof candidate.fingerprint !== 'string') {
      throw new Error('Media worker returned an invalid stream ranking candidate.')
    }
    return candidate
  }).sort((left, right) => right.score - left.score || left.fingerprint.localeCompare(right.fingerprint))
    .map(({ stream, score, reasons }) => ({ stream, score, reasons }))
}

function requireConfig(): MediaWorkerConfig {
  const config = getMediaWorkerConfig()
  if (!config) throw new Error('Configure the Aurales media worker URL and API key first.')
  return config
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL
  try { parsed = new URL(value.trim()) } catch { throw new Error('Worker URL must be a valid HTTPS URL.') }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Worker URL must use HTTPS, except for localhost development.')
  }
  if (parsed.pathname !== '/') throw new Error('Worker URL must be an origin without a path prefix.')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Worker URL cannot include credentials, query parameters, or a fragment.')
  }
  return parsed.toString().replace(/\/$/, '')
}

function validateMediaSessionUrl(value: string, baseUrl: string): string {
  const sessionUrl = new URL(value, `${baseUrl}/`)
  if (sessionUrl.origin !== baseUrl || !/^\/v1\/media\/[a-f\d]{32}$/i.test(sessionUrl.pathname) || !sessionUrl.searchParams.has('signature') || !sessionUrl.searchParams.has('expires')) {
    throw new Error('Media worker returned an unsafe playback session URL.')
  }
  return sessionUrl.toString()
}

function workerError(status: number): string {
  if (status === 401) return 'Worker rejected its API key. Check the saved key.'
  if (status === 413) return 'Worker rejected the request because it is too large.'
  if (status === 429) return 'Worker is busy. Try again shortly.'
  if (status === 503) return 'This media conversion mode is unavailable on the configured worker.'
  return `Aurales media worker request failed (${status}). Check its URL, TLS, and CORS configuration.`
}
