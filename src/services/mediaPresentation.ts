import type { SearchResult } from '../types'

export type CardArtworkKind = 'poster' | 'landscape'
export type PosterDisplaySize = 'compact' | 'default' | 'large' | 'huge'

export function mediaIdentity(item: Pick<SearchResult, 'type' | 'provider' | 'id'>): string {
  return `${item.type}:${item.provider.trim().toLowerCase()}:${item.id}`
}

export function dedupeMediaItems(items: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = mediaIdentity(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function tmdbCardWidth(kind: CardArtworkKind, posterSize: PosterDisplaySize): string {
  if (kind === 'landscape') return 'w780'
  if (posterSize === 'compact') return 'w185'
  if (posterSize === 'huge') return 'w500'
  return 'w342'
}

/**
 * Downsizes only TMDB CDN artwork. Other providers may sign or transform their
 * URLs, so those URLs must remain byte-for-byte unchanged.
 */
export function cardArtworkUrl(
  url: string | undefined,
  kind: CardArtworkKind,
  posterSize: PosterDisplaySize = 'default',
): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'image.tmdb.org') return url
    parsed.pathname = parsed.pathname.replace(
      /\/t\/p\/(?:original|w\d+)\//,
      `/t/p/${tmdbCardWidth(kind, posterSize)}/`,
    )
    return parsed.toString()
  } catch {
    return url
  }
}
