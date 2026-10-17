import type { SubtitleResult } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { streamPreloadManager, StreamPreloadPriority, type PreloadedStream, type StreamPreloadRequest } from './preloadManager'
import { canonicalStreamKey, streamUrlTtlSeconds } from './preloadUtils'
import { type SmartPlayMode, type SmartScoreContext, type SmartStream } from './smartScoring'
import { rankStreamCandidates } from './nativeScoring'
import type { PlaybackPreference } from './playbackMemory'
import { getPlayableStreamUrl } from './playableUrl'
import { loadReliabilityHistory, reliabilityHistoryRevision } from './reliabilityHistory'
import { probeStreamUrl, type StreamProbeResult } from './streamProbe'
import { annotateTorBoxStreams, resolveTorBoxStream } from '../torbox'

export type PreparedStreamState = 'resolving' | 'ready' | 'failed'

export interface PreparedStream {
  mediaKey: string
  request: StreamPreloadRequest
  state: PreparedStreamState
  stream: PreloadedStream
  playableUrl: string // probe.finalUrl ?? getPlayableStreamUrl(stream)
  score: number
  reasons: string[]
  runnerUp?: PreloadedStream // measured fallback retained for diagnostics
  probe?: StreamProbeResult // undefined when probing is unavailable (web build)
  rankingContextKey: string
  title?: string
  preparedAt: number
  expiresAt: number
  lastAccessAt: number
  // v2 extension point — a future PlayerWarmupManager attaches here; always 'none' in v1.
  warmup: { state: 'none' | 'warming' | 'warm' | 'discarded' }
}

export interface PrepareOptions {
  streams?: PreloadedStream[]
  signal?: AbortSignal
  title?: string
  priority?: StreamPreloadPriority
}

const PROBE_TIMEOUT_MS = 4_000
const MAX_ENTRIES = 2 // current detail media + next episode
const FAILED_TTL_MS = 60_000 // negative cache so dwell re-triggers don't re-probe a dead link
const READY_TTL_CAP_MS = 15 * 60_000
const TOKENIZED_TTL_CAP_MS = 10 * 60_000
const CONSUME_MARGIN_MS = 5_000

interface PrepareFlight {
  promise: Promise<PreparedStream | null>
  controller: AbortController
  rankingContextKey: string
  signalConsumers: Set<symbol>
  hasUncancellableConsumer: boolean
  priority: StreamPreloadPriority
  streamRequestPending: boolean
}

const devLog = (...args: unknown[]) => { if (import.meta.env.DEV) console.log('[PreparedStream]', ...args) }

function warmupScore(probe: StreamProbeResult | null): number {
  if (!probe?.ok) return -200
  const latency = probe.elapsedMs ?? PROBE_TIMEOUT_MS
  const speed = probe.throughputMbps ?? 0
  const latencyScore = latency < 500 ? 18 : latency < 1000 ? 10 : latency < 2000 ? 2 : latency < 3000 ? -10 : -25
  const speedScore = speed >= 80 ? 24 : speed >= 30 ? 16 : speed >= 10 ? 7 : speed >= 5 ? 0 : -30
  return latencyScore + speedScore + (probe.acceptsRanges ? 5 : 0)
}

function rankingContext(request: StreamPreloadRequest, title?: string): SmartScoreContext {
  return buildSmartContext({
    title,
    season: request.seasonEpisode?.season,
    episode: request.seasonEpisode?.episode,
  })
}

function rankingContextKey(context: SmartScoreContext, request: StreamPreloadRequest): string {
  return JSON.stringify([
    streamPreloadManager.configurationKey(request.mediaType),
    context.title,
    context.season ?? null,
    context.episode ?? null,
    context.preferredAudio ?? [],
    context.preferredSubtitles ?? [],
    context.subtitles ?? [],
    context.mode,
    context.player,
    context.maxSizeGb ?? null,
    typeof reliabilityHistoryRevision === 'function' ? reliabilityHistoryRevision() : 0,
    context.playbackMemories ?? [],
  ])
}

// Shared ranking context so StreamSelector, the prepared registry and the
// Up-Next autoplay path score streams identically.
export function buildSmartContext(opts: { title?: string; season?: number; episode?: number; subtitles?: SubtitleResult[]; mode?: SmartPlayMode; playbackMemories?: PlaybackPreference[] } = {}): SmartScoreContext {
  const store = useAppStore.getState()
  return {
    title: opts.title ?? '',
    season: opts.season,
    episode: opts.episode,
    preferredAudio: store.preferredAudio,
    preferredSubtitles: store.preferredSubtitles,
    subtitles: opts.subtitles ?? [],
    mode: opts.mode ?? ((typeof localStorage !== 'undefined' && localStorage.getItem('aurales_smart_play_mode') as SmartPlayMode) || 'best'),
    player: typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ ? 'mpv' : 'web',
    maxSizeGb: 20,
    history: loadReliabilityHistory(),
    playbackMemories: opts.playbackMemories,
  }
}

