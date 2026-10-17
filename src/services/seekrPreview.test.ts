import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { getSeekrPreview, seekrCueAt } from './seekrPreview'

describe('Seekr progressive preview fallback', () => {
  beforeEach(() => invokeMock.mockReset())

  it('keeps a missing provider preview optional', async () => {
    invokeMock.mockResolvedValue(null)
    const result = await getSeekrPreview({ duration: 3600, tmdbId: 7 })
    expect(result).toBeNull()
  })

  it('returns the nearest valid sprite cue without changing static artwork', () => {
    const cue = { start: 0, end: 10, spriteUrl: 'sprite.jpg', x: 0, y: 0, width: 160, height: 90 }
    expect(seekrCueAt({ scale: 1, cues: [cue] }, 5)).toEqual(cue)
  })
})
