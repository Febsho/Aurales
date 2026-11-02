import type { SearchResult } from '../../types'
import { mediaIdentity } from '../mediaPresentation'

export type DatedLibraryItem = SearchResult & { libraryAddedAt: number }
export type NewLibraryItem = SearchResult & { addedAt: number }

export function parseLibraryAddedAt(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** Merge personal lists while keeping the newest genuine add date and best available artwork. */
export function buildNewLibraryItems(
  local: Array<SearchResult & { addedAt: number }>,
  connected: DatedLibraryItem[],
  matchesTab: (item: SearchResult) => boolean,
): NewLibraryItem[] {
  const merged = new Map<string, NewLibraryItem>()
  for (const item of [...local, ...connected.map(({ libraryAddedAt, ...item }) => ({ ...item, addedAt: libraryAddedAt }))]) {
    if (!item.addedAt || !matchesTab(item)) continue
    const key = mediaIdentity(item)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, item)
      continue
    }
    merged.set(key, {
      ...current,
      ...item,
      poster: current.poster || item.poster,
      backdrop: current.backdrop || item.backdrop,
      addedAt: Math.max(current.addedAt, item.addedAt),
    })
  }
  return [...merged.values()]
    .filter((item) => Boolean(item.poster))
    .sort((left, right) => right.addedAt - left.addedAt)
}