function readyTtlMs(url: string): number {
  const tokenized = /token|signature|sig|policy/i.test(url)
  const cap = tokenized ? TOKENIZED_TTL_CAP_MS : READY_TTL_CAP_MS
  return Math.min(streamUrlTtlSeconds(url, Math.floor(cap / 1000)) * 1000, cap)
}

class PreparedStreamRegistry {
  private entries = new Map<string, PreparedStream>()
  private inFlight = new Map<string, PrepareFlight>()

  async prepare(request: StreamPreloadRequest, opts: PrepareOptions = {}): Promise<PreparedStream | null> {
    const mediaKey = canonicalStreamKey(request)
    if (opts.signal?.aborted) return null
    const currentRankingContextKey = rankingContextKey(rankingContext(request, opts.title), request)
    let pending = this.inFlight.get(mediaKey)
    if (pending?.controller.signal.aborted) {
      // All previous callers cancelled. Do not hand a fresh request the
      // already-aborted flight; let it start a new preparation attempt.
      this.inFlight.delete(mediaKey)
      pending = undefined
    }
    if (pending && pending.rankingContextKey !== currentRankingContextKey) {
      pending.controller.abort()
      if (this.inFlight.get(mediaKey) === pending) this.inFlight.delete(mediaKey)
      pending = undefined
    }
    if (pending) {
      const priority = opts.priority ?? StreamPreloadPriority.DETAILS_OPEN
      if (priority > pending.priority) {
        pending.priority = priority
        if (pending.streamRequestPending) {
          // The selector may request the same prepared stream at playback
          // priority while a detail-page prefetch is still resolving. Join
          // the existing aggregate flight so its queued addon work is promoted.
          void streamPreloadManager.request(request, { priority }).catch(() => undefined)
        }
      }
      return this.subscribeToFlight(pending, opts.signal)
    }

    const existing = this.entries.get(mediaKey)
    const now = Date.now()
    if (existing && existing.expiresAt > now + (existing.state === 'ready' ? 10_000 : 0)) {
      if (existing.rankingContextKey !== currentRankingContextKey) {
        this.entries.delete(mediaKey)
      } else {
        existing.lastAccessAt = now
        return existing.state === 'ready' ? existing : null
      }
    }

    const controller = new AbortController()
    const flight: PrepareFlight = {
      promise: Promise.resolve(null),
      controller,
      rankingContextKey: currentRankingContextKey,
      signalConsumers: new Set(),
      hasUncancellableConsumer: false,
      priority: opts.priority ?? StreamPreloadPriority.DETAILS_OPEN,
      streamRequestPending: !opts.streams,
    }
    flight.promise = this.resolve(request, mediaKey, { ...opts, signal: controller.signal }, flight).finally(() => {
      if (this.inFlight.get(mediaKey) === flight) this.inFlight.delete(mediaKey)
    })
    this.inFlight.set(mediaKey, flight)
    return this.subscribeToFlight(flight, opts.signal)
  }

