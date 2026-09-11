import { invoke } from '@tauri-apps/api/core'
import type { RequestPriority } from './network/requestCoordinator'

interface NativeAddonCatalogResponse {
  metas: unknown[]
  stale: boolean
}

interface NativeAddonMetaResponse {
  meta: Record<string, unknown>
  stale: boolean
}

const groups = new Map<string, { key: string; generation: number }>()

function staleError(): DOMException {
  return new DOMException('Addon catalog request was superseded', 'AbortError')
}

function begin(group: string, key: string): number {
  const current = groups.get(group)
  const generation = current?.key === key ? current.generation : (current?.generation || 0) + 1
  groups.set(group, { key, generation })
  return generation
}

function ensureCurrent(group: string, key: string, generation: number): void {
  const current = groups.get(group)
  if (current?.key !== key || current.generation !== generation) throw staleError()
}

export function nativeAddonCatalogAvailable(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

export async function loadAddonCatalogNative(
  addonUrl: string,
  mediaType: string,
  catalogId: string,
  extra: Record<string, string> | undefined,
  options: { cancelGroup?: string; priority?: RequestPriority } = {},
): Promise<unknown[]> {
  if (!nativeAddonCatalogAvailable()) throw new Error('Native addon catalog loading is unavailable')
  const orderedExtra = Object.entries(extra || {})
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => ({ key, value }))
  const base = addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
  const operationKey = JSON.stringify([base, mediaType, catalogId, orderedExtra])
  const cancelGroup = options.cancelGroup || `addon-catalog:${operationKey}`
  const generation = begin(cancelGroup, operationKey)

  try {
    const response = await invoke<NativeAddonCatalogResponse>('load_addon_catalog', {
      request: {
        addonUrl,
        mediaType,
        catalogId,
        extra: orderedExtra,
        priority: options.priority || 'visible',
        cancelGroup,
        timeoutMs: 15_000,
      },
    })
    if (response.stale) throw staleError()
    ensureCurrent(cancelGroup, operationKey, generation)
    if (!Array.isArray(response.metas)) throw new Error('Malformed native addon catalog response')
    return response.metas
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    if ((error instanceof DOMException && error.name === 'AbortError') || /request was (superseded|cancelled)/i.test(message)) {
      throw staleError()
    }
    throw error
  }
}

export async function loadAddonMetaNative(
  addonUrl: string,
  mediaType: string,
  id: string,
  options: { cancelGroup?: string; priority?: RequestPriority } = {},
): Promise<Record<string, unknown>> {
  if (!nativeAddonCatalogAvailable()) throw new Error('Native addon metadata loading is unavailable')
  const base = addonUrl.replace(/\/manifest\.json$/, '').replace(/\/$/, '')
  const operationKey = JSON.stringify([base, mediaType, id])
  const cancelGroup = options.cancelGroup || `detail:addon:${mediaType}`
  const generation = begin(cancelGroup, operationKey)

  try {
    const response = await invoke<NativeAddonMetaResponse>('load_addon_meta', {
      request: {
        addonUrl,
        mediaType,
        id,
        priority: options.priority || 'interactive',
        cancelGroup,
        timeoutMs: 15_000,
      },
    })
    if (response.stale) throw staleError()
    ensureCurrent(cancelGroup, operationKey, generation)
    if (!response.meta || typeof response.meta !== 'object' || Array.isArray(response.meta)) {
      throw new Error('Malformed native addon metadata response')
    }
    return response.meta
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    if ((error instanceof DOMException && error.name === 'AbortError') || /request was (superseded|cancelled)/i.test(message)) {
      throw staleError()
    }
    throw error
  }
}
