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

  it('does not expose server connection writes while the feature is disabled', async () => {
    await expect(saveServerConnection({ kind: 'jellyfin', name: 'Home', serverUrl: 'https://media.test', username: 'me', secret: 'private', authMode: 'password', enabled: true }))
      .rejects.toThrow('currently disabled')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not resolve server streams while the feature is disabled', async () => {
    invokeMock.mockResolvedValue([])
    await expect(getServerStreams({ mediaType: 'series', mediaId: 'tvdb-42', tvdbId: 42, season: 1, episode: 2, sourceConnectionId: 'one', sourceItemId: 'episode' })).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not expose native server catalogs while the feature is disabled', async () => {
    invokeMock.mockResolvedValue([])
    await expect(getServerCatalogItems('server-one', 'library:Movies', 40)).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not invoke native search for a blank query', async () => {
    await expect(searchServerCatalogs('   ')).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not refresh saved connections while the feature is disabled', async () => {
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
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('disconnects enabled servers without removing their saved configuration', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_server_connections') return Promise.resolve([
        { id: 'enabled-server', enabled: true },
        { id: 'already-disabled', enabled: false },
      ])
      return Promise.resolve(undefined)
    })

    await disconnectDisabledServerIntegrations()

    expect(invokeMock).toHaveBeenCalledWith('set_server_connection_enabled', {
      connectionId: 'enabled-server',
      enabled: false,
    })
    expect(invokeMock).not.toHaveBeenCalledWith('remove_server_connection', expect.anything())
  })
})
