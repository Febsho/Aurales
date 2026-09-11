import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppMediaItem, AddonMediaInput, ResolvedExternalIds } from './types'

const {
  loadDetailPageMock,
  loadMovieDetailPageMock,
  normalizeMovieMock,
  normalizeShowMock,
} = vi.hoisted(() => ({
  loadDetailPageMock: vi.fn(),
  loadMovieDetailPageMock: vi.fn(),
  normalizeMovieMock: vi.fn(),
  normalizeShowMock: vi.fn(),
}))

let settings = { seriesMetadataSource: 'tmdb', seriesMetadataFallback: true }

vi.mock('./detailPageLoader', () => ({
  loadDetailPage: loadDetailPageMock,
  loadMovieDetailPage: loadMovieDetailPageMock,
}))
vi.mock('./metadataNormalizer', () => ({
  normalizeMovieWithNativeFallback: normalizeMovieMock,
  normalizeShowWithNativeFallback: normalizeShowMock,
}))
vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => settings },
}))

import { fetchAppProviderMetadata } from './metadataProviders'

const input: AddonMediaInput = { addonId: 'addon.example', id: 'item-1', title: 'Example' }
const ids: ResolvedExternalIds = { tmdbId: 7, tvdbId: 9 }
const tmdbShow = { id: 'tmdb-7', title: 'TMDB', genres: [], seasons: [], cast: [], crew: [], recommendations: [], trailers: [], provider: 'tmdb' }
const tvdbShow = { ...tmdbShow, id: 'tvdb-9', title: 'TVDB', provider: 'tvdb', poster: 'tvdb-poster' }
const normalized = {
  id: 'app_tmdb_tv_7', type: 'show', title: 'Example', genres: [], sourceMetadataProvider: 'tmdb', updatedAt: '2026-01-01T00:00:00.000Z',
} as AppMediaItem

describe('non-anime metadata provider operation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings = { seriesMetadataSource: 'tmdb', seriesMetadataFallback: true }
    normalizeMovieMock.mockResolvedValue({ ...normalized, type: 'movie' })
    normalizeShowMock.mockResolvedValue({ ...normalized })
  })

  it('uses the coarse native movie operation while preserving the normalizer result', async () => {
    loadMovieDetailPageMock.mockResolvedValue({ ...tmdbShow, id: 'tmdb-7' })

    await expect(fetchAppProviderMetadata(input, ids, 'movie')).resolves.toEqual({ ...normalized, type: 'movie' })
    expect(loadMovieDetailPageMock).toHaveBeenCalledWith('tmdb-7', {
      cancelGroup: 'metadata:tmdb:addon.example:item-1',
      priority: 'background',
    })
    expect(normalizeMovieMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'tmdb-7' }), { ...input, ...ids })
  })

  it('keeps unrelated visible metadata items in separate cancellation groups', async () => {
    loadDetailPageMock.mockResolvedValue(tmdbShow)
    await Promise.all([
      fetchAppProviderMetadata(input, ids, 'show'),
      fetchAppProviderMetadata({ ...input, id: 'item-2' }, { tmdbId: 8 }, 'show'),
    ])

    expect(loadDetailPageMock).toHaveBeenNthCalledWith(1, 'tmdb', 'tmdb-7', {
      cancelGroup: 'metadata:tmdb:addon.example:item-1',
      priority: 'background',
    })
    expect(loadDetailPageMock).toHaveBeenNthCalledWith(2, 'tmdb', 'tmdb-8', {
      cancelGroup: 'metadata:tmdb:addon.example:item-2',
      priority: 'background',
    })
  })

  it('preserves TVDB fallback and TMDB artwork enrichment', async () => {
    loadDetailPageMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(tvdbShow)
      .mockResolvedValueOnce({ ...tmdbShow, poster: 'tmdb-poster', backdrop: 'tmdb-backdrop', logo: 'tmdb-logo', overview: 'TMDB overview', rating: 8 })
    normalizeShowMock.mockResolvedValue({ ...normalized, sourceMetadataProvider: 'tvdb', poster: 'tvdb-poster' })

    const result = await fetchAppProviderMetadata(input, ids, 'show')

    expect(loadDetailPageMock).toHaveBeenNthCalledWith(1, 'tmdb', 'tmdb-7', expect.any(Object))
    expect(loadDetailPageMock).toHaveBeenNthCalledWith(2, 'tvdb', 'tvdb-9', expect.any(Object))
    expect(loadDetailPageMock).toHaveBeenNthCalledWith(3, 'tmdb', 'tmdb-7', expect.any(Object))
    expect(result).toMatchObject({ sourceMetadataProvider: 'tvdb', poster: 'tmdb-poster', backdrop: 'tmdb-backdrop', logo: 'tmdb-logo', overview: 'TMDB overview', rating: 8 })
  })
})
