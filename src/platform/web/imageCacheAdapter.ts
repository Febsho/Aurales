import type { ImageCacheAdapter } from '../imageCacheAdapter'

/** Browser artwork uses normal HTTPS URLs and the browser's HTTP cache. */
const webImageCacheAdapter: ImageCacheAdapter = {
  usesCustomProtocol: () => false,
  cachedImage: (source) => source,
  configure: async () => undefined,
  stats: async () => null,
  clear: async () => undefined,
}

export default webImageCacheAdapter
