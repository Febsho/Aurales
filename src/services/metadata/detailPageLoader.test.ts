import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, cacheGetMock, cacheSetMock, tmdbGetShowMock, tmdbGetMovieMock, tvdbGetShowMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  cacheGetMock: vi.fn(),
  cacheSetMock: vi.fn(),
  tmdbGetShowMock: vi.fn(),
  tmdbGetMovieMock: vi.fn(),
  tvdbGetShowMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../cache/sqliteCache', () => ({ cacheGet: cacheGetMock, cacheSet: cacheSetMock }))
vi.mock('../tmdb', () => ({ tmdbProvider: { getShow: tmdbGetShowMock, getMovie: tmdbGetMovieMock } }))
vi.mock('../tvdb', () => ({ tvdbProvider: { getShow: tvdbGetShowMock } }))
vi.mock('../apiKeys', () => ({ getTmdbApiKey: () => 'tmdb-key', getTvdbApiKey: () => 'tvdb-key' }))

import { loadDetailPage, loadMovieDetailPage } from './detailPageLoader'

const show = {
  id: 'tmdb-7', title: 'Example', genres: [], seasons: [], cast: [], crew: [],
  recommendations: [], trailers: [], provider: 'tmdb',
}

describe('detail page compatibility loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cacheGetMock.mockResolvedValue(null)
  })

  it('uses the normalized native result without changing its shape', async () => {
    invokeMock.mockResolvedValue({ data: show, stale: false, cacheStatus: 'miss' })
    await expect(loadDetailPage('tmdb', 'tmdb-7')).resolves.toEqual(show)
    expect(invokeMock).toHaveBeenCalledWith('load_detail_page', expect.objectContaining({
      request: expect.objectContaining({ provider: 'tmdb', id: '7', apiKey: 'tmdb-key' }),
    }))
    expect(tmdbGetShowMock).not.toHaveBeenCalled()
  })

  it('activates the same native contract for canonical TVDB anime details', async () => {
    const tvdbShow = { ...show, id: 'tvdb-9', provider: 'tvdb' }
    invokeMock.mockResolvedValue({ data: tvdbShow, stale: false, cacheStatus: 'hit' })
    await expect(loadDetailPage('tvdb', 'tvdb:9')).resolves.toEqual(tvdbShow)
    expect(invokeMock).toHaveBeenCalledWith('load_detail_page', expect.objectContaining({
      request: expect.objectContaining({ provider: 'tvdb', id: '9', apiKey: 'tvdb-key' }),
    }))
    expect(tvdbGetShowMock).not.toHaveBeenCalled()
  })

  it('does not let a stale native result enter the legacy path', async () => {
    invokeMock.mockResolvedValue({ data: show, stale: true, cacheStatus: 'miss' })
    await expect(loadDetailPage('tmdb', '7')).rejects.toMatchObject({ name: 'AbortError' })
    expect(tmdbGetShowMock).not.toHaveBeenCalled()
  })

  it('does not fallback when Rust cancels a superseded queued operation', async () => {
    invokeMock.mockRejectedValue('Detail request was superseded')
    await expect(loadDetailPage('tmdb', '7')).rejects.toMatchObject({ name: 'AbortError' })
    expect(tmdbGetShowMock).not.toHaveBeenCalled()
  })

  it('loads movies through the coarse native operation and preserves its output', async () => {
    const movie = { ...show, id: 'tmdb-11', title: 'Movie' }
    invokeMock.mockResolvedValue({ data: movie, stale: false, cacheStatus: 'miss' })
    await expect(loadMovieDetailPage('tmdb-11')).resolves.toEqual(movie)
    expect(invokeMock).toHaveBeenCalledWith('load_detail_page', expect.objectContaining({
      request: expect.objectContaining({ provider: 'tmdb', mediaType: 'movie', id: '11' }),
    }))
    expect(tmdbGetMovieMock).not.toHaveBeenCalled()
  })

  it('keeps the direct movie provider fallback without adding cache semantics', async () => {
    const movie = { ...show, id: 'tmdb-11', title: 'Movie' }
    invokeMock.mockRejectedValue(new Error('native unavailable'))
    tmdbGetMovieMock.mockResolvedValue(movie)
    await expect(loadMovieDetailPage('11')).resolves.toEqual(movie)
    expect(tmdbGetMovieMock).toHaveBeenCalledWith('tmdb-11')
    expect(cacheGetMock).not.toHaveBeenCalled()
  })

  it('preserves the established fallback and cache behavior on native failure', async () => {
    invokeMock.mockRejectedValue(new Error('native unavailable'))
    tmdbGetShowMock.mockResolvedValue(show)
    await expect(loadDetailPage('tmdb', '7')).resolves.toEqual(show)
    expect(cacheGetMock).toHaveBeenCalledWith('detail:series-provider:v2:tmdb:7')
    expect(tmdbGetShowMock).toHaveBeenCalledWith('tmdb-7')
    expect(cacheSetMock).toHaveBeenCalledWith(
      'detail:series-provider:v2:tmdb:7',
      show,
      expect.objectContaining({ category: 'detail_page' }),
    )
  })

  it('preserves cached empty and successful provider semantics for TVDB', async () => {
    const tvdbShow = { ...show, id: 'tvdb-9', provider: 'tvdb' }
    invokeMock.mockRejectedValue(new Error('native unavailable'))
    cacheGetMock.mockResolvedValue({ data: tvdbShow, stale: true, age: 10 })
    await expect(loadDetailPage('tvdb', 'tvdb:9')).resolves.toEqual(tvdbShow)
    expect(tvdbGetShowMock).not.toHaveBeenCalled()
  })

  it('prevents an A to B to C fallback race from returning older navigation data', async () => {
    invokeMock.mockRejectedValue(new Error('native unavailable'))
    const resolvers = new Map<string, (value: typeof show) => void>()
    tmdbGetShowMock.mockImplementation((providerId: string) => new Promise(resolve => {
      resolvers.set(providerId, resolve)
    }))
    const first = loadDetailPage('tmdb', '1', { cancelGroup: 'rapid-navigation' })
    const second = loadDetailPage('tmdb', '2', { cancelGroup: 'rapid-navigation' })
    const third = loadDetailPage('tmdb', '3', { cancelGroup: 'rapid-navigation' })
    await vi.waitFor(() => expect(resolvers.size).toBe(3))
    resolvers.get('tmdb-3')?.({ ...show, id: 'tmdb-3' })
    await expect(third).resolves.toMatchObject({ id: 'tmdb-3' })
    resolvers.get('tmdb-1')?.({ ...show, id: 'tmdb-1' })
    resolvers.get('tmdb-2')?.({ ...show, id: 'tmdb-2' })
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
  })
})
