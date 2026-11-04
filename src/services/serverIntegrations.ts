import { invoke } from '@tauri-apps/api/core'
import type { MovieDetails, SearchResult, StreamResult } from '../types'
import * as web from './serverIntegrationsWeb'
import { makeWatchedKey, useWatchedCacheStore } from '../stores/watchedCacheStore'

/** Native media server connections, catalogs, search, and playback are active. */
export const SERVER_INTEGRATIONS_ENABLED = true

export type ServerIntegrationKind = 'jellyfin' | 'webdav'
export type ServerAuthMode = 'password' | 'token'

export interface ServerConnectionSummary {
  id: string
  kind: ServerIntegrationKind
  name: string
  serverUrl: string
  username?: string
  authMode: ServerAuthMode
  baseDirectory?: string
  enabled: boolean
  hasSecret: boolean
  status: 'connected' | 'disconnected' | 'error' | 'unknown'
  statusMessage?: string
  serverName?: string
  userName?: string
  lastCheckedAt?: string
  lastCatalogRefreshAt?: string
}

export interface ServerConnectionInput {
  id?: string
  kind: ServerIntegrationKind
  name: string
  serverUrl: string
  username?: string
  /** Password, Jellyfin access token, or WebDAV bearer/app token. Never persisted by the webview. */
  secret?: string
  authMode: ServerAuthMode
  baseDirectory?: string
  enabled: boolean
}

export interface ServerConnectionTestResult {
  ok: boolean
  message?: string
  serverName?: string
  userName?: string
}

export interface ServerCatalogDescriptor {
  connectionId: string
  catalogId: string
  /** Jellyfin BoxSet folder id for AIOMetadata collection descriptors. */
  sourceItemId?: string
  provider: ServerIntegrationKind
  title: string
  group?: string
  contentType: 'movie' | 'series' | 'anime' | 'mixed'
  kind: 'library' | 'catalog' | 'continue-watching' | 'next-up' | 'upcoming' | 'history' | 'recently-added' | 'favorites' | 'collection'
  itemCount: number
  connectionItemCount: number
}

/** A cached server item, including its provider payload for resume metadata. */
export interface ServerCatalogItem extends SearchResult {
  connectionId?: string
  mediaType: 'movie' | 'series' | 'season' | 'episode' | 'collection'
  catalogIds: string[]
  sourceConnectionId: string
  sourceItemId: string
  parentSourceItemId?: string
  raw: Record<string, unknown>
}

/** Convert Jellyfin's RemoteTrailer records into the detail-page video shape. */
export function jellyfinRemoteTrailers(raw: Record<string, unknown>): MovieDetails['trailers'] {
  const trailers = Array.isArray(raw.RemoteTrailers) ? raw.RemoteTrailers : []
  return trailers.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return []
    const trailer = entry as Record<string, unknown>
    const url = typeof trailer.Url === 'string' ? trailer.Url : ''
    if (!/^https?:\/\//i.test(url)) return []
    let youtubeId: string | undefined
    try {
      const parsed = new URL(url)
      if (parsed.hostname === 'youtu.be') youtubeId = parsed.pathname.split('/').filter(Boolean)[0]
      else if (/(^|\.)youtube(?:-nocookie)?\.com$/i.test(parsed.hostname)) {
        youtubeId = parsed.searchParams.get('v') || parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?]+)/)?.[1]
      }
    } catch { /* keep a valid direct trailer URL */ }
    const key = youtubeId || url
    return [{
      id: `jellyfin-trailer-${index}-${key}`,
      name: typeof trailer.Name === 'string' && trailer.Name.trim() ? trailer.Name : `Trailer ${index + 1}`,
      key,
      site: youtubeId ? 'YouTube' : 'External',
      type: 'Trailer',
      url,
      ...(youtubeId ? { thumbnail: `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` } : {}),
    }]
  })
}

export interface ServerStream extends StreamResult {
  addonId: string
  addonName: string
  headers?: [string, string][]
}

export interface ServerStreamRequest {
  mediaType: 'movie' | 'series'
  mediaId: string
  title?: string
  imdbId?: string
  tmdbId?: number
  tvdbId?: number | string
  malId?: number
  anilistId?: number
  season?: number
  episode?: number
  sourceConnectionId?: string
  sourceItemId?: string
}

export type JellyfinPlaybackEvent = 'start' | 'progress' | 'pause' | 'unpause' | 'stop'

export interface JellyfinPlaybackReport {
  connectionId: string
  itemId: string
  /** Set only when itemId is a Jellyfin series id that needs episode resolution. */
  season?: number
  episode?: number
  mediaSourceId?: string
  playSessionId: string
  positionTicks: number
  runtimeTicks?: number
  event: JellyfinPlaybackEvent
  isPaused: boolean
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode'
}

