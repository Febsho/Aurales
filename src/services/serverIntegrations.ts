import { invoke } from '@tauri-apps/api/core'
import type { SearchResult, StreamResult } from '../types'

/** Server integrations are intentionally parked. Saved native configuration
 * remains recoverable, but no server UI, catalogs, searches, or streams are
 * exposed while this is false. */
export const SERVER_INTEGRATIONS_ENABLED = false

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
  provider: ServerIntegrationKind
  title: string
  contentType: 'movie' | 'series' | 'anime' | 'mixed'
  kind: 'library' | 'continue-watching' | 'recently-added' | 'favorites' | 'collection'
  itemCount: number
  connectionItemCount: number
}

/** A cached server item, including its provider payload for resume metadata. */
export interface ServerCatalogItem extends SearchResult {
  sourceConnectionId: string
  sourceItemId: string
  raw: Record<string, unknown>
}

export interface ServerStream extends StreamResult {
  addonId: string
  addonName: string
}

export interface ServerStreamRequest {
  mediaType: 'movie' | 'series'
  mediaId: string
  tmdbId?: number
  tvdbId?: number | string
  malId?: number
  anilistId?: number
  season?: number
  episode?: number
  sourceConnectionId?: string
  sourceItemId?: string
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

function requireNative(): void {
  if (!nativeAvailable()) throw new Error('Server integrations are only available in the Aurales desktop app.')
}

export async function listServerConnections(): Promise<ServerConnectionSummary[]> {
  if (!SERVER_INTEGRATIONS_ENABLED || !nativeAvailable()) return []
  return invoke<ServerConnectionSummary[]>('list_server_connections')
}

export async function saveServerConnection(input: ServerConnectionInput): Promise<ServerConnectionSummary> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  requireNative()
  const result = await invoke<ServerConnectionSummary>('save_server_connection', { request: input })
  announceCatalogChange()
  return result
}

export async function removeServerConnection(connectionId: string): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  requireNative()
  await invoke('remove_server_connection', { connectionId })
  announceCatalogChange()
}

export async function setServerConnectionEnabled(connectionId: string, enabled: boolean): Promise<ServerConnectionSummary> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  requireNative()
  const result = await invoke<ServerConnectionSummary>('set_server_connection_enabled', { connectionId, enabled })
  announceCatalogChange()
  return result
}

export async function testServerConnection(input: ServerConnectionInput): Promise<ServerConnectionTestResult> {
  if (!SERVER_INTEGRATIONS_ENABLED) throw new Error('Server integrations are currently disabled.')
  requireNative()
  return invoke<ServerConnectionTestResult>('test_server_connection', { request: input })
}

export async function refreshServerCatalog(connectionId: string, announce = true): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED) return
  requireNative()
  await invoke('refresh_server_catalog', { connectionId })
  if (announce) announceCatalogChange()
}

/** Refreshes only stale enabled servers; every failure stays isolated. */
export async function refreshStaleServerCatalogs(maxAgeMs = 15 * 60 * 1000): Promise<void> {
  if (!SERVER_INTEGRATIONS_ENABLED || !nativeAvailable()) return
  const connections = await listServerConnections()
  const now = Date.now()
  const stale = connections.filter((connection) => {
    if (!connection.enabled) return false
    const refreshedAt = connection.lastCatalogRefreshAt ? Date.parse(connection.lastCatalogRefreshAt) : 0
    return !Number.isFinite(refreshedAt) || now - refreshedAt >= maxAgeMs
  })
  if (!stale.length) return
  await Promise.allSettled(stale.map((connection) => refreshServerCatalog(connection.id, false)))
  announceCatalogChange()
}

export async function listServerCatalogs(): Promise<ServerCatalogDescriptor[]> {
  if (!SERVER_INTEGRATIONS_ENABLED || !nativeAvailable()) return []
  return invoke<ServerCatalogDescriptor[]>('list_server_catalogs')
}

export async function getServerCatalogItems(connectionId: string, catalogId: string, maxItems?: number): Promise<ServerCatalogItem[]> {
  if (!SERVER_INTEGRATIONS_ENABLED) return []
  requireNative()
  return invoke<ServerCatalogItem[]>('get_server_catalog_items', { connectionId, catalogId, maxItems })
}

export async function searchServerCatalogs(query: string): Promise<SearchResult[]> {
  if (!SERVER_INTEGRATIONS_ENABLED || !nativeAvailable() || !query.trim()) return []
  return invoke<SearchResult[]>('search_server_catalogs', { query: query.trim() })
}

export async function getServerStreams(request: ServerStreamRequest): Promise<ServerStream[]> {
  if (!SERVER_INTEGRATIONS_ENABLED || !nativeAvailable()) return []
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
