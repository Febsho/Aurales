import type { SyncRecord } from './auralesSync'

/**
 * Durable storage for the pending sync queue.
 *
 * The outbox used to live in localStorage, which is capped at roughly 5 MB per
 * origin in WebKit. An encrypted-vault record is a base64 copy of a whole
 * profile's stored state, so queueing one per profile wrote about 1.33x of
 * localStorage back into localStorage and threw QuotaExceededError before the
 * upload could start. That left the queue permanently undrainable, because the
 * failure happened while building the snapshot rather than while sending it.
 *
 * IndexedDB has no comparable ceiling and stores structured values directly, so
 * nothing is serialised to a string on the way in. Reads stay synchronous
 * against an in-memory copy to keep the existing call sites unchanged.
 */
const OUTBOX_DB = 'aurales_sync_outbox'
const OUTBOX_STORE = 'outbox'
const OUTBOX_RECORD_KEY = 'records'
const LEGACY_OUTBOX_KEY = 'aurales_sync_outbox_v1'
const MAX_OUTBOX_RECORDS = 1000
export const OUTBOX_CHANGED_EVENT = 'aurales:outbox-changed'

/** Insertion-ordered, keyed by recordId so repeated edits compact instead of accumulating. */
let records = new Map<string, SyncRecord>()
let persistTimer: ReturnType<typeof setTimeout> | undefined
let lastPersistError: string | undefined

function openOutboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(OUTBOX_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open sync outbox storage'))
  })
}
async function readStoredOutbox(): Promise<SyncRecord[] | undefined> {
  const db = await openOutboxDb()
  return new Promise((resolve, reject) => { const request = db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).get(OUTBOX_RECORD_KEY); request.onsuccess = () => { db.close(); resolve(request.result as SyncRecord[] | undefined) }; request.onerror = () => { db.close(); reject(request.error) } })
}
async function writeStoredOutbox(value: SyncRecord[]): Promise<void> {
  const db = await openOutboxDb()
  await new Promise<void>((resolve, reject) => { const transaction = db.transaction(OUTBOX_STORE, 'readwrite'); transaction.objectStore(OUTBOX_STORE).put(value, OUTBOX_RECORD_KEY); transaction.oncomplete = () => { db.close(); resolve() }; transaction.onerror = () => { db.close(); reject(transaction.error) } })
}

/** Reads the pre-IndexedDB queue and frees the localStorage it was occupying. */
function readLegacyOutbox(): SyncRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_OUTBOX_KEY) || '[]')
    return Array.isArray(value) ? value as SyncRecord[] : []
  } catch { return [] }
}

function notifyChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OUTBOX_CHANGED_EVENT))
}

/**
 * Write-behind, so that queueing a snapshot of several hundred records persists
 * once rather than rewriting the whole queue on every enqueue.
 */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    void writeStoredOutbox([...records.values()])
      .then(() => { lastPersistError = undefined })
      .catch((error) => {
        // Never rethrow: a storage failure must not abort the sync that is
        // trying to drain this queue. The in-memory copy stays authoritative
        // for this session and the next successful write catches up.
        lastPersistError = error instanceof Error ? error.message : String(error)
        console.error('[sync] could not persist the outbox', error)
      })
  }, 150)
}

let hydration: Promise<void> | undefined
export function loadOutbox(): Promise<void> {
  if (hydration) return hydration
  hydration = (async () => {
    let stored: SyncRecord[] | undefined
    try { stored = await readStoredOutbox() } catch (error) { console.error('[sync] could not read the stored outbox', error) }
    const legacy = readLegacyOutbox()
    for (const record of [...(stored || []), ...legacy]) if (record?.recordId) records.set(record.recordId, record)
    if (legacy.length) {
      // Migrate before clearing, so a failed write cannot lose queued changes.
      try { await writeStoredOutbox([...records.values()]) } catch (error) { console.error('[sync] could not migrate the outbox', error); notifyChanged(); return }
    }
    // Reclaim the localStorage the old queue held, whether or not it had
    // entries. This is what unsticks an app already over the WebView quota.
    try { localStorage.removeItem(LEGACY_OUTBOX_KEY) } catch { /* nothing further to reclaim */ }
    notifyChanged()
  })()
  return hydration
}

/** Resolves once the queue has been read back from storage. */
export const outboxReady = (): Promise<void> => loadOutbox()

export function getOutboxRecords(): SyncRecord[] { return [...records.values()] }
export function getOutboxError(): string | undefined { return lastPersistError }

/** Replaces a record, moving it to the back of the queue as the previous localStorage implementation did. */
export function putOutboxRecord(record: SyncRecord): void {
  records.delete(record.recordId)
  records.set(record.recordId, record)
  while (records.size > MAX_OUTBOX_RECORDS) records.delete(records.keys().next().value as string)
  schedulePersist()
  notifyChanged()
}

export function removeOutboxRecords(recordIds: Set<string>): void {
  let removed = false
  for (const recordId of recordIds) removed = records.delete(recordId) || removed
  if (!removed) return
  schedulePersist()
  notifyChanged()
}

export function replaceOutbox(next: SyncRecord[]): void {
  records = new Map(next.map((record) => [record.recordId, record]))
  schedulePersist()
  notifyChanged()
}

void loadOutbox()