/** Report playback state to the Jellyfin library that supplied this stream. */
export async function reportJellyfinPlayback(request: JellyfinPlaybackReport): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) return
  try {
    if (!nativeAvailable()) await web.webReportJellyfinPlayback(request)
    else await invoke('report_server_playback', { request })
  } catch (error) {
    console.warn(`[Jellyfin playback sync] ${request.event} callback failed for item ${request.itemId}:`, error)
    throw error
  }
  if (request.event === 'stop') announceCatalogChange()
}

/** Set or clear the watched state on the Jellyfin account that owns an item. */
export async function setJellyfinItemWatched(
  connectionId: string,
  itemId: string,
  watched: boolean,
  episode?: { season: number; episode: number },
): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) return
  if (!nativeAvailable()) return web.webSetJellyfinItemWatched(connectionId, itemId, watched, episode)
  await invoke('set_server_item_watched', { request: { connectionId, itemId, watched, ...episode } })
  announceCatalogChange()
}

export function serverCatalogListId(connectionId: string, catalogId: string): string {
  return JSON.stringify([connectionId, catalogId])
}

export function parseServerCatalogListId(value?: string): { connectionId: string; catalogId: string } | null {
  try {
    const parsed = JSON.parse(value || '') as unknown
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === 'string')
      ? { connectionId: parsed[0], catalogId: parsed[1] }
      : null
  } catch { return null }
}

function announceCatalogChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('aurales:server-catalogs-changed'))
}

function nativeAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

export async function listServerConnections(): Promise<ServerConnectionSummary[]> {
  if (!SERVER_INTEGRATIONS_ENABLED) return []
  if (!nativeAvailable()) return web.webListServerConnections()
  return invoke<ServerConnectionSummary[]>('list_server_connections')
}

export async function saveServerConnection(input: ServerConnectionInput): Promise<ServerConnectionSummary> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  if (!nativeAvailable()) {
    if (input.kind !== 'jellyfin') throw new Error('WebDAV connections are supported in Aurales Desktop; browser mode currently supports Jellyfin.')
    return web.webSaveServerConnection(input)
  }
  const result = await invoke<ServerConnectionSummary>('save_server_connection', { request: input })
  announceCatalogChange()
  return result
}

export async function removeServerConnection(connectionId: string): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  if (!nativeAvailable()) return web.webRemoveServerConnection(connectionId)
  await invoke('remove_server_connection', { connectionId })
  announceCatalogChange()
}

export async function setServerConnectionEnabled(connectionId: string, enabled: boolean): Promise<ServerConnectionSummary> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  if (!nativeAvailable()) return web.webSetServerConnectionEnabled(connectionId, enabled)
  const result = await invoke<ServerConnectionSummary>('set_server_connection_enabled', { connectionId, enabled })
  announceCatalogChange()
  return result
}

export async function testServerConnection(input: ServerConnectionInput): Promise<ServerConnectionTestResult> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  if (!nativeAvailable()) {
    if (input.kind !== 'jellyfin') return { ok: false, message: 'WebDAV connections are supported in Aurales Desktop; browser mode currently supports Jellyfin.' }
    return web.webTestServerConnection(input)
  }
  return invoke<ServerConnectionTestResult>('test_server_connection', { request: input })
}

export async function refreshServerCatalog(connectionId: string, announce = true): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) return
  if (!nativeAvailable()) await web.webRefreshServerCatalog(connectionId)
  else await invoke('refresh_server_catalog', { connectionId })
  if (announce) await cacheJellyfinWatchedItems().catch((error) => console.warn('[Jellyfin watched cache] refresh failed:', error))
  if (announce) announceCatalogChange()
}

/** Fill the shared watched identity cache from Jellyfin's already-loaded library data. */
async function cacheJellyfinWatchedItems(): Promise<void> {
  const connections = (await listServerConnections()).filter((entry) => entry.enabled && entry.kind === 'jellyfin')
  const watchedKeys = new Set<string>()
  const catalogs = await listServerCatalogs()
  for (const connection of connections) {
    const connectionCatalogs = catalogs.filter((catalog) => catalog.connectionId === connection.id)
    // The browser exposes Jellyfin's complete played history as a catalog;
    // desktop scans already include UserData for all library items.
    const watchedCatalogs = nativeAvailable()
      ? connectionCatalogs.filter((catalog) => catalog.kind === 'library')
      : connectionCatalogs.filter((catalog) => catalog.catalogId === 'history')
    for (const catalog of watchedCatalogs) {
      const items = await getServerCatalogItems(connection.id, catalog.catalogId, 50_000)
      for (const item of items) {
        const userData = item.raw.UserData
        if (!userData || typeof userData !== 'object' || (userData as Record<string, unknown>).Played !== true) continue
        watchedKeys.add(makeWatchedKey('id', item.id))
        const ids = item.raw.ProviderIds && typeof item.raw.ProviderIds === 'object'
          ? item.raw.ProviderIds as Record<string, unknown>
          : {}
        const imdb = typeof ids.Imdb === 'string' ? ids.Imdb : item.imdbId
        const tmdb = ids.Tmdb ?? item.tmdbId
        const tvdb = ids.Tvdb ?? item.tvdbId
        if (imdb) watchedKeys.add(makeWatchedKey('imdb', imdb))
        if (typeof tmdb === 'string' || typeof tmdb === 'number') watchedKeys.add(makeWatchedKey('tmdb', tmdb))
        if (typeof tvdb === 'string' || typeof tvdb === 'number') watchedKeys.add(makeWatchedKey('tvdb', tvdb))
      }
    }
  }
  useWatchedCacheStore.getState().setJellyfinWatchedKeys(watchedKeys)
}

