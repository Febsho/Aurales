import type { HomeRowConfig, SearchResult } from '../types'
import { getAniListList, getStoredAniListAccount } from './anilist'
import { getCollection, getWatchlist } from './trakt/sync'
import { getListItems as getTraktListItems, getPublicListItems as getTraktPublicListItems, searchTraktPopularLists } from './trakt/lists'
import {
  getPMDBListItems,
  getPMDBLists,
  getPMDBPickCatalogs,
  getPMDBPickItems,
  getPMDBWatchlistItems,
  type PMDBListItem,
  type PMDBPickItem,
} from './pmdb'
import {
  getMdblistListItems,
  getMdblistUserLists,
  getMdblistWatchlistItems,
  searchMdblistPublicLists,
} from './mdblist'
import { getTvdbIdFromTmdb, getTmdbCardMetadata, tmdbProvider } from './tmdb'
import { getTvdbCardMetadata } from './tvdb'
import { resolveAnimeIds } from './animeLists'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'

function providerListCacheKey(row: Pick<HomeRowConfig, 'sourceType' | 'providerListId'>): string {
  const account = row.sourceType === 'anilist' ? getStoredAniListAccount()?.id || 'anonymous' : ''
  return `provider:${row.sourceType || 'unknown'}:${account}:${row.providerListId || ''}`
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

export const MDBLIST_LIST_SOURCES = [
  { id: 'watchlist', label: 'MDBList - Watchlist', layout: 'poster' as const },
]

export async function getProviderListItems(row: Pick<HomeRowConfig, 'sourceType' | 'providerListId'>): Promise<SearchResult[]> {
  const key = providerListCacheKey(row)
  return cachedFetch<SearchResult[]>(key, () => loadProviderListItems(row), {
    category: CACHE_CATEGORIES.PROVIDER_LIST,
    ttlSeconds: CACHE_TTLS.PROVIDER_LIST,
  })
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
  } else if (row.sourceType === 'mdblist') {
    items = await getMdblistProviderList(id)
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
      return canonicalizeCatalogItemsWithTvdb(deduplicated, { preservePictures: false })
    }

    const { enrichSearchResultsWithAppMetadata } = await import('./metadata/metadataResolver')
    const enriched = await enrichSearchResultsWithAppMetadata(items)
    return canonicalizeCatalogItemsWithTvdb(enriched)
  }
  return []
}

export async function canonicalizeCatalogItemsWithTvdb(
  items: SearchResult[],
  options?: { preservePictures?: boolean }
): Promise<SearchResult[]> {
  const results = [...items]
  let cursor = 0
  const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item.type !== 'series') continue

      let tvdbId = item.tvdbId ? Number(String(item.tvdbId).replace('tvdb-', '')) || undefined : undefined
      let resolvedTmdbId = item.tmdbId ? Number(item.tmdbId) : undefined
      if (!tvdbId && (item.anilistId || item.malId)) {
        const anime = await resolveAnimeIds({
          anilistId: item.anilistId ? Number(item.anilistId) : undefined,
          malId: item.malId ? Number(item.malId) : undefined,
          tmdbId: resolvedTmdbId,
          imdbId: item.imdbId,
        }).catch(() => null)
        tvdbId = anime?.tvdbId
        if (anime?.tmdbId) resolvedTmdbId = anime.tmdbId
      }
      if (!tvdbId && resolvedTmdbId) tvdbId = await getTvdbIdFromTmdb(resolvedTmdbId)

      if (tvdbId) {
        const tvdb = await getTvdbCardMetadata(tvdbId)
        let poster = options?.preservePictures ? item.poster : (tvdb?.poster || item.poster)
        let backdrop = options?.preservePictures ? item.backdrop : (tvdb?.backdrop || item.backdrop)
        if (!options?.preservePictures && resolvedTmdbId && (!poster || poster === item.poster)) {
          const tmdb = await getTmdbCardMetadata('series', resolvedTmdbId).catch(() => null)
          if (tmdb?.poster) poster = tmdb.poster
          if (tmdb?.backdrop && !backdrop) backdrop = tmdb.backdrop
        }
        results[index] = {
          ...item,
          id: `tvdb-${tvdbId}`,
          title: tvdb?.title || item.title,
          year: tvdb?.year || item.year,
          overview: tvdb?.overview || item.overview,
          poster,
          backdrop,
          genres: tvdb?.genres?.length ? tvdb.genres : item.genres,
          provider: 'tvdb',
          tvdbId,
        }
      } else if (resolvedTmdbId && !options?.preservePictures) {
        const tmdb = await getTmdbCardMetadata('series', resolvedTmdbId).catch(() => null)
        if (tmdb?.poster || tmdb?.backdrop) {
          results[index] = {
            ...item,
            poster: tmdb.poster || item.poster,
            backdrop: tmdb.backdrop || item.backdrop,
            tmdbId: resolvedTmdbId,
          }
        }
      }
    }
  })
  await Promise.all(workers)

  // Deduplicate multi-season anime that resolved to the same TVDB/TMDB series
  const seen = new Set<string>()
  return results.filter((item) => {
    if (item.tvdbId) {
      const key = `tvdb:${String(item.tvdbId).replace('tvdb-', '')}`
      if (seen.has(key)) return false
      seen.add(key)
    }
    if (item.tmdbId) {
      const key = `tmdb:${String(item.tmdbId).replace('tmdb-', '')}`
      if (seen.has(key)) return false
      seen.add(key)
    }
    return true
  })
}

