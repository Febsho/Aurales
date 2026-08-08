export type RequestPriority = 'playback' | 'interactive' | 'visible' | 'background'
export type RequestKind = 'addon' | 'metadata'
export type RequestRetryPolicy = 'none' | 'interactive-once'

export interface CoordinatedRequestOptions {
  origin: string
  label: string
  kind: RequestKind
  dedupeKey: string
  priority: RequestPriority
  cancelGroup?: string
  timeoutMs?: number
  retry?: RequestRetryPolicy
}

export interface RequestDiagnostics {
  networkCalls: number
  cacheHits: number
  cacheMisses: number
  deduplicated: number
  cancelled: number
  rateLimited: number
  queued: number
  active: number
  recentLatencyMs: number[]
  origins: Array<{
    label: string
    calls: number
    failures: number
    consecutiveFailures: number
    cooldownUntil?: number
    averageLatencyMs: number
  }>
}

interface OriginState {
  label: string
  calls: number
  failures: number
  consecutiveFailures: number
  cooldownUntil: number
  latencyTotal: number
}

interface QueueEntry<T> {
  id: number
  options: CoordinatedRequestOptions
  groups: Set<string>
  controller: AbortController
  execute: (signal: AbortSignal) => Promise<T>
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  started: boolean
}

const PRIORITY_SCORE: Record<RequestPriority, number> = {
  playback: 4,
  interactive: 3,
  visible: 2,
  background: 1,
}

const FAILURE_COOLDOWN_MS = 2 * 60 * 1000
const MAX_RETRY_WAIT_MS = 10_000
const UNGROUPED_CONSUMER = '__request_coordinator_ungrouped__'

function abortError(message = 'Request cancelled'): DOMException {
  return new DOMException(message, 'AbortError')
}

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get('Retry-After')
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0
}

class HttpStatusError extends Error {
  readonly status: number
  readonly retryAfter: number

  constructor(status: number, retryAfter: number) {
    super(`HTTP ${status}`)
    this.status = status
    this.retryAfter = retryAfter
  }
}

