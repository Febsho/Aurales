import { isHlsUrl } from '../../platform/capabilities'
import type { MediaConversionMode } from '../mediaWorker'

export const AUTOPLAY_GESTURE_MESSAGE = 'Tap Play to start this stream. Your browser requires a user action before it can play audio.'

/** Keep source credentials off subtitle CDNs that differ from the video host. */
export function playbackHeadersForSubtitle(
  subtitleUrl: string,
  mediaUrl: string,
  headers: Record<string, string>,
): Record<string, string> {
  let subtitle: URL
  let media: URL
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://aurales.invalid'
    subtitle = new URL(subtitleUrl, base)
    media = new URL(mediaUrl, base)
  } catch {
    return {}
  }
  if (!/^https?:$/.test(subtitle.protocol) || !/^https?:$/.test(media.protocol)) return {}
  if (subtitle.origin === media.origin) return headers
  const safeCrossOriginHeaders = new Set(['accept', 'user-agent'])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => safeCrossOriginHeaders.has(name.toLowerCase())))
}

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
  [/^(?:hevc|h265|hev1|hvc1|x265)(?:main10|10bit|10)$/, 'hvc1.2.4.L120.B0'],
  [/^(?:h264|avc|avc1|x264)$/, 'avc1.42E01E'],
  [/^(?:h264|avc|avc1|x264)(?:high10|high10profile)$/, 'avc1.6E0028'],
  [/^(?:h264|avc|avc1|x264)(?:high|highprofile)$/, 'avc1.640028'],
  [/^(?:h264|avc|avc1|x264)(?:baseline|baselineprofile|constrainedbaseline)$/, 'avc1.42E01E'],
  [/^(?:hevc|h265|hev1|hvc1|x265)$/, 'hvc1.1.6.L93.B0'],
  [/^(?:av1|av01)$/, 'av01.0.04M.08'],
  [/^(?:av1|av01)(?:main10|10bit|10)$/, 'av01.0.08M.10'],
  [/^(?:vp9|vp09)(?:profile2|p2|10bit|10)$/, 'vp09.02.10.10'],
  [/^(?:vp9|vp09)$/, 'vp09.00.10.08'],
  [/^(?:vp8|vp08)$/, 'vp8.0'],
  [/^(?:aac|aaclc|mp4a)$/, 'mp4a.40.2'],
  [/^(?:eac3|dd|ddp|ddplus|dolbydigitalplus)$/, 'ec-3'],
  [/^(?:ac3|dolbydigital)$/, 'ac-3'],
  [/^(?:dts|dca|dtshd)$/, 'dtsc'],
  [/^(?:truehd|mlp)$/, 'mlpa'],
  [/^(?:opus)$/i, 'opus'],
]

function normalizedCodec(value: string | undefined): string | undefined {
  if (!value) return undefined
  // Preserve profile words such as “HEVC (Main 10)” and “H.264 High”; those
  // profiles can change mobile decoder support even when the codec family is
  // the same.
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '').trim()
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

