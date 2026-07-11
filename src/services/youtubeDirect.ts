import { invoke } from '@tauri-apps/api/core'

// Resolves a YouTube video id to a directly playable stream URL so trailers
// can run in a native <video> element with no YouTube UI.
//
// Only the ANDROID client's muxed mp4 (itag 18, 360p) is usable: adaptive
// (1080p) URLs are PoToken-gated — googlevideo serves only their first ~1MB
// without an attestation token, then 403s. The muxed stream is exempt but
// googlevideo still rejects the open-ended Range requests browsers send, so
// playback goes through the local ytproxy which converts them into bounded
// 1MB chunk requests over a pinned IP family (stream URLs are IP-bound).

export interface DirectStream {
  videoUrl: string
  /** Separate audio track; absent when videoUrl is a muxed stream. */
  audioUrl?: string
  height?: number
  expiresAt: number
}

interface InnertubeFormat {
  itag?: number
  url?: string
  mimeType?: string
  width?: number
  height?: number
  audioQuality?: string
  bitrate?: number
  contentLength?: string
}

interface PlayerResponse {
  playabilityStatus?: { status?: string }
  streamingData?: {
    expiresInSeconds?: string
    formats?: InnertubeFormat[]
    adaptiveFormats?: InnertubeFormat[]
  }
}

let proxyPortPromise: Promise<number> | null = null

function getProxyPort(): Promise<number> {
  if (!proxyPortPromise) {
    proxyPortPromise = invoke<number>('ytproxy_port').catch((err) => {
      proxyPortPromise = null
      throw err
    })
  }
  return proxyPortPromise
}

function proxiedUrl(port: number, format: InnertubeFormat): string {
  const mime = (format.mimeType || 'video/mp4').split(';')[0]
  // clen=0 tells the proxy to discover the total size itself.
  return `http://127.0.0.1:${port}/stream?u=${encodeURIComponent(format.url || '')}&clen=${format.contentLength || 0}&mime=${encodeURIComponent(mime)}`
}

async function callPlayerApi(client: Record<string, unknown>, userAgent: string, videoId: string): Promise<PlayerResponse> {
  // Goes through the ytproxy agent (not the generic http_request) so the
  // returned stream URLs are IP-bound to the same route the proxy fetches on.
  const text = await invoke<string>('innertube_player', {
    userAgent,
    body: JSON.stringify({
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: { client },
    }),
  })
  return JSON.parse(text) as PlayerResponse
}

function expiryFrom(response: PlayerResponse, url: string): number {
  const seconds = Number(response.streamingData?.expiresInSeconds)
  if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000
  try {
    const expire = new URL(url).searchParams.get('expire')
    if (expire && /^\d+$/.test(expire)) return Number(expire) * 1000
  } catch (_) { /* ignore */ }
  return Date.now() + 4 * 60 * 60 * 1000
}

// ANDROID client: exposes the muxed 360p mp4 (itag 18) with a plain URL.
async function fetchAndroidMuxed(videoId: string): Promise<DirectStream | null> {
  const response = await callPlayerApi(
    {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 30,
      osName: 'Android',
      osVersion: '11',
      hl: 'en',
    },
    'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    videoId,
  )
  if (response.playabilityStatus?.status !== 'OK') return null
  const muxed = (response.streamingData?.formats || [])
    .filter((f) => f.url && f.mimeType?.startsWith('video/mp4') && f.audioQuality)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  if (!muxed?.url) return null
  const port = await getProxyPort()
  return {
    videoUrl: proxiedUrl(port, muxed),
    height: muxed.height,
    expiresAt: expiryFrom(response, muxed.url),
  }
}

const streamCache = new Map<string, Promise<DirectStream | null>>()

export function getDirectYoutubeStream(videoId: string): Promise<DirectStream | null> {
  const cached = streamCache.get(videoId)
  if (cached) {
    return cached.then((stream) => {
      if (stream && stream.expiresAt > Date.now() + 60_000) return stream
      streamCache.delete(videoId)
      return getDirectYoutubeStream(videoId)
    })
  }

  const promise = (async () => {
    const android = await fetchAndroidMuxed(videoId).catch((err) => {
      console.warn('[youtubeDirect] ANDROID client failed for', videoId, err)
      return null
    })
    if (!android) console.warn('[youtubeDirect] no direct stream for', videoId, '- falling back to iframe embed')
    return android
  })()

  streamCache.set(videoId, promise)
  promise.then((stream) => {
    if (!stream) streamCache.delete(videoId)
  }).catch(() => streamCache.delete(videoId))
  return promise
}
