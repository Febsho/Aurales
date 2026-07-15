import { invoke } from '@tauri-apps/api/core'

// Frontend side of the disk image cache (src-tauri/src/image_cache.rs).
// cachedImage() rewrites a remote artwork URL to the imgcache:// protocol so
// the Rust layer downloads it once and serves it from disk, honoring the
// Settings → Image Cache size cap and max age.

const isTauri = () => !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

export function cachedImage(url: string): string
export function cachedImage(url: string | undefined): string | undefined
export function cachedImage(url: string | undefined): string | undefined {
  // The custom protocol currently starts one blocking 20-second download per
  // image and cannot reliably redirect failures back to HTTPS. Under a normal
  // Home load that starves artwork and leaves Heroes black. Use WebView's HTTP
  // cache until the disk proxy has bounded concurrency and in-flight dedupe.
  return url
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
