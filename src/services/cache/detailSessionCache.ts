interface DetailSessionEntry<T> {
  data: T
  storedAt: number
}

const MAX_DETAIL_ENTRIES = 100
const DEFAULT_DETAIL_TTL_MS = 10 * 60 * 1000
const entries = new Map<string, DetailSessionEntry<unknown>>()

export function rememberSessionDetail<T>(key: string, data: T): void {
  entries.delete(key)
  entries.set(key, { data, storedAt: Date.now() })
  while (entries.size > MAX_DETAIL_ENTRIES) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    entries.delete(oldest)
  }
}

export function getSessionDetail<T>(key: string, ttlMs = DEFAULT_DETAIL_TTL_MS): { data: T; stale: boolean } | null {
  const entry = entries.get(key) as DetailSessionEntry<T> | undefined
  if (!entry) return null
  entries.delete(key)
  entries.set(key, entry)
  return { data: entry.data, stale: Date.now() - entry.storedAt > ttlMs }
}

export function clearDetailSessionCache(): void {
  entries.clear()
}