/** Refreshes only stale enabled servers; every failure stays isolated. */
export async function refreshStaleServerCatalogs(maxAgeMs = 15 * 60 * 1000): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) return
  const connections = await listServerConnections()
  const now = Date.now()
  const stale = connections.filter((connection) => {
    if (!connection.enabled) return false
    const refreshedAt = connection.lastCatalogRefreshAt ? Date.parse(connection.lastCatalogRefreshAt) : 0
    return !Number.isFinite(refreshedAt) || now - refreshedAt >= maxAgeMs
  })
  if (!stale.length) {
    await cacheJellyfinWatchedItems().catch((error) => console.warn('[Jellyfin watched cache] load failed:', error))
    return
  }
  await Promise.allSettled(stale.map((connection) => refreshServerCatalog(connection.id, false)))
  await cacheJellyfinWatchedItems().catch((error) => console.warn('[Jellyfin watched cache] load failed:', error))
  announceCatalogChange()
}

export async function listServerCatalogs(): Promise<ServerCatalogDescriptor[]> {
  if (!SERVER_INTEGRATIONS_ENABLED) return []
  if (!nativeAvailable()) return web.webListServerCatalogs()
  return invoke<ServerCatalogDescriptor[]>('list_server_catalogs')
}

export async function getServerCatalogItems(connectionId: string, catalogId: string, maxItems?: number): Promise<ServerCatalogItem[]> {
  if (!SERVER_INTEGRATIONS_ENABLED) return []
  if (!nativeAvailable()) return web.webGetServerCatalogItems(connectionId, catalogId, maxItems)
  return invoke<ServerCatalogItem[]>('get_server_catalog_items', { connectionId, catalogId, maxItems })
}

/** Resolve an exact Jellyfin item for details/playback, including browser mode. */
export async function getServerItem(connectionId: string, itemId: string): Promise<ServerCatalogItem | undefined> {
  if (!nativeAvailable()) return (await web.webGetServerCatalogItems(connectionId, `item:${itemId}`, 1))[0]
  const catalogs = await listServerCatalogs()
  const ids = catalogs.filter((catalog) => catalog.connectionId === connectionId).map((catalog) => catalog.catalogId)
  for (const catalogId of ids) {
    const item = (await getServerCatalogItems(connectionId, catalogId, 50_000)).find((entry) => entry.sourceItemId === itemId)
    if (item) return item
  }
  return undefined
}

/** Resolve episodes by the source series id for details/playback. */
export async function getServerEpisodes(connectionId: string, seriesId: string, maxItems = 50_000): Promise<ServerCatalogItem[]> {
  if (!nativeAvailable()) return web.webGetServerCatalogItems(connectionId, `episodes:${seriesId}`, maxItems)
  const catalogs = await listServerCatalogs()
  const unique = new Map<string, ServerCatalogItem>()
  for (const catalog of catalogs.filter((entry) => entry.connectionId === connectionId)) {
    const items = await getServerCatalogItems(connectionId, catalog.catalogId, maxItems)
    for (const item of items) {
      const parentId = item.parentSourceItemId || (typeof item.raw.SeriesId === 'string' ? item.raw.SeriesId : undefined)
      if (item.mediaType === 'episode' && parentId === seriesId) unique.set(item.sourceItemId, item)
    }
  }
  return [...unique.values()].slice(0, maxItems)
}

export async function searchServerCatalogs(query: string): Promise<SearchResult[]> {
  if (!SERVER_INTEGRATIONS_ENABLED || !query.trim()) return []
  if (!nativeAvailable()) return web.webSearchServerCatalogs(query)
  return invoke<SearchResult[]>('search_server_catalogs', { query: query.trim() })
}

export async function getServerStreams(request: ServerStreamRequest): Promise<ServerStream[]> {
  if (!SERVER_INTEGRATIONS_ENABLED) return []
  if (!nativeAvailable()) return web.webGetServerStreams(request)
  return invoke<ServerStream[]>('get_server_streams', { request })
}

/** Disable previously enabled connections without deleting their credentials
 * or cached catalog records, so the feature can be restored later. */
export async function disconnectDisabledServerIntegrations(): Promise<void> {
  if (SERVER_INTEGRATIONS_ENABLED || !nativeAvailable()) return
  const connections = await invoke<ServerConnectionSummary[]>('list_server_connections').catch(() => [])
  await Promise.allSettled(connections
    .filter((connection) => connection.enabled)
    .map((connection) => invoke('set_server_connection_enabled', { connectionId: connection.id, enabled: false })))
  announceCatalogChange()
}
