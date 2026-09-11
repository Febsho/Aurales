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

/** One account sync round-trip. IndexedDB outbox mutation and remote-record
 * application stay in the caller so existing user-data semantics are unchanged. */
export async function runSyncBatch(
  input: SyncBatchInput,
  fetcher: typeof fetch = fetch,
): Promise<SyncBatchResult> {
  if (nativeAvailable() && fetcher === fetch) {
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
