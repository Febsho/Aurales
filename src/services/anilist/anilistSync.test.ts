import { describe, expect, it } from 'vitest'
import { getAniListPrimaryWatchedKeys } from '../anilist'

describe('AniList watched sync keys', () => {
  it('keeps AniList and MAL watched keys without requiring provider mappings', () => {
    expect(getAniListPrimaryWatchedKeys({
      mediaId: 101,
      idMal: 202,
      status: 'COMPLETED',
      repeat: 0,
      episodes: 12,
      progress: 12,
    })).toEqual(['anilist:101', 'mal:202'])
  })

  it('does not mark partially watched entries as complete', () => {
    expect(getAniListPrimaryWatchedKeys({
      mediaId: 101,
      idMal: 202,
      status: 'CURRENT',
      repeat: 0,
      episodes: 12,
      progress: 4,
    })).toEqual([])
  })
})
