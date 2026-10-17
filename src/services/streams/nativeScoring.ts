import { invoke } from '@tauri-apps/api/core'
import { rankStreams, type ScoredStream, type SmartScoreContext, type SmartStream } from './smartScoring'
import { streamFingerprint } from './reliabilityHistory'

type RankPriority = 'playback' | 'interactive' | 'visible' | 'background'

interface NativeScoredStream extends ScoredStream {
  fingerprint: string
}

interface NativeRankResponse {
  candidates: NativeScoredStream[]
  stale: boolean
}

const navigationGroups = new Map<string, { key: string; generation: number; users: number }>()
let nextNavigationGeneration = 0

function operationKey(streams: SmartStream[], context: SmartScoreContext): string {
  // A cancellation group represents one exact ranking request. Include every
  // input that can affect score or tie-breaking, or a new request with changed
  // preferences/history can accidentally join the old generation.
  const { history, ...staticContext } = context
  return JSON.stringify([
    staticContext,
    // Reliability history can grow independently of the visible candidate
    // batch. Ranking depends only on records for these streams, so serializing
    // the entire history on every ranking pass needlessly scales with lifetime
    // playback count.
    streams.map((stream) => {
      const fingerprint = streamFingerprint(stream)
      return [fingerprint, history?.[fingerprint] ?? null]
    }),
    streams.map((stream) => ({
      addonId: stream.addonId,
      infoHash: stream.infoHash,
      fileIdx: stream.fileIdx,
      url: stream.url,
      name: stream.name,
      title: stream.title,
      description: stream.description,
      filename: stream.filename,
      behaviorHints: stream.behaviorHints,
      subtitles: stream.subtitles,
    })),
  ])
}

function begin(group: string, key: string): number {
  const current = navigationGroups.get(group)
  if (current?.key === key) {
    current.users += 1
    return current.generation
  }
  // A monotonically increasing id prevents an old ranking from becoming
  // current again if navigation returns to the same input after group cleanup.
  const generation = ++nextNavigationGeneration
  navigationGroups.set(group, { key, generation, users: 1 })
  return generation
}

function finish(group: string, key: string, generation: number): void {
  const current = navigationGroups.get(group)
  if (!current || current.key !== key || current.generation !== generation) return
  current.users -= 1
  if (current.users === 0) navigationGroups.delete(group)
}

function staleError(): DOMException {
  return new DOMException('Stream ranking was superseded', 'AbortError')
}

function ensureCurrent(group: string, key: string, generation: number, signal?: AbortSignal): void {
  const current = navigationGroups.get(group)
  if (signal?.aborted || !current || current.key !== key || current.generation !== generation) throw staleError()
}

function isNativeCancellation(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return /request was (superseded|cancelled)/i.test(message)
}

/**
 * Coarse compatibility boundary for ranking a complete candidate batch. The
 * synchronous scorer remains the exact web/native-failure fallback until the
 * native implementation has accumulated production parity coverage.
 */
export async function rankStreamCandidates(
  streams: SmartStream[],
  context: SmartScoreContext,
  options: { cancelGroup?: string; priority?: RankPriority; signal?: AbortSignal } = {},
): Promise<ScoredStream[]> {
  const cancelGroup = options.cancelGroup || 'streams:ranking'
  const key = operationKey(streams, context)
  const generation = begin(cancelGroup, key)
  try {
    ensureCurrent(cancelGroup, key, generation, options.signal)

    const hasNativeBridge = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
    if (hasNativeBridge) {
      try {
        const response = await invoke<NativeRankResponse>('rank_stream_candidates', {
          request: {
            streams,
            context: {
              ...context,
              appOrigin: window.location?.origin,
            },
            priority: options.priority || 'playback',
            cancelGroup,
            timeoutMs: 3_000,
          },
        })
        if (response.stale) throw staleError()
        ensureCurrent(cancelGroup, key, generation, options.signal)
        // Keep the established locale-aware deterministic tie break. Rust owns
        // score calculation; this only resolves equal scores exactly as before.
        return response.candidates
          .sort((left, right) => right.score - left.score || left.fingerprint.localeCompare(right.fingerprint))
          .map(({ stream, score, reasons }) => ({ stream, score, reasons }))
      } catch (error) {
        if ((error instanceof DOMException && error.name === 'AbortError') || isNativeCancellation(error)) throw staleError()
        console.warn('[streams] Native ranking failed, using compatibility scorer:', error)
      }
    }

    const fallback = rankStreams(streams, context)
    ensureCurrent(cancelGroup, key, generation, options.signal)
    return fallback
  } finally {
    finish(cancelGroup, key, generation)
  }
}