  private subscribeToFlight(flight: PrepareFlight, signal?: AbortSignal): Promise<PreparedStream | null> {
    if (!signal) {
      // A caller without a signal has requested the shared result until it
      // settles, so another caller's navigation must not cancel that work.
      flight.hasUncancellableConsumer = true
      return flight.promise
    }
    if (signal.aborted) return Promise.resolve(null)

    const consumer = Symbol('prepared-stream-consumer')
    flight.signalConsumers.add(consumer)
    return new Promise((resolve, reject) => {
      let settled = false
      const release = () => {
        signal.removeEventListener('abort', onAbort)
        flight.signalConsumers.delete(consumer)
        if (!flight.hasUncancellableConsumer && flight.signalConsumers.size === 0) {
          flight.controller.abort()
        }
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        release()
        resolve(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(
        (prepared) => {
          if (settled) return
          settled = true
          release()
          resolve(prepared)
        },
        (error) => {
          if (settled) return
          settled = true
          release()
          reject(error)
        },
      )
    })
  }

  private async resolve(request: StreamPreloadRequest, mediaKey: string, opts: PrepareOptions, flight: PrepareFlight): Promise<PreparedStream | null> {
    const entry: PreparedStream = {
      mediaKey,
      request,
      state: 'resolving',
      stream: undefined as unknown as PreloadedStream,
      playableUrl: '',
      score: 0,
      reasons: [],
      rankingContextKey: flight.rankingContextKey,
      title: opts.title,
      preparedAt: Date.now(),
      expiresAt: Date.now() + PROBE_TIMEOUT_MS + 30_000,
      lastAccessAt: Date.now(),
      warmup: { state: 'none' },
    }
    this.insert(entry)

    try {
      let rawStreams = opts.streams
      if (!rawStreams) {
        try {
          rawStreams = await streamPreloadManager.request(request, { priority: flight.priority })
        } finally {
          flight.streamRequestPending = false
        }
      }
      const streams = await annotateTorBoxStreams(rawStreams).catch(() => rawStreams)
      if (opts.signal?.aborted) { this.drop(entry); return null }

      const context = rankingContext(request, opts.title)
      flight.rankingContextKey = rankingContextKey(context, request)
      entry.rankingContextKey = flight.rankingContextKey
      const ranked = (await rankStreamCandidates(streams as SmartStream[], context, { cancelGroup: `streams:prepare:${mediaKey}`, priority: flight.priority === StreamPreloadPriority.PLAYBACK ? 'playback' : 'visible', signal: opts.signal })).filter((candidate) => candidate.score > -500)
      if (opts.signal?.aborted || flight.rankingContextKey !== rankingContextKey(rankingContext(request, opts.title), request)) { this.drop(entry); return null }
      const candidates = ranked.slice(0, 2)
      if (candidates.length === 0) {
        this.drop(entry)
        return null
      }
      const measured = await Promise.all(candidates.map(async (candidate) => {
        try {
          const url = getPlayableStreamUrl(candidate.stream) || await resolveTorBoxStream(candidate.stream, {
            title: opts.title,
            season: request.seasonEpisode?.season,
            episode: request.seasonEpisode?.episode,
          })
          const probe = await probeStreamUrl(url, PROBE_TIMEOUT_MS)
          return { candidate, url, probe, total: candidate.score + warmupScore(probe) }
        } catch (_) {
          return { candidate, url: '', probe: { ok: false, status: 0 } as StreamProbeResult, total: -Infinity }
        }
      }))
      if (opts.signal?.aborted || flight.rankingContextKey !== rankingContextKey(rankingContext(request, opts.title), request)) { this.drop(entry); return null }

      const playable = measured
        .filter((item) => item.url && (item.probe == null || item.probe.ok))
        .sort((a, b) => b.total - a.total)
      const winner = playable[0]
      if (!winner) {
        entry.state = 'failed'
        entry.expiresAt = Date.now() + FAILED_TTL_MS
        return null
      }
      const runnerUp = playable[1]
      const { candidate: top, url, probe } = winner

      entry.stream = top.stream as PreloadedStream
      entry.score = top.score
      entry.reasons = top.reasons
      entry.runnerUp = runnerUp?.candidate.stream as PreloadedStream | undefined
      entry.probe = probe ?? undefined
      entry.lastAccessAt = Date.now()

      entry.playableUrl = probe?.finalUrl || url
      entry.state = 'ready'
      entry.expiresAt = Date.now() + readyTtlMs(entry.playableUrl)
      devLog(`Prepared ${mediaKey}: ${entry.stream.addonName} score ${entry.score}${probe ? ` (probe ${probe.status}, ${probe.elapsedMs ?? 0}ms, ${(probe.throughputMbps ?? 0).toFixed(1)}Mbps${probe.acceptsRanges ? ', ranges' : ''})` : ' (unprobed)'}`)
      return entry
    } catch (error) {
      devLog(`Prepare error for ${mediaKey}:`, error)
      this.drop(entry)
      return null
    }
  }

  // One-shot: a consumed URL is about to be handed to the player.
  consume(mediaKey: string): PreparedStream | null {
    const entry = this.valid(mediaKey)
    if (entry) { this.entries.delete(mediaKey); devLog(`Consumed ${mediaKey}`) }
    return entry
  }

  peek(mediaKey: string): PreparedStream | null {
    const entry = this.valid(mediaKey)
    if (entry) entry.lastAccessAt = Date.now()
    return entry
  }

  invalidate(mediaKey: string): void {
    this.entries.delete(mediaKey)
    const flight = this.inFlight.get(mediaKey)
    if (flight) {
      flight.controller.abort()
      if (this.inFlight.get(mediaKey) === flight) this.inFlight.delete(mediaKey)
    }
  }

  clear(): void {
    this.entries.clear()
    for (const [mediaKey, flight] of this.inFlight) {
      flight.controller.abort()
      if (this.inFlight.get(mediaKey) === flight) this.inFlight.delete(mediaKey)
    }
  }

  private valid(mediaKey: string): PreparedStream | null {
    const entry = this.entries.get(mediaKey)
    if (!entry || entry.state !== 'ready' || entry.expiresAt <= Date.now() + CONSUME_MARGIN_MS) return null
    if (entry.rankingContextKey !== rankingContextKey(rankingContext(entry.request, entry.title), entry.request)) {
      this.entries.delete(mediaKey)
      return null
    }
    return entry
  }

  private insert(entry: PreparedStream): void {
    this.entries.set(entry.mediaKey, entry)
    while (this.entries.size > MAX_ENTRIES) {
      let oldest: PreparedStream | undefined
      for (const candidate of this.entries.values()) {
        if (candidate === entry) continue
        if (!oldest || candidate.lastAccessAt < oldest.lastAccessAt) oldest = candidate
      }
      if (!oldest) break
      this.entries.delete(oldest.mediaKey)
      devLog(`Evicted ${oldest.mediaKey} (LRU)`)
    }
  }

  private drop(entry: PreparedStream): void {
    // Only remove if the map still holds this exact resolve attempt.
    if (this.entries.get(entry.mediaKey) === entry) this.entries.delete(entry.mediaKey)
  }
}

export const preparedStreamRegistry = new PreparedStreamRegistry()
