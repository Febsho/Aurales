import { isHlsUrl } from '../../platform/capabilities'
import type { MediaConversionMode } from '../mediaWorker'

export const AUTOPLAY_GESTURE_MESSAGE = 'Tap Play to start this stream. Your browser requires a user action before it can play audio.'

export function isAutoplayGestureError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError')
}

/** A play request may be rejected after pause/load replaces its pending media operation. */
export function isPlaybackInterruptedError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

/** Worker session expiries are Unix seconds; use this to renew only expired sessions. */
export function isMediaSessionExpired(expiresAt: number, nowSeconds = Date.now() / 1000): boolean {
  return Number.isFinite(expiresAt) && nowSeconds >= expiresAt
}

/** Escalate only after the browser rejects the last worker output. */
export function nextPlaybackConversionAfterDecodeFailure(mode: Exclude<MediaConversionMode, 'auto'>): Exclude<MediaConversionMode, 'auto'> | null {
  if (mode === 'remux') return 'audioAac'
  if (mode === 'audioAac') return 'h264Aac'
  if (mode === 'h264Aac') return 'h264AacLow'
  if (mode === 'h264AacLow') return 'h264AacCompat'
  return null
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

const MIME_BY_CONTAINER: Record<string, string> = {
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  mkv: 'video/x-matroska',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
}

const MIME_CODEC_BY_NAME: Array<[RegExp, string]> = [
  [/^(?:h264|avc|avc1|x264)$/, 'avc1.42E01E'],
  [/^(?:hevc|h265|hev1|hvc1|x265)$/, 'hvc1.1.6.L93.B0'],
  [/^(?:av1|av01)$/, 'av01.0.04M.08'],
  [/^(?:vp9|vp09)$/, 'vp09.00.10.08'],
  [/^(?:vp8|vp08)$/, 'vp8.0'],
  [/^(?:aac|aaclc|mp4a)$/, 'mp4a.40.2'],
  [/^(?:eac3|dd|dolbydigitalplus)$/, 'ec-3'],
  [/^(?:ac3|dolbydigital)$/, 'ac-3'],
  [/^(?:dts|dca|dtshd)$/, 'dtsc'],
  [/^(?:truehd|mlp)$/, 'mlpa'],
  [/^(?:opus)$/i, 'opus'],
]

function normalizedCodec(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '').trim()
  return MIME_CODEC_BY_NAME.find(([pattern]) => pattern.test(normalized))?.[1]
}

/** Return true only when the browser explicitly rejects known source metadata. */
export function browserRejectsKnownMedia(
  video: Pick<HTMLVideoElement, 'canPlayType'>,
  sourceUrl: string,
  mediaInfo: { container?: string; videoCodec?: string; audioCodec?: string },
): boolean {
  const container = mediaInfo.container?.toLowerCase().replace(/^\./, '').trim()
  const extension = (() => {
    try {
      const pathname = new URL(sourceUrl, typeof location !== 'undefined' ? location.href : 'https://aurales.invalid').pathname
      return pathname.split('.').pop()?.toLowerCase() || ''
    } catch {
      return ''
    }
  })()
  const mime = (container && MIME_BY_CONTAINER[container]) || MIME_BY_EXTENSION[container || ''] || MIME_BY_EXTENSION[extension]
  if (!isHlsUrl(sourceUrl) && mime && video.canPlayType(mime) === '') return true

  const videoCodec = normalizedCodec(mediaInfo.videoCodec)
  const audioCodec = normalizedCodec(mediaInfo.audioCodec)
  if (!videoCodec && !audioCodec) return false
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(',')
  const codecMime = mime?.startsWith('audio/') ? mime : 'video/mp4'
  return video.canPlayType(`${codecMime}; codecs="${codecs}"`) === ''
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
