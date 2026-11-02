import type { SearchResult } from '../types'
import { v4 as uuid } from 'uuid'
import type {
  JellyfinPlaybackReport,
  ServerCatalogDescriptor,
  ServerCatalogItem,
  ServerConnectionInput,
  ServerConnectionSummary,
  ServerConnectionTestResult,
  ServerStream,
  ServerStreamRequest,
} from './serverIntegrations'

const DB_NAME = 'aurales-jellyfin-web'
const DB_VERSION = 1
const STORE = 'records'
const CONNECTIONS_KEY = 'connections'
type WebConnection = ServerConnectionSummary & { userId?: string; cursor?: string }
type WebCatalogMode = 'view' | 'boxset' | 'continue-watching' | 'next-up' | 'upcoming' | 'favorites' | 'history' | 'recently-added'
type WebCatalogSource = Pick<ServerCatalogDescriptor, 'catalogId' | 'title' | 'kind' | 'contentType'> & { group?: string; mode: WebCatalogMode; sourceId?: string; itemCount?: number }
type WebCatalogRecord = { connectionId: string; items: ServerCatalogItem[]; sources?: WebCatalogSource[]; sourcesRefreshedAt?: number }
type AuthResult = { token: string; userId?: string; userName?: string; serverName?: string }

const ITEM_FIELDS = 'ProviderIds,Genres,Overview,DateCreated,DateLastSaved,ParentId,SeriesId,AncestorIds,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,ParentThumbItemId,ParentThumbImageTag,ParentBackdropItemId,ParentBackdropImageTags,ParentLogoItemId,ParentLogoImageTag,PremiereDate,EndDate,ProductionYear,CommunityRating,CriticRating,OfficialRating,RunTimeTicks,OriginalTitle,OriginalLanguage,SortName,Taglines,Tags,Studios,People,ProductionLocations,RemoteTrailers,ExternalUrls,ImageTags,BackdropImageTags,ImageBlurHashes,UserData'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open browser storage.'))
  })
}

async function readRecord<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

async function writeRecord(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function deleteRecord(key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function tokenKey(id: string): string { return `aurales-jellyfin-token:${id}` }
function catalogKey(id: string): string { return `catalog:${id}` }
function cleanBase(url: string): string { return url.trim().replace(/\/+$/, '') }
function absolute(base: string, path: string): string {
  // Keep Jellyfin's configured Base URL (for example /jellyfin) when joining
  // API paths; a leading slash passed to URL() would silently discard it.
  return new URL(path.replace(/^\/+/, ''), `${cleanBase(base)}/`).toString()
}
function authHeaders(token?: string): HeadersInit {
  const identity = 'Client="Aurales", Device="Web Browser", DeviceId="aurales-web", Version="0.5.3"'
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `MediaBrowser Token="${token}", ${identity}` } : {}),
  }
}