/** Fill missing playback hints from addon labels and filenames without guessing ambiguous codecs. */
export function inferSourceMediaInfo<T extends {
  container?: string
  videoCodec?: string
  audioCodec?: string
  resolution?: string
  bitrate?: number
  frameRate?: number
  name?: string
  title?: string
  description?: string
  filename?: string
  behaviorHints?: { filename?: string }
}>(source: T, sourceUrl?: string): T & {
  container?: string
  videoCodec?: string
  audioCodec?: string
  resolution?: string
  bitrate?: number
  frameRate?: number
} {
  const text = [source.name, source.title, source.description, source.filename, source.behaviorHints?.filename]
    .filter((part): part is string => Boolean(part)).join(' ')
  const urlPath = (() => {
    try { return new URL(sourceUrl || '', 'https://aurales.invalid').pathname } catch { return '' }
  })()
  const filename = [source.filename, source.behaviorHints?.filename, urlPath].filter(Boolean).join(' ')
  const codecTokens = text.match(/(?:^|[\s._()[\]-])(?:h\.?264|avc1?|x264|hevc|h\.?265|hev1|hvc1|x265|av1|av01|vp9|vp09|vp8|vp08)(?:$|[\s._()[\]-])/gi) || []
  const codecFamily = codecTokens[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const profile10 = /\b(?:main[\s._-]*10|10[\s._-]*bit)\b/i.test(text)
  const codec = codecFamily && /^(?:hevc|h265|hev1|hvc1|x265)$/.test(codecFamily) && profile10
    ? 'HEVC (Main 10)'
    : codecFamily && /^(?:h264|avc|avc1|x264)$/.test(codecFamily) && /\bhigh[\s._-]*10(?:[\s._-]*profile)?\b/i.test(text)
      ? 'H.264 High 10'
      : codecFamily && /^(?:h264|avc|avc1|x264)$/.test(codecFamily) && /\bhigh(?:[\s._-]*profile)?\b/i.test(text)
        ? 'H.264 High'
        : codecFamily && /^(?:vp9|vp09)$/.test(codecFamily) && /\b(?:profile[\s._-]*2|p2|10[\s._-]*bit)\b/i.test(text)
          ? 'VP9 Profile 2'
          : codecFamily && /^(?:av1|av01)$/.test(codecFamily) && profile10
            ? 'AV1 Main 10'
            : codecFamily
  const audioTokens = text.match(/(?:^|[\s._()[\]-])(?:aac(?:lc)?|eac3|ddp|ac3|dts(?:hd)?|truehd|opus)(?=\d|$|[\s._()[\]-])/gi) || []
  const audioCodec = audioTokens[0]?.trim().replace(/[\s._()[\]-]/g, '').toLowerCase()
  const resolution = text.match(/\b(?:\d{3,5}\s*[x×]\s*\d{3,5}|4320p|2880p|2160p|1440p|1080p|720p|576p|480p|360p|8k|4k)\b/i)?.[0]
  // Release names often place a bitrate after a 5.1/7.1 audio token with
  // periods as separators (e.g. DDP5.1.35Mbps). Consume that channel token as
  // a unit so “1.35 Mbps” is not mistaken for the bitrate.
  const bitrateMatch = text.match(/(?:\d{1,2}\.\d{1,2}\.)?(\d+(?:[.,]\d+)?)\s*(gbps|mbps|kbps|bps)\b/i)
  const bitrateMultiplier = bitrateMatch?.[2].toLowerCase() === 'gbps' ? 1_000_000_000
    : bitrateMatch?.[2].toLowerCase() === 'mbps' ? 1_000_000
      : bitrateMatch?.[2].toLowerCase() === 'kbps' ? 1_000 : 1
  const frameRate = text.match(/\b(23\.976|24|25|29\.97|30|48|50|59\.94|60|90|120|144|165|240)\s*fps\b/i)?.[1]
  const knownContainers = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv'])
  const extension = [...`${filename} ${text}`.matchAll(/\.([a-z0-9]{2,5})(?=$|[\s()[\],])/gi)]
    .map((match) => match[1].toLowerCase()).find((candidate) => knownContainers.has(candidate))
  return {
    ...source,
    container: source.container || (extension && knownContainers.has(extension) ? extension : undefined),
    videoCodec: source.videoCodec || codec,
    audioCodec: source.audioCodec || audioCodec,
    resolution: source.resolution || resolution,
    bitrate: source.bitrate ?? (bitrateMatch ? Math.round(Number(bitrateMatch[1].replace(',', '.')) * bitrateMultiplier) : undefined),
    frameRate: source.frameRate ?? (frameRate ? Number(frameRate) : undefined),
  }
}

function resolutionDimensions(value?: string): { width: number; height: number } | null {
  if (!value) return null
  if (/^8k$/i.test(value.trim())) return { width: 7680, height: 4320 }
  if (/^4k$/i.test(value.trim())) return { width: 3840, height: 2160 }
  const dimensions = value.match(/^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i)
  if (dimensions) {
    const width = Number(dimensions[1])
    const height = Number(dimensions[2])
    if (width >= 160 && height >= 160 && width <= 16_384 && height <= 16_384) return { width, height }
  }
  const label = value.match(/(?:^|\b)(4320|2880|2160|1440|1080|720|576|480|360)p\b/i)?.[1]
  if (!label) return null
  const height = Number(label)
  const width = Math.round(height * 16 / 9)
  return { width, height }
}

/** Ask the browser's decoder database when source metadata is enough to probe safely. */
export async function browserMediaCapabilitiesConversionMode(
  mediaCapabilities: Pick<MediaCapabilities, 'decodingInfo'> | undefined,
  mediaInfo: { container?: string; videoCodec?: string; audioCodec?: string; resolution?: string; bitrate?: number; frameRate?: number },
): Promise<Exclude<MediaConversionMode, 'auto'> | null> {
  if (!mediaCapabilities || !mediaInfo.videoCodec) return null
  const videoCodec = normalizedCodec(mediaInfo.videoCodec)
  const audioCodec = normalizedCodec(mediaInfo.audioCodec)
  const dimensions = resolutionDimensions(mediaInfo.resolution)
  if (!videoCodec || !dimensions) return null
  const container = mediaInfo.container?.toLowerCase().replace(/^\./, '').trim()
  const mime = container === 'webm' || container === 'mkv' || container === 'matroska'
    ? 'video/webm'
    : 'video/mp4'
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(',')
  const bitrate = Number.isFinite(mediaInfo.bitrate) && mediaInfo.bitrate! >= 32_000
    ? Math.min(mediaInfo.bitrate!, 100_000_000)
    : 4_000_000
  try {
    const result = await mediaCapabilities.decodingInfo({
      type: 'file',
      video: {
        contentType: `${mime}; codecs="${codecs}"`,
        width: dimensions.width,
        height: dimensions.height,
        bitrate,
        framerate: Number.isFinite(mediaInfo.frameRate) && mediaInfo.frameRate! >= 1 && mediaInfo.frameRate! <= 240
          ? mediaInfo.frameRate!
          : 30,
      },
    })
    // A decoder can technically support a profile while failing the browser's
    // real-time smoothness estimate at the requested resolution/bitrate. On
    // mobile that is a strong signal to prepare a smaller compatible copy.
    if (result.supported === false) return 'h264Aac'
    if (result.smooth === false) return 'h264AacLow'
    return null
  } catch {
    return null
  }
}

export async function browserMediaCapabilitiesRejectsKnownMedia(
  mediaCapabilities: Pick<MediaCapabilities, 'decodingInfo'> | undefined,
  mediaInfo: { container?: string; videoCodec?: string; audioCodec?: string; resolution?: string; bitrate?: number; frameRate?: number },
): Promise<boolean> {
  return Boolean(await browserMediaCapabilitiesConversionMode(mediaCapabilities, mediaInfo))
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
