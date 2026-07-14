import { convertFileSrc, invoke } from '@tauri-apps/api/core'

// Frontend side of the disk image cache (src-tauri/src/image_cache.rs).
// cachedImage() rewrites a remote artwork URL to the imgcache:// protocol so
// the Rust layer downloads it once and serves it from disk, honoring the
// Settings → Image Cache size cap and max age.

const isTauri = () => !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

export function cachedImage(url: string): string
export function cachedImage(url: string | undefined): string | undefined
export function cachedImage(url: string | undefined): string | undefined {
  if (!url || !isTauri()) return url
  if (!/^https?:\/\//.test(url)) return url
  try {
    // convertFileSrc owns protocol URL escaping. Passing an already escaped
    // remote URL double-encodes '%' and means the Rust handler only decodes
    // back to `https%3A…`, not the `https://…` URL it must download.
    return convertFileSrc(url, 'imgcache')
  } catch (_) {
    return url
  }
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
