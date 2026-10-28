import { invoke } from '@tauri-apps/api/core'
import type { TrailerSource } from './trailers'
import { getPlatformCapabilities } from '../platform/capabilities'

export interface ResolvedHeroStreams {
  videoUrl: string
  audioUrl?: string
  expiresAt: number
}

const resolveCache = new Map<string, Promise<ResolvedHeroStreams | null>>()
const MAX_RESOLVED_HERO_STREAMS = 64

function rememberResolvedHeroStream(key: string, promise: Promise<ResolvedHeroStreams | null>): void {
  resolveCache.delete(key)
  resolveCache.set(key, promise)
  while (resolveCache.size > MAX_RESOLVED_HERO_STREAMS) {
    const oldest = resolveCache.keys().next().value
    if (oldest === undefined) break
    resolveCache.delete(oldest)
  }
}

export function resolveHeroStreams(videoId: string, maxHeight = 2160): Promise<ResolvedHeroStreams | null> {
  if (!getPlatformCapabilities().nativePlayer) return Promise.resolve(null)
  const cacheKey = `${videoId}:${maxHeight}`
  const cached = resolveCache.get(cacheKey)
  if (cached) {
    rememberResolvedHeroStream(cacheKey, cached)
    return cached.then((streams) => {
      if (streams && streams.expiresAt > Date.now() + 60_000) return streams
      if (resolveCache.get(cacheKey) === cached) resolveCache.delete(cacheKey)
      return resolveHeroStreams(videoId, maxHeight)
    })
  }

  const promise = invoke<string[]>('ytdlp_resolve', { videoId, maxHeight })
    .then((urls) => {
      if (!urls.length) return null
      return {
        videoUrl: urls[0],
        audioUrl: urls[1],
        // googlevideo URLs expire after about six hours.
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      }
    })
    .catch((error) => {
      console.warn('[heroTrailerStreams] yt-dlp resolve failed:', error)
      return null
    })

  rememberResolvedHeroStream(cacheKey, promise)
  promise.then((streams) => {
    if (!streams && resolveCache.get(cacheKey) === promise) resolveCache.delete(cacheKey)
  })
  return promise
}

/** Warm yt-dlp resolution before the Hero's viewing delay elapses. */
export function preloadHeroTrailerStreams(trailer: TrailerSource): void {
  if (trailer.directUrl || !/^[a-zA-Z0-9_-]{11}$/.test(trailer.key)) return
  resolveHeroStreams(trailer.key, 2160).catch(() => undefined)
  resolveHeroStreams(trailer.key, 1080).catch(() => undefined)
}
