export interface PlatformCapabilities {
  platform: 'tauri' | 'web'
  nativePlayer: boolean
  nativeFilesystem: boolean
  nativeWindowControls: boolean
  serviceWorker: boolean
  pictureInPicture: boolean
  airPlay: boolean
  nativeHls: boolean
  mediaSource: boolean
}

type SafariVideoElement = Omit<HTMLVideoElement, 'requestPictureInPicture'> & {
  requestPictureInPicture?: () => Promise<PictureInPictureWindow>
  webkitShowPlaybackTargetPicker?: () => void
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitPresentationMode?: string
}

/** Safari exposes PiP through a WebKit presentation-mode API on some versions. */
export function supportsPictureInPicture(video?: HTMLVideoElement | null): boolean {
  if (!video || typeof document === 'undefined') return false
  const safariVideo = video as SafariVideoElement
  if (document.pictureInPictureEnabled && safariVideo.requestPictureInPicture) return true
  return Boolean(safariVideo.webkitSetPresentationMode && safariVideo.webkitSupportsPresentationMode?.('picture-in-picture'))
}

export async function togglePictureInPicture(video: HTMLVideoElement): Promise<void> {
  const safariVideo = video as SafariVideoElement
  if (safariVideo.requestPictureInPicture && typeof document !== 'undefined' && document.pictureInPictureEnabled) {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture()
    else await safariVideo.requestPictureInPicture()
    return
  }
  if (!supportsPictureInPicture(video) || !safariVideo.webkitSetPresentationMode) {
    throw new Error('Picture-in-picture is unavailable for this browser.')
  }
  safariVideo.webkitSetPresentationMode(safariVideo.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture')
}

export function getPlatformCapabilities(video?: HTMLVideoElement | null): PlatformCapabilities {
  const hasWindow = typeof window !== 'undefined'
  // The app is never run in a non-DOM environment. Keep such test/SSR
  // runtimes on the native adapter by default so existing IPC mocks continue
  // to exercise the desktop contract; a real browser always has `window`.
  const isTauri = hasWindow
    ? Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
    : true
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const nativeHls = Boolean(video?.canPlayType('application/vnd.apple.mpegurl'))
  return {
    platform: isTauri ? 'tauri' : 'web',
    nativePlayer: isTauri && (/Windows|Linux/.test(ua)),
    nativeFilesystem: isTauri,
    nativeWindowControls: isTauri,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    pictureInPicture: supportsPictureInPicture(video),
    airPlay: Boolean((video as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | undefined)?.webkitShowPlaybackTargetPicker),
    nativeHls,
    mediaSource: typeof MediaSource !== 'undefined',
  }
}

/** Native builds can recover the vault key from the OS keyring after reload.
 * Browser builds keep it in memory and must hydrate restored settings in place. */
export function shouldReloadAfterVaultRestore(): boolean {
  return getPlatformCapabilities().platform === 'tauri'
}

export function isHlsUrl(url: string): boolean {
  try { return /\.m3u8$/i.test(new URL(url, typeof location !== 'undefined' ? location.href : 'https://aurales.invalid').pathname) } catch { return /\.m3u8(?:$|\?)/i.test(url) }
}