class RequestCoordinator {
  private sequence = 0
  private active = 0
  private metadataActive = 0
  private playbackActive = false
  private queue: QueueEntry<unknown>[] = []
  private requests = new Map<string, QueueEntry<unknown>>()
  private groupCancellations = new Map<string, Set<(reason: DOMException) => void>>()
  private originActive = new Map<string, number>()
  private originStates = new Map<string, OriginState>()
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private diagnostics = {
    networkCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    deduplicated: 0,
    cancelled: 0,
    rateLimited: 0,
    recentLatencyMs: [] as number[],
  }

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.pump())
      window.addEventListener('focus', () => this.pump())
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => this.pump())
    }
  }

  run<T>(
    options: CoordinatedRequestOptions,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const normalized = { ...options, origin: normalizedOrigin(options.origin) }
    const requestKey = `${normalized.origin}|${normalized.dedupeKey}`
    const existing = this.requests.get(requestKey) as QueueEntry<T> | undefined
    if (existing) {
      this.diagnostics.deduplicated += 1
      existing.groups.add(normalized.cancelGroup || UNGROUPED_CONSUMER)
      if (PRIORITY_SCORE[normalized.priority] > PRIORITY_SCORE[existing.options.priority]) {
        existing.options.priority = normalized.priority
        this.sortQueue()
      }
      return this.consumerPromise(existing.promise, normalized.cancelGroup)
    }

    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((done, fail) => {
      resolve = done
      reject = fail
    })
    const entry: QueueEntry<T> = {
      id: this.sequence++,
      options: normalized,
      groups: new Set([normalized.cancelGroup || UNGROUPED_CONSUMER]),
      controller: new AbortController(),
      execute,
      promise,
      resolve,
      reject,
      started: false,
    }
    this.requests.set(requestKey, entry as QueueEntry<unknown>)
    this.queue.push(entry as QueueEntry<unknown>)
    this.sortQueue()
    this.pump()
    return this.consumerPromise(promise, normalized.cancelGroup)
  }

  cancelGroup(group: string): void {
    const reason = abortError()
    const cancellations = this.groupCancellations.get(group)
    this.groupCancellations.delete(group)
    for (const cancel of cancellations || []) cancel(reason)

    for (const entry of this.requests.values()) {
      if (!entry.groups.delete(group)) continue
      if (entry.groups.size > 0) continue
      this.diagnostics.cancelled += 1
      if (entry.started) entry.controller.abort(reason)
      else {
        this.queue = this.queue.filter((candidate) => candidate !== entry)
        this.deleteEntry(entry)
        entry.reject(reason)
      }
    }
    this.pump()
  }

  setPlaybackActive(active: boolean): void {
    this.playbackActive = active
    if (!active) this.pump()
  }

  recordCacheHit(): void {
    this.diagnostics.cacheHits += 1
  }

  recordCacheMiss(): void {
    this.diagnostics.cacheMisses += 1
  }

  recordRateLimited(): void {
    this.diagnostics.rateLimited += 1
  }

  snapshot(): RequestDiagnostics {
    return {
      ...this.diagnostics,
      recentLatencyMs: [...this.diagnostics.recentLatencyMs],
      queued: this.queue.length,
      active: this.active,
      origins: [...this.originStates.values()].map((state) => ({
        label: state.label,
        calls: state.calls,
        failures: state.failures,
        consecutiveFailures: state.consecutiveFailures,
        cooldownUntil: state.cooldownUntil || undefined,
        averageLatencyMs: state.calls ? Math.round(state.latencyTotal / state.calls) : 0,
      })),
    }
  }

  resetForTests(): void {
    for (const entry of this.requests.values()) entry.controller.abort()
    this.queue = []
    this.requests.clear()
    this.groupCancellations.clear()
    this.originActive.clear()
    this.originStates.clear()
    this.active = 0
    this.metadataActive = 0
    this.playbackActive = false
    this.diagnostics = {
      networkCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      deduplicated: 0,
      cancelled: 0,
      rateLimited: 0,
      recentLatencyMs: [],
    }
  }

  private backgroundPaused(): boolean {
    if (this.playbackActive) return true
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  private consumerPromise<T>(promise: Promise<T>, group?: string): Promise<T> {
    if (!group) return promise

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cancellations = this.groupCancellations.get(group) || new Set<(reason: DOMException) => void>()
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        cancellations.delete(cancel)
        if (cancellations.size === 0) this.groupCancellations.delete(group)
        callback()
      }
      const cancel = (reason: DOMException) => finish(() => reject(reason))
      cancellations.add(cancel)
      this.groupCancellations.set(group, cancellations)
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  private originLimit(entry: QueueEntry<unknown>): number {
    return entry.options.kind === 'addon' ? 1 : 2
  }

  private sortQueue(): void {
    this.queue.sort((a, b) =>
      PRIORITY_SCORE[b.options.priority] - PRIORITY_SCORE[a.options.priority] || a.id - b.id
    )
  }

  private pump(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
    while (true) {
      const now = Date.now()
      const index = this.queue.findIndex((entry) => {
        if (entry.options.priority === 'background' && this.backgroundPaused()) return false
        if (entry.options.kind === 'metadata' && this.metadataActive >= 4) return false
        const state = this.originStates.get(entry.options.origin)
        if (state && state.cooldownUntil > now && entry.options.priority !== 'playback') return false
        return (this.originActive.get(entry.options.origin) || 0) < this.originLimit(entry)
      })
      if (index === -1) {
        const nextCooldown = this.queue
          .map((entry) => this.originStates.get(entry.options.origin)?.cooldownUntil || 0)
          .filter((value) => value > now)
          .sort((a, b) => a - b)[0]
        if (nextCooldown) {
          this.wakeTimer = setTimeout(() => this.pump(), Math.max(1, nextCooldown - now))
        }
        return
      }
      const [entry] = this.queue.splice(index, 1)
      this.start(entry)
    }
  }

  private start(entry: QueueEntry<unknown>): void {
    entry.started = true
    this.active += 1
    if (entry.options.kind === 'metadata') this.metadataActive += 1
    this.originActive.set(entry.options.origin, (this.originActive.get(entry.options.origin) || 0) + 1)
    const state = this.originStates.get(entry.options.origin) || {
      label: entry.options.label,
      calls: 0,
      failures: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      latencyTotal: 0,
    }
    state.label = entry.options.label
    state.calls += 1
    this.originStates.set(entry.options.origin, state)
    this.diagnostics.networkCalls += 1
    const startedAt = performance.now()
    const timeout = setTimeout(
      () => entry.controller.abort(abortError('Request timed out')),
      entry.options.timeoutMs ?? 15_000,
    )

    entry.execute(entry.controller.signal)
      .then((value) => {
        state.consecutiveFailures = 0
        state.cooldownUntil = 0
        entry.resolve(value)
      })
      .catch((error) => {
        if (!isAbort(error)) {
          state.failures += 1
          state.consecutiveFailures += 1
          if (error instanceof HttpStatusError && error.status === 429 && error.retryAfter > 0) {
            state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + error.retryAfter)
          }
          if (state.consecutiveFailures >= 3) state.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        }
        entry.reject(error)
      })
      .finally(() => {
        clearTimeout(timeout)
        const latency = Math.max(0, Math.round(performance.now() - startedAt))
        state.latencyTotal += latency
        this.diagnostics.recentLatencyMs.push(latency)
        if (this.diagnostics.recentLatencyMs.length > 20) this.diagnostics.recentLatencyMs.shift()
        this.active -= 1
        if (entry.options.kind === 'metadata') this.metadataActive -= 1
        this.originActive.set(entry.options.origin, Math.max(0, (this.originActive.get(entry.options.origin) || 1) - 1))
        this.deleteEntry(entry)
        this.pump()
      })
  }

  private deleteEntry(entry: QueueEntry<unknown>): void {
    this.requests.delete(`${entry.options.origin}|${entry.options.dedupeKey}`)
  }
}

