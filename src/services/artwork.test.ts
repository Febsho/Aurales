import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      appManagedMetadata: false,
      artProviders: {},
      fanartApiKey: '',
      customArtUrls: {
        posterUrl: '',
        backdropUrl: '',
        logoUrl: '',
        episodeThumbnailUrl: '',
      },
    }),
  },
}))

import { resolveArtFromProviders } from './artwork'

describe('artwork provider preference', () => {
  it('does not start external artwork requests when addon metadata is authoritative', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(resolveArtFromProviders('series', {
      tmdbId: 123,
      tvdbId: 456,
      imdbId: 'tt1234567',
    }, true)).resolves.toEqual({})
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
