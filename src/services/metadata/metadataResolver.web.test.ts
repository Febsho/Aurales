import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, cacheGetMock, cacheSetMock, cacheDeleteMock, cacheClearCategoryMock, classifyMock, resolveIdsMock, fetchMetadataMock, stored } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  cacheGetMock: vi.fn(),
  cacheSetMock: vi.fn(),
  cacheDeleteMock: vi.fn(),
  cacheClearCategoryMock: vi.fn(),
  classifyMock: vi.fn(),
  resolveIdsMock: vi.fn(),
  fetchMetadataMock: vi.fn(),
  stored: new Map<string, unknown>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../cache/sqliteCache', () => ({
  cacheClearCategory: cacheClearCategoryMock,
  cacheGet: cacheGetMock,
  cacheDelete: cacheDeleteMock,
  cacheSet: cacheSetMock,
}))
vi.mock('../metadata/metadataClassifier', () => ({ classifyMediaItem: classifyMock }))
vi.mock('../metadata/externalIdResolver', () => ({ resolveExternalIds: resolveIdsMock }))
vi.mock('../metadata/metadataProviders', () => ({ fetchAppProviderMetadata: fetchMetadataMock }))
vi.mock('../metadata/animeResolver', () => ({ resolveAnimeMetadata: vi.fn() }))
vi.mock('../metadata/metadataNormalizer', () => ({
  addonFallback: vi.fn(),
  appMediaToSearchResult: vi.fn(),
}))
vi.mock('../metadata/animeSeasonCache', () => ({ clearAnimeSeasonMemoryCache: vi.fn() }))
vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({
    appManagedMetadata: true,
    useAddonMetadataFallback: true,
    movieMetadataSource: 'tmdb',
    movieMetadataFallback: true,
    seriesMetadataSource: 'tmdb',
    seriesMetadataFallback: true,
    animeTitleLanguage: 'auto',
    preferTvdbAnimeSeasons: true,
    hideUnairedAnimeSeasons: true,
    hideUnairedAnimeEpisodes: true,
    includeAnimeSpecials: false,
    useGenericAnimeSeasonLabels: true,
    avoidJapaneseSeasonNames: true,
  }) },
}))

import { resolveAppMetadata } from './metadataResolver'

const input = { addonId: 'addon:test', addonType: 'movie', id: 'tmdb-42', title: 'Sample', tmdbId: 42 }
const result = {
  id: 'app_tmdb_movie_42', type: 'movie' as const, title: 'Sample', tmdbId: 42,
  genres: ['Drama'], sourceMetadataProvider: 'tmdb' as const, sourceAddonId: input.addonId,
  sourceAddonItemId: input.id, updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('browser app metadata persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stored.clear()
    cacheDeleteMock.mockResolvedValue(undefined)
    vi.stubGlobal('window', {})
    cacheGetMock.mockImplementation(async (key: string) => {
      const value = stored.get(key)
      return value ? { data: value, stale: false, age: 0 } : null
    })
    cacheSetMock.mockImplementation(async (key: string, value: unknown) => { stored.set(key, value) })
    classifyMock.mockResolvedValue('movie')
    resolveIdsMock.mockResolvedValue({ tmdbId: 42 })
    fetchMetadataMock.mockResolvedValue({ ...result })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('caches normalized metadata in the browser and reuses it without desktop IPC', async () => {
    await expect(resolveAppMetadata(input)).resolves.toMatchObject({ id: result.id, metadataClassifierVersion: 5 })
    expect(cacheSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^app_metadata_v1:/),
      expect.objectContaining({ metadataSettingsSignature: expect.any(String) }),
      expect.objectContaining({ category: 'app_metadata', ttlSeconds: null }),
    )

    fetchMetadataMock.mockClear()
    await expect(resolveAppMetadata(input)).resolves.toMatchObject({ id: result.id })
    expect(fetchMetadataMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('deletes stale browser metadata before resolving a fresh value', async () => {
    stored.set('stale', { ...result, metadataClassifierVersion: 1 })
    cacheGetMock.mockImplementation(async () => ({ data: { ...result, metadataClassifierVersion: 1 }, stale: false, age: 0 }))
    await expect(resolveAppMetadata(input)).resolves.toMatchObject({ id: result.id, metadataClassifierVersion: 5 })
    expect(cacheDeleteMock).toHaveBeenCalledWith(expect.stringMatching(/^app_metadata_v1:/))
    expect(cacheSetMock).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
