import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import {
  disconnectDisabledServerIntegrations,
  getServerStreams,
  getServerCatalogItems,
  parseServerCatalogListId,
  saveServerConnection,
  searchServerCatalogs,
  refreshStaleServerCatalogs,
  serverCatalogListId,
} from './serverIntegrations'

describe('native server integration adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, dispatchEvent: vi.fn() })
  })

  it('keeps catalog identities reversible even when ids contain punctuation', () => {
    const value = serverCatalogListId('server:one', 'library/all:movies')
    expect(parseServerCatalogListId(value)).toEqual({ connectionId: 'server:one', catalogId: 'library/all:movies' })
  })

  it('saves native server connections through the protected command', async () => {
    const input = { kind: 'jellyfin' as const, name: 'Home', serverUrl: 'https://media.test', username: 'me', secret: 'private', authMode: 'password' as const, enabled: true }
    invokeMock.mockResolvedValue({ id: 'server-one', ...input })
    await expect(saveServerConnection(input)).resolves.toMatchObject({ id: 'server-one' })
    expect(invokeMock).toHaveBeenCalledWith('save_server_connection', { request: input })
  })

  it('resolves native server streams', async () => {
    invokeMock.mockResolvedValue([{ provider: 'jellyfin' }])
    await expect(getServerStreams({ mediaType: 'series', mediaId: 'tvdb-42', tvdbId: 42, season: 1, episode: 2, sourceConnectionId: 'one', sourceItemId: 'episode' })).resolves.toEqual([{ provider: 'jellyfin' }])
    expect(invokeMock).toHaveBeenCalledWith('get_server_streams', { request: { mediaType: 'series', mediaId: 'tvdb-42', tvdbId: 42, season: 1, episode: 2, sourceConnectionId: 'one', sourceItemId: 'episode' } })
  })

  it('loads native server catalog items', async () => {
    invokeMock.mockResolvedValue([{ title: 'Film' }])
    await expect(getServerCatalogItems('server-one', 'library:Movies', 40)).resolves.toEqual([{ title: 'Film' }])
    expect(invokeMock).toHaveBeenCalledWith('get_server_catalog_items', { connectionId: 'server-one', catalogId: 'library:Movies', maxItems: 40 })
  })

  it('does not invoke native search for a blank query', async () => {
    await expect(searchServerCatalogs('   ')).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('refreshes only stale enabled connections', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_server_connections') return Promise.resolve([
        { id: 'stale', enabled: true, lastCatalogRefreshAt: '2020-01-01T00:00:00Z' },
        { id: 'fresh', enabled: true, lastCatalogRefreshAt: new Date().toISOString() },
        { id: 'off', enabled: false },
      ])
      if (command === 'refresh_server_catalog') return Promise.reject(new Error('offline'))
      return Promise.resolve(undefined)
    })
    await expect(refreshStaleServerCatalogs()).resolves.toBeUndefined()
    expect(invokeMock).toHaveBeenCalledWith('refresh_server_catalog', { connectionId: 'stale' })
  })

  it('does not disconnect active server integrations during app startup', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_server_connections') return Promise.resolve([
        { id: 'enabled-server', enabled: true },
        { id: 'already-disabled', enabled: false },
      ])
      return Promise.resolve(undefined)
    })

    await disconnectDisabledServerIntegrations()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
