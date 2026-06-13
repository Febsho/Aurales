import type { HomeRowConfig, SearchResult } from '../types'
import { getAniListList, getStoredAniListAccount } from './anilist'
import { getCollection, getWatchlist } from './trakt/sync'
import { getListItems as getTraktListItems } from './trakt/lists'
import {
  getPMDBListItems,
  getPMDBLists,
  getPMDBPickCatalogs,
  getPMDBPickItems,
  getPMDBWatchlistItems,
  type PMDBListItem,
  type PMDBPickItem,
} from './pmdb'
import { getTvdbIdFromTmdb, tmdbProvider } from './tmdb'
import { getTvdbCardMetadata } from './tvdb'
import { resolveAnimeIds } from './animeLists'

const PROVIDER_LIST_CACHE_TTL = 15 * 60 * 1000
const providerListCache = new Map<string, { items: SearchResult[]; timestamp: number }>()
const providerListPending = new Map<string, Promise<SearchResult[]>>()

function providerListCacheKey(row: Pick<HomeRowConfig, 'sourceType' | 'providerListId'>): string {
  const account = row.sourceType === 'anilist' ? getStoredAniListAccount()?.id || 'anonymous' : ''
  return `tvdb-v1:${row.sourceType || 'unknown'}:${account}:${row.providerListId || ''}`
}

function readPersistentProviderList(key: string): { items: SearchResult[]; timestamp: number } | null {
  if (!key.includes(':anilist:')) return null
  try {
    const cached = JSON.parse(localStorage.getItem(`orynt_provider_list:${key}`) || 'null')
    if (cached && Array.isArray(cached.items) && Date.now() - Number(cached.timestamp) < PROVIDER_LIST_CACHE_TTL) return cached
  } catch { /* ignore invalid cache */ }
  return null
}

function cacheProviderList(key: string, items: SearchResult[]): SearchResult[] {
  const entry = { items, timestamp: Date.now() }
  providerListCache.set(key, entry)
  if (key.includes(':anilist:')) {
    try { localStorage.setItem(`orynt_provider_list:${key}`, JSON.stringify(entry)) } catch { /* memory cache remains available */ }
  }
  return items
}

export const TRAKT_LIST_SOURCES = [
  { id: 'watchlist-movies', label: 'Trakt - Movie Watchlist', layout: 'poster' as const },
  { id: 'watchlist-shows', label: 'Trakt - Show Watchlist', layout: 'poster' as const },
  { id: 'collection-movies', label: 'Trakt - Movie Collection', layout: 'poster' as const },
  { id: 'collection-shows', label: 'Trakt - Show Collection', layout: 'poster' as const },
]

export const PMDB_LIST_SOURCES = [
  { id: 'watchlist', label: 'PMDB - Watchlist', layout: 'poster' as const },
]

export async function getProviderListItems(row: Pick<HomeRowConfig, 'sourceType' | 'providerListId'>): Promise<SearchResult[]> {
  const key = providerListCacheKey(row)
  const memoryCached = providerListCache.get(key)
  if (memoryCached && Date.now() - memoryCached.timestamp < PROVIDER_LIST_CACHE_TTL) return memoryCached.items
  const persistentCached = readPersistentProviderList(key)
  if (persistentCached) {
    providerListCache.set(key, persistentCached)
    return persistentCached.items
  }
  const existing = providerListPending.get(key)
  if (existing) return existing

  const request = loadProviderListItems(row).finally(() => providerListPending.delete(key))
  providerListPending.set(key, request)
  return request
}

async function loadProviderListItems(row: Pick<HomeRowConfig, 'sourceType' | 'providerListId'>): Promise<SearchResult[]> {
  const id = row.providerListId || ''
  let items: SearchResult[] = []
  if (row.sourceType === 'anilist') {
    items = await getAniListList(id || 'CURRENT')
  } else if (row.sourceType === 'trakt') {
    items = await getTraktProviderList(id)
  } else if (row.sourceType === 'pmdb') {
    items = await getPmdbProviderList(id)
  } else if (row.sourceType === 'pmdb-picks') {
    items = (await getPMDBPickItems(id)).map(pmdbPickItemToSearchResult)
  }

  if (items.length > 0) {
    if (row.sourceType === 'anilist') {
      const seenAnilistId = new Set<number>()
      const deduplicated = items.filter((item) => {
        const aid = item.anilistId ? Number(item.anilistId) : 0
        if (aid && seenAnilistId.has(aid)) return false
        if (aid) seenAnilistId.add(aid)
        return true
      })
      const canonical = await canonicalizeCatalogItemsWithTvdb(deduplicated)
      return cacheProviderList(providerListCacheKey(row), canonical)
    }

    const { enrichSearchResultsWithAppMetadata } = await import('./metadata/metadataResolver')
    const enriched = await enrichSearchResultsWithAppMetadata(items)
    const canonical = await canonicalizeCatalogItemsWithTvdb(enriched)
    return cacheProviderList(providerListCacheKey(row), canonical)
  }
  return []
}

