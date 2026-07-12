import { describe, expect, it, vi } from 'vitest'
import { canonicalStreamKey, resolveNextEpisodeWith } from './preloadUtils'

describe('canonicalStreamKey', () => {
  it('normalizes movie IMDb IDs', () => {
    expect(canonicalStreamKey({ mediaType: 'movie', mediaId: 'tt0111161' })).toBe('movie:imdb:tt0111161')
  })

  it('separates episodes deterministically', () => {
    expect(canonicalStreamKey({ mediaType: 'series', mediaId: 'ignored', imdbId: 'TT1234567', seasonEpisode: { season: 3, episode: 7 } }))
      .toBe('episode:imdb:tt1234567:s03:e07')
  })
})

describe('resolveNextEpisode', () => {
  it('selects the next episode in the same season', async () => {
    const loader = vi.fn().mockResolvedValue([
      { seasonNumber: 2, episodeNumber: 4 },
      { seasonNumber: 2, episodeNumber: 5 },
    ])
    await expect(resolveNextEpisodeWith({ mediaType: 'series', mediaId: 'show', tmdbId: 10, seasonEpisode: { season: 2, episode: 4 } }, loader))
      .resolves.toEqual({ season: 2, episode: 5 })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('crosses a season boundary without inventing an episode', async () => {
    const loader = vi.fn(async (_id: string | number, season: number) => season === 2
      ? [{ seasonNumber: 2, episodeNumber: 8 }]
      : [{ seasonNumber: 3, episodeNumber: 1 }])
    await expect(resolveNextEpisodeWith({ mediaType: 'series', mediaId: 'show', tmdbId: 10, seasonEpisode: { season: 2, episode: 8 } }, loader))
      .resolves.toEqual({ season: 3, episode: 1 })
  })

  it('does not speculate without a TMDB ID', async () => {
    const loader = vi.fn()
    await expect(resolveNextEpisodeWith({ mediaType: 'series', mediaId: 'show', seasonEpisode: { season: 1, episode: 1 } }, loader))
      .resolves.toBeUndefined()
    expect(loader).not.toHaveBeenCalled()
  })
})
