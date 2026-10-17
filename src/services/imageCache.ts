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
  if (!image || !url || !isTauri()) return () => {}
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
const WARM_IMAGE_TIMEOUT_MS = 8_000

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
interface ImageWarmupJob {
  source: string
  priority: 'interactive' | 'background'
  sequence: number
  run: () => void
  cancel: () => void
}
const imageWarmupQueue: ImageWarmupJob[] = []
// Warmups are optional speculation. Keep a short look-ahead window so rapid
// shelf/route changes cannot leave hundreds of no-longer-visible downloads
// queued behind the small native image worker pool.
const MAX_QUEUED_IMAGE_WARMUPS = 24
// Match the native cache's bounded downloader. This maximizes cold-cache
// throughput without allowing background artwork to monopolize connections.
const IMAGE_WARMUP_CONCURRENCY = 3
let activeImageWarmups = 0
let imageWarmupWakeup: number | null = null
let imageWarmupSequence = 0

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
    imageWarmupQueue.sort((a, b) => Number(b.priority === 'interactive') - Number(a.priority === 'interactive') || a.sequence - b.sequence)
    imageWarmupQueue.shift()?.run()
  }
}

function loadWarmImage(source: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    let settled = false
    const finish = (loaded: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      image.onload = null
      image.onerror = null
      if (loaded) rememberDecodedImage(source, image)
      else image.removeAttribute('src')
      resolve()
    }
    const timeout = window.setTimeout(() => finish(false), WARM_IMAGE_TIMEOUT_MS)
    image.onload = () => finish(true)
    image.onerror = () => finish(false)
    image.src = source
  })
}

function enqueueImageWarmup(url: string | undefined, variant: ImageCacheVariant, startImmediately: boolean): Promise<void> {
  if (!url) return Promise.resolve()
  const source = cachedImage(url, variant)
  if (!source || sessionDecodedImages.has(source)) return Promise.resolve()
  const active = imageWarmups.get(source)
  if (active) return active
  const queued = queuedImageWarmups.get(source)
  if (queued) return queued
  if (imageWarmupQueue.length >= MAX_QUEUED_IMAGE_WARMUPS) {
    if (!startImmediately) return Promise.resolve()
    const backgroundIndex = imageWarmupQueue.findIndex((job) => job.priority === 'background')
    if (backgroundIndex < 0) return Promise.resolve()
    const [displaced] = imageWarmupQueue.splice(backgroundIndex, 1)
    queuedImageWarmups.delete(displaced.source)
    displaced.cancel()
  }

  let resolve!: () => void
  const request = new Promise<void>((done) => { resolve = done })
  queuedImageWarmups.set(source, request)
  const job: ImageWarmupJob = {
    source,
    priority: startImmediately ? 'interactive' : 'background',
    sequence: imageWarmupSequence++,
    cancel: resolve,
    run: () => {
      const loading = loadWarmImage(source).finally(() => {
        activeImageWarmups -= 1
        imageWarmups.delete(source)
        queuedImageWarmups.delete(source)
        resolve()
        runNextImageWarmup()
      })
      imageWarmups.set(source, loading)
    },
  }
  imageWarmupQueue.push(job)
  if (startImmediately) runNextImageWarmup()
  return request
}

/** Direct card focus and shelf look-ahead share bounded concurrency and URL deduplication. */
export function warmCachedImage(url: string | undefined, variant: ImageCacheVariant = 'card'): Promise<void> {
  return enqueueImageWarmup(url, variant, true)
}

/**
 * Warm a shelf's artwork at a deliberately small concurrency. This fills the
 * native disk cache during idle time without competing with the images the
 * person is currently looking at. Repeated shelves and route visits share the
 * same queued request.
 */
export function warmCachedImages(urls: Array<string | undefined>): Promise<void> {
  const uniqueUrls = [...new Set(urls.filter((url): url is string => Boolean(url)))]
  const requests = uniqueUrls.map((url) => enqueueImageWarmup(url, 'card', false))
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
  await invoke('image_cache_clear')
}
