import { isHlsUrl } from '../../platform/capabilities'

export const AUTOPLAY_GESTURE_MESSAGE = 'Tap Play to start this stream. Your browser requires a user action before it can play audio.'

export function isAutoplayGestureError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError')
}

/** Worker session expiries are Unix seconds; use this to renew only expired sessions. */
export function isMediaSessionExpired(expiresAt: number, nowSeconds = Date.now() / 1000): boolean {
  return Number.isFinite(expiresAt) && nowSeconds >= expiresAt
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
}

/** Explain what the browser can establish without treating MIME hints as proof. */
export function browserPlaybackFailureMessage(url: string, video?: Pick<HTMLVideoElement, 'canPlayType'> | null): string {
  if (isHlsUrl(url)) {
    return 'This HLS stream could not be played. The source may block browser requests, its session may have expired, or its codecs may be unsupported. Try another stream.'
  }

  const extension = (() => {
    try {
      const pathname = new URL(url, typeof location !== 'undefined' ? location.href : 'https://aurales.invalid').pathname
      return pathname.split('.').pop()?.toLowerCase() || ''
    } catch {
      return ''
    }
  })()
  const mime = MIME_BY_EXTENSION[extension]
  if (mime && video?.canPlayType(mime) === '') {
    return `This browser reports that it cannot play ${mime} directly. The URL suffix may be misleading; try a different stream or browser.`
  }
  return 'This stream could not be played by the browser video engine. Its codec or container may be unsupported, cross-origin access may be blocked, or the signed URL may have expired. Try another stream.'
}
