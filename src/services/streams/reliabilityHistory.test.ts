import { describe, expect, it, vi } from 'vitest'
import { recordReliabilityEvent } from './reliabilityHistory'

describe('stream reliability history', () => {
  it('does not block playback when local storage is full', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        const error = new Error('The quota has been exceeded.')
        error.name = 'QuotaExceededError'
        throw error
      },
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => recordReliabilityEvent({ url: 'https://example.com/video.mp4' }, 'preferred', storage)).not.toThrow()
    expect(warning).toHaveBeenCalled()
    warning.mockRestore()
  })
})
