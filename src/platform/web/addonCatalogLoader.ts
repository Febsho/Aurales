import type { RequestPriority } from '../../services/network/requestCoordinator'

/** Browser adapter: addon catalogs use the existing CORS-aware fetch path. */
export function nativeAddonCatalogAvailable(): boolean {
  return false
}

export async function loadAddonCatalogNative(
  _addonUrl: string,
  _mediaType: string,
  _catalogId: string,
  _extra: Record<string, string> | undefined,
  _options: { cancelGroup?: string; priority?: RequestPriority } = {},
): Promise<unknown[]> {
  throw new Error('Native addon catalog IPC is unavailable in the browser; use the browser fetch path.')
}

export async function loadAddonMetaNative(
  _addonUrl: string,
  _mediaType: string,
  _id: string,
  _options: { cancelGroup?: string; priority?: RequestPriority } = {},
): Promise<Record<string, unknown>> {
  throw new Error('Native addon metadata IPC is unavailable in the browser; use the browser fetch path.')
}
