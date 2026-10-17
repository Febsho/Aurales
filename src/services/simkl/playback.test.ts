import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveSimklId, mapEpisodeToProviders } = vi.hoisted(() => ({
  resolveSimklId: vi.fn(),
  mapEpisodeToProviders: vi.fn(),
}))

vi.mock('./mappings', () => ({ resolveSimklId }))
vi.mock('../anime-mapping', () => ({
  mapEpisodeToProviders,
  isConfidenceSufficient: (mapping: { confidence: number }) => mapping.confidence >= 0.5,
}))

import { buildSimklPlaybackPayload, type PlaybackItem } from './playback'

function playback(overrides: Partial<PlaybackItem> = {}): PlaybackItem {
  return {
    localId: 'anime-1',
    title: 'Example Anime',
    type: 'anime',
    mediaType: 'anime',
    contentType: 'series',
    isAnime: true,
    simklId: 123,
    season: 1,
    episode: 1,
    ...overrides,
  }
}

describe('Simkl anime payload routing', () => {
  beforeEach(() => {
    resolveSimklId.mockReset()
    mapEpisodeToProviders.mockReset()
  })

  it('uses the exact provider movie type for an anime movie', async () => {
    const payload = await buildSimklPlaybackPayload(playback({
      contentType: 'movie',
      type: 'movie',
      mediaType: 'anime',
      season: undefined,
      episode: undefined,
    }), 92)

    expect(payload?.movie?.ids.simkl).toBe(123)
    expect(payload?.anime).toBeUndefined()
    expect(payload?.episode).toBeUndefined()
  })

  it('uses episode one only when an exact Simkl mapping classifies the movie as anime', async () => {
    const payload = await buildSimklPlaybackPayload(playback({
      contentType: 'movie',
      type: 'anime',
      season: undefined,
      episode: undefined,
    }), 95)

    expect(payload?.anime?.ids.simkl).toBe(123)
    expect(payload?.episode?.number).toBe(1)
    expect(payload?.movie).toBeUndefined()
  })

  it('uses the mapped Simkl cour id and relative episode', async () => {
    mapEpisodeToProviders.mockResolvedValue({
      confidence: 0.95,
      simkl: { id: 999, seasonNumber: 1, episodeNumber: 3 },
    })

    const payload = await buildSimklPlaybackPayload(playback({
      tvdbId: 777,
      season: 2,
      episode: 15,
    }), 80)

    expect(payload?.anime?.ids.simkl).toBe(999)
    expect(payload?.episode?.number).toBe(3)
  })

  it('skips an anime mark when no exact mapping exists', async () => {
    resolveSimklId.mockResolvedValue(null)
    const payload = await buildSimklPlaybackPayload(playback({ simklId: undefined }), 90)
    expect(payload).toBeNull()
    expect(resolveSimklId).toHaveBeenCalledWith(expect.any(Object), {
      allowTitleFallback: false,
      allowExactTitleFallback: false,
    })
  })
})
