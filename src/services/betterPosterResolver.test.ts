import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../types'

const mocks = vi.hoisted(() => ({
  resolveImdbId: vi.fn(),
}))

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      betterPosters: {
        enabled: true,
        trendTags: true,
        qualityTags: true,
        showGenre: true,
        showRating: true,
        ratingSource: 'avg',
        ageRating: true,
        language: 'en',
      },
      customArtUrls: { posterUrl: '', backdropUrl: '', logoUrl: '', episodeThumbnailUrl: '' },
    }),
  },
}))

vi.mock('./metadataEnrich', () => ({ resolveImdbId: mocks.resolveImdbId }))

import { resolveBetterPoster } from './artwork'

function item(id: string): SearchResult {
  return { id, type: 'movie', provider: 'tmdb', title: id, tmdbId: id }
}

describe('Better Poster resolution cache', () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.resolveImdbId.mockReset()
  })

  it('deduplicates simultaneous ID bridge requests', async () => {
    let release!: (value: string) => void
    mocks.resolveImdbId.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const first = resolveBetterPoster(item('dedup'))
    const second = resolveBetterPoster(item('dedup'))
    await vi.waitFor(() => expect(mocks.resolveImdbId).toHaveBeenCalledTimes(1))
    release('tt1234567')
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('retries a failed resolution after the negative-cache TTL', async () => {
    vi.useFakeTimers()
    mocks.resolveImdbId.mockRejectedValueOnce(new Error('provider offline')).mockResolvedValueOnce('tt7654321')

    await expect(resolveBetterPoster(item('recovery'))).resolves.toBeUndefined()
    await expect(resolveBetterPoster(item('recovery'))).resolves.toBeUndefined()
    expect(mocks.resolveImdbId).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_001)
    await expect(resolveBetterPoster(item('recovery'))).resolves.toContain('tt7654321')
    expect(mocks.resolveImdbId).toHaveBeenCalledTimes(2)
  })
})