async function requestJson<T>(base: string, path: string, token?: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    response = await fetch(absolute(base, path), { ...init, signal: controller.signal, headers: { ...authHeaders(token), ...init.headers } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) throw new Error(`Jellyfin did not respond within 15 seconds at ${base}. Check the server URL and connection.`)
    throw new Error(`The browser could not reach ${base}. Check that the URL includes http:// or https:// and is reachable from this browser. If the browser reports a CORS error, configure Jellyfin or its reverse proxy to allow origin ${window.location.origin}, methods GET, POST and DELETE, and headers Authorization and Content-Type. (${message})`)
  } finally {
    window.clearTimeout(timeout)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Jellyfin returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

async function listConnections(): Promise<WebConnection[]> {
  return await readRecord<WebConnection[]>(CONNECTIONS_KEY) || []
}

async function saveConnections(connections: WebConnection[]): Promise<void> {
  await writeRecord(CONNECTIONS_KEY, connections)
}

function announce(): void { window.dispatchEvent(new Event('aurales:server-catalogs-changed')) }

async function authenticate(input: ServerConnectionInput, savedToken?: string): Promise<AuthResult> {
  const base = cleanBase(input.serverUrl)
  if (!/^https?:\/\//i.test(base)) throw new Error('Enter a valid http:// or https:// Jellyfin URL.')
  const publicInfo = await requestJson<Record<string, unknown>>(base, '/System/Info/Public')
  const serverName = typeof publicInfo.ServerName === 'string' ? publicInfo.ServerName : undefined
  if (input.authMode === 'password' && !input.secret && savedToken) {
    const user = await requestJson<Record<string, unknown>>(base, '/Users/Me', savedToken)
    return { token: savedToken, userId: stringValue(user.Id), userName: stringValue(user.Name) || input.username, serverName }
  }
  if (input.authMode === 'password') {
    const username = input.username?.trim()
    const password = input.secret || savedToken
    if (!username || !password) throw new Error('Enter your Jellyfin username and password.')
    const body = await requestJson<Record<string, unknown>>(base, '/Users/AuthenticateByName', undefined, {
      method: 'POST', headers: { Authorization: 'MediaBrowser Client="Aurales", Device="Web Browser", DeviceId="aurales-web", Version="0.5.3"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    const user = body.User && typeof body.User === 'object' ? body.User as Record<string, unknown> : {}
    if (typeof body.AccessToken !== 'string') throw new Error('Jellyfin did not return an access token.')
    return { token: body.AccessToken, userId: typeof user.Id === 'string' ? user.Id : undefined, userName: typeof user.Name === 'string' ? user.Name : username, serverName }
  }
  const token = input.secret || savedToken
  if (!token) throw new Error('Enter a Jellyfin access token or API key.')
  try {
    const user = await requestJson<Record<string, unknown>>(base, '/Users/Me', token)
    return { token, userId: typeof user.Id === 'string' ? user.Id : undefined, userName: typeof user.Name === 'string' ? user.Name : input.username, serverName }
  } catch (meError) {
    const username = input.username?.trim()
    if (!username) throw meError
    const users = await requestJson<Record<string, unknown>[]>(base, '/Users', token)
    const user = users.find((entry) => typeof entry.Name === 'string' && entry.Name.toLowerCase() === username.toLowerCase())
    if (!user) throw new Error(`Could not resolve Jellyfin user “${username}” with this token. Use a user access token or an API key that can list users.`)
    return { token, userId: typeof user.Id === 'string' ? user.Id : undefined, userName: typeof user.Name === 'string' ? user.Name : username, serverName }
  }
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function idValue(ids: unknown, keys: string[]): string | undefined {
  if (!ids || typeof ids !== 'object') return undefined
  const record = ids as Record<string, unknown>
  for (const key of keys) if (typeof record[key] === 'string' || typeof record[key] === 'number') return String(record[key])
  return undefined
}
function normalizedTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim()
    : ''
}
function itemFromRaw(connection: WebConnection, raw: Record<string, unknown>, catalogId: string): ServerCatalogItem | null {
  const id = stringValue(raw.Id)
  const kind = stringValue(raw.Type)
  if (!id || !kind) return null
  const mediaType = ({ Movie: 'movie', Series: 'series', Season: 'season', Episode: 'episode', BoxSet: 'collection' } as Record<string, ServerCatalogItem['mediaType']>)[kind]
  if (!mediaType) return null
  const tmdbId = idValue(raw.ProviderIds, ['Tmdb'])
  const tvdbId = idValue(raw.ProviderIds, ['Tvdb'])
  const imdbId = idValue(raw.ProviderIds, ['Imdb'])
  const anilistId = idValue(raw.ProviderIds, ['AniList', 'Anilist'])
  const malId = idValue(raw.ProviderIds, ['MyAnimeList', 'Mal'])
  const genres = asArray(raw.Genres).filter((value): value is string => typeof value === 'string')
  const isAnime = genres.some((genre) => genre.toLowerCase() === 'anime') || Boolean(anilistId || malId)
  const user = (raw.UserData && typeof raw.UserData === 'object' ? raw.UserData : {}) as Record<string, unknown>
  const catalogs = [catalogId]
  if (Number(user.PlaybackPositionTicks) > 0 && user.Played !== true) catalogs.push('continue-watching')
  if (user.IsFavorite === true) catalogs.push('favorites')
  const imageTags = (raw.ImageTags && typeof raw.ImageTags === 'object' ? raw.ImageTags : {}) as Record<string, unknown>
  const backdropTags = asArray(raw.BackdropImageTags)
  const parentBackdropTags = asArray(raw.ParentBackdropImageTags)
  const imageUrl = (itemId: string, image: string, tag?: unknown) => {
    const params = new URLSearchParams({ fillHeight: '900', quality: '90' })
    if (typeof tag === 'string' && tag) params.set('tag', tag)
    return absolute(connection.serverUrl, `/Items/${encodeURIComponent(itemId)}/Images/${image}?${params}`)
  }
  const primaryTag = imageTags.Primary
  const logoTag = imageTags.Logo
  const parentThumbItemId = stringValue(raw.ParentThumbItemId) || stringValue(raw.SeriesId)
  const parentThumbTag = raw.ParentThumbImageTag
  const primaryImage = mediaType === 'episode' && parentThumbItemId && parentThumbTag
    ? imageUrl(parentThumbItemId, 'Thumb', parentThumbTag)
    : typeof primaryTag === 'string' && primaryTag ? imageUrl(id, 'Primary', primaryTag) : undefined
  const backdropTag = typeof backdropTags[0] === 'string' ? backdropTags[0] : undefined
  const parentBackdropItemId = stringValue(raw.ParentBackdropItemId) || stringValue(raw.SeriesId)
  const parentBackdropTag = typeof parentBackdropTags[0] === 'string' ? parentBackdropTags[0] : undefined
  const backdropImage = backdropTag
    ? imageUrl(id, 'Backdrop', backdropTag)
    : parentBackdropItemId && parentBackdropTag ? imageUrl(parentBackdropItemId, 'Backdrop', parentBackdropTag) : undefined
  const normalizedRaw = { ...raw, serverUrl: connection.serverUrl }
  return {
    connectionId: connection.id, sourceConnectionId: connection.id, sourceItemId: id,
    parentSourceItemId: stringValue(raw.ParentId), sourceAddonId: `server:${connection.id}`, sourceAddonItemId: id,
    provider: 'jellyfin', id: tmdbId || tvdbId || anilistId || imdbId || id,
    type: mediaType === 'episode' || mediaType === 'collection' || mediaType === 'season' ? 'series' : mediaType, isAnime,
    catalogIds: catalogs, mediaType: mediaType as ServerCatalogItem['mediaType'], title: stringValue(raw.Name) || 'Untitled',
    year: typeof raw.ProductionYear === 'number' ? raw.ProductionYear : undefined,
    overview: stringValue(raw.Overview), rating: typeof raw.CommunityRating === 'number' ? raw.CommunityRating : undefined,
    criticRating: typeof raw.CriticRating === 'number' ? raw.CriticRating : undefined,
    runtime: typeof raw.RunTimeTicks === 'number' ? Math.floor(raw.RunTimeTicks / 10_000_000) : undefined,
    releaseDate: stringValue(raw.PremiereDate), originalTitle: stringValue(raw.OriginalTitle),
    certification: stringValue(raw.OfficialRating), tagline: asArray(raw.Taglines).find((value): value is string => typeof value === 'string'),
    genres, studios: asArray(raw.Studios).flatMap((studio) => studio && typeof studio === 'object' && typeof (studio as Record<string, unknown>).Name === 'string' ? [(studio as Record<string, unknown>).Name as string] : []),
    people: asArray(raw.People).filter((person): person is Record<string, unknown> => Boolean(person && typeof person === 'object')),
    season: typeof raw.ParentIndexNumber === 'number' ? raw.ParentIndexNumber : undefined,
    episode: typeof raw.IndexNumber === 'number' ? raw.IndexNumber : undefined,
    tmdbId, tvdbId, imdbId, anilistId, malId,
    poster: primaryImage || (mediaType === 'episode' && parentBackdropItemId && parentBackdropTag ? imageUrl(parentBackdropItemId, 'Backdrop', parentBackdropTag) : undefined),
    logo: typeof logoTag === 'string' ? imageUrl(id, 'Logo', logoTag) : undefined,
    backdrop: backdropImage || primaryImage, raw: normalizedRaw,
  }
}

function catalogSourceFromView(view: Record<string, unknown>, group?: string): WebCatalogSource | null {
  const sourceId = stringValue(view.Id)
  const title = stringValue(view.Name)
  if (!sourceId || !title) return null
  const collectionType = stringValue(view.CollectionType)
  const contentType: ServerCatalogDescriptor['contentType'] = collectionType === 'movies'
    ? 'movie'
    : collectionType === 'tvshows'
      ? 'series'
      : /anime|animation/i.test(title) ? 'anime' : 'mixed'
  return { catalogId: `view:${sourceId}`, title, group, kind: 'catalog', contentType, mode: 'view', sourceId }
}

async function discoverCatalogSources(connection: WebConnection, token: string): Promise<WebCatalogSource[]> {
  const params = new URLSearchParams()
  if (connection.userId) params.set('UserId', connection.userId)
  const response = await requestJson<Record<string, unknown>>(connection.serverUrl, `/UserViews?${params}`, token)
  const views = asArray(response.Items).filter((view): view is Record<string, unknown> => Boolean(view && typeof view === 'object'))
  const sources: WebCatalogSource[] = []
  for (const view of views) {
    if (stringValue(view.CollectionType) !== 'boxsets') {
      const source = catalogSourceFromView(view)
      if (source) sources.push(source)
      continue
    }
    const parentId = stringValue(view.Id)
    const groupName = stringValue(view.Name) || 'Collections'
    if (!parentId) continue
    const childrenParams = new URLSearchParams({ ParentId: parentId, Limit: '100', StartIndex: '0' })
    if (connection.userId) childrenParams.set('UserId', connection.userId)
    const children = await requestJson<Record<string, unknown>>(connection.serverUrl, `/Items?${childrenParams}`, token)
      .catch(() => ({} as Record<string, unknown>))
    const folders = asArray(children.Items).filter((child): child is Record<string, unknown> => Boolean(child && typeof child === 'object' && 'Type' in child && child.Type === 'BoxSet'))
    for (const folder of folders) {
      const sourceId = stringValue(folder.Id)
      const title = stringValue(folder.Name)
      if (!sourceId || !title) continue
      sources.push({ catalogId: `boxset:${sourceId}`, title, group: groupName, kind: 'collection', contentType: groupName === 'Genres' || groupName === 'Decades' ? 'mixed' : /movie/i.test(title) ? 'movie' : /show|series|anime/i.test(title) ? 'series' : 'mixed', mode: 'boxset', sourceId })
    }
    if (!folders.length) {
      const source = catalogSourceFromView(view, groupName)
      if (source) sources.push(source)
    }
  }
  sources.push(
    { catalogId: 'continue-watching', title: 'Continue Watching', group: 'Playback', kind: 'continue-watching', contentType: 'mixed', mode: 'continue-watching' },
    { catalogId: 'next-up', title: 'Next Up', group: 'Playback', kind: 'next-up', contentType: 'series', mode: 'next-up' },
    { catalogId: 'upcoming', title: 'Upcoming', group: 'Playback', kind: 'upcoming', contentType: 'mixed', mode: 'upcoming' },
    { catalogId: 'favorites', title: 'Watchlist', group: 'Playback', kind: 'favorites', contentType: 'mixed', mode: 'favorites' },
    { catalogId: 'history', title: 'Recently watched', group: 'Playback', kind: 'history', contentType: 'mixed', mode: 'history' },
    { catalogId: 'recently-added', title: 'Recently added', group: 'Playback', kind: 'recently-added', contentType: 'mixed', mode: 'recently-added' },
  )
  return [...new Map(sources.map((source) => [source.catalogId, source])).values()]
}

function catalogsFor(connection: WebConnection, record: WebCatalogRecord): ServerCatalogDescriptor[] {
  return (record.sources || []).map((source) => ({
    connectionId: connection.id,
    catalogId: source.catalogId,
    ...(source.mode === 'boxset' && source.kind === 'collection' && source.sourceId ? { sourceItemId: source.sourceId } : {}),
    provider: 'jellyfin',
    title: source.title,
    group: source.group,
    contentType: source.contentType,
    kind: source.kind,
    itemCount: source.itemCount || record.items.filter((item) => item.catalogIds.includes(source.catalogId)).length,
    connectionItemCount: record.items.length,
  }))
}

async function getCatalogRecord(connectionId: string): Promise<WebCatalogRecord | undefined> { return readRecord<WebCatalogRecord>(catalogKey(connectionId)) }
function decorateArt(item: ServerCatalogItem, token?: string): ServerCatalogItem {
  if (!token) return item
  const addToken = (value?: string) => {
    if (!value) return value
    try { const url = new URL(value); url.searchParams.set('ApiKey', token); return url.toString() } catch { return value }
  }
  return { ...item, poster: addToken(item.poster), backdrop: addToken(item.backdrop), logo: addToken(item.logo) }
}
async function getToken(connectionId: string): Promise<string> {
  const token = sessionStorage.getItem(tokenKey(connectionId))
  if (!token) throw new Error('Jellyfin web login expired for this browser tab. Edit the server, enter its credential again, and reconnect.')
  return token
}

async function ensureCatalogRecord(connection: WebConnection, force = false): Promise<WebCatalogRecord> {
  const existing = await getCatalogRecord(connection.id)
  if (!force && existing?.sources && Date.now() - (existing.sourcesRefreshedAt || 0) < 5 * 60_000) return existing
  const token = await getToken(connection.id)
  const sources = await discoverCatalogSources(connection, token)
  const record: WebCatalogRecord = { connectionId: connection.id, items: existing?.items || [], sources, sourcesRefreshedAt: Date.now() }
  await writeRecord(catalogKey(connection.id), record)
  return record
}

function mergeCatalogItems(existing: ServerCatalogItem[], next: ServerCatalogItem[]): ServerCatalogItem[] {
  const byId = new Map(existing.map((item) => [item.sourceItemId, item]))
  for (const item of next) {
    const previous = byId.get(item.sourceItemId)
    byId.set(item.sourceItemId, previous
      ? { ...previous, ...item, catalogIds: [...new Set([...previous.catalogIds, ...item.catalogIds])] }
      : item)
  }
  return [...byId.values()]
}

async function fetchCatalogItems(connection: WebConnection, token: string, source: WebCatalogSource, maxItems = 100): Promise<ServerCatalogItem[]> {
  const limit = Math.max(0, Math.min(maxItems, 50_000))
  if (!limit) return []
  const results: ServerCatalogItem[] = []
  let start = 0
  let total: number | undefined
  const pageSize = Math.min(100, limit)
  while (start < limit && (total === undefined || start < total)) {
    const params = new URLSearchParams({ StartIndex: String(start), Limit: String(Math.min(pageSize, limit - start)), Fields: ITEM_FIELDS, EnableImageTypes: 'Primary,Backdrop' })
    if (connection.userId) params.set('UserId', connection.userId)
    let path: string
    switch (source.mode) {
      case 'continue-watching': path = `/UserItems/Resume?${params}`; break
      case 'next-up': path = `/Shows/NextUp?${params}`; break
      case 'upcoming': path = `/Shows/Upcoming?${params}`; break
      case 'favorites': params.set('Filters', 'IsFavorite'); params.set('IncludeItemTypes', 'Movie,Series'); path = `/Items?${params}`; break
      case 'history': params.set('Filters', 'IsPlayed'); params.set('IncludeItemTypes', 'Movie,Episode'); path = `/Items?${params}`; break
      case 'recently-added': params.set('SortBy', 'DateCreated'); params.set('SortOrder', 'Descending'); params.set('IncludeItemTypes', 'Movie,Series,Episode'); path = `/Items?${params}`; break
      case 'view':
      case 'boxset':
        if (!source.sourceId) return []
        params.set('ParentId', source.sourceId)
        path = `/Items?${params}`
        break
    }
    const page = await requestJson<Record<string, unknown>>(connection.serverUrl, path, token)
    const rawItems = asArray(page.Items).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    results.push(...rawItems.flatMap((raw) => { const item = itemFromRaw(connection, raw, source.catalogId); return item ? [item] : [] }))
    total = typeof page.TotalRecordCount === 'number' ? page.TotalRecordCount : undefined
    start += rawItems.length
    if (!rawItems.length || rawItems.length < pageSize) break
  }
  const record = await getCatalogRecord(connection.id) || { connectionId: connection.id, items: [] }
  const sources = record.sources?.map((entry) => entry.catalogId === source.catalogId
    ? { ...entry, itemCount: total ?? results.length }
    : entry)
  await writeRecord(catalogKey(connection.id), { ...record, ...(sources ? { sources } : {}), items: mergeCatalogItems(record.items, results) })
  return results
}

async function fetchServerItem(connection: WebConnection, token: string, itemId: string, maxItems: number): Promise<ServerCatalogItem[]> {
  const params = new URLSearchParams({ Ids: itemId, Fields: ITEM_FIELDS })
  if (connection.userId) params.set('UserId', connection.userId)
  const response = await requestJson<Record<string, unknown>>(connection.serverUrl, `/Items?${params}`, token)
  return asArray(response.Items).flatMap((raw) => raw && typeof raw === 'object' ? [itemFromRaw(connection, raw as Record<string, unknown>, `item:${itemId}`)].filter((item): item is ServerCatalogItem => Boolean(item)) : []).slice(0, maxItems)
}

async function fetchSeriesEpisodes(connection: WebConnection, token: string, seriesId: string, maxItems: number): Promise<ServerCatalogItem[]> {
  const source: WebCatalogSource = { catalogId: `episodes:${seriesId}`, title: 'Episodes', kind: 'catalog', contentType: 'series', mode: 'boxset', sourceId: seriesId }
  const results: ServerCatalogItem[] = []
  let start = 0
  const limit = Math.max(0, Math.min(maxItems, 50_000))
  while (start < limit) {
    const params = new URLSearchParams({ UserId: connection.userId || '', StartIndex: String(start), Limit: String(Math.min(100, limit - start)), Fields: ITEM_FIELDS })
    const page = await requestJson<Record<string, unknown>>(connection.serverUrl, `/Shows/${encodeURIComponent(seriesId)}/Episodes?${params}`, token)
    const items = asArray(page.Items).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    results.push(...items.flatMap((raw) => { const item = itemFromRaw(connection, raw, source.catalogId); return item ? [item] : [] }))
    start += items.length
    const total = typeof page.TotalRecordCount === 'number' ? page.TotalRecordCount : undefined
    if (!items.length || items.length < 100 || (total !== undefined && start >= total)) break
  }
  const record = await getCatalogRecord(connection.id) || { connectionId: connection.id, items: [] }
  await writeRecord(catalogKey(connection.id), { ...record, items: mergeCatalogItems(record.items, results) })
  return results
}

export async function webListServerConnections(): Promise<ServerConnectionSummary[]> {
  return (await listConnections()).map((connection) => {
    const hasSecret = Boolean(sessionStorage.getItem(tokenKey(connection.id)))
    return { ...connection, hasSecret, status: hasSecret ? connection.status : 'disconnected' }
  })
}
export async function webSaveServerConnection(input: ServerConnectionInput): Promise<ServerConnectionSummary> {
  const connections = await listConnections()
  // randomUUID() is unavailable on non-secure origins such as the HTTP
  // Tailscale IP used by the hosted web app. uuid uses getRandomValues there.
  const id = input.id || uuid()
  const previous = connections.find((connection) => connection.id === id)
  const savedToken = sessionStorage.getItem(tokenKey(id)) || undefined
  const identity = await authenticate(input, savedToken)
  sessionStorage.setItem(tokenKey(id), identity.token)
  const connection: WebConnection = {
    id, kind: 'jellyfin', name: input.name.trim(), serverUrl: cleanBase(input.serverUrl), username: input.username?.trim(),
    authMode: input.authMode, enabled: input.enabled, hasSecret: true, status: 'connected', serverName: identity.serverName,
    userName: identity.userName, userId: identity.userId, lastCheckedAt: new Date().toISOString(),
    lastCatalogRefreshAt: previous?.lastCatalogRefreshAt,
  }
  await saveConnections([...connections.filter((entry) => entry.id !== id), connection])
  announce()
  return connection
}
export async function webTestServerConnection(input: ServerConnectionInput): Promise<ServerConnectionTestResult> {
  try {
    const identity = await authenticate(input, input.id ? sessionStorage.getItem(tokenKey(input.id)) || undefined : undefined)
    return { ok: true, serverName: identity.serverName, userName: identity.userName }
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
}
export async function webRemoveServerConnection(id: string): Promise<void> {
  await saveConnections((await listConnections()).filter((connection) => connection.id !== id))
  sessionStorage.removeItem(tokenKey(id)); await deleteRecord(catalogKey(id)); announce()
}
export async function webSetServerConnectionEnabled(id: string, enabled: boolean): Promise<ServerConnectionSummary> {
  const connections = await listConnections()
  const found = connections.find((connection) => connection.id === id)
  if (!found) throw new Error('Jellyfin connection not found.')
  const next = { ...found, enabled }
  await saveConnections(connections.map((connection) => connection.id === id ? next : connection)); announce(); return next
}
export async function webRefreshServerCatalog(id: string): Promise<void> {
  const connections = await listConnections()
  const connection = connections.find((entry) => entry.id === id)
  if (!connection) throw new Error('Jellyfin connection not found.')
  const record = await ensureCatalogRecord(connection, true)
  // List contents load when a shelf is opened. Fetching all source views on
  // connect can mean hundreds of requests and delays the connection result.
  record.items = record.items.filter((item) => !item.catalogIds.includes('continue-watching') && !item.catalogIds.includes('next-up'))
  await writeRecord(catalogKey(id), record)
  const updated = { ...connection, status: 'connected' as const, lastCatalogRefreshAt: new Date().toISOString(), statusMessage: undefined }
  await saveConnections(connections.map((entry) => entry.id === id ? updated : entry)); announce()
}
export async function webListServerCatalogs(): Promise<ServerCatalogDescriptor[]> {
  const connections = await listConnections()
  const records = await Promise.all(connections.map(async (connection) => {
    try { return await ensureCatalogRecord(connection) } catch { return await getCatalogRecord(connection.id) }
  }))
  return connections.flatMap((connection, index) => records[index] ? catalogsFor(connection, records[index]!) : [])
}
export async function webGetServerCatalogItems(id: string, catalogId: string, maxItems?: number): Promise<ServerCatalogItem[]> {
  const connections = await listConnections()
  const connection = connections.find((entry) => entry.id === id)
  if (!connection) return []
  const token = await getToken(id)
  // BoxSet collections are browsable libraries in AIOMetadata, not ordinary
  // one-screen recommendation rows. Load enough pages for the full collection
  // when opened; keep the smaller default for general catalog shelves.
  const limit = maxItems ?? (catalogId.startsWith('boxset:') ? 5_000 : 100)
  if (catalogId.startsWith('item:')) return (await fetchServerItem(connection, token, catalogId.slice(5), limit)).map((item) => decorateArt(item, token))
  if (catalogId.startsWith('episodes:')) return (await fetchSeriesEpisodes(connection, token, catalogId.slice(9), limit)).map((item) => decorateArt(item, token))
  const record = await ensureCatalogRecord(connection)
  const source = record.sources?.find((entry) => entry.catalogId === catalogId)
  if (source) return (await fetchCatalogItems(connection, token, source, limit)).map((item) => decorateArt(item, token))
  // Legacy ids stay readable for existing Aurales profiles while they migrate
  // to the server's actual browsable views.
  const cached = record.items.filter((item) => item.catalogIds.includes(catalogId) || item.mediaType === catalogId)
  return cached.slice(0, limit).map((item) => decorateArt(item, token))
}
export async function webSearchServerCatalogs(query: string): Promise<SearchResult[]> {
  const q = query.trim()
  if (!q) return []
  const connections = (await listConnections()).filter((connection) => connection.enabled)
  const results = await Promise.all(connections.map(async (connection) => {
    const token = await getToken(connection.id)
    const params = new URLSearchParams({ SearchTerm: q, IncludeItemTypes: 'Movie,Series', Limit: '50', Fields: ITEM_FIELDS })
    if (connection.userId) params.set('UserId', connection.userId)
    const response = await requestJson<Record<string, unknown>>(connection.serverUrl, `/Items?${params}`, token)
    const rawItems = asArray(response.Items).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    const items = rawItems.flatMap((raw) => { const item = itemFromRaw(connection, raw, 'search'); return item ? [item] : [] })
    const record = await getCatalogRecord(connection.id) || { connectionId: connection.id, items: [] }
    await writeRecord(catalogKey(connection.id), { ...record, items: mergeCatalogItems(record.items, items) })
    return items.map((item) => decorateArt(item, token))
  }))
  return results.flat()
}

async function resolvePlaybackItemId(
  connection: WebConnection,
  token: string,
  requestedItemId: string,
  season?: number,
  episode?: number,
): Promise<string> {
  if (season == null || episode == null) return requestedItemId
  const record = await getCatalogRecord(connection.id)
  const cachedEpisode = record?.items.find((item) => item.mediaType === 'episode'
    && item.season === season && item.episode === episode
    && (item.sourceItemId === requestedItemId || item.parentSourceItemId === requestedItemId
      || (item.raw as Record<string, unknown>).SeriesId === requestedItemId))
  if (cachedEpisode) return cachedEpisode.sourceItemId

  // The detail page passes the series id with S/E coordinates. aiometadata's
  // PlaybackInfo route only accepts movie and episode ids, so resolve the
  // exact Jellyfin episode first.
  const params = new URLSearchParams({ Season: String(season), StartIndex: '0', Limit: '500', Fields: ITEM_FIELDS })
  if (connection.userId) params.set('UserId', connection.userId)
  try {
    const page = await requestJson<Record<string, unknown>>(connection.serverUrl,
      `/Shows/${encodeURIComponent(requestedItemId)}/Episodes?${params}`, token)
    const raw = asArray(page.Items).find((item) => item && typeof item === 'object'
      && Number((item as Record<string, unknown>).ParentIndexNumber) === season
      && Number((item as Record<string, unknown>).IndexNumber) === episode) as Record<string, unknown> | undefined
    const id = stringValue(raw?.Id)
    if (id) {
      const mapped = itemFromRaw(connection, raw!, `episodes:${requestedItemId}`)
      if (mapped) {
        const latest = await getCatalogRecord(connection.id) || { connectionId: connection.id, items: [] }
        await writeRecord(catalogKey(connection.id), { ...latest, items: mergeCatalogItems(latest.items, [mapped]) })
      }
      return id
    }
  } catch { /* Fall through to a helpful item lookup error below. */ }

  // Continue Watching can already carry an episode id. Validate and retain it.
  try {
    const [item] = await fetchServerItem(connection, token, requestedItemId, 1)
    if (item?.mediaType === 'episode' && item.season === season && item.episode === episode) return requestedItemId
  } catch { /* report the exact episode lookup failure below */ }
  throw new Error(`Could not find Jellyfin episode S${season}E${episode} for this series. Refresh the server catalog and try again.`)
}

export async function webGetServerStreams(request: ServerStreamRequest): Promise<ServerStream[]> {
  const connections = await listConnections()
  const candidates = connections.filter((connection) => connection.enabled && (!request.sourceConnectionId || request.sourceConnectionId === connection.id))
  if (!candidates.length) throw new Error('No enabled Jellyfin connection is available for this item. Check the Jellyfin connection in Settings.')
  const results: ServerStream[] = []
  for (const connection of candidates) {
    const token = await getToken(connection.id)
    let itemId = request.sourceItemId
    if (!itemId) {
      const items = (await getCatalogRecord(connection.id))?.items || []
      const matched = items.find((item) => (request.mediaType === 'movie' ? item.mediaType === 'movie' : item.mediaType === 'episode')
        && (item.id === request.mediaId || request.tmdbId && item.tmdbId === String(request.tmdbId) || request.tvdbId && item.tvdbId === String(request.tvdbId) || request.imdbId && item.imdbId === request.imdbId
          || request.anilistId && item.anilistId === String(request.anilistId) || request.malId && item.malId === String(request.malId)))
      itemId = matched?.sourceItemId
      // Series detail routes often know the external series identity but have
      // not loaded a Jellyfin episode yet. Resolve the server's series first;
      // resolvePlaybackItemId then fetches the requested season and episode.
      if (!itemId && request.mediaType === 'series') {
        const series = items.find((item) => item.mediaType === 'series'
          && (item.id === request.mediaId || request.tmdbId && item.tmdbId === String(request.tmdbId) || request.tvdbId && item.tvdbId === String(request.tvdbId)
            || request.imdbId && item.imdbId === request.imdbId || request.anilistId && item.anilistId === String(request.anilistId) || request.malId && item.malId === String(request.malId)))
        itemId = series?.sourceItemId
      }
    }
    // External IDs such as tt0182576 are metadata-provider IDs, not Jellyfin
    // item IDs. If this page was opened from an addon/TMDB route, query the
    // connected server by its title, then match its ProviderIds before using
    // an exact normalized title as a fallback.
    if (!itemId && request.title?.trim()) {
      const params = new URLSearchParams({
        SearchTerm: request.title.trim(),
        IncludeItemTypes: request.mediaType === 'movie' ? 'Movie' : 'Series',
        Limit: '100',
        Fields: ITEM_FIELDS,
      })
      if (connection.userId) params.set('UserId', connection.userId)
      const page = await requestJson<Record<string, unknown>>(connection.serverUrl, `/Items?${params}`, token)
      const matches = asArray(page.Items).filter((raw): raw is Record<string, unknown> => Boolean(raw && typeof raw === 'object'))
      const identityMatch = matches.find((raw) =>
        request.imdbId && idValue(raw.ProviderIds, ['Imdb'])?.toLowerCase() === request.imdbId.toLowerCase()
        || request.tmdbId != null && idValue(raw.ProviderIds, ['Tmdb']) === String(request.tmdbId)
        || request.tvdbId != null && idValue(raw.ProviderIds, ['Tvdb']) === String(request.tvdbId)
        || request.anilistId != null && idValue(raw.ProviderIds, ['AniList', 'Anilist']) === String(request.anilistId)
        || request.malId != null && idValue(raw.ProviderIds, ['MyAnimeList', 'Mal']) === String(request.malId))
      const normalizedRequestTitle = normalizedTitle(request.title)
      const exactTitleMatch = matches.find((raw) => normalizedTitle(raw.Name) === normalizedRequestTitle)
      const resolved = identityMatch || exactTitleMatch
      itemId = stringValue(resolved?.Id)
      if (resolved) {
        const mapped = itemFromRaw(connection, resolved, `search:${request.mediaType}`)
        if (mapped) {
          const latest = await getCatalogRecord(connection.id) || { connectionId: connection.id, items: [] }
          await writeRecord(catalogKey(connection.id), { ...latest, items: mergeCatalogItems(latest.items, [mapped]) })
        }
      }
    }
    if (!itemId) throw new Error(`Could not match “${request.mediaId}” to an item in ${connection.name}. Refresh the Jellyfin catalog and retry.`)
    itemId = await resolvePlaybackItemId(connection, token, itemId, request.season, request.episode)
    const userQuery = connection.userId ? `?UserId=${encodeURIComponent(connection.userId)}` : ''
    const body = await requestJson<Record<string, unknown>>(connection.serverUrl, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo${userQuery}`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ UserId: connection.userId, EnableDirectPlay: true, EnableDirectStream: true, EnableTranscoding: true, EnableRequiredHttpHeaders: true, AutoOpenLiveStream: false }) })
    const mediaSources = asArray(body.MediaSources).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
    if (!mediaSources.length) {
      const code = stringValue(body.ErrorCode)
      throw new Error(code ? `Jellyfin could not resolve this episode (${code}).` : 'The Jellyfin server returned no playable sources for this episode.')
    }
    for (const source of mediaSources) {
      const sourceId = stringValue(source.Id) || itemId
      const sourceStreams = asArray(source.MediaStreams).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      const video = sourceStreams.find((track) => track.Type === 'Video')
      const audio = sourceStreams.find((track) => track.Type === 'Audio')
      const subtitles = sourceStreams.filter((track) => track.Type === 'Subtitle')
      const playSessionId = stringValue(source.PlaySessionId) || stringValue(body.PlaySessionId) || sourceId
      const directUrl = stringValue(source.DirectStreamUrl) || stringValue(source.Path)
      const directPlay = source.SupportsDirectPlay === true
      const directStream = source.SupportsDirectStream === true || Boolean(directUrl)
      const fallbackPath = `/Videos/${encodeURIComponent(itemId)}/stream?Static=true&MediaSourceId=${encodeURIComponent(sourceId)}`
      let playUrl = absolute(connection.serverUrl, fallbackPath)
      if (directUrl) {
        try {
          const candidate = new URL(absolute(connection.serverUrl, directUrl))
          if ((candidate.protocol === 'https:' || candidate.protocol === 'http:') && !candidate.username && !candidate.password) playUrl = candidate.toString()
        } catch { /* keep the authenticated Jellyfin playback URL */ }
      }
      const url = new URL(playUrl)
      if (url.origin === new URL(connection.serverUrl).origin) {
        url.searchParams.delete('api_key')
        url.searchParams.set('ApiKey', token)
        url.searchParams.set('PlaySessionId', playSessionId)
      }
      const requiredHeaders = source.RequiredHttpHeaders && typeof source.RequiredHttpHeaders === 'object'
        ? Object.entries(source.RequiredHttpHeaders as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        : []
      const streamMeta = source.aiostreams && typeof source.aiostreams === 'object' ? source.aiostreams as Record<string, unknown> : {}
      const baseStream: ServerStream = {
        addonId: `server:${connection.id}`, addonName: `${connection.name} · AIOMetadata`, provider: 'jellyfin', connectionId: connection.id, sourceItemId: itemId,
        name: String(streamMeta.name || source.Name || connection.name), title: String(streamMeta.name || source.Name || connection.name),
        description: stringValue(streamMeta.description) || stringValue(source.Name), filename: stringValue(streamMeta.id), url: url.toString(),
        headers: requiredHeaders, directPlay, directStream, transcode: false, mediaSourceId: sourceId, playSessionId,
        container: stringValue(source.Container), videoCodec: stringValue(video?.Codec), audioCodec: stringValue(audio?.Codec),
        resolution: typeof video?.Width === 'number' && typeof video.Height === 'number' ? `${video.Width}x${video.Height}` : undefined,
        bitrate: typeof source.Bitrate === 'number' ? source.Bitrate : undefined,
        hdr: stringValue(video?.VideoRangeType) || stringValue(video?.VideoRange), audioTracks: sourceStreams.filter((track) => track.Type === 'Audio'), subtitleTracks: subtitles,
        subtitles: subtitles.flatMap((track) => {
          if (typeof track.Index !== 'number') return []
          const subtitleUrl = new URL(absolute(connection.serverUrl, `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(sourceId)}/Subtitles/${track.Index}/Stream.${['vtt','srt','ass','ssa','sub'].includes(String(track.Codec).toLowerCase()) ? track.Codec : 'vtt'}`))
          subtitleUrl.searchParams.set('ApiKey', token)
          return [{ id: String(track.Index), url: subtitleUrl.toString(), lang: stringValue(track.Language) || 'und', label: stringValue(track.DisplayTitle) || stringValue(track.Title) || 'Subtitle', source: 'stream' as const }]
        }),
        chapters: asArray(body.Chapters).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object')),
        behaviorHints: { notWebReady: true, serverProvider: 'jellyfin', directPlay,
          ...(requiredHeaders.length ? { proxyHeaders: { request: Object.fromEntries(requiredHeaders) } } : {}) },
      }
      if (directPlay || directStream) results.push(baseStream)
      if (typeof source.TranscodingUrl === 'string') {
        const transcodeUrl = new URL(absolute(connection.serverUrl, source.TranscodingUrl))
        if (transcodeUrl.origin === new URL(connection.serverUrl).origin) {
          transcodeUrl.searchParams.delete('api_key')
          transcodeUrl.searchParams.set('ApiKey', token)
          results.push({ ...baseStream, name: `${baseStream.name} · Transcode`, directPlay: false, directStream: false, transcode: true, url: transcodeUrl.toString(), container: stringValue(source.TranscodingContainer), behaviorHints: { notWebReady: true, serverProvider: 'jellyfin', directPlay: false, transcode: true } })
        }
      }
    }
  }
  if (!results.length) throw new Error('Jellyfin returned media sources, but none included a playable URL. Check the AIOMetadata stream add-on configuration and its source filters.')
  return results.sort((left, right) => Number(left.transcode) - Number(right.transcode) || Number(right.directPlay) - Number(left.directPlay))
}
export async function webReportJellyfinPlayback(request: JellyfinPlaybackReport): Promise<void> {
  const connections = await listConnections()
  const connection = connections.find((entry) => entry.id === request.connectionId)
  if (!connection) throw new Error('Jellyfin connection not found.')
  const token = await getToken(connection.id)
  const path = request.event === 'start' ? '/Sessions/Playing' : request.event === 'stop' ? '/Sessions/Playing/Stopped' : '/Sessions/Playing/Progress'
  const payload: Record<string, unknown> = { ItemId: request.itemId, MediaSourceId: request.mediaSourceId, PlaySessionId: request.playSessionId, PositionTicks: request.positionTicks }
  if (request.event !== 'stop') Object.assign(payload, { CanSeek: true, IsPaused: request.isPaused, PlayMethod: request.playMethod })
  try {
    await requestJson(connection.serverUrl, path, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  } catch (sessionError) {
    // Jellyfin can reject /Sessions callbacks for web clients that are not
    // registered as a server session (common with AIOMetadata virtual media).
    // Its user-scoped playstate endpoints still persist resume positions.
    if (!connection.userId) throw sessionError
    const userItemPath = `/Users/${encodeURIComponent(connection.userId)}/PlayingItems/${encodeURIComponent(request.itemId)}`
    const query = new URLSearchParams({
      positionTicks: String(request.positionTicks),
      playMethod: request.playMethod,
      isPaused: String(request.isPaused),
      playSessionId: request.playSessionId,
    })
    if (request.mediaSourceId) query.set('mediaSourceId', request.mediaSourceId)
    if (request.event === 'start') {
      await requestJson(connection.serverUrl, `${userItemPath}?${query}`, token, { method: 'POST' })
    } else {
      await requestJson(connection.serverUrl, `${userItemPath}/Progress?${query}`, token, { method: 'POST' })
      if (request.event === 'stop') await requestJson(connection.serverUrl, userItemPath, token, { method: 'DELETE' })
    }
  }
  const completed = request.event === 'stop' && Number(request.runtimeTicks) > 0
    && request.positionTicks / Number(request.runtimeTicks) >= 0.80
  if (completed) {
    const previous = await getCatalogRecord(connection.id)
    const previousItem = previous?.items.find((entry) => entry.sourceItemId === request.itemId)
    const previousUserData = previousItem?.raw.UserData
    const alreadyPlayed = Boolean(previousUserData && typeof previousUserData === 'object'
      && (previousUserData as Record<string, unknown>).Played === true)
    if (!alreadyPlayed) await webSetJellyfinItemWatched(request.connectionId, request.itemId, true)
  }
  const record = await getCatalogRecord(connection.id)
  const item = record?.items.find((entry) => entry.sourceItemId === request.itemId)
  if (record && item) {
    const user = item.raw.UserData && typeof item.raw.UserData === 'object' ? item.raw.UserData as Record<string, unknown> : {}
    user.PlaybackPositionTicks = request.positionTicks
    if (completed) {
      if (user.Played !== true) user.PlayCount = Number(user.PlayCount || 0) + 1
      user.Played = true
      user.PlaybackPositionTicks = 0
    }
    item.raw.UserData = user
    item.catalogIds = item.catalogIds.filter((id) => id !== 'continue-watching')
    if (!completed && request.positionTicks > 0 && user.Played !== true) item.catalogIds.push('continue-watching')
    await writeRecord(catalogKey(connection.id), record)
  }
  if (request.event === 'stop') announce()
}
export async function webSetJellyfinItemWatched(
  connectionId: string,
  itemId: string,
  watched: boolean,
  episode?: { season: number; episode: number },
): Promise<void> {
  const connections = await listConnections()
  const connection = connections.find((entry) => entry.id === connectionId)
  if (!connection?.userId) throw new Error('Jellyfin watched status requires a user account. Reconnect using a password or user access token.')
  const token = await getToken(connectionId)
  let targetIds = [itemId]
  if (episode) {
    const record = await getCatalogRecord(connectionId)
    let exact = record?.items.find((item) => item.mediaType === 'episode'
      && item.season === episode.season && item.episode === episode.episode
      && (item.sourceItemId === itemId || item.parentSourceItemId === itemId || item.raw.SeriesId === itemId))
    if (!exact) {
      const params = new URLSearchParams({ Season: String(episode.season), StartIndex: '0', Limit: '500', Fields: ITEM_FIELDS, UserId: connection.userId })
      const page = await requestJson<Record<string, unknown>>(connection.serverUrl,
        `/Shows/${encodeURIComponent(itemId)}/Episodes?${params}`, token)
      const raw = asArray(page.Items).find((entry) => entry && typeof entry === 'object'
        && Number((entry as Record<string, unknown>).ParentIndexNumber) === episode.season
        && Number((entry as Record<string, unknown>).IndexNumber) === episode.episode) as Record<string, unknown> | undefined
      if (!raw || !stringValue(raw.Id)) throw new Error(`Jellyfin episode S${episode.season}E${episode.episode} could not be resolved.`)
      exact = itemFromRaw(connection, raw, `episodes:${itemId}`) || undefined
      if (exact) {
        const latest = await getCatalogRecord(connectionId) || { connectionId, items: [] }
        await writeRecord(catalogKey(connectionId), { ...latest, items: mergeCatalogItems(latest.items, [exact]) })
      } else {
        targetIds = [stringValue(raw.Id)!]
      }
    }
    if (exact) targetIds = [exact.sourceItemId]
  }
  for (const targetId of targetIds) {
    const url = absolute(connection.serverUrl, `/UserPlayedItems/${encodeURIComponent(targetId)}?userId=${encodeURIComponent(connection.userId)}`)
    let response = await fetch(url, { method: watched ? 'POST' : 'DELETE', headers: authHeaders(token) })
    if (response.status === 404) {
      response = await fetch(absolute(connection.serverUrl, `/Users/${encodeURIComponent(connection.userId)}/PlayedItems/${encodeURIComponent(targetId)}`), { method: watched ? 'POST' : 'DELETE', headers: authHeaders(token) })
    }
    if (!response.ok) throw new Error(`Jellyfin returned HTTP ${response.status} while updating watched status.`)
    const record = await getCatalogRecord(connectionId)
    if (record) {
      const item = record.items.find((entry) => entry.sourceItemId === targetId)
      if (item) {
        const user = item.raw.UserData && typeof item.raw.UserData === 'object' ? item.raw.UserData as Record<string, unknown> : {}
        user.Played = watched; user.PlaybackPositionTicks = 0; user.PlayCount = watched ? Number(user.PlayCount || 0) + 1 : 0
        item.raw.UserData = user
        item.catalogIds = item.catalogIds.filter((id) => id !== 'continue-watching')
        await writeRecord(catalogKey(connectionId), record)
      }
    }
  }
  announce()
}
