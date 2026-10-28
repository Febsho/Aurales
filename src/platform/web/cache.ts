export interface WebCacheEntry {
  key: string
  value: string
  category: string
  created_at: string
  expires_at: string | null
  updated_at: string
}

const DATABASE = 'aurales-web-cache-v1'
const STORE = 'entries'
const memoryFallback = new Map<string, WebCacheEntry>()
let databasePromise: Promise<IDBDatabase | null> | undefined

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('category', 'category', { unique: false })
        store.createIndex('expires_at', 'expires_at', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return databasePromise
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
  })
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function webCacheGet(key: string): Promise<WebCacheEntry | null> {
  const db = await openDatabase()
  if (!db) return memoryFallback.get(key) || null
  const tx = db.transaction(STORE, 'readonly')
  const done = transactionDone(tx)
  const result = await requestValue<WebCacheEntry | undefined>(tx.objectStore(STORE).get(key))
  await done
  return result || null
}

export async function webCacheGetMany(keys: string[]): Promise<WebCacheEntry[]> {
  const db = await openDatabase()
  if (!db) return keys.flatMap((key) => memoryFallback.has(key) ? [memoryFallback.get(key)!] : [])
  const tx = db.transaction(STORE, 'readonly')
  const done = transactionDone(tx)
  const store = tx.objectStore(STORE)
  const results = await Promise.all(keys.map((key) => requestValue<WebCacheEntry | undefined>(store.get(key))))
  await done
  return results.filter((entry): entry is WebCacheEntry => Boolean(entry))
}

export async function webCacheSet(entry: WebCacheEntry): Promise<void> {
  const db = await openDatabase()
  if (!db) { memoryFallback.set(entry.key, entry); return }
  const tx = db.transaction(STORE, 'readwrite')
  const done = transactionDone(tx)
  tx.objectStore(STORE).put(entry)
  await done
}

export async function webCacheDelete(key: string, expectedValue?: string): Promise<void> {
  const db = await openDatabase()
  if (!db) {
    if (!expectedValue || memoryFallback.get(key)?.value === expectedValue) memoryFallback.delete(key)
    return
  }
  const tx = db.transaction(STORE, 'readwrite')
  const done = transactionDone(tx)
  const store = tx.objectStore(STORE)
  if (expectedValue) {
    await new Promise<void>((resolve, reject) => {
      const request = store.get(key)
      request.onsuccess = () => {
        if ((request.result as WebCacheEntry | undefined)?.value === expectedValue) store.delete(key)
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
  } else store.delete(key)
  await done
}

export async function webCacheDeleteMany(entries: Array<{ key: string; value?: string }>): Promise<void> {
  await Promise.all(entries.map(({ key, value }) => webCacheDelete(key, value)))
}

export async function webCacheClearCategory(category: string): Promise<number> {
  const db = await openDatabase()
  if (!db) {
    let count = 0
    for (const [key, entry] of memoryFallback) if (entry.category === category) { memoryFallback.delete(key); count += 1 }
    return count
  }
  const tx = db.transaction(STORE, 'readwrite')
  const done = transactionDone(tx)
  const index = tx.objectStore(STORE).index('category')
  let count = 0
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(category))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return resolve()
      count += 1
      cursor.delete()
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
  await done
  return count
}

export async function webCacheClearExpired(now = Date.now()): Promise<number> {
  const db = await openDatabase()
  if (!db) {
    let count = 0
    for (const [key, entry] of memoryFallback) {
      if (entry.expires_at && Date.parse(entry.expires_at) <= now) { memoryFallback.delete(key); count += 1 }
    }
    return count
  }
  const tx = db.transaction(STORE, 'readwrite')
  const done = transactionDone(tx)
  let count = 0
  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(STORE).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return resolve()
      const entry = cursor.value as WebCacheEntry
      if (entry.expires_at && Date.parse(entry.expires_at) <= now) { cursor.delete(); count += 1 }
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
  await done
  return count
}

export async function webCacheStats(now = Date.now()): Promise<{ totalEntries: number; expiredEntries: number; byCategory: Record<string, number> }> {
  const db = await openDatabase()
  const entries = db
    ? await requestValue<WebCacheEntry[]>(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
    : [...memoryFallback.values()]
  const byCategory: Record<string, number> = {}
  let expiredEntries = 0
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1
    if (entry.expires_at && Date.parse(entry.expires_at) <= now) expiredEntries += 1
  }
  return { totalEntries: entries.length, expiredEntries, byCategory }
}

export async function webCacheClearAll(): Promise<number> {
  const db = await openDatabase()
  if (!db) { const count = memoryFallback.size; memoryFallback.clear(); return count }
  const tx = db.transaction(STORE, 'readwrite')
  const done = transactionDone(tx)
  const store = tx.objectStore(STORE)
  const countRequest = store.count()
  store.clear()
  const count = await requestValue<number>(countRequest)
  await done
  return count
}
