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
export const OUTBOX_CHANGED_EVENT = 'aurales:outbox-changed'

/**
 * Records are bounded by size rather than by count. A count is a poor proxy now
 * that one encrypted-vault record can outweigh several thousand progress
 * records: 1000 records might be a few hundred KB or several GB.
 *
 * The service rejects a request body over MAX_SYNC_BODY_BYTES, 5 MB by default,
 * so a record larger than that can never be uploaded no matter how often it is
 * retried. Such a record is refused at the door with a reason the panel can
 * show, instead of silently failing every sync forever.
 */
export const MAX_RECORD_BYTES = 4_500_000
const MAX_OUTBOX_BYTES = 64_000_000
/** Leaves room for the request envelope alongside the records themselves. */
export const MAX_BATCH_BYTES = 4_500_000
const MAX_BATCH_RECORDS = 250

type OutboxEntry = { record: SyncRecord; bytes: number }
/** Insertion-ordered, keyed by recordId so repeated edits compact instead of accumulating. */
const records = new Map<string, OutboxEntry>()
let totalBytes = 0
let persistTimer: ReturnType<typeof setTimeout> | undefined
let lastPersistError: string | undefined
/** A refused or evicted record is a standing condition, so it is tracked apart from a transient write failure. */
let lastCapacityWarning: string | undefined

/**
 * Serialised size, which is what both the storage layer and the request body
 * are measured in. Vault ciphertext is base64, so for the records that actually
 * approach the limits this equals the UTF-8 byte count exactly; a title with
 * non-ASCII characters is undercounted slightly, which the headroom absorbs.
 */
function measure(record: SyncRecord): number {
  try { return JSON.stringify(record).length } catch { return Number.MAX_SAFE_INTEGER }
}

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
    void writeStoredOutbox(getOutboxRecords())
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
    for (const record of [...(stored || []), ...legacy]) {
      if (!record?.recordId) continue
      const previous = records.get(record.recordId)
      if (previous) totalBytes -= previous.bytes
      const bytes = measure(record)
      records.set(record.recordId, { record, bytes })
      totalBytes += bytes
    }
    evictOverflow()
    if (legacy.length) {
      // Migrate before clearing, so a failed write cannot lose queued changes.
      try { await writeStoredOutbox(getOutboxRecords()) } catch (error) { console.error('[sync] could not migrate the outbox', error); notifyChanged(); return }
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

export function getOutboxRecords(): SyncRecord[] { return [...records.values()].map((entry) => entry.record) }
export function getOutboxBytes(): number { return totalBytes }
export function getOutboxError(): string | undefined { return lastCapacityWarning ?? lastPersistError }

/** Oldest first, and never the record just queued, so a single large record cannot empty the queue. */
function evictOverflow(): void {
  while (totalBytes > MAX_OUTBOX_BYTES && records.size > 1) {
    const oldest = records.keys().next().value as string
    totalBytes -= records.get(oldest)?.bytes ?? 0
    records.delete(oldest)
    lastCapacityWarning = 'Older pending changes were dropped to stay within the local storage limit.'
  }
}

/**
 * Replaces a record, moving it to the back of the queue as the previous
 * localStorage implementation did. Returns false when the record is too large
 * to ever be uploaded, in which case it is not queued.
 */
export function putOutboxRecord(record: SyncRecord): boolean {
  const bytes = measure(record)
  if (bytes > MAX_RECORD_BYTES) {
    lastCapacityWarning = `A ${Math.round(bytes / 1_000_000)} MB ${record.type} change is larger than the sync service accepts and was not queued.`
    console.error('[sync] refusing to queue an unsendable record', record.recordId, bytes)
    notifyChanged()
    return false
  }
  const previous = records.get(record.recordId)
  if (previous) totalBytes -= previous.bytes
  records.delete(record.recordId)
  records.set(record.recordId, { record, bytes })
  totalBytes += bytes
  evictOverflow()
  schedulePersist()
  notifyChanged()
  return true
}

/**
 * The leading records that fit in one request. Batching by count alone would
 * overflow the service's body limit, because 250 records is a few KB of
 * progress or several hundred MB of vaults. At least one record is always
 * returned so the queue cannot stall.
 */
export function takeOutboxBatch(maxRecords = MAX_BATCH_RECORDS, maxBytes = MAX_BATCH_BYTES): SyncRecord[] {
  const batch: SyncRecord[] = []
  let bytes = 0
  for (const entry of records.values()) {
    if (batch.length >= maxRecords) break
    if (batch.length && bytes + entry.bytes > maxBytes) break
    batch.push(entry.record)
    bytes += entry.bytes
  }
  return batch
}

export function removeOutboxRecords(recordIds: Set<string>): void {
  let removed = false
  for (const recordId of recordIds) {
    const entry = records.get(recordId)
    if (!entry) continue
    totalBytes -= entry.bytes
    records.delete(recordId)
    removed = true
  }
  if (!removed) return
  schedulePersist()
  notifyChanged()
}

void loadOutbox()
