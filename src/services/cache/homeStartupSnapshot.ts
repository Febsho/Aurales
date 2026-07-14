import type { HomeRowConfig, SearchResult } from '../../types'
import { heroRowCacheKey } from './homeRowCacheKeys'

export type ContinueWatchingSource = 'local' | 'simkl' | 'trakt' | 'pmdb' | 'mdblist' | 'anilist'

export interface ContinueWatchingSnapshotItem {
  id: string
  mediaId: string
  mediaType: 'movie' | 'series'
  title: string
  subtitle?: string
  poster?: string
  backdrop?: string
  season?: number
  episode?: number
  progressSeconds: number
  durationSeconds: number
  progressPct: number
  imdbId?: string
  tmdbId?: number
  malId?: number
  anilistId?: number
  updatedAt: string
}

export interface HeroStartupSnapshot {
  version: 1
  rowKey: string
  savedAt: number
  items: SearchResult[]
}

export interface ContinueWatchingStartupSnapshot {
  version: 1
  source: ContinueWatchingSource
  accountScope: string
  limit: number
  savedAt: number
  items: ContinueWatchingSnapshotItem[]
}

interface HomeStartupSnapshotState {
  version: 1
  hero?: HeroStartupSnapshot
  continueWatching: Record<string, ContinueWatchingStartupSnapshot>
}

const STORAGE_KEY = 'aurales_home_startup_snapshots_v1'
const MAX_ITEMS = 15
const CREDENTIAL_SCOPE_PREFIX = 'aurales_cw_credential_scope:'

function emptyState(): HomeStartupSnapshotState {
  return { version: 1, continueWatching: {} }
}

function loadState(): HomeStartupSnapshotState {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as HomeStartupSnapshotState | null
    if (!value || value.version !== 1 || !value.continueWatching || typeof value.continueWatching !== 'object') return emptyState()
    return value
  } catch {
    return emptyState()
  }
}

function saveState(state: HomeStartupSnapshotState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* storage unavailable/full */ }
}

function validHeroItem(value: unknown): value is SearchResult {
  const item = value as Partial<SearchResult> | null
  return Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && (item.type === 'movie' || item.type === 'series'))
}

function compactHeroItem(item: SearchResult): SearchResult {
  return {
    id: item.id, title: item.title, type: item.type, provider: item.provider,
    year: item.year, poster: item.poster, backdrop: item.backdrop, logo: item.logo,
    overview: item.overview, rating: item.rating, runtime: item.runtime,
    releaseDate: item.releaseDate, genres: item.genres, genreIds: item.genreIds,
    imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId,
    malId: item.malId, anilistId: item.anilistId, traktId: item.traktId,
    simklId: item.simklId, isAnime: item.isAnime, originalLanguage: item.originalLanguage,
    addonUrl: item.addonUrl, sourceAddonId: item.sourceAddonId,
    sourceAddonItemId: item.sourceAddonItemId,
  }
}

function validContinueItem(value: unknown): value is ContinueWatchingSnapshotItem {
  const item = value as Partial<ContinueWatchingSnapshotItem> | null
  return Boolean(item
    && typeof item.id === 'string'
    && typeof item.mediaId === 'string'
    && typeof item.title === 'string'
    && (item.mediaType === 'movie' || item.mediaType === 'series')
    && typeof item.progressSeconds === 'number'
    && typeof item.durationSeconds === 'number'
    && typeof item.progressPct === 'number'
    && typeof item.updatedAt === 'string')
}

export function readHeroStartupSnapshot(row: HomeRowConfig): SearchResult[] | null {
  const snapshot = loadState().hero
  const rowKey = heroRowCacheKey(row)
  if (!snapshot || snapshot.version !== 1 || snapshot.rowKey !== rowKey || !Array.isArray(snapshot.items)) return null
  const items = snapshot.items.filter(validHeroItem).slice(0, MAX_ITEMS)
  return items.length ? items : null
}

export function writeHeroStartupSnapshot(row: HomeRowConfig, items: SearchResult[]): void {
  const safe = items.filter(validHeroItem).slice(0, MAX_ITEMS).map(compactHeroItem)
  if (!safe.length) return
  const state = loadState()
  state.hero = { version: 1, rowKey: heroRowCacheKey(row), savedAt: Date.now(), items: safe }
  saveState(state)
}

function continueKey(source: ContinueWatchingSource, accountScope: string, limit: number): string {
  return `${source}:${accountScope}:${Math.min(MAX_ITEMS, Math.max(1, limit))}`
}

export function readContinueWatchingStartupSnapshot(
  source: ContinueWatchingSource,
  accountScope: string | null,
  limit: number,
): ContinueWatchingSnapshotItem[] | null {
  if (!accountScope) return null
  const snapshot = loadState().continueWatching[continueKey(source, accountScope, limit)]
  if (!snapshot
    || snapshot.version !== 1
    || snapshot.source !== source
    || snapshot.accountScope !== accountScope
    || snapshot.limit !== Math.min(MAX_ITEMS, Math.max(1, limit))
    || !Array.isArray(snapshot.items)) return null
  const items = snapshot.items.filter(validContinueItem).slice(0, Math.min(MAX_ITEMS, limit))
  return items.length ? items : null
}

