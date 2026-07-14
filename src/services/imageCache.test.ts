import { beforeEach, describe, expect, it, vi } from 'vitest'

const convertFileSrc = vi.fn((path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`)

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc,
  invoke: vi.fn(),
}))

import { cachedImage } from './imageCache'

describe('cachedImage', () => {
  beforeEach(() => {
    convertFileSrc.mockClear()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  })

  it('passes the raw remote URL to convertFileSrc exactly once', () => {
    const source = 'https://image.tmdb.org/t/p/w500/a poster%20name.jpg?lang=en&v=1'
    cachedImage(source)
    expect(convertFileSrc).toHaveBeenCalledWith(source, 'imgcache')
  })

  it('leaves non-remote URLs unchanged', () => {
    expect(cachedImage('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
    expect(convertFileSrc).not.toHaveBeenCalled()
  })
})
