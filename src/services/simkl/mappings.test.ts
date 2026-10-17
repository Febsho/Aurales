import { beforeEach, describe, expect, it, vi } from 'vitest'

const { searchSimklItem } = vi.hoisted(() => ({ searchSimklItem: vi.fn() }))

vi.mock('./client', () => ({
  resolveSimklMapping: vi.fn(),
  searchSimklItem,
}))

import { searchSimklByTitleYear } from './mappings'

describe('strict Simkl anime movie title mapping', () => {
  beforeEach(() => {
    searchSimklItem.mockReset()
  })

  it('searches anime and movie indexes and accepts the exact anime record', async () => {
    searchSimklItem.mockImplementation(({ type }: { type: string }) => Promise.resolve(type === 'anime' ? [{
      anime: { title: 'Chainsaw Man – The Movie: Reze Arc', year: 2025, ids: { simkl: 42, mal: 57555 } },
    }] : []))

    const result = await searchSimklByTitleYear({
      localId: 'anilist-176496',
      title: 'Chainsaw Man: The Movie - Reze Arc',
      year: 2025,
      type: 'anime',
      contentType: 'movie',
      isAnime: true,
    }, { exactYear: true })

    expect(searchSimklItem).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ simklId: 42, type: 'anime' })
  })

  it('rejects an otherwise matching title from a different year', async () => {
    searchSimklItem.mockResolvedValue([{ anime: { title: 'Example Movie', year: 2024, ids: { simkl: 10 } } }])
    const result = await searchSimklByTitleYear({
      localId: 'anime-movie', title: 'Example Movie', year: 2025,
      type: 'anime', contentType: 'movie', isAnime: true,
    }, { exactYear: true })
    expect(result).toBeNull()
  })
})
