import type { HomeRowConfig, SearchResult } from '../types'
import { getAniListList } from './anilist'
import { getCollection, getWatchlist } from './trakt/sync'
import { getListItems as getTraktListItems } from './trakt/lists'
import { getPMDBListItems, getPMDBLists, getPMDBWatchlistItems, type PMDBListItem } from './pmdb'
import { tmdbProvider } from './tmdb'

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
  const id = row.providerListId || ''
  if (row.sourceType === 'anilist') return getAniListList(id || 'CURRENT')
  if (row.sourceType === 'trakt') return getTraktProviderList(id)
  if (row.sourceType === 'pmdb') return getPmdbProviderList(id)
  return []
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
