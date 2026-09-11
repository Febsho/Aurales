import { invoke } from '@tauri-apps/api/core'
import type { StreamResult } from '../../types'
import type { InstalledAddon } from '../addons'
import type { PreloadedStream } from './preloadManager'

interface NativeCandidateResponse {
  candidates: PreloadedStream[]
  failures: Array<{ addonId: string; addonName: string; error: string }>
  stale: boolean
}

const groups = new Map<string, { key: string; generation: number }>()

function staleError(): DOMException {
  return new DOMException('Stream candidate request was superseded', 'AbortError')
}

function begin(group: string, key: string): number {
  const current = groups.get(group)
  const generation = current?.key === key ? current.generation : (current?.generation || 0) + 1
  groups.set(group, { key, generation })
  return generation
}

function ensureCurrent(group: string, key: string, generation: number, signal?: AbortSignal): void {
  const current = groups.get(group)
  if (signal?.aborted || current?.key !== key || current.generation !== generation) throw staleError()
}

export async function loadStreamCandidatesNative(
  mediaType: 'movie' | 'series',
  id: string,
  addons: InstalledAddon[],
  options: { cancelGroup: string; signal?: AbortSignal; priority?: 'playback' | 'interactive' | 'visible' | 'background' },
): Promise<{ candidates: PreloadedStream[]; failures: NativeCandidateResponse['failures'] }> {
  if (typeof window === 'undefined' || !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    throw new Error('Native stream candidate loading is unavailable')
  }
  const descriptors = addons.map((addon) => ({
    id: addon.manifest.id,
    name: addon.displayName || addon.manifest.name,
    url: addon.url,
  }))
  const key = `${mediaType}:${id}:${descriptors.map((addon) => `${addon.id}:${addon.url}`).join('|')}`
  const generation = begin(options.cancelGroup, key)
  ensureCurrent(options.cancelGroup, key, generation, options.signal)
  try {
    const response = await invoke<NativeCandidateResponse>('load_stream_candidates', {
      request: {
        mediaType,
        id,
        addons: descriptors,
        priority: options.priority || 'playback',
        cancelGroup: options.cancelGroup,
        timeoutMs: 20_000,
        providerTimeoutMs: 8_000,
      },
    })
    if (response.stale) throw staleError()
    ensureCurrent(options.cancelGroup, key, generation, options.signal)
    return { candidates: response.candidates as Array<StreamResult & { addonId: string; addonName: string }>, failures: response.failures }
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    if ((error instanceof DOMException && error.name === 'AbortError') || /request was (superseded|cancelled)/i.test(message)) throw staleError()
    throw error
  }
}
