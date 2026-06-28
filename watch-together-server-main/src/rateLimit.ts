interface RateBucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, RateBucket>()

export function checkRateLimit(key: string, maxPerMinute: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }

  if (bucket.count >= maxPerMinute) return false
  bucket.count++
  return true
}

export function cleanupRateLimits(): void {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key)
  }
}