export const requestCoordinator = new RequestCoordinator()

export function cancelRequestGroup(group: string): void {
  requestCoordinator.cancelGroup(group)
}

export function setRequestPlaybackActive(active: boolean): void {
  requestCoordinator.setPlaybackActive(active)
}

export function requestDiagnostics(): RequestDiagnostics {
  return requestCoordinator.snapshot()
}

export async function coordinatedJson<T>(
  url: string,
  init: RequestInit,
  options: Omit<CoordinatedRequestOptions, 'origin'> & { origin?: string },
): Promise<T> {
  const origin = normalizedOrigin(options.origin || url)
  const dedupeKey = `${options.dedupeKey}|url:${url}`
  return requestCoordinator.run({ ...options, origin, dedupeKey }, async (signal) => {
    const maxAttempts = options.retry === 'interactive-once'
      && (options.priority === 'interactive' || options.priority === 'playback')
      ? 2
      : 1
    let lastError: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, { ...init, signal })
        if (response.ok) return await response.json() as T
        const waitMs = response.status === 429 ? retryAfterMs(response) : 0
        if (response.status === 429) requestCoordinator.recordRateLimited()
        const retryable = response.status === 429 || response.status >= 500
        if (!retryable || attempt + 1 >= maxAttempts) throw new HttpStatusError(response.status, waitMs)
        const delay = waitMs || 250 + Math.round(Math.random() * 250)
        if (delay > MAX_RETRY_WAIT_MS) throw new HttpStatusError(response.status, delay)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason || abortError())
          }, { once: true })
        })
      } catch (error) {
        lastError = error
        if (isAbort(error) || error instanceof HttpStatusError || attempt + 1 >= maxAttempts) throw error
        await new Promise((resolve) => setTimeout(resolve, 250 + Math.round(Math.random() * 250)))
      }
    }
    throw lastError
  })
}
