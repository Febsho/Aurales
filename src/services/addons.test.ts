import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveMetadataBatch, cachedFetch, invokeMock } = vi.hoisted(() => ({
  resolveMetadataBatch: vi.fn(),
  cachedFetch: vi.fn(async (_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('./metadata', () => ({
  appMediaToSearchResult: vi.fn(),
  resolveMetadataBatch,
}))

vi.mock('./cache/sqliteCache', () => ({
  cachedFetch,
}))

import { getAddonCatalog, getAddonMeta } from './addons'

describe('addon catalog metadata preference', () => {
  beforeEach(() => {
    resolveMetadataBatch.mockReset()
    cachedFetch.mockClear()
    invokeMock.mockReset()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => key === 'aurales_app_managed_metadata' ? 'false' : null),
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        metas: [{
          id: 'addon-show-1',
          type: 'series',
          name: 'Addon Show',
          poster: 'https://images.example/poster.jpg',
          background: 'https://images.example/backdrop.jpg',
          description: 'Addon description',
        }],
      }),
    })))
  })

  it('returns addon metadata immediately when app-managed metadata is disabled', async () => {
    const result = await getAddonCatalog(
      'https://addon.example/manifest.json',
      'series',
      'trending',
      undefined,
      'example.addon',
    )

    expect(resolveMetadataBatch).not.toHaveBeenCalled()
    expect(result).toEqual([expect.objectContaining({
      id: 'addon-show-1',
      title: 'Addon Show',
      poster: 'https://images.example/poster.jpg',
      backdrop: 'https://images.example/backdrop.jpg',
      overview: 'Addon description',
      provider: 'addon',
    })])
  })

  it('keeps episode metadata already included in a catalog item', async () => {
    const videos = [{ season: 1, episode: 1, name: 'Episode 1' }]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ metas: [{ id: 'addon-show-1', type: 'series', name: 'Addon Show', videos }] }),
    })))

    const result = await getAddonCatalog(
      'https://addon.example/manifest.json',
      'series',
      'with-episodes',
      undefined,
      'example.addon',
    )

    expect(result[0].addonMeta).toEqual(expect.objectContaining({ videos }))
  })

  it('activates the native catalog path without changing normalized output', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const videos = [{ season: 1, episode: 1, name: 'Episode 1' }]
    invokeMock.mockResolvedValue({
      stale: false,
      metas: [{
        id: 'addon-show-1',
        type: 'series',
        name: 'Addon Show',
        releaseInfo: '2025-2026',
        imdbRating: '8.4',
        poster: 'https://images.example/poster.jpg',
        videos,
      }],
    })

    const result = await getAddonCatalog(
      'https://addon.example/manifest.json',
      'series',
      'top',
      undefined,
      'example.addon',
    )

    expect(result).toEqual([expect.objectContaining({
      id: 'addon-show-1',
      title: 'Addon Show',
      type: 'series',
      year: 2025,
      rating: 8.4,
      provider: 'addon',
      sourceAddonId: 'example.addon',
      addonMeta: expect.objectContaining({ videos }),
    })])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not convert stale native navigation into an empty catalog result', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockResolvedValue({ stale: true, metas: [] })

    await expect(getAddonCatalog(
      'https://addon.example/manifest.json',
      'series',
      'old-search',
      undefined,
      'example.addon',
      false,
      { cancelGroup: 'search' },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the catalog compatibility path available on native failure', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockRejectedValue(new Error('native unavailable'))

    const result = await getAddonCatalog(
      'https://addon.example/manifest.json',
      'series',
      'fallback',
      undefined,
      'example.addon',
    )

    expect(result).toEqual([expect.objectContaining({ id: 'addon-show-1', title: 'Addon Show' })])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stores successful addon detail metadata in the detail cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ meta: { id: 'addon-show-1', name: 'Addon Show' } }),
    })))

    await expect(getAddonMeta(
      'https://addon.example/manifest.json',
      'series',
      'addon-show-1',
    )).resolves.toEqual({ id: 'addon-show-1', name: 'Addon Show' })

    expect(cachedFetch).toHaveBeenCalledWith(
      expect.stringContaining('addon-meta:v1:'),
      expect.any(Function),
      expect.objectContaining({ category: 'detail_page' }),
    )
  })

  it('uses native addon detail metadata inside the existing detail cache contract', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const meta = { id: 'addon-show-1', name: 'Addon Show', videos: [{ season: 1, episode: 1 }] }
    invokeMock.mockResolvedValue({ meta, stale: false })

    await expect(getAddonMeta(
      'https://addon.example/manifest.json',
      'series',
      'addon-show-1',
    )).resolves.toEqual(meta)

    expect(invokeMock).toHaveBeenCalledWith('load_addon_meta', expect.objectContaining({
      request: expect.objectContaining({ id: 'addon-show-1', mediaType: 'series' }),
    }))
    expect(fetch).not.toHaveBeenCalled()
    expect(cachedFetch).toHaveBeenCalledWith(
      expect.stringContaining('addon-meta:v1:'),
      expect.any(Function),
      expect.objectContaining({ category: 'detail_page' }),
    )
  })

  it('keeps the addon metadata compatibility path available on native failure', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    invokeMock.mockRejectedValue(new Error('native unavailable'))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ meta: { id: 'addon-show-1', name: 'Fallback Show' } }),
    })))

    await expect(getAddonMeta(
      'https://addon.example/manifest.json',
      'series',
      'addon-show-1',
    )).resolves.toEqual({ id: 'addon-show-1', name: 'Fallback Show' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('limits simultaneous catalog requests to one addon', async () => {
    const releases: Array<() => void> = []
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      releases.push(() => resolve({
        ok: true,
        json: async () => ({ metas: [{ id: `item-${releases.length}`, name: 'Item' }] }),
      } as Response))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const requests = ['one', 'two', 'three'].map((catalogId) => getAddonCatalog(
      'https://addon.example/manifest.json',
      'series',
      catalogId,
      undefined,
      'example.addon',
    ))

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releases[0]()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    releases[1]()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    releases[2]()
    await expect(Promise.all(requests)).resolves.toHaveLength(3)
  })

  it('prioritizes detail metadata ahead of queued catalogs for the same addon', async () => {
    const releases: Array<() => void> = []
    const fetchMock = vi.fn((url: string) => new Promise<Response>((resolve) => {
      releases.push(() => resolve({
        ok: true,
        json: async () => url.includes('/meta/')
          ? { meta: { id: 'show-1', videos: [] } }
          : { metas: [{ id: url, name: 'Item' }] },
      } as Response))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const firstCatalog = getAddonCatalog('https://addon.example/manifest.json', 'series', 'first')
    const secondCatalog = getAddonCatalog('https://addon.example/manifest.json', 'series', 'second')
    const detail = getAddonMeta('https://addon.example/manifest.json', 'series', 'show-1')

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releases[0]()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toContain('/meta/series/show-1.json')
    releases[1]()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    releases[2]()

    await expect(Promise.all([firstCatalog, secondCatalog, detail])).resolves.toHaveLength(3)
  })
})
