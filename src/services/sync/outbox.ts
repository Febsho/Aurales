import type { SyncRecord } from './syncQueue'

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
let persistChain: Promise<void> = Promise.resolve()
let outboxVersion = 0
let lastPersistError: string | undefined
let hydrationComplete = false
let persistRequestedDuringHydration = false
// A failed read must never be treated as an empty queue: the next write would
// otherwise overwrite records that are still safely stored in IndexedDB.
let storageReadSucceeded = false
/** A refused or evicted record is a standing condition, so it is tracked apart from a transient write failure. */
let lastCapacityWarning: string | undefined

/**
 * UTF-8 serialized size, matching the request body's actual byte limit even
 * when profile values contain multibyte characters.
 */
function measure(record: SyncRecord): number {
  try { return new TextEncoder().encode(JSON.stringify(record)).byteLength } catch { return Number.MAX_SAFE_INTEGER }
}

function isSyncRecord(value: unknown): value is SyncRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SyncRecord>
  return typeof record.recordId === 'string' && record.recordId.length > 0
    && typeof record.profileId === 'string' && record.profileId.length > 0
    && ['profile', 'progress', 'watchlist', 'discovery-feedback', 'playback-memory', 'profile-preferences', 'encrypted-vault'].includes(record.type as string)
    && typeof record.updatedAt === 'string'
    && typeof record.deviceId === 'string' && record.deviceId.length > 0
    && typeof record.version === 'number' && Number.isFinite(record.version)
    && typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
    && (record.revision == null || (typeof record.revision === 'number' && Number.isFinite(record.revision)))
}

function openOutboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(OUTBOX_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open sync outbox storage'))
  })
}
async function readStoredOutbox(): Promise<unknown> {
  const db = await openOutboxDb()
  return new Promise((resolve, reject) => { const request = db.transaction(OUTBOX_STORE, 'readonly').objectStore(OUTBOX_STORE).get(OUTBOX_RECORD_KEY); request.onsuccess = () => { db.close(); resolve(request.result) }; request.onerror = () => { db.close(); reject(request.error) } })
}
async function writeStoredOutbox(value: SyncRecord[]): Promise<void> {
  const db = await openOutboxDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(OUTBOX_STORE, 'readwrite')
    transaction.objectStore(OUTBOX_STORE).put(value, OUTBOX_RECORD_KEY)
    let settled = false
    const finish = (error?: DOMException | null) => {
      if (settled) return
      settled = true
      db.close()
      if (error) reject(error)
      else resolve()
    }
    transaction.oncomplete = () => finish()
    transaction.onerror = () => finish(transaction.error || new DOMException('Outbox transaction failed', 'UnknownError'))
    transaction.onabort = () => finish(transaction.error || new DOMException('Outbox transaction was aborted', 'AbortError'))
  })
}

/** Reads the pre-IndexedDB queue and frees the localStorage it was occupying. */
function readLegacyOutbox(): SyncRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_OUTBOX_KEY) || '[]')
    return Array.isArray(value) ? value.filter(isSyncRecord) : []
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
  // Do not write a partial in-memory queue while IndexedDB is still loading;
  // that write could replace durable records before they are merged.
  if (!hydrationComplete) {
    persistRequestedDuringHydration = true
    return
  }
  if (!storageReadSucceeded) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    // Serialize transactions. Without this, a slower older write can finish
    // after a newer snapshot and resurrect records that were already removed.
    persistChain = persistChain.catch(() => undefined).then(() => writeStoredOutbox(getOutboxRecords()))
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
    try {
      let storedValue: unknown
      try {
        storedValue = await readStoredOutbox()
        storageReadSucceeded = true
      } catch (error) {
        lastPersistError = error instanceof Error ? error.message : String(error)
        console.error('[sync] could not read the stored outbox', error)
      }
      const legacy = readLegacyOutbox()
      const stored = Array.isArray(storedValue) ? storedValue.filter(isSyncRecord) : []
      let changed = storedValue !== undefined && (!Array.isArray(storedValue) || stored.length !== storedValue.length)
      for (const record of [...stored, ...legacy]) {
        const bytes = measure(record)
        if (bytes > MAX_RECORD_BYTES) {
          lastCapacityWarning = `A ${Math.round(bytes / 1_000_000)} MB ${record.type} change was too large to sync and was removed from the queue.`
          changed = true
          continue
        }
        const previous = records.get(record.recordId)
        if (previous) {
          const previousAt = Date.parse(previous.record.updatedAt)
          const incomingAt = Date.parse(record.updatedAt)
          // New edits can enter the synchronous in-memory queue before the
          // IndexedDB read finishes. Preserve that value over a stale snapshot.
          if (!Number.isFinite(incomingAt) || (Number.isFinite(previousAt) && previousAt >= incomingAt)) continue
          totalBytes -= previous.bytes
          changed = true
        }
        records.set(record.recordId, { record, bytes })
        totalBytes += bytes
      }
      const beforeCapacityEviction = records.size
      evictOverflow()
      changed ||= records.size !== beforeCapacityEviction
      if (legacy.length && storageReadSucceeded) {
        // Migrate before clearing, so a failed write cannot lose queued changes.
        try { await writeStoredOutbox(getOutboxRecords()) } catch (error) { console.error('[sync] could not migrate the outbox', error); notifyChanged(); return }
      }
      // Reclaim the localStorage the old queue held, whether or not it had
      // entries. This is what unsticks an app already over the WebView quota.
      if (storageReadSucceeded) {
        try { localStorage.removeItem(LEGACY_OUTBOX_KEY) } catch { /* nothing further to reclaim */ }
      }
      notifyChanged()
      if (changed) schedulePersist()
    } finally {
      hydrationComplete = true
      if (persistRequestedDuringHydration) {
        persistRequestedDuringHydration = false
        schedulePersist()
      }
    }
  })()
  return hydration
}

