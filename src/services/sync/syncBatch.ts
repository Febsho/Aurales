import { invoke } from '@tauri-apps/api/core'
import type { SyncRecord } from './syncQueue'

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
          timeoutMs: 30_000,
        },
      })
      if (response.stale) throw new DOMException('Sync request was superseded', 'AbortError')
      return { cursor: response.cursor, records: response.records || [] }
    } catch (error) {
      if (!isMissingNativeCommand(error)) throw error
      console.warn('[sync] Native sync batch is unavailable; using compatibility transport:', error)
    }
  }

  const response = await fetcher(`${input.endpoint.replace(/\/$/, '')}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${input.accessToken}` },
    body: JSON.stringify({
      schemaVersion: input.schemaVersion,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      cursor: input.cursor,
      records: input.records,
    }),
  })
  if (!response.ok) throw new Error(`${input.mode === 'download' ? 'Download' : 'Sync'} failed (${response.status})`)
  const body = await response.json() as { cursor?: string; records?: SyncRecord[] }
  return { cursor: body.cursor, records: body.records || [] }
}
