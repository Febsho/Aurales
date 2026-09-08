type MetricName = string

const enabled = import.meta.env.DEV
const marks = new Map<string, number>()
let detailProviderRequests = 0

/** Detail-page providers call this only when starting a real request, not on a cache or in-flight hit. */
export function resetDetailProviderRequestCount(): void { detailProviderRequests = 0 }
export function recordDetailProviderRequest(): void { detailProviderRequests++ }
export function detailProviderRequestCount(): number { return detailProviderRequests }

export function markPerformance(name: string): void {
  if (!enabled || typeof performance === 'undefined') return
  marks.set(name, performance.now())
  performance.mark(`aurales:${name}`)
}

export function measurePerformance(name: MetricName, from: string, to: string): number | null {
  if (!enabled) return null
  const start = marks.get(from)
  const end = marks.get(to)
  if (start == null || end == null) return null
  const duration = Math.round(end - start)
  performance.measure(`aurales:${name}`, `aurales:${from}`, `aurales:${to}`)
  console.debug(`[PERF] ${name} ${duration}ms`)
  return duration
}

/** Exposed only in development for a quick manual performance snapshot. */
export function performanceSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = {}
  for (const entry of performance.getEntriesByType('measure')) {
    if (entry.name.startsWith('aurales:')) snapshot[entry.name.slice(8)] = Math.round(entry.duration)
  }
  return snapshot
}
