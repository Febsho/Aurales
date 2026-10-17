import { describe, expect, it } from 'vitest'
import type { StreamResult } from '../types'
import { selectTorBoxFile, type TorBoxCachedFile } from './torbox'

const files: TorBoxCachedFile[] = [
  { id: 10, name: 'Show.S01E01.1080p.mkv', size: 2_000, mimetype: 'video/x-matroska' },
  { id: 11, name: 'Show.S01E02.1080p.mkv', size: 2_100, mimetype: 'video/x-matroska' },
  { id: 12, name: 'sample.mkv', size: 100, mimetype: 'video/x-matroska' },
]

describe('selectTorBoxFile', () => {
  it('honors the Stremio file index', () => {
    expect(selectTorBoxFile(files, { fileIdx: 0 } as StreamResult)?.id).toBe(10)
  })

  it('matches the requested episode', () => {
    expect(selectTorBoxFile(files, {}, { season: 1, episode: 2 })?.id).toBe(11)
  })

  it('uses the largest non-sample video as fallback', () => {
    expect(selectTorBoxFile(files, {})?.id).toBe(11)
  })
})
