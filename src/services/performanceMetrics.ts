type MetricName = string

const enabled = import.meta.env.DEV
const marks = new Map<string, number>()
const MAX_TRACKED_MARKS = 256
const MAX_TRACKED_MEASURES = 64
let detailProviderRequests = 0

/** Detail-page providers call this only when starting a real request, not on a cache or in-flight hit. */
export function resetDetailProviderRequestCount(): void { detailProviderRequests = 0 }
export function recordDetailProviderRequest(): void { detailProviderRequests++ }
export function detailProviderRequestCount(): number { return detailProviderRequests }

export function markPerformance(name: string): void {
  if (!enabled || typeof performance === 'undefined') return
  marks.delete(name)
  marks.set(name, performance.now())
  performance.clearMarks(`aurales:${name}`)
  performance.mark(`aurales:${name}`)
  while (marks.size > MAX_TRACKED_MARKS) {
    const oldest = marks.keys().next().value
    if (oldest === undefined) break
    marks.delete(oldest)
    performance.clearMarks(`aurales:${oldest}`)
  }
}

export function measurePerformance(name: MetricName, from: string, to: string): number | null {
  if (!enabled) return null
  const start = marks.get(from)
  const end = marks.get(to)
  if (start == null || end == null) return null
  const duration = Math.round(end - start)
  const measureName = `aurales:${name}`
  performance.clearMeasures(measureName)
  // Numeric endpoints let old route marks be evicted without invalidating a
  // measurement that still needs their timestamps.
  performance.measure(measureName, { start, end })
  const measures = performance.getEntriesByType('measure')
  if (measures.length > MAX_TRACKED_MEASURES) {
    for (const entry of measures.slice(0, measures.length - MAX_TRACKED_MEASURES)) {
      performance.clearMeasures(entry.name)
    }
  }
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
