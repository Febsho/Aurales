const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)])
  )
  return value
}

export function stableCacheInput(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function catalogCacheKey(input: {
  scope: 'home' | 'discover' | 'provider' | 'watchlist' | 'catalog' | 'cards'
  id: string
  mediaType?: string
  region?: string
  language?: string
  provider?: string
  accountId?: string
  filters?: unknown
  source?: string
  version?: number
}): string {
  return `catalog:v${input.version ?? 1}:${input.scope}:${stableCacheInput(input)}`
}

