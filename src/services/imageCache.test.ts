import { beforeEach, describe, expect, it, vi } from 'vitest'

const { convertFileSrc } = vi.hoisted(() => ({
  convertFileSrc: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc,
  invoke: vi.fn(),
}))

import { cachedImage, recoverArtworkSource } from './imageCache'

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

  it('recovers direct artwork from obsolete poster proxy URLs', () => {
    const source = 'https://btttr.cc/poster/auto/tt22084616/auto.png'
    expect(recoverArtworkSource(`https://poster-cache.febsho.me/poster/${source}`)).toBe(source)
    expect(recoverArtworkSource(`https://poster-cache.febsho.me/poster/${encodeURIComponent(source)}`)).toBe(source)
    expect(cachedImage(`https://poster-cache.febsho.me/poster/${source}`)).toBe(source)
  })

  it('leaves non-URL poster proxy keys unchanged', () => {
    const source = 'https://poster-cache.febsho.me/poster/known-poster-key'
    expect(recoverArtworkSource(source)).toBe(source)
  })
})
