import type { SearchResult } from '../types'
import { getServerEpisodes, searchServerCatalogs } from './serverIntegrations'

export interface PosterEpisodeSummary {
  watched: number
  total: number
  nextEpisode?: string
}

const CACHE_TTL_MS = 15 * 60_000
const MAX_CACHE_ENTRIES = 500
const MAX_CONCURRENT_REQUESTS = 2
const cache = new Map<string, { summary: PosterEpisodeSummary; expiresAt: number }>()
const pending = new Map<string, Promise<PosterEpisodeSummary | undefined>>()
const catalogSearchCache = new Map<string, { items: SearchResult[]; expiresAt: number }>()
const catalogSearchPending = new Map<string, Promise<SearchResult[]>>()
const catalogSearchQueue: Array<() => void> = []
let activeCatalogSearches = 0
const requestQueue: Array<() => void> = []
let activeRequests = 0
let cacheRevision = 0

function invalidatePosterEpisodeSummaries(): void {
  cacheRevision += 1
  cache.clear()
  pending.clear()
  catalogSearchCache.clear()
  catalogSearchPending.clear()
}

if (typeof window !== 'undefined') window.addEventListener('aurales:server-catalogs-changed', invalidatePosterEpisodeSummaries)

/** Episode totals and watched counts from the user's own Jellyfin library. */
export function getJellyfinPosterEpisodeSummary(connectionId: string, seriesId: string): Promise<PosterEpisodeSummary | undefined> {
  const key = `${connectionId}:${seriesId}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.summary)
  const current = pending.get(key)
  if (current) return current

  const load = async (): Promise<PosterEpisodeSummary | undefined> => {
    const requestRevision = cacheRevision
    const episodes = await getServerEpisodes(connectionId, seriesId)
    if (!episodes.length) return undefined
    const uniqueEpisodes = new Map(episodes.map((episode) => [episode.sourceItemId, episode]))
    // Season zero contains specials. Keep those out of the regular episode
    // count and next-episode hint so the poster agrees with Trakt/AniList.
    const orderedEpisodes = [...uniqueEpisodes.values()]
      .filter((episode) => Number(episode.raw.ParentIndexNumber) > 0 && Number(episode.raw.IndexNumber) > 0)
      .sort((left, right) =>
        Number(left.raw.ParentIndexNumber) - Number(right.raw.ParentIndexNumber)
        || Number(left.raw.IndexNumber) - Number(right.raw.IndexNumber))
    const nextUnplayed = orderedEpisodes.find((episode) => {
      const userData = episode.raw.UserData
      return !(userData && typeof userData === 'object' && (userData as Record<string, unknown>).Played === true)
    })
    const nextSeason = Number(nextUnplayed?.raw.ParentIndexNumber)
    const nextNumber = Number(nextUnplayed?.raw.IndexNumber)
    const summary = {
      total: orderedEpisodes.length,
      watched: orderedEpisodes.filter((episode) => {
        const userData = episode.raw.UserData
        return Boolean(userData && typeof userData === 'object' && (userData as Record<string, unknown>).Played === true)
      }).length,
      ...(nextUnplayed && Number.isFinite(nextSeason) && Number.isFinite(nextNumber) && nextSeason > 0 && nextNumber > 0
        ? { nextEpisode: `S${nextSeason}E${nextNumber}` } : {}),
    }
    if (requestRevision === cacheRevision) {
      cache.set(key, { summary, expiresAt: Date.now() + CACHE_TTL_MS })
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    }
    return summary
  }
  let request: Promise<PosterEpisodeSummary | undefined>
  request = new Promise<PosterEpisodeSummary | undefined>((resolve) => {
    const run = () => {
      activeRequests += 1
      void load().then(resolve, () => resolve(undefined)).finally(() => {
        activeRequests -= 1
        requestQueue.shift()?.()
      })
    }
    if (activeRequests < MAX_CONCURRENT_REQUESTS) run()
    else requestQueue.push(run)
  }).finally(() => {
    if (pending.get(key) === request) pending.delete(key)
  })
  pending.set(key, request)
  return request
}

function normalizedTitle(value: string | undefined): string {
  return (value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim()
}

function matchingServerSeries(media: SearchResult, candidates: SearchResult[]): SearchResult | undefined {
  const identities = ['tmdbId', 'imdbId', 'tvdbId'] as const
  const mediaIds = identities.map((key) => [key, media[key] == null ? '' : String(media[key]).toLocaleLowerCase()] as const)
    .filter((entry) => entry[1])
  const title = normalizedTitle(media.title)
  const series = candidates.filter((candidate) => candidate.provider === 'jellyfin' && candidate.type === 'series')

  const byId = series.find((candidate) => mediaIds.some(([key, value]) => {
    const candidateId = candidate[key] == null ? '' : String(candidate[key]).toLocaleLowerCase()
    return candidateId !== '' && candidateId === value
  }))
  if (byId) return byId
  if (!title) return undefined

  const exactTitle = series.filter((candidate) => normalizedTitle(candidate.title) === title
    || normalizedTitle(candidate.originalTitle) === title)
  const compatibleTitle = exactTitle.filter((candidate) => {
    const hasConflictingId = mediaIds.some(([key, value]) => {
      const candidateId = candidate[key] == null ? '' : String(candidate[key]).toLocaleLowerCase()
      return candidateId !== '' && candidateId !== value
    })
    if (hasConflictingId) return false
    if (media.year != null) return candidate.year === media.year
    return candidate.year == null
  })
  return compatibleTitle.length === 1 ? compatibleTitle[0] : undefined
}

async function searchServerCatalogsCached(title: string): Promise<SearchResult[]> {
  const key = normalizedTitle(title)
  if (!key) return []
  const cached = catalogSearchCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.items
  const existing = catalogSearchPending.get(key)
  if (existing) return existing
  const requestRevision = cacheRevision
  let request: Promise<SearchResult[]>
  request = new Promise<SearchResult[]>((resolve) => {
    const run = () => {
      activeCatalogSearches += 1
      void searchServerCatalogs(title).catch(() => []).then(resolve).finally(() => {
        activeCatalogSearches -= 1
        catalogSearchQueue.shift()?.()
      })
    }
    if (activeCatalogSearches < MAX_CONCURRENT_REQUESTS) run()
    else catalogSearchQueue.push(run)
  }).then((items) => {
    if (requestRevision === cacheRevision) {
      catalogSearchCache.set(key, { items, expiresAt: Date.now() + CACHE_TTL_MS })
      while (catalogSearchCache.size > MAX_CACHE_ENTRIES) catalogSearchCache.delete(catalogSearchCache.keys().next().value!)
    }
    return items
  }).finally(() => {
    if (catalogSearchPending.get(key) === request) catalogSearchPending.delete(key)
  })
  catalogSearchPending.set(key, request)
  return request
}

/** Resolve a series poster to the user's Jellyfin library, even when the card came from TMDB or another catalog. */
export async function getJellyfinPosterEpisodeSummaryForMedia(media: SearchResult): Promise<PosterEpisodeSummary | undefined> {
  if (media.type !== 'series') return undefined
  if (media.provider === 'jellyfin' && media.sourceConnectionId && media.sourceItemId) {
    return getJellyfinPosterEpisodeSummary(media.sourceConnectionId, media.sourceItemId)
  }
  const match = matchingServerSeries(media, await searchServerCatalogsCached(media.title))
  if (!match?.sourceConnectionId || !match.sourceItemId) return undefined
  return getJellyfinPosterEpisodeSummary(match.sourceConnectionId, match.sourceItemId)
}
