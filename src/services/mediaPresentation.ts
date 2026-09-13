import type { SearchResult } from '../types'

export type CardArtworkKind = 'poster' | 'landscape'
export type PosterDisplaySize = 'compact' | 'default' | 'large' | 'huge'

type MediaIdentityInput = Pick<SearchResult, 'type' | 'provider' | 'id'> & Partial<Pick<
  SearchResult,
  'title' | 'year' | 'imdbId' | 'tmdbId' | 'tvdbId' | 'anilistId' | 'malId'
>>

function cleanProviderId(value: string | number | undefined, prefix: string): string | undefined {
  if (value == null) return undefined
  const cleaned = String(value).trim().replace(new RegExp(`^${prefix}[-:]`, 'i'), '')
  return cleaned || undefined
}

/**
 * Cross-provider identity used when catalogs are merged. External metadata IDs
 * deliberately win over the source-local ID so the same title supplied by a
 * server, an addon, and TMDB occupies one card and one detail route.
 */
export function mediaIdentity(item: MediaIdentityInput): string {
  const imdbId = cleanProviderId(item.imdbId, 'imdb')
  if (imdbId) return `${item.type}:imdb:${imdbId.toLowerCase()}`
  const tmdbId = cleanProviderId(item.tmdbId, 'tmdb')
  if (tmdbId) return `${item.type}:tmdb:${tmdbId}`
  const tvdbId = cleanProviderId(item.tvdbId, 'tvdb')
  if (tvdbId) return `${item.type}:tvdb:${tvdbId}`
  const anilistId = cleanProviderId(item.anilistId, 'anilist')
  if (anilistId) return `${item.type}:anilist:${anilistId}`
  const malId = cleanProviderId(item.malId, 'mal')
  if (malId) return `${item.type}:mal:${malId}`
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
