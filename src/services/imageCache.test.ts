import { beforeEach, describe, expect, it, vi } from 'vitest'

const { convertFileSrc } = vi.hoisted(() => ({
  convertFileSrc: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc,
  invoke: vi.fn(),
}))

import { cachedImage } from './imageCache'

describe('cachedImage', () => {
  beforeEach(() => {
    convertFileSrc.mockReset()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  })

  it('uses the remote URL directly while the disk proxy is disabled', () => {
    const source = 'https://image.tmdb.org/t/p/w500/a%20poster.jpg?lang=en&v=1'
    expect(cachedImage(source)).toBe(source)

    expect(convertFileSrc).not.toHaveBeenCalled()
  })

  it('does not route data URLs through the cache', () => {
    expect(cachedImage('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
    expect(convertFileSrc).not.toHaveBeenCalled()
  })
})