export async function canonicalizeCatalogItemsWithTvdb(items: SearchResult[]): Promise<SearchResult[]> {
  const results = [...items]
  let cursor = 0
  const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item.type !== 'series') continue

      let tvdbId = item.tvdbId ? Number(String(item.tvdbId).replace('tvdb-', '')) || undefined : undefined
      if (!tvdbId && (item.anilistId || item.malId)) {
        const anime = await resolveAnimeIds({
          anilistId: item.anilistId ? Number(item.anilistId) : undefined,
          malId: item.malId ? Number(item.malId) : undefined,
          tmdbId: item.tmdbId ? Number(item.tmdbId) : undefined,
          imdbId: item.imdbId,
        }).catch(() => null)
        tvdbId = anime?.tvdbId
      }
      if (!tvdbId && item.tmdbId) tvdbId = await getTvdbIdFromTmdb(item.tmdbId)
      if (!tvdbId) continue

      const tvdb = await getTvdbCardMetadata(tvdbId)
      results[index] = {
        ...item,
        id: `tvdb-${tvdbId}`,
        title: tvdb?.title || item.title,
        year: tvdb?.year || item.year,
        overview: tvdb?.overview || item.overview,
        poster: tvdb?.poster || item.poster,
        backdrop: tvdb?.backdrop || item.backdrop,
        genres: tvdb?.genres?.length ? tvdb.genres : item.genres,
        provider: 'tvdb',
        tvdbId,
      }
    }
  })
  await Promise.all(workers)
  return results
}

export async function getAvailableTraktListSources(): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  try {
    const { getUserLists } = await import('./trakt/lists')
    const lists = await getUserLists()
    return [
      ...TRAKT_LIST_SOURCES,
      ...lists.map((list) => ({ id: `list:${list.ids.slug}`, label: `Trakt - ${list.name}`, layout: 'poster' as const })),
    ]
  } catch {
    return TRAKT_LIST_SOURCES
  }
}

export async function getAvailablePmdbListSources(): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  try {
    const lists = await getPMDBLists()
    return [
      ...PMDB_LIST_SOURCES,
      ...lists.map((list) => ({ id: `list:${list.id}`, label: `PMDB - ${list.name}`, layout: 'poster' as const })),
    ]
  } catch {
    return PMDB_LIST_SOURCES
  }
}

export async function getAvailablePmdbPickSources(): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  const catalogs = await getPMDBPickCatalogs()
  return catalogs.map((catalog) => ({ id: catalog.id, label: catalog.name, layout: 'poster' as const }))
}

async function getTraktProviderList(id: string): Promise<SearchResult[]> {
  let raw: unknown[] = []
  if (id === 'watchlist-movies') raw = await getWatchlist('movies')
  else if (id === 'watchlist-shows') raw = await getWatchlist('shows')
  else if (id === 'collection-movies') raw = await getCollection('movies')
  else if (id === 'collection-shows') raw = await getCollection('shows')
  else if (id.startsWith('list:')) raw = await getTraktListItems(id.slice(5))
  return raw.map(traktItemToSearchResult).filter((item): item is SearchResult => item !== null)
}

async function getPmdbProviderList(id: string): Promise<SearchResult[]> {
  const raw = id.startsWith('list:')
    ? await getPMDBListItems(id.slice(5))
    : await getPMDBWatchlistItems()
  const items = await Promise.all(raw.map(pmdbItemToSearchResult))
  return items.filter((item): item is SearchResult => item !== null)
}

function traktItemToSearchResult(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as any
  const movie = item.movie
  const show = item.show
  const media = movie || show
  if (!media) return null
  const ids = media.ids || {}
  const type = movie ? 'movie' : 'series'
  return {
    id: ids.imdb || (ids.tmdb ? `tmdb-${ids.tmdb}` : `trakt-${ids.trakt || media.title}`),
    title: media.title || 'Untitled',
    type,
    year: media.year,
    poster: undefined,
    provider: 'trakt',
    imdbId: ids.imdb,
    tmdbId: ids.tmdb,
    tvdbId: ids.tvdb,
  }
}

async function pmdbItemToSearchResult(item: PMDBListItem): Promise<SearchResult | null> {
  try {
    if (item.media_type === 'movie') {
      const meta = await tmdbProvider.getMovie(`tmdb-${item.tmdb_id}`)
      return { ...meta, id: meta.imdbId || `tmdb-${item.tmdb_id}`, provider: 'pmdb', type: 'movie', tmdbId: item.tmdb_id }
    }
    const meta = await tmdbProvider.getShow(`tmdb-${item.tmdb_id}`)
    return { ...meta, id: meta.imdbId || `tmdb-${item.tmdb_id}`, provider: 'pmdb', type: 'series', tmdbId: item.tmdb_id }
  } catch {
    return {
      id: `tmdb-${item.tmdb_id}`,
      title: `${item.media_type === 'movie' ? 'Movie' : 'Show'} ${item.tmdb_id}`,
      type: item.media_type === 'movie' ? 'movie' : 'series',
      provider: 'pmdb',
      tmdbId: item.tmdb_id,
    }
  }
}

function pmdbPickItemToSearchResult(item: PMDBPickItem): SearchResult {
  const type = item.media_type === 'movie' ? 'movie' : 'series'
  return {
    id: `tmdb-${item.tmdb_id}`,
    title: item.title || `${type === 'movie' ? 'Movie' : 'Show'} ${item.tmdb_id}`,
    type,
    year: item.year ? Number(item.year) || undefined : undefined,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : undefined,
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : undefined,
    overview: item.overview,
    rating: item.vote_average,
    genreIds: item.genre_ids,
    provider: 'pmdb',
    tmdbId: item.tmdb_id,
  }
}
