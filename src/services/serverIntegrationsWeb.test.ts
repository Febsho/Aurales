import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webGetServerStreams } from './serverIntegrationsWeb'

const DB_NAME = 'aurales-jellyfin-web'
const STORE = 'records'
const CONNECTIONS_KEY = 'connections'
const connectionId = 'test-server'

function storeRecord(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(value, key)
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
    }
  })
}

describe('AIOMetadata episode stream lookup', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
    const session = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    })
    vi.stubGlobal('window', {
      origin: 'http://aurales.test',
      setTimeout,
      clearTimeout,
      dispatchEvent: vi.fn(),
    })
    await storeRecord(CONNECTIONS_KEY, [{
      id: connectionId,
      kind: 'jellyfin',
      name: 'Main',
      serverUrl: 'https://aiometadata.test/jellyfin/config-id',
      enabled: true,
      userId: 'user-id',
    }])
    session.set(`aurales-jellyfin-token:${connectionId}`, 'test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves IMDb title identity to the exact Jellyfin episode before PlaybackInfo', async () => {
    const requested: Array<{ url: URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requested.push({ url, init })
      if (url.pathname.endsWith('/Items') && url.searchParams.has('SearchTerm')) {
        return Response.json({ Items: [{
          Id: 'encoded-series-id',
          Type: 'Series',
          Name: 'Family Guy',
          ProviderIds: { Imdb: 'tt0182576' },
        }] })
      }
      if (url.pathname.endsWith('/Shows/encoded-series-id/Episodes')) {
        return Response.json({ Items: [{
          Id: 'encoded-episode-id',
          Type: 'Episode',
          Name: 'Death Has a Shadow',
          SeriesId: 'encoded-series-id',
          ParentIndexNumber: 6,
          IndexNumber: 1,
        }] })
      }
      if (url.pathname.endsWith('/Items/encoded-episode-id/PlaybackInfo')) {
        return Response.json({
          PlaySessionId: 'play-session',
          MediaSources: [{
            Id: 'source-id',
            Name: 'AIOMetadata source',
            PlaySessionId: 'play-session',
            SupportsDirectPlay: true,
            DirectStreamUrl: 'https://cdn.example.test/family-guy.mp4',
            MediaStreams: [],
          }],
        })
      }
      return Response.json({ Items: [] })
    }))

    const streams = await webGetServerStreams({
      mediaType: 'series',
      mediaId: 'tt0182576',
      imdbId: 'tt0182576',
      title: 'Family Guy',
      season: 6,
      episode: 1,
      sourceConnectionId: connectionId,
    })

    expect(streams).toHaveLength(1)
    expect(streams[0]).toMatchObject({
      provider: 'jellyfin',
      sourceItemId: 'encoded-episode-id',
      url: 'https://cdn.example.test/family-guy.mp4',
    })
    expect(requested.map(({ url }) => url.pathname)).toEqual([
      '/jellyfin/config-id/Items',
      '/jellyfin/config-id/Shows/encoded-series-id/Episodes',
      '/jellyfin/config-id/Items/encoded-episode-id/PlaybackInfo',
    ])
    expect(JSON.parse(String(requested[2].init?.body))).toMatchObject({ EnableRequiredHttpHeaders: true })
  })
})
