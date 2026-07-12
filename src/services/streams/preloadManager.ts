import type { StreamResult } from '../../types'
import { fetchAddonStreamsStrict, getStreamAddons, type InstalledAddon } from '../addons'
import { useAppStore } from '../../stores/appStore'
import { tmdbProvider } from '../tmdb'
import { canonicalStreamKey, resolveNextEpisodeWith } from './preloadUtils'
export { canonicalStreamKey } from './preloadUtils'
import { cacheGet, cacheSet } from '../cache/sqliteCache'
import { CACHE_CATEGORIES } from '../cache/constants'

export const StreamPreloadPriority = {
  PLAYBACK: 100,
  DETAILS_OPEN: 90,
  CONTINUE_CURRENT: 80,
  CONTINUE_NEXT_EPISODE: 70,
  IDLE_PREDICTION: 10,
} as const
export type StreamPreloadPriority = typeof StreamPreloadPriority[keyof typeof StreamPreloadPriority]

function priorityName(value: number): string {
  return Object.entries(StreamPreloadPriority).find(([, priority]) => priority === value)?.[0] || String(value)
}

export type PreloadedStream = StreamResult & { addonId: string; addonName: string }

export interface StreamPreloadRequest {
  mediaType: 'movie' | 'series'
  mediaId: string
  imdbId?: string
  tmdbId?: string | number
  seasonEpisode?: { season: number; episode: number }
  sourceAddonId?: string
  sourceAddonItemId?: string
}

interface AddonCacheEntry {
  streams: StreamResult[]
  fetchedAt: number
  expiresAt: number
  staleUntil: number
}

export interface AddonPerformanceStats {
  addonId: string
  averageLatencyMs: number
  successRate: number
  averageResultCount: number
  consecutiveFailures: number
  lastSuccessAt?: number
  lastFailureAt?: number
  samples: number
}

type UpdateCallback = (streams: PreloadedStream[], status: { cached: boolean; complete: boolean }) => void

interface QueueJob {
  id: string
  mediaKey: string
  addonId: string
  priority: number
  sequence: number
  run: () => Promise<AddonCacheEntry>
  resolve: (entry: AddonCacheEntry) => void
  reject: (error: unknown) => void
}

interface AggregateFlight {
  priority: number
  promise: Promise<PreloadedStream[]>
  subscribers: Set<UpdateCallback>
  latest: PreloadedStream[]
}

const MAX_CONCURRENCY = 4
const ADDON_TIMEOUT_MS = 8_000
const NEGATIVE_TTL_SECONDS = 7 * 60
const EPISODE_TTL_SECONDS = 45 * 60
const MOVIE_TTL_SECONDS = 12 * 60 * 60
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000
const PERF_STORAGE_KEY = 'aurales_stream_preload_addon_stats_v1'

const devLog = (...args: unknown[]) => { if (import.meta.env.DEV) console.log('[StreamPreload]', ...args) }

function cleanId(value: string | number | undefined): string {
  return String(value ?? '').trim().replace(/:(\d+):(\d+)$/, '')
}

function supportsStreams(addon: InstalledAddon, type: string): boolean {
  return addon.manifest.resources.some((resource) => {
    if (resource === 'stream') return true
    return typeof resource === 'object' && resource?.name === 'stream' && (!resource.types || resource.types.includes(type))
  })
}

function allStreamAddons(type: 'movie' | 'series'): InstalledAddon[] {
  const map = new Map<string, InstalledAddon>()
  for (const addon of getStreamAddons(type)) map.set(addon.manifest.id, addon)
  for (const addon of useAppStore.getState().addons) {
    if (addon.enabled && supportsStreams(addon, type)) map.set(addon.manifest.id, addon)
  }
  return [...map.values()]
}

function cacheKey(mediaKey: string, addon: InstalledAddon, streamId: string): string {
  return `stream_preload:v1:${mediaKey}:${addon.manifest.id}:${streamId}`
}

export async function resolveNextEpisode(
  request: StreamPreloadRequest,
  loadSeason = async (tmdbId: string | number, season: number) => (await tmdbProvider.getSeason(`tmdb-${tmdbId}`, season)).episodes,
): Promise<{ season: number; episode: number } | undefined> {
  return resolveNextEpisodeWith(request, loadSeason)
}

function safeTtl(request: StreamPreloadRequest, streams: StreamResult[]): number {
  if (streams.length === 0) return NEGATIVE_TTL_SECONDS
  let ttl = request.seasonEpisode ? EPISODE_TTL_SECONDS : MOVIE_TTL_SECONDS
  for (const stream of streams) {
    if (!stream.url) continue
    try {
      const parsed = new URL(stream.url)
      const expiry = Number(parsed.searchParams.get('expires') || parsed.searchParams.get('exp') || parsed.searchParams.get('e'))
      if (Number.isFinite(expiry) && expiry > 1_000_000_000 && expiry < 4_000_000_000) {
        ttl = Math.min(ttl, Math.max(5 * 60, expiry - Math.floor(Date.now() / 1000) - 120))
      } else if (/token|signature|sig|policy/i.test(parsed.search)) {
        ttl = Math.min(ttl, 20 * 60)
      }
    } catch { /* non-URL streams are ranked later by the existing pipeline */ }
  }
  return ttl
}