export function writeContinueWatchingStartupSnapshot(
  source: ContinueWatchingSource,
  accountScope: string,
  limit: number,
  items: ContinueWatchingSnapshotItem[],
): void {
  const cappedLimit = Math.min(MAX_ITEMS, Math.max(1, limit))
  const safe = items.filter(validContinueItem).slice(0, cappedLimit)
  if (!safe.length) return
  const state = loadState()
  const key = continueKey(source, accountScope, cappedLimit)
  state.continueWatching[key] = { version: 1, source, accountScope, limit: cappedLimit, savedAt: Date.now(), items: safe }
  saveState(state)
}

export function clearContinueWatchingStartupSnapshot(
  source: ContinueWatchingSource,
  accountScope: string,
  limit: number,
): void {
  const state = loadState()
  const key = continueKey(source, accountScope, limit)
  if (!state.continueWatching[key]) return
  delete state.continueWatching[key]
  saveState(state)
}

export function clearContinueWatchingSnapshotsForSource(source: ContinueWatchingSource): void {
  const state = loadState()
  let changed = false
  for (const [key, snapshot] of Object.entries(state.continueWatching)) {
    if (snapshot.source === source) {
      delete state.continueWatching[key]
      changed = true
    }
  }
  if (changed) saveState(state)
  try { window.dispatchEvent(new CustomEvent('aurales:cw-cache-clear', { detail: source })) } catch { /* no window in tests */ }
}

function randomScope(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

function credentialScope(source: 'pmdb' | 'mdblist'): string {
  const key = `${CREDENTIAL_SCOPE_PREFIX}${source}`
  let value = localStorage.getItem(key)
  if (!value) {
    value = randomScope()
    try { localStorage.setItem(key, value) } catch { /* storage unavailable */ }
  }
  return value
}

export function rotateProviderCredentialScope(source: 'pmdb' | 'mdblist', connected: boolean): void {
  clearContinueWatchingSnapshotsForSource(source)
  const key = `${CREDENTIAL_SCOPE_PREFIX}${source}`
  if (connected) {
    try { localStorage.setItem(key, randomScope()) } catch { /* storage unavailable */ }
  } else {
    localStorage.removeItem(key)
  }
}

function parsedAccount<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) || 'null') as T | null } catch { return null }
}

export function getContinueWatchingAccountScope(source: ContinueWatchingSource): string | null {
  if (source === 'local') return 'device'
  if (source === 'trakt') {
    if (!localStorage.getItem('trakt_tokens')) return null
    const account = parsedAccount<{ username?: string }>('trakt_account')
    return account?.username ? `trakt:${account.username}` : null
  }
  if (source === 'simkl') {
    if (!localStorage.getItem('simkl_token')) return null
    const account = parsedAccount<{ id?: string }>('simkl_account')
    return account?.id ? `simkl:${account.id}` : null
  }
  if (source === 'anilist') {
    if (!localStorage.getItem('anilist_token')) return null
    const account = parsedAccount<{ id?: number }>('anilist_account')
    return account?.id ? `anilist:${account.id}` : null
  }
  if (source === 'pmdb') return localStorage.getItem('pmdb_api_key') ? `pmdb:${credentialScope('pmdb')}` : null
  const mdblistConnected = Boolean(localStorage.getItem('mdblist_api_key') || localStorage.getItem('mdblist_oauth_tokens'))
  return mdblistConnected ? `mdblist:${credentialScope('mdblist')}` : null
}

function normalizedIdentity(item: SearchResult | ContinueWatchingSnapshotItem): string {
  const mediaType = 'mediaType' in item ? item.mediaType : item.type
  if (item.imdbId) return `${mediaType}:imdb:${item.imdbId}`
  if (item.tmdbId != null) return `${mediaType}:tmdb:${item.tmdbId}`
  if ('anilistId' in item && item.anilistId != null) return `${mediaType}:anilist:${item.anilistId}`
  if ('malId' in item && item.malId != null) return `${mediaType}:mal:${item.malId}`
  if ('mediaId' in item && item.mediaId) return `${mediaType}:media:${item.mediaId}`
  return `${mediaType}:id:${item.id}`
}

export function stableListFingerprint(items: Array<SearchResult | ContinueWatchingSnapshotItem>): string {
  return items.map(normalizedIdentity).join('|')
}

/** Detects presentation changes as well as identity/order changes in catalogs. */
export function catalogContentFingerprint(items: SearchResult[]): string {
  return JSON.stringify(items.map((item) => ({
    identity: normalizedIdentity(item),
    title: item.title,
    year: item.year,
    poster: item.poster,
    backdrop: item.backdrop,
    logo: item.logo,
    rating: item.rating,
    releaseDate: item.releaseDate,
    genres: item.genres,
    genreIds: item.genreIds,
  })))
}

export function mergeContinueWatchingPresentation(
  fresh: ContinueWatchingSnapshotItem[],
  cached: ContinueWatchingSnapshotItem[],
): ContinueWatchingSnapshotItem[] {
  const presentations = new Map(cached.map((item) => [normalizedIdentity(item), item]))
  return fresh.map((item) => {
    const previous = presentations.get(normalizedIdentity(item))
    if (!previous) return item
    const placeholderTitle = /^(Movie|Show) \d+$/.test(item.title) || item.title === 'Untitled'
    return {
      ...item,
      title: placeholderTitle ? previous.title : item.title,
      poster: item.poster || previous.poster,
      backdrop: item.backdrop || previous.backdrop,
      imdbId: item.imdbId || previous.imdbId,
      tmdbId: item.tmdbId || previous.tmdbId,
      malId: item.malId || previous.malId,
      anilistId: item.anilistId || previous.anilistId,
    }
  })
}
