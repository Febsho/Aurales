import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlatformCapabilities, isHlsUrl, shouldReloadAfterVaultRestore, supportsPictureInPicture, togglePictureInPicture } from './capabilities'

afterEach(() => vi.unstubAllGlobals())

describe('browser stream detection', () => {
  it('recognizes HLS paths with signed query parameters', () => {
    expect(isHlsUrl('https://cdn.example.test/playlist.m3u8?token=abc')).toBe(true)
    expect(isHlsUrl('https://worker.example/v1/media/0123456789abcdef0123456789abcdef?expires=123&signature=opaque&format=hls')).toBe(true)
  })

  it('does not classify ordinary media files as HLS', () => {
    expect(isHlsUrl('https://cdn.example.test/movie.mp4?token=abc')).toBe(false)
  })
})

describe('vault restore platform behavior', () => {
  it('keeps browser vaults in the current in-memory session', () => {
    vi.stubGlobal('window', {})
    expect(shouldReloadAfterVaultRestore()).toBe(false)
  })

  it('preserves native reload behavior when the keyring can restore the vault', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    expect(shouldReloadAfterVaultRestore()).toBe(true)
  })
})

describe('Safari picture-in-picture capability', () => {
  it('detects WebKit presentation mode support and toggles it', async () => {
    vi.stubGlobal('document', {})
    const video = {} as HTMLVideoElement & {
      webkitSetPresentationMode?: (mode: string) => void
      webkitSupportsPresentationMode?: (mode: string) => boolean
      webkitPresentationMode?: string
    }
    const setMode = vi.fn((mode: string) => { video.webkitPresentationMode = mode })
    video.webkitSetPresentationMode = setMode
    video.webkitSupportsPresentationMode = (mode) => mode === 'picture-in-picture'

    expect(supportsPictureInPicture(video)).toBe(true)
    await togglePictureInPicture(video)
    expect(setMode).toHaveBeenCalledWith('picture-in-picture')
    await togglePictureInPicture(video)
    expect(setMode).toHaveBeenLastCalledWith('inline')
  })
})

describe('Safari native HLS capability', () => {
  it('prefers native HLS when the browser video element reports support', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' })
    const video = { canPlayType: vi.fn((mime: string) => mime === 'application/vnd.apple.mpegurl' ? 'probably' : '') } as unknown as HTMLVideoElement
    expect(getPlatformCapabilities(video)).toMatchObject({ platform: 'web', nativeHls: true })
    expect(video.canPlayType).toHaveBeenCalledWith('application/vnd.apple.mpegurl')
  })
})