class StreamPreloadManager {
  private queue: QueueJob[] = []
  private active = 0
  private sequence = 0
  private addonFlights = new Map<string, { promise: Promise<AddonCacheEntry>; job?: QueueJob }>()
  private aggregateFlights = new Map<string, AggregateFlight>()
  private performance = this.loadStats()
  private homeReady = false
  private continueWatchingReady = false
  private startupScheduled = false
  private pendingContinue: Array<StreamPreloadRequest & { progressPct?: number }> = []

  request(request: StreamPreloadRequest, options: { priority: StreamPreloadPriority; onUpdate?: UpdateCallback } = { priority: StreamPreloadPriority.PLAYBACK }): Promise<PreloadedStream[]> {
    const mediaKey = canonicalStreamKey(request)
    const existing = this.aggregateFlights.get(mediaKey)
    if (existing) {
      if (options.onUpdate) { existing.subscribers.add(options.onUpdate); if (existing.latest.length) options.onUpdate(existing.latest, { cached: true, complete: false }) }
      if (options.priority > existing.priority) {
        existing.priority = options.priority
        this.promote(mediaKey, options.priority)
        devLog(`Promoted job to ${priorityName(options.priority)}: ${mediaKey}`)
      }
      devLog(`Reusing in-flight request: ${mediaKey}`)
      return existing.promise
    }

    const flight: AggregateFlight = { priority: options.priority, promise: Promise.resolve([]), subscribers: new Set(options.onUpdate ? [options.onUpdate] : []), latest: [] }
    flight.promise = this.execute(request, mediaKey, flight).finally(() => this.aggregateFlights.delete(mediaKey))
    this.aggregateFlights.set(mediaKey, flight)
    return flight.promise
  }

  markHomeReady(): void {
    this.homeReady = true
    this.maybeScheduleStartup()
  }

  setContinueWatching(items: Array<StreamPreloadRequest & { progressPct?: number }>): void {
    this.pendingContinue = items.slice(0, 5)
    this.continueWatchingReady = true
    this.maybeScheduleStartup()
  }

  private maybeScheduleStartup(): void {
    if (!this.homeReady || !this.continueWatchingReady || this.startupScheduled || this.pendingContinue.length === 0) return
    this.startupScheduled = true
    const run = async () => {
      if (!navigator.onLine) return
      devLog(`Idle startup preload: ${this.pendingContinue.length} Continue Watching targets`)
      for (const item of this.pendingContinue) {
        this.request(item, { priority: StreamPreloadPriority.CONTINUE_CURRENT }).catch(() => undefined)
        if (item.mediaType === 'series' && item.seasonEpisode && (item.progressPct || 0) >= 85) {
          const next = await resolveNextEpisode(item)
          if (next) this.request({ ...item, seasonEpisode: next }, { priority: StreamPreloadPriority.CONTINUE_NEXT_EPISODE }).catch(() => undefined)
        }
      }
    }
    // Give React/layout/image work a quiet window first. requestIdleCallback
    // alone may fire immediately on fast machines, which would still compete
    // with Home's first meaningful paint.
    window.setTimeout(() => {
      const idle = window.requestIdleCallback
      if (idle) idle(() => { void run() }, { timeout: 6_000 })
      else window.setTimeout(() => { void run() }, 1_000)
    }, 1_250)
  }

  private async execute(request: StreamPreloadRequest, mediaKey: string, flight: AggregateFlight): Promise<PreloadedStream[]> {
    if (!navigator.onLine && flight.priority < StreamPreloadPriority.DETAILS_OPEN) return []
    const addons = allStreamAddons(request.mediaType).sort((a, b) => this.addonScore(b.manifest.id) - this.addonScore(a.manifest.id))
    if (!addons.length) return []
    const results = new Map<string, PreloadedStream[]>()
    const refreshes: Promise<void>[] = []

    await Promise.all(addons.map(async (addon) => {
      const baseId = addon.manifest.id === request.sourceAddonId && request.sourceAddonItemId
        ? request.sourceAddonItemId
        : cleanId(request.mediaId)
      if (!baseId) return
      const streamId = request.seasonEpisode ? `${baseId}:${request.seasonEpisode.season}:${request.seasonEpisode.episode}` : baseId
      const key = cacheKey(mediaKey, addon, streamId)
      const cached = await cacheGet<AddonCacheEntry>(key)
      const now = Date.now()
      if (cached?.data && cached.data.staleUntil > now) {
        results.set(addon.manifest.id, this.decorate(cached.data.streams, addon))
        devLog(`${cached.data.expiresAt > now && !cached.stale ? 'Cache HIT' : 'Cache STALE'}: ${mediaKey} / ${addon.manifest.id}`)
        this.emit(flight, results, true, false)
      }
      if (!cached?.data || cached.stale || cached.data.expiresAt <= now) {
        refreshes.push(this.fetchAddon(request, mediaKey, addon, streamId, flight.priority).then((entry) => {
          results.set(addon.manifest.id, this.decorate(entry.streams, addon))
          this.emit(flight, results, false, false)
        }).catch(() => undefined))
      }
    }))

    await Promise.all(refreshes)
    const final = [...results.values()].flat()
    flight.latest = final
    for (const subscriber of flight.subscribers) subscriber(final, { cached: false, complete: true })
    return final
  }

