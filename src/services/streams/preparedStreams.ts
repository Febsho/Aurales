import type { SubtitleResult } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { streamPreloadManager, StreamPreloadPriority, type PreloadedStream, type StreamPreloadRequest } from './preloadManager'
import { canonicalStreamKey, streamUrlTtlSeconds } from './preloadUtils'
import { rankStreams, type SmartPlayMode, type SmartScoreContext, type SmartStream } from './smartScoring'
import { getPlayableStreamUrl } from './playableUrl'
import { loadReliabilityHistory } from './reliabilityHistory'
import { probeStreamUrl, type StreamProbeResult } from './streamProbe'

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

const devLog = (...args: unknown[]) => { if (import.meta.env.DEV) console.log('[PreparedStream]', ...args) }

function warmupScore(probe: StreamProbeResult | null): number {
  if (!probe?.ok) return -200
  const latency = probe.elapsedMs ?? PROBE_TIMEOUT_MS
  const speed = probe.throughputMbps ?? 0
  const latencyScore = latency < 500 ? 18 : latency < 1000 ? 10 : latency < 2000 ? 2 : latency < 3000 ? -10 : -25
  const speedScore = speed >= 80 ? 24 : speed >= 30 ? 16 : speed >= 10 ? 7 : speed >= 5 ? 0 : -30
  return latencyScore + speedScore + (probe.acceptsRanges ? 5 : 0)
}

// Shared ranking context so StreamSelector, the prepared registry and the
// Up-Next autoplay path score streams identically.
export function buildSmartContext(opts: { title?: string; season?: number; episode?: number; subtitles?: SubtitleResult[]; mode?: SmartPlayMode } = {}): SmartScoreContext {
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
    maxSizeGb: store.cacheBufferSize === 'default' ? 20 : store.cacheBufferSize === 'large' ? 45 : 80,
    history: loadReliabilityHistory(),
  }
}

function readyTtlMs(url: string): number {
  const tokenized = /token|signature|sig|policy/i.test(url)
  const cap = tokenized ? TOKENIZED_TTL_CAP_MS : READY_TTL_CAP_MS
  return Math.min(streamUrlTtlSeconds(url, Math.floor(cap / 1000)) * 1000, cap)
}

class PreparedStreamRegistry {
  private entries = new Map<string, PreparedStream>()
  private inFlight = new Map<string, Promise<PreparedStream | null>>()

  async prepare(request: StreamPreloadRequest, opts: PrepareOptions = {}): Promise<PreparedStream | null> {
    const mediaKey = canonicalStreamKey(request)
    const pending = this.inFlight.get(mediaKey)
    if (pending) return pending

    const existing = this.entries.get(mediaKey)
    const now = Date.now()
    if (existing && existing.expiresAt > now + (existing.state === 'ready' ? 10_000 : 0)) {
      existing.lastAccessAt = now
      return existing.state === 'ready' ? existing : null
    }

    const flight = this.resolve(request, mediaKey, opts).finally(() => this.inFlight.delete(mediaKey))
    this.inFlight.set(mediaKey, flight)
    return flight
  }

  private async resolve(request: StreamPreloadRequest, mediaKey: string, opts: PrepareOptions): Promise<PreparedStream | null> {
    const entry: PreparedStream = {
      mediaKey,
      request,
      state: 'resolving',
      stream: undefined as unknown as PreloadedStream,
      playableUrl: '',
      score: 0,
      reasons: [],
      preparedAt: Date.now(),
      expiresAt: Date.now() + PROBE_TIMEOUT_MS + 30_000,
      lastAccessAt: Date.now(),
      warmup: { state: 'none' },
    }
    this.insert(entry)

    try {
      const streams = opts.streams ?? await streamPreloadManager.request(request, { priority: opts.priority ?? StreamPreloadPriority.DETAILS_OPEN })
      if (opts.signal?.aborted) { this.drop(entry); return null }

      const ranked = rankStreams(streams as SmartStream[], buildSmartContext({
        title: opts.title,
        season: request.seasonEpisode?.season,
        episode: request.seasonEpisode?.episode,
      })).filter((candidate) => candidate.score > -500 && getPlayableStreamUrl(candidate.stream))
      const candidates = ranked.slice(0, 2)
      if (candidates.length === 0) {
        this.drop(entry)
        return null
      }
      const measured = await Promise.all(candidates.map(async (candidate) => {
        const url = getPlayableStreamUrl(candidate.stream)!
        const probe = await probeStreamUrl(url, PROBE_TIMEOUT_MS)
        return { candidate, url, probe, total: candidate.score + warmupScore(probe) }
      }))
      if (opts.signal?.aborted) { this.drop(entry); return null }

      const playable = measured
        .filter((item) => item.probe == null || item.probe.ok)
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
  }

  clear(): void {
    this.entries.clear()
  }

  private valid(mediaKey: string): PreparedStream | null {
    const entry = this.entries.get(mediaKey)
    if (!entry || entry.state !== 'ready' || entry.expiresAt <= Date.now() + CONSUME_MARGIN_MS) return null
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
