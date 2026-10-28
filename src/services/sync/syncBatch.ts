import { invoke } from '@tauri-apps/api/core'
import { getMediaWorkerConfig, proxyAuralesSyncRequest } from '../mediaWorker'
import type { SyncRecord } from './syncQueue'

const SYNC_BATCH_TIMEOUT_MS = 30_000
const MAX_SYNC_RESPONSE_BYTES = 16 * 1024 * 1024

export interface SyncBatchInput {
  endpoint: string
  accessToken: string
  schemaVersion: number
  deviceId: string
  deviceName: string
  cursor?: string
  records: SyncRecord[]
  mode: 'sync' | 'download'
}

export interface SyncBatchResult {
  cursor?: string
  records: SyncRecord[]
  stale?: boolean
}

function nativeAvailable(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

// A WebView bridge can outlive the Rust binary that introduced sync_batch.
// Only this pre-dispatch error is safe to retry through fetch: any other
// native failure may have reached the server, and replaying it could duplicate
// a sync action.
function isMissingNativeCommand(error: unknown): boolean {
  const message = (typeof error === 'string' ? error : error instanceof Error ? error.message : '').trim()
  // Restrict this to the bridge's command-resolution wording. In particular,
  // do not treat text returned by a server (for example an HTTP 500 body) as
  // proof that no request was sent.
  return /^(?:command\s+[`'"]?sync_batch[`'"]?\s+(?:not found|not registered|does not exist)|unknown\s+command\s+[`'"]?sync_batch[`'"]?)$/i.test(message)
}

async function readSyncResponse(response: Response): Promise<{ cursor?: string; records: SyncRecord[] }> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Sync response has no readable body')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_SYNC_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('Sync response exceeded the 16 MiB limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid sync response')
  const envelope = body as { cursor?: unknown; records?: unknown }
  if (envelope.cursor != null && typeof envelope.cursor !== 'string') throw new Error('Invalid sync response cursor')
  if (envelope.records != null && !Array.isArray(envelope.records)) throw new Error('Invalid sync response records')
  if (Array.isArray(envelope.records) && envelope.records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
    throw new Error('Invalid sync response records')
  }
  return {
    cursor: typeof envelope.cursor === 'string' ? envelope.cursor : undefined,
    records: (envelope.records || []) as SyncRecord[],
  }
}

/** One account sync round-trip. IndexedDB outbox mutation and remote-record
 * application stay in the caller so existing user-data semantics are unchanged. */
export async function runSyncBatch(
  input: SyncBatchInput,
  fetcher: typeof fetch = fetch,
): Promise<SyncBatchResult> {
  if (nativeAvailable() && fetcher === fetch) {
    try {
      const response = await invoke<SyncBatchResult>('sync_batch', {
        request: {
          ...input,
          priority: 'interactive',
          cancelGroup: 'aurales-sync:account',
          timeoutMs: SYNC_BATCH_TIMEOUT_MS,
        },
      })
      if (response.stale) throw new DOMException('Sync request was superseded', 'AbortError')
      return { cursor: response.cursor, records: response.records || [] }
    } catch (error) {
      if (!isMissingNativeCommand(error)) throw error
      console.warn('[sync] Native sync batch is unavailable; using compatibility transport:', error)
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Sync request timed out', 'TimeoutError'))
  }, SYNC_BATCH_TIMEOUT_MS)
  try {
    const body = JSON.stringify({
      schemaVersion: input.schemaVersion,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      cursor: input.cursor,
      records: input.records,
    })
    const response = fetcher === fetch && getMediaWorkerConfig()
      ? await proxyAuralesSyncRequest('/v1/sync', body, input.accessToken, controller.signal).then((result) => {
        if (!result.ok) throw new Error(`${input.mode === 'download' ? 'Download' : 'Sync'} failed (${result.status})`)
        return new Response(result.body, { status: 200, headers: { 'content-type': 'application/json' } })
      })
      : await fetcher(`${input.endpoint.replace(/\/$/, '')}/v1/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.accessToken}` },
        body,
        signal: controller.signal,
      })
    if (!response.ok) throw new Error(`${input.mode === 'download' ? 'Download' : 'Sync'} failed (${response.status})`)
    return await readSyncResponse(response)
  } finally {
    clearTimeout(timeout)
  }
}
