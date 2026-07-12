import type { HomeRowConfig } from '../types'

export type ShelfDraft = Omit<HomeRowConfig, 'id' | 'order'>

export interface PendingShelfSelection {
  key: string
  row: ShelfDraft
  existingId?: string
}

export type CatalogPickerSource = 'builtin' | 'smart' | 'addons' | 'simkl' | 'trakt' | 'anilist' | 'pmdb' | 'pmdb-picks' | 'mdblist'
export type CatalogContentType = 'movie' | 'series' | 'anime' | 'unknown'

export interface CatalogPickerItem {
  key: string
  source: CatalogPickerSource
  group: string
  title: string
  subtitle: string
  contentType: CatalogContentType
  row: ShelfDraft
  added: boolean
  existingId?: string
  isPublic?: boolean
}

export function inferCatalogContentType(id: string, label: string, catalogType?: string): CatalogContentType {
  const value = `${id} ${label} ${catalogType || ''}`.toLowerCase()
  if (/anime|anilist|mal\b/.test(value)) return 'anime'
  if (/\b(movie|movies|film|films)\b/.test(value)) return 'movie'
  if (/\b(series|show|shows|tv)\b/.test(value)) return 'series'
  return 'unknown'
}

export function shelfDraftKey(row: ShelfDraft): string {
  if (row.sourceType === 'discover') return `discover:${row.title}`
  if (row.sourceType && row.providerListId) return `${row.sourceType}:${row.providerListId}`
  if (row.layout === 'continue') return 'builtin:continue'
  return `addon:${row.addonId || ''}:${row.catalogType || ''}:${row.catalogId || ''}`
}

export function normalizeShelfDraft(row: ShelfDraft): ShelfDraft {
  return { ...row, layout: row.layout === 'continue' ? 'continue' : 'poster', enabled: true }
}

export function getPosterStackItems(posters: string[]): string[] {
  return posters.filter(Boolean).slice(0, 5)
}

export function isCatalogUsedByHomeShelf(rows: HomeRowConfig[], key: string): boolean {
  return rows.some((row) => {
    if (row.layout === 'hero') return false
    if (row.sourceType && row.providerListId) return `${row.sourceType}:${row.providerListId}` === key
    return `${row.addonId || ''}::${row.catalogType || ''}::${row.catalogId || ''}` === key
  })
}
