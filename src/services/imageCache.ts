import { convertFileSrc, invoke } from '@tauri-apps/api/core'

// Frontend side of the disk image cache (src-tauri/src/image_cache.rs).
// cachedImage() rewrites a remote artwork URL to the imgcache:// protocol so
// the Rust layer downloads it once and serves it from disk, honoring the
// Settings → Image Cache size cap and max age.

const isTauri = () => !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

const LEGACY_POSTER_PROXY_PREFIX = 'https://poster-cache.febsho.me/poster/'

/**
 * Older addon responses wrapped a complete artwork URL after `/poster/`.
 * That endpoint rejects both raw and percent-encoded nested URLs with HTTP
 * 400. Recover the embedded source so already-persisted catalogs self-heal
 * without a cache reset or another addon request.
 */
export function recoverArtworkSource(url: string): string {
  if (!url.toLowerCase().startsWith(LEGACY_POSTER_PROXY_PREFIX)) return url
  let candidate = url.slice(LEGACY_POSTER_PROXY_PREFIX.length)
  try {
    candidate = decodeURIComponent(candidate)
  } catch (_) { /* keep the original candidate */ }
  return /^https?:\/\//i.test(candidate) ? candidate : url
}

export function cachedImage(url: string): string
export function cachedImage(url: string | undefined): string | undefined
export function cachedImage(url: string | undefined): string | undefined {
  if (!url) return url
  const source = recoverArtworkSource(url)
  if (!isTauri() || !/^https?:\/\//i.test(source)) return source
  try {
    // The native handler bounds concurrent misses and deduplicates requests
    // for the same URL. convertFileSrc also emits the platform-correct custom
    // protocol URL (imgcache:// on Linux, http://imgcache.localhost on Windows).
    return convertFileSrc(source, 'imgcache')
  } catch (_) {
    return source
  }
}

/** Retry a failed custom-protocol request once with its original HTTPS URL.
 * Some WebViews do not follow redirects returned by custom image protocols;
 * this keeps a transient cache/origin error from turning a card black. */
export function retryImageFromSource(image: HTMLImageElement, url: string | undefined): boolean {
  if (!url) return false
  const source = recoverArtworkSource(url)
  if (!/^https?:\/\//i.test(source) || image.dataset.cacheSourceRetry === source) return false
  if (image.currentSrc === source || image.src === source) return false
  image.dataset.cacheSourceRetry = source
  image.src = source
  return true
}

/** Watch an image that is already rendering and fall back to its origin URL if
 * the custom protocol stalls. A hung protocol response fires neither `load` nor
 * `error`, so `retryImageFromSource` alone never runs and the element stays
 * blank indefinitely — a deadline is the only way out of that state.
 * Returns a cleanup function for the caller's effect. */
export function watchStalledImage(
  image: HTMLImageElement | null,
  url: string | undefined,
  timeoutMs = 5000,
): () => void {
  if (!image || !url) return () => {}
  const timer = window.setTimeout(() => {
    if (image.complete && image.naturalWidth > 0) return
    retryImageFromSource(image, url)
  }, timeoutMs)
  return () => window.clearTimeout(timer)
}

const imageWarmups = new Map<string, Promise<void>>()

/** Warm the same URL the destination component will render. Concurrent card
 * focus/click requests share one browser/custom-protocol fetch. */
export function warmCachedImage(url: string | undefined): Promise<void> {
  if (!url) return Promise.resolve()
  const source = cachedImage(url)
  if (!source) return Promise.resolve()
  const existing = imageWarmups.get(source)
  if (existing) return existing

  const request = new Promise<void>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = source
  }).finally(() => {
    // The decoded resource remains in the browser cache; only release our
    // promise bookkeeping.
    imageWarmups.delete(source)
  })
  imageWarmups.set(source, request)
  return request
}

export async function configureImageCache(maxMb: number, keepDays: number): Promise<void> {
  if (!isTauri()) return
  await invoke('image_cache_configure', { maxMb, keepDays }).catch(() => undefined)
}

export async function imageCacheStats(): Promise<{ bytes: number; files: number } | null> {
  if (!isTauri()) return null
  try {
    return await invoke<{ bytes: number; files: number }>('image_cache_stats')
  } catch (_) {
    return null
  }
}

export async function clearImageCache(): Promise<void> {
  if (!isTauri()) return
  await invoke('image_cache_clear').catch(() => undefined)
}