  private decorate(streams: StreamResult[], addon: InstalledAddon): PreloadedStream[] {
    return streams.map((stream) => ({ ...stream, addonId: addon.manifest.id, addonName: addon.displayName || addon.manifest.name }))
  }

  private emit(flight: AggregateFlight, results: Map<string, PreloadedStream[]>, cached: boolean, complete: boolean): void {
    flight.latest = [...results.values()].flat()
    for (const subscriber of flight.subscribers) subscriber(flight.latest, { cached, complete })
  }

  private fetchAddon(request: StreamPreloadRequest, mediaKey: string, addon: InstalledAddon, streamId: string, priority: number): Promise<AddonCacheEntry> {
    const flightKey = `${mediaKey}:${addon.manifest.id}:${streamId}`
    const existing = this.addonFlights.get(flightKey)
    if (existing) {
      if (existing.job && priority > existing.job.priority) existing.job.priority = priority
      return existing.promise
    }
    let jobRef: QueueJob | undefined
    const promise = new Promise<AddonCacheEntry>((resolve, reject) => {
      const job: QueueJob = {
        id: flightKey, mediaKey, addonId: addon.manifest.id, priority, sequence: this.sequence++, resolve, reject,
        run: async () => {
          const controller = new AbortController()
          const timeout = window.setTimeout(() => controller.abort(), ADDON_TIMEOUT_MS)
          const started = performance.now()
          try {
            const streams = await fetchAddonStreamsStrict(addon.url, request.mediaType, streamId, controller.signal)
            const latency = Math.round(performance.now() - started)
            this.recordStats(addon.manifest.id, true, latency, streams.length)
            const ttl = safeTtl(request, streams)
            const entry = { streams, fetchedAt: Date.now(), expiresAt: Date.now() + ttl * 1000, staleUntil: Date.now() + ttl * 1000 + STALE_WINDOW_MS }
            await cacheSet(cacheKey(mediaKey, addon, streamId), entry, { category: CACHE_CATEGORIES.STREAM_PRELOAD, ttlSeconds: ttl })
            devLog(`Addon ${addon.manifest.id} completed in ${latency}ms with ${streams.length} results`)
            return entry
          } catch (error) {
            const latency = Math.round(performance.now() - started)
            this.recordStats(addon.manifest.id, false, latency, 0)
            devLog(`Addon ${addon.manifest.id} ${controller.signal.aborted ? `timed out after ${ADDON_TIMEOUT_MS}ms` : 'failed'}`)
            throw error
          } finally {
            window.clearTimeout(timeout)
          }
        },
      }
      jobRef = job
      this.queue.push(job)
      this.drain()
    }).finally(() => this.addonFlights.delete(flightKey))
    this.addonFlights.set(flightKey, { promise, job: jobRef })
    return promise
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENCY && this.queue.length) {
      this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)
      const job = this.queue.shift()!
      this.active++
      job.run().then(job.resolve, job.reject).finally(() => { this.active--; this.drain() })
    }
  }

  private promote(mediaKey: string, priority: number): void {
    for (const job of this.queue) if (job.mediaKey === mediaKey) job.priority = Math.max(job.priority, priority)
    this.drain()
  }

  private loadStats(): Record<string, AddonPerformanceStats> {
    if (typeof localStorage === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem(PERF_STORAGE_KEY) || '{}') }
    catch { return {} }
  }

  private recordStats(addonId: string, success: boolean, latency: number, count: number): void {
    const old = this.performance[addonId] || { addonId, averageLatencyMs: latency, successRate: success ? 1 : 0, averageResultCount: count, consecutiveFailures: 0, samples: 0 }
    const samples = old.samples + 1
    const next: AddonPerformanceStats = {
      ...old, samples,
      averageLatencyMs: Math.round((old.averageLatencyMs * old.samples + latency) / samples),
      successRate: (old.successRate * old.samples + (success ? 1 : 0)) / samples,
      averageResultCount: (old.averageResultCount * old.samples + count) / samples,
      consecutiveFailures: success ? 0 : old.consecutiveFailures + 1,
      ...(success ? { lastSuccessAt: Date.now() } : { lastFailureAt: Date.now() }),
    }
    this.performance[addonId] = next
    if (typeof localStorage !== 'undefined') localStorage.setItem(PERF_STORAGE_KEY, JSON.stringify(this.performance))
  }

  private addonScore(addonId: string): number {
    const stats = this.performance[addonId]
    if (!stats) return 0
    return stats.successRate * 1_000 + Math.min(stats.averageResultCount, 20) * 10 - stats.averageLatencyMs / 100 - stats.consecutiveFailures * 100
  }
}

export const streamPreloadManager = new StreamPreloadManager()
