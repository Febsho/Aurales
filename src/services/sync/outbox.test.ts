import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncRecord } from './auralesSync'

/**
 * WebKit gives localStorage roughly 5 MB per origin and throws
 * QuotaExceededError past it. The desktop app hit exactly this: the sync queue
 * lived in localStorage, and one encrypted-vault record per profile is a base64
 * copy of that profile's whole stored state.
 */
const LOCAL_STORAGE_QUOTA_BYTES = 5_000_000

function createLocalStorage(quotaBytes: number) {
  const entries = new Map<string, string>()
  const used = () => [...entries.entries()].reduce((total, [key, value]) => total + key.length + value.length, 0)
  return {
    get length() { return entries.size },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => { entries.delete(key) },
    clear: () => entries.clear(),
    setItem(key: string, value: string) {
      const next = used() - (entries.get(key)?.length ?? 0) - (entries.has(key) ? key.length : 0) + key.length + value.length
      if (next > quotaBytes) { const error = new Error('The quota has been exceeded.'); error.name = 'QuotaExceededError'; throw error }
      entries.set(key, value)
    },
    bytesUsed: used,
  }
}

/** Just enough IndexedDB for a single keyed value store. */
function createIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>()
  const settle = <T,>(request: { onsuccess?: (() => void) | null; onerror?: (() => void) | null; result?: T }, result: T) => {
    request.result = result
    queueMicrotask(() => request.onsuccess?.())
  }
  return {
    open(name: string) {
      const request: Record<string, unknown> = { onupgradeneeded: null, onsuccess: null, onerror: null }
      const isNew = !stores.has(name)
      if (isNew) stores.set(name, new Map())
      const store = stores.get(name)!
      const db = {
        close: () => {},
        createObjectStore: () => ({}),
        transaction: (_store: string, _mode?: string) => {
          const transaction: Record<string, unknown> = { oncomplete: null, onerror: null }
          const objectStore = {
            get: (key: string) => { const getRequest: Record<string, unknown> = { onsuccess: null, onerror: null }; settle(getRequest as never, store.get(key)); return getRequest },
            put: (value: unknown, key: string) => { store.set(key, value); queueMicrotask(() => (transaction.oncomplete as (() => void) | null)?.()); return {} },
          }
          transaction.objectStore = () => objectStore
          return transaction
        },
      }
      request.result = db
      queueMicrotask(() => {
        if (isNew) (request.onupgradeneeded as (() => void) | null)?.()
        ;(request.onsuccess as (() => void) | null)?.()
      })
      return request
    },
    stores,
  }
}

const vaultRecord = (index: number, bytes: number): SyncRecord => ({
  recordId: `profile-${index}:encrypted-vault:vault`,
  profileId: `profile-${index}`,
  type: 'encrypted-vault',
  payload: { algorithm: 'AES-GCM', ciphertext: 'A'.repeat(bytes) },
  updatedAt: '2026-08-30T09:00:00.000Z',
  deviceId: 'device',
  version: 1,
  schemaVersion: 1,
})

let storage: ReturnType<typeof createLocalStorage>

beforeEach(() => {
  vi.resetModules()
  storage = createLocalStorage(LOCAL_STORAGE_QUOTA_BYTES)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('indexedDB', createIndexedDb())
})
afterEach(() => vi.unstubAllGlobals())

describe('sync outbox storage', () => {
  it('queues more vault records than localStorage could ever hold', async () => {
    const { getOutboxRecords, outboxReady, putOutboxRecord } = await import('./outbox')
    await outboxReady()

    // Thirteen profiles, each a 900 KB vault: ~11.7 MB, far past the 5 MB cap.
    for (let index = 0; index < 13; index += 1) putOutboxRecord(vaultRecord(index, 900_000))

    expect(getOutboxRecords()).toHaveLength(13)
    // The queue must not consume the localStorage the rest of the app needs.
    expect(storage.bytesUsed()).toBe(0)
  })

  it('reproduces the failure the old localStorage queue hit', () => {
    const queue = Array.from({ length: 13 }, (_, index) => vaultRecord(index, 900_000))
    expect(() => storage.setItem('aurales_sync_outbox_v1', JSON.stringify(queue)))
      .toThrowError('The quota has been exceeded.')
  })

  it('migrates a stuck localStorage queue and frees the space it held', async () => {
    const stranded = Array.from({ length: 3 }, (_, index) => vaultRecord(index, 1_000))
    storage.setItem('aurales_sync_outbox_v1', JSON.stringify(stranded))
    expect(storage.bytesUsed()).toBeGreaterThan(3_000)

    const { getOutboxRecords, outboxReady } = await import('./outbox')
    await outboxReady()

    expect(getOutboxRecords().map((record) => record.recordId)).toEqual(stranded.map((record) => record.recordId))
    expect(storage.getItem('aurales_sync_outbox_v1')).toBeNull()
    expect(storage.bytesUsed()).toBe(0)
  })

  it('compacts repeated edits of one record instead of accumulating them', async () => {
    const { getOutboxRecords, outboxReady, putOutboxRecord } = await import('./outbox')
    await outboxReady()
    for (let index = 0; index < 50; index += 1) putOutboxRecord({ ...vaultRecord(0, 10), payload: { seconds: index } })
    const records = getOutboxRecords()
    expect(records).toHaveLength(1)
    expect(records[0].payload).toEqual({ seconds: 49 })
  })

  it('survives a storage write failure instead of aborting the sync', async () => {
    vi.stubGlobal('indexedDB', { open: () => { const request: Record<string, unknown> = {}; queueMicrotask(() => (request.onerror as (() => void) | null)?.()); return request } })
    const { getOutboxRecords, outboxReady, putOutboxRecord } = await import('./outbox')
    await expect(outboxReady()).resolves.toBeUndefined()
    expect(() => putOutboxRecord(vaultRecord(0, 10))).not.toThrow()
    expect(getOutboxRecords()).toHaveLength(1)
  })
})
