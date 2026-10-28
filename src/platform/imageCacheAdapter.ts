import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getPlatformCapabilities } from './capabilities'

export type ImageCacheVariant = 'card' | 'backdrop'

export interface ImageCacheAdapter {
  usesCustomProtocol(): boolean
  cachedImage(source: string, variant: ImageCacheVariant): string
  configure(maxMb: number, keepDays: number): Promise<void>
  stats(): Promise<{ bytes: number; files: number } | null>
  clear(): Promise<void>
}

/** Native artwork cache backed by the Rust disk cache and imgcache protocol. */
const nativeImageCacheAdapter: ImageCacheAdapter = {
  usesCustomProtocol: () => getPlatformCapabilities().platform === 'tauri',
  cachedImage(source, variant) {
    if (getPlatformCapabilities().platform !== 'tauri') return source
    const cacheSource = variant === 'backdrop'
      ? `${source}${source.includes('#') ? '&' : '#'}aurales-cache=backdrop`
      : source
    try { return convertFileSrc(cacheSource, 'imgcache') }
    catch { return source }
  },
  async configure(maxMb, keepDays) {
    if (getPlatformCapabilities().platform !== 'tauri') return
    await invoke('image_cache_configure', { maxMb, keepDays }).catch(() => undefined)
  },
  async stats() {
    if (getPlatformCapabilities().platform !== 'tauri') return null
    try { return await invoke<{ bytes: number; files: number }>('image_cache_stats') }
    catch { return null }
  },
  async clear() {
    if (getPlatformCapabilities().platform === 'tauri') await invoke('image_cache_clear')
  },
}

export default nativeImageCacheAdapter