export async function getAvailableTraktListSources(): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  try {
    const { getUserLists } = await import('./trakt/lists')
    const lists = await getUserLists()
    return [
      ...TRAKT_LIST_SOURCES,
      ...lists.map((list) => ({ id: `list:${list.ids.slug}`, label: `Trakt - ${list.name}`, layout: 'poster' as const })),
    ]
  } catch (_) {
    return TRAKT_LIST_SOURCES
  }
}

export async function searchTraktPublicListSources(query: string): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  const results = await searchTraktPopularLists(query)
  return results.map((list) => ({
    id: `public:${list.user.ids.slug}:${list.ids.slug}`,
    label: list.name,
    layout: 'poster' as const,
  }))
}

export async function getAvailablePmdbListSources(): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  try {
    const lists = await getPMDBLists()
    return [
      ...PMDB_LIST_SOURCES,
      ...lists.map((list) => ({ id: `list:${list.id}`, label: `PMDB - ${list.name}`, layout: 'poster' as const })),
    ]
  } catch (_) {
    return PMDB_LIST_SOURCES
  }
}

export async function getAvailablePmdbPickSources(): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  const catalogs = await getPMDBPickCatalogs()
  return catalogs.map((catalog) => ({ id: catalog.id, label: catalog.name, layout: 'poster' as const }))
}

export async function getAvailableMdblistSources(search = ''): Promise<{ id: string; label: string; layout: 'poster' | 'landscape' }[]> {
  const [owned, publicLists] = await Promise.all([
    getMdblistUserLists().catch(() => []),
    search.trim() ? searchMdblistPublicLists(search).catch(() => []) : Promise.resolve([]),
  ])
  const mediatypeSuffix = (mt?: string) => mt ? ` (${mt === 'movie' ? 'Movies' : mt === 'show' ? 'Shows' : mt})` : ''
  return [
    ...MDBLIST_LIST_SOURCES,
    ...owned.map((list) => ({
      id: `list:${list.id}`,
      label: `MDBList - ${list.name}${mediatypeSuffix(list.mediatype)}`,
      layout: 'poster' as const,
    })),
    ...publicLists.map((list) => ({
      id: `list:${list.id}`,
      label: `MDBList - ${list.name}${mediatypeSuffix(list.mediatype)}`,
      layout: 'poster' as const,
    })),
  ]
}

async function getTraktProviderList(id: string): Promise<SearchResult[]> {
  let raw: unknown[] = []
  if (id === 'watchlist-movies') raw = await getWatchlist('movies')
  else if (id === 'watchlist-shows') raw = await getWatchlist('shows')
  else if (id === 'collection-movies') raw = await getCollection('movies')
  else if (id === 'collection-shows') raw = await getCollection('shows')
  else if (id.startsWith('public:')) {
    const parts = id.slice(7).split(':')
    raw = await getTraktPublicListItems(parts[0], parts.slice(1).join(':'))
  }
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

async function getMdblistProviderList(id: string): Promise<SearchResult[]> {
  return id.startsWith('list:')
    ? getMdblistListItems(id.slice(5))
    : getMdblistWatchlistItems()
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
  } catch (_) {
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
    backdrop: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : undefined,
    overview: item.overview,
    rating: item.vote_average,
    genreIds: item.genre_ids,
    provider: 'pmdb',
    tmdbId: item.tmdb_id,
  }
}