/** Resolves once the queue has been read back from storage. */
export const outboxReady = (): Promise<void> => loadOutbox()

/** Forces the current in-memory queue to IndexedDB before a page reload. */
export async function flushOutbox(): Promise<void> {
  await outboxReady()
  if (!storageReadSucceeded) {
    throw new Error(lastPersistError || 'Could not read the sync outbox; refusing to overwrite stored records.')
  }
  for (;;) {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const version = outboxVersion
    const snapshot = getOutboxRecords()
    const write = persistChain
      .catch(() => undefined)
      .then(() => writeStoredOutbox(snapshot))
    persistChain = write
    try {
      await write
      lastPersistError = undefined
    } catch (error) {
      lastPersistError = error instanceof Error ? error.message : String(error)
      throw error
    }
    // Enqueues/removals can race this write, including when their debounce
    // timer fires before the transaction completes. Compare the actual state
    // version as well as the timer so this resolves only after the latest
    // snapshot is durable.
    if (version === outboxVersion && !persistTimer) return
  }
}

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
  return putOutboxRecords([record])[0] ?? false
}

/** Queues a related group with one persistence pass and one change event. */
export function putOutboxRecords(batch: SyncRecord[]): boolean[] {
  if (batch.length === 0) return []
  let changed = false
  let rejected = false
  const accepted = batch.map((record) => {
    const bytes = measure(record)
    if (bytes > MAX_RECORD_BYTES) {
      lastCapacityWarning = `A ${Math.round(bytes / 1_000_000)} MB ${record.type} change is larger than the sync service accepts and was not queued.`
      console.error('[sync] refusing to queue an unsendable record', record.recordId, bytes)
      rejected = true
      return false
    }
    const previous = records.get(record.recordId)
    if (previous) totalBytes -= previous.bytes
    records.delete(record.recordId)
    records.set(record.recordId, { record, bytes })
    totalBytes += bytes
    changed = true
    return true
  })
  if (changed) {
    outboxVersion += 1
    evictOverflow()
    schedulePersist()
  }
  if (changed || rejected) {
    notifyChanged()
  }
  return accepted
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

export function removeOutboxRecords(recordsToRemove: SyncRecord[] | Set<string>): void {
  const expectedRecords = Array.isArray(recordsToRemove)
    ? new Map<string, SyncRecord>(recordsToRemove.map((record) => [record.recordId, record] as const))
    : undefined
  const recordIds: string[] = expectedRecords
    ? [...expectedRecords.keys()]
    : [...(recordsToRemove as Set<string>)]
  let removed = false
  for (const recordId of recordIds) {
    const entry = records.get(recordId)
    if (!entry) continue
    // A newer edit can replace this key while its older snapshot is in flight.
    // Acknowledge only the exact object sent; keep any replacement queued.
    if (expectedRecords && entry.record !== expectedRecords.get(recordId)) continue
    totalBytes -= entry.bytes
    records.delete(recordId)
    removed = true
  }
  if (!removed) return
  outboxVersion += 1
  schedulePersist()
  notifyChanged()
}

void loadOutbox()
