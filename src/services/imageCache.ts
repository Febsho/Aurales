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

export type ImageCacheVariant = 'card' | 'backdrop'

export function cachedImage(url: string, variant?: ImageCacheVariant): string
export function cachedImage(url: string | undefined, variant?: ImageCacheVariant): string | undefined
export function cachedImage(url: string | undefined, variant: ImageCacheVariant = 'card'): string | undefined {
  if (!url) return url
  const source = recoverArtworkSource(url)
  if (!isTauri() || !/^https?:\/\//i.test(source)) return source
  try {
    // The native handler bounds concurrent misses and deduplicates requests
    // for the same URL. convertFileSrc also emits the platform-correct custom
    // protocol URL (imgcache:// on Linux, http://imgcache.localhost on Windows).
    // Full-bleed detail artwork needs a larger cached derivative than a shelf
    // card. A URL fragment creates a separate native cache key without
    // changing the provider request (fragments are never sent over HTTP).
    const cacheSource = variant === 'backdrop'
      ? `${source}${source.includes('#') ? '&' : '#'}aurales-cache=backdrop`
      : source
    return convertFileSrc(cacheSource, 'imgcache')
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

// Keep a *small* hot set of images that were explicitly warmed. Holding every
// DOM <img> that happens to load retains its card, row and decoded bitmap for
// the whole session, which turns long Home feeds into an unbounded renderer
// memory leak. WebKit's normal HTTP cache remains responsible for all ordinary
// images; this only avoids duplicate work for the most recently warmed art.
const imageWarmups = new Map<string, Promise<void>>()
const sessionDecodedImages = new Map<string, HTMLImageElement>()
// Full-resolution provider artwork can be far larger than its card. A dozen
// entries covers the viewport and next rail batch without pinning hundreds of
// megabytes in WebKit's decoded-image memory.
const MAX_SESSION_DECODED_IMAGES = 12

function rememberDecodedImage(source: string, image: HTMLImageElement): void {
  // Map insertion order gives us a compact LRU without retaining the DOM for
  // every poster the user has scrolled past.
  sessionDecodedImages.delete(source)
  sessionDecodedImages.set(source, image)
  while (sessionDecodedImages.size > MAX_SESSION_DECODED_IMAGES) {
    const oldest = sessionDecodedImages.keys().next().value
    if (!oldest) break
    sessionDecodedImages.delete(oldest)
  }
}
const queuedImageWarmups = new Map<string, Promise<void>>()
const imageWarmupQueue: Array<() => void> = []
// Match the native cache's bounded downloader. This maximizes cold-cache
// throughput without allowing background artwork to monopolize connections.
const IMAGE_WARMUP_CONCURRENCY = 3
let activeImageWarmups = 0
let imageWarmupWakeup: number | null = null

function scheduleImageWarmup(): void {
  if (imageWarmupWakeup !== null) return
  imageWarmupWakeup = window.setTimeout(() => {
    imageWarmupWakeup = null
    runNextImageWarmup()
  }, 32)
}

function runNextImageWarmup(): void {
  // Do not make a cache-fill task compete with an active wheel/touch gesture.
  // Chromium exposes this scheduling signal; WebKitGTK simply falls through
  // to the already conservative concurrency limit.
  const scheduler = (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling
  if (scheduler?.isInputPending?.()) {
    scheduleImageWarmup()
    return
  }
  while (activeImageWarmups < IMAGE_WARMUP_CONCURRENCY && imageWarmupQueue.length > 0) {
    activeImageWarmups += 1
    imageWarmupQueue.shift()?.()
  }
}

/** Warm the same URL the destination component will render. Concurrent card
 * focus/click requests share one browser/custom-protocol fetch. */
export function warmCachedImage(url: string | undefined): Promise<void> {
  if (!url) return Promise.resolve()
  const source = cachedImage(url)
  if (!source) return Promise.resolve()
  if (sessionDecodedImages.has(source)) return Promise.resolve()
  const existing = imageWarmups.get(source)
  if (existing) return existing

  const request = new Promise<void>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      rememberDecodedImage(source, image)
      resolve()
    }
    image.onerror = () => resolve()
    image.src = source
  }).finally(() => {
    // Keep successful decodes above, but release failed attempts so a later
    // origin/cache recovery can retry them.
    imageWarmups.delete(source)
  })
  imageWarmups.set(source, request)
  return request
}

/**
 * Warm a shelf's artwork at a deliberately small concurrency. This fills the
 * native disk cache during idle time without competing with the images the
 * person is currently looking at. Repeated shelves and route visits share the
 * same queued request.
 */
export function warmCachedImages(urls: Array<string | undefined>): Promise<void> {
  const uniqueUrls = [...new Set(urls.filter((url): url is string => Boolean(url)))]
  const requests = uniqueUrls.map((url) => {
    const source = cachedImage(url)
    if (!source) return Promise.resolve()
    const existing = queuedImageWarmups.get(source)
    if (existing) return existing

    let resolve!: () => void
    const request = new Promise<void>((done) => { resolve = done })
    queuedImageWarmups.set(source, request)
    imageWarmupQueue.push(() => {
      void warmCachedImage(url).finally(() => {
        activeImageWarmups -= 1
        queuedImageWarmups.delete(source)
        resolve()
        runNextImageWarmup()
      })
    })
    return request
  })
  // Enqueue the full batch before waking the scheduler so a shelf can only
  // create one input-pending retry timer, not one per image URL.
  runNextImageWarmup()
  return Promise.all(requests).then(() => undefined)
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
