import { describe, expect, it, vi } from 'vitest'
import imageCacheAdapter from './imageCacheAdapter'

describe('browser artwork cache adapter', () => {
  it('keeps artwork on normal URLs and reports browser-managed cache behavior', async () => {
    expect(imageCacheAdapter.usesCustomProtocol()).toBe(false)
    expect(imageCacheAdapter.cachedImage('https://images.example/poster.jpg', 'card'))
      .toBe('https://images.example/poster.jpg')
    await expect(imageCacheAdapter.configure(256, 30)).resolves.toBeUndefined()
    await expect(imageCacheAdapter.stats()).resolves.toBeNull()
    await expect(imageCacheAdapter.clear()).resolves.toBeUndefined()
  })

  it('never requires a DOM or native cache command', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(imageCacheAdapter.cachedImage('data:image/png;base64,test', 'backdrop')).toBe('data:image/png;base64,test')
    await imageCacheAdapter.configure(0, 0)
    await imageCacheAdapter.clear()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
