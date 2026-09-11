import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { loadAddonCatalogNative, loadAddonMetaNative } from './addonCatalogLoader'

describe('native addon catalog loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  })

  it('sends one coarse request while preserving raw addon metadata', async () => {
    const meta = { id: 'show', videos: [{ season: 1, episode: 1 }] }
    invokeMock.mockResolvedValue({ metas: [meta], stale: false })
    await expect(loadAddonCatalogNative(
      'https://addon.example/manifest.json',
      'series',
      'top now',
      { search: 'A/B', skip: '20' },
      { cancelGroup: 'search', priority: 'interactive' },
    )).resolves.toEqual([meta])
    expect(invokeMock).toHaveBeenCalledWith('load_addon_catalog', {
      request: expect.objectContaining({
        mediaType: 'series',
        catalogId: 'top now',
        extra: [{ key: 'search', value: 'A/B' }, { key: 'skip', value: '20' }],
        cancelGroup: 'search',
        priority: 'interactive',
      }),
    })
  })

  it('rejects a stale native response', async () => {
    invokeMock.mockResolvedValue({ metas: [], stale: true })
    await expect(loadAddonCatalogNative('https://addon.example', 'series', 'top', undefined))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('prevents rapid A to B to C navigation from accepting older results', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    invokeMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    const a = loadAddonCatalogNative('https://addon.example', 'series', 'a', undefined, { cancelGroup: 'catalog-page' })
    const b = loadAddonCatalogNative('https://addon.example', 'series', 'b', undefined, { cancelGroup: 'catalog-page' })
    const c = loadAddonCatalogNative('https://addon.example', 'series', 'c', undefined, { cancelGroup: 'catalog-page' })
    resolvers[2]({ metas: [{ id: 'c' }], stale: false })
    await expect(c).resolves.toEqual([{ id: 'c' }])
    resolvers[0]({ metas: [{ id: 'a' }], stale: false })
    resolvers[1]({ metas: [{ id: 'b' }], stale: false })
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('loads complete addon detail metadata through one coarse request', async () => {
    const meta = { id: 'show', videos: [{ season: 1, episode: 1 }] }
    invokeMock.mockResolvedValue({ meta, stale: false })
    await expect(loadAddonMetaNative('https://addon.example/manifest.json', 'series', 'tt1'))
      .resolves.toEqual(meta)
    expect(invokeMock).toHaveBeenCalledWith('load_addon_meta', {
      request: expect.objectContaining({
        addonUrl: 'https://addon.example/manifest.json',
        mediaType: 'series',
        id: 'tt1',
        priority: 'interactive',
      }),
    })
  })
})
