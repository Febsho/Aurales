import { useState, useEffect, useRef, useCallback, cloneElement } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import ErrorBoundary from '../components/ui/ErrorBoundary'
import { EmptyState } from '../components/ui'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import ContinueWatchingRow from '../components/ContinueWatchingRow'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import {
  getSimklWatchStatusList,
  getSimklDerivedCatalogItems,
  isSimklDerivedCatalogId,
} from '../services/simkl/lists'
import { getSimklWatchedMovies } from '../services/simkl/history'
import type { SearchResult, HomeRowConfig } from '../types'
import type { SimklWatchlistItem } from '../services/simkl/types'
import { discoverTmdbWithCache } from '../services/tmdb'
import { canonicalizeCatalogItemsWithTvdb, getProviderListItems } from '../services/providerLists'
import { cachedFetch, cacheClearExpired, cacheGetMany } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../services/cache/constants'
import {
  simklRowCacheKey,
  providerRowCacheKey,
  addonRowCacheKey,
  discoverRowCacheKey,
  heroRowCacheKey,
  homeRowCacheKey,
} from '../services/cache/homeRowCacheKeys'
import { taskQueue } from '../services/cache/backgroundTaskQueue'
import { useHomeCatalogCache } from '../stores/homeCatalogCache'
import { useGlobalBackdrop } from '../hooks/useGlobalBackdrop'

// Drag & Drop imports for Edit Mode
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const SIMKL_LIST_SOURCES = [
  { id: 'watchlist',          label: 'Simkl — Plan to Watch (All)',       type: 'poster' },
  { id: 'watching',           label: 'Simkl — Currently Watching (All)',  type: 'landscape' },
  { id: 'completed',          label: 'Simkl — Completed (All)',           type: 'poster' },
  { id: 'history',            label: 'Simkl — Watch History',             type: 'landscape' },
  { id: 'movies-watchlist',   label: 'Simkl — Movies Watchlist',          type: 'poster' },
  { id: 'movies-watching',    label: 'Simkl — Movies Watching',           type: 'landscape' },
  { id: 'movies-completed',   label: 'Simkl — Movies Completed',          type: 'poster' },
  { id: 'shows-watchlist',    label: 'Simkl — Shows Watchlist',           type: 'poster' },
  { id: 'shows-watching',     label: 'Simkl — Shows Watching',            type: 'landscape' },
  { id: 'shows-completed',    label: 'Simkl — Shows Completed',           type: 'poster' },
  { id: 'anime-watchlist',    label: 'Simkl — Anime Watchlist',           type: 'poster' },
  { id: 'anime-watching',     label: 'Simkl — Anime Watching',            type: 'landscape' },
  { id: 'anime-completed',    label: 'Simkl — Anime Completed',           type: 'poster' },
  { id: 'on-hold',            label: 'Simkl — On Hold',                   type: 'poster' },
  { id: 'dropped',            label: 'Simkl — Dropped',                   type: 'poster' },
] as const

function getRowDisplayTitle(row: HomeRowConfig): string {
  let title = row.title.trim().replace(/\s*\(\d+\)\s*$/, '')

  if (row.sourceType === 'simkl') title = title.replace(/^Simkl\s*(?:-|—|–|â€”)\s*/i, '')
  else if (row.sourceType === 'trakt') title = title.replace(/^Trakt\s*(?:-|—|–)\s*/i, '')
  else if (row.sourceType === 'anilist') title = title.replace(/^AniList\s*(?:-|—|–)\s*/i, '')
  else if (row.sourceType === 'pmdb') title = title.replace(/^PMDB\s*(?:-|—|–)\s*/i, '')
  else if (row.sourceType === 'pmdb-picks') title = title.replace(/^PMDB Picks\s*(?:-|—|–)\s*/i, '')
  else if (row.sourceType === 'mdblist') title = title.replace(/^MDBList\s*(?:-|—|–)\s*/i, '')

  if ((row.sourceType === 'trakt' && row.providerListId?.startsWith('public:')) || row.sourceType === 'mdblist') {
    title = title.replace(/\s+by\s+[^()]+$/i, '')
  }

  if (row.addonId && row.addonId !== 'com.example.mockaddon') {
    title = title.replace(/\s*\([^()]+\)\s*$/, '')
  }

  return title.trim() || row.title
}

function defaultCatalogExtra(extra: { name: string; isRequired?: boolean; options?: string[] }[] | undefined): Record<string, string> | undefined {
  const required = (extra || []).filter((item) => item.isRequired)
  if (required.length === 0) return undefined

  const defaults = required.reduce<Record<string, string>>((acc, item) => {
    const value = item.options?.[0]
    if (value) acc[item.name] = value
    return acc
  }, {})
  return Object.keys(defaults).length ? defaults : undefined
}

// Keep raw provider/HTTP errors in the console; show people a readable message.
function friendlyRowError(err: unknown, fallback: string): string {
  console.warn('[HomeRow]', err)
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/network|fetch|timed? ?out|abort|offline/i.test(msg)) {
    return "Couldn't reach the server. Check your connection and try again."
  }
  return fallback
}

function simklItemToSearchResult(item: SimklWatchlistItem): SearchResult {
  return {
    id: item.tvdbId ? `tvdb-${item.tvdbId}` : item.imdbId || (item.tmdbId ? `tmdb-${item.tmdbId}` : item.simklId?.toString() || item.id),
    title: item.title,
    type: item.type === 'movie' ? 'movie' : 'series',
    year: item.year,
    poster: item.poster,
    backdrop: item.backdrop,
    provider: 'simkl',
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
  }
}

function MediaRowSkeleton({ title, layout, headerLeftControls, headerRightControls }: { title: string; layout: 'poster' | 'landscape'; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const isLandscape = layout === 'landscape'
  return (
    <div className="mb-8 animate-pulse select-none">
      <div className="flex items-center justify-between px-6 mb-4">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className="text-xl font-bold tracking-tight text-white/60">{title}</h2>
        </div>
        <div>
          {headerRightControls}
        </div>
      </div>
      <div className="flex gap-4 overflow-x-hidden px-6 pb-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex-shrink-0 flex flex-col">
            <div
              className={`bg-neutral-800/40 rounded-xl ${
                isLandscape ? 'w-72 aspect-video' : 'w-36 aspect-[2/3]'
              }`}
            />
            {!isLandscape && <div className="h-3 bg-neutral-800/35 rounded mt-2.5 w-24" />}
            {!isLandscape && <div className="h-3 bg-neutral-800/35 rounded mt-1.5 w-12" />}
          </div>
        ))}
      </div>
    </div>
  )
}

function MediaRowError({ title, message, layout, headerLeftControls, headerRightControls }: { title: string; message: string; layout: 'poster' | 'landscape'; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const isLandscape = layout === 'landscape'
  return (
    <div className="mb-8 select-none">
      <div className="flex items-center justify-between px-6 mb-4">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className="text-xl font-bold tracking-tight text-white/50">{title}</h2>
        </div>
        <div>
          {headerRightControls}
        </div>
      </div>
      <div className="px-6 pb-2">
        <div
          className={`rounded-xl border border-dashed border-border-subtle/30 bg-neutral-900/30 flex items-center justify-center p-6 text-center ${
            isLandscape ? 'h-36 max-w-lg' : 'h-24 max-w-sm'
          }`}
        >
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-xs font-semibold text-muted leading-normal">{message}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SimklRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = simklRowCacheKey(row)
  const memCache = useHomeCatalogCache()
  const cached = memCache.get(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    const load = async () => {
      try {
        const fetcher = async () => {
          const listId = row.providerListId || 'watchlist'
          const rawResults = isSimklDerivedCatalogId(listId)
            ? await getSimklDerivedCatalogItems(listId)
            : (listId === 'history' ? await getSimklWatchedMovies() : await getSimklWatchStatusList(listId)).map(simklItemToSearchResult)
          const canonicalized = await canonicalizeCatalogItemsWithTvdb(rawResults)
          const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
          const results = await enrichSearchResultsWithAppMetadata(canonicalized)
          if (row.sortBy === 'alphabetical') {
            results.sort((a, b) => a.title.localeCompare(b.title))
          }
          return results
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.SIMKL_LIST,
          ttlSeconds: CACHE_TTLS.SIMKL_LIST,
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) { setItems(fresh); memCache.set(cacheKey, fresh) } },
        })
        if (!cancelledRef.current) {
          setItems(results)
          memCache.set(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(friendlyRowError(err, "Couldn't load this Simkl list right now."))
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelledRef.current = true }
  }, [cacheKey, row.providerListId, row.sortBy])

  if (loading) {
    return (
      <MediaRowSkeleton
        title={getRowDisplayTitle(row)}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (error) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message={error}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (!items || items.length === 0) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message="No items found in this list."
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  return (
    <MediaRow
      title={getRowDisplayTitle(row)}
      items={items}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={items.length >= 20}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function ProviderListRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = providerRowCacheKey(row)
  const memCache = useHomeCatalogCache()
  const cached = memCache.get(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    const load = async () => {
      try {
        const fetcher = async () => {
          const results = await getProviderListItems(row)
          if (row.sortBy === 'alphabetical') results.sort((a, b) => a.title.localeCompare(b.title))
          return results
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.PROVIDER_LIST,
          ttlSeconds: CACHE_TTLS.PROVIDER_LIST,
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) { setItems(fresh); memCache.set(cacheKey, fresh) } },
        })
        if (!cancelledRef.current) {
          setItems(results)
          memCache.set(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(friendlyRowError(err, "Couldn't load this list right now."))
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelledRef.current = true }
  }, [cacheKey, row.providerListId, row.sourceType, row.sortBy])

  const layout = row.layout === 'landscape' ? 'landscape' : 'poster'
  if (loading) return <MediaRowSkeleton title={getRowDisplayTitle(row)} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (error) return <MediaRowError title={getRowDisplayTitle(row)} message={error} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (!items || items.length === 0) return <MediaRowError title={getRowDisplayTitle(row)} message="No items found in this list." layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />

  return (
    <MediaRow
      title={getRowDisplayTitle(row)}
      items={items}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      disableArtOverride={false}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={items.length >= 20}
    />
  )
}

function AddonCatalogRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = addonRowCacheKey(row)
  const memCache = useHomeCatalogCache()
  const cached = memCache.get(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false

    if (isMockCatalog && row.catalogId) {
      setItems(getMockCatalog(row.catalogId))
      setLoading(false)
      return
    }

    if (!row.catalogType || !row.catalogId) {
      setError('Shelf is unconfigured.')
      setLoading(false)
      return
    }

    const addon = addons.find((a) => a.enabled && a.manifest.id === row.addonId)
    const url = addon?.url || row.addonUrl
    if (!url) {
      setError('Addon not found or disabled.')
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        const fetcher = async () => {
          const firstPage = await getAddonCatalog(url, row.catalogType!, row.catalogId!, row.catalogExtra, row.addonId)
          if (firstPage.length < 20 || row.catalogExtra?.skip) return firstPage

          const secondPage = await getAddonCatalog(url, row.catalogType!, row.catalogId!, {
            ...(row.catalogExtra || {}),
            skip: '20',
          }, row.addonId)

          const seen = new Set<string>()
          return [...firstPage, ...secondPage].filter((item) => {
            if (seen.has(item.id)) return false
            seen.add(item.id)
            return true
          })
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.ADDON_CATALOG,
          ttlSeconds: CACHE_TTLS.ADDON_CATALOG,
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) { setItems(fresh); memCache.set(cacheKey, fresh) } },
        })
        if (!cancelledRef.current) {
          setItems(results)
          memCache.set(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(friendlyRowError(err, "Couldn't load this catalog right now."))
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelledRef.current = true }
  }, [cacheKey, isMockCatalog, row.addonId, row.addonUrl, row.catalogType, row.catalogId, row.catalogExtra, addons])

  const displayItems = isMockCatalog && row.catalogId ? getMockCatalog(row.catalogId) : items

  if (loading) {
    return (
      <MediaRowSkeleton
        title={getRowDisplayTitle(row)}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (error) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message={error}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (!displayItems || displayItems.length === 0) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message="No items found in this catalog."
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  const sortedItems = [...displayItems]
  if (row.sortBy === 'alphabetical') {
    sortedItems.sort((a, b) => a.title.localeCompare(b.title))
  }

  return (
    <MediaRow
      title={getRowDisplayTitle(row)}
      items={sortedItems}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={sortedItems.length >= 20}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function DiscoverRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = discoverRowCacheKey(row)
  const memCache = useHomeCatalogCache()
  const cached = memCache.get(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false

    if (!row.discoverConfig) {
      setError('Shelf is unconfigured.')
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        const fetcher = async () => {
          const results = await discoverTmdbWithCache(row.discoverConfig!, row.id)
          const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
          return enrichSearchResultsWithAppMetadata(results)
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.DISCOVER,
          ttlSeconds: CACHE_TTLS.DISCOVER,
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) { setItems(fresh); memCache.set(cacheKey, fresh) } },
        })
        if (!cancelledRef.current) {
          setItems(results)
          memCache.set(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(friendlyRowError(err, "Couldn't load recommendations right now."))
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelledRef.current = true }
  }, [cacheKey, row.id, row.discoverConfig])

  if (loading) {
    return (
      <MediaRowSkeleton
        title={getRowDisplayTitle(row)}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (error) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message={error}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (!items || items.length === 0) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message="No items found matching the filters."
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  const sortedItems = [...items]
  if (row.sortBy === 'alphabetical') {
    sortedItems.sort((a, b) => a.title.localeCompare(b.title))
  }

  return (
    <MediaRow
      title={getRowDisplayTitle(row)}
      items={sortedItems}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={sortedItems.length >= 20}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function HeroCatalogSection({ row, onBackdropChange }: { row: HomeRowConfig; onBackdropChange?: (url: string | undefined) => void }) {
  const memCache = useHomeCatalogCache()
  const cacheKey = heroRowCacheKey(row)
  const cached = memCache.get(cacheKey)
  const [items, setItems] = useState<SearchResult[]>(cached || [])
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false

    const load = async () => {
      try {
        if (isMockCatalog && row.catalogId) {
          setItems(getMockCatalog(row.catalogId))
          return
        }

        const fetcher = async (): Promise<SearchResult[]> => {
          if (row.sourceType === 'simkl') {
            const listId = row.providerListId || 'watchlist'
            const rawResults = isSimklDerivedCatalogId(listId)
              ? await getSimklDerivedCatalogItems(listId)
              : (listId === 'history' ? await getSimklWatchedMovies() : await getSimklWatchStatusList(listId)).map(simklItemToSearchResult)
            return canonicalizeCatalogItemsWithTvdb(rawResults)
          } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'mdblist' || row.sourceType === 'anilist') {
            return getProviderListItems(row)
          } else if (row.sourceType === 'discover') {
            if (row.discoverConfig) {
              const rawDiscover = await discoverTmdbWithCache(row.discoverConfig, row.id)
              const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
              return enrichSearchResultsWithAppMetadata(rawDiscover)
            }
            return []
          } else if (row.addonId) {
            const addon = addons.find((a) => a.enabled && a.manifest.id === row.addonId)
            const url = addon?.url || row.addonUrl
            if (url && row.catalogType && row.catalogId) {
              return getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra, row.addonId)
            }
            return []
          }
          return []
        }

        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.ADDON_CATALOG,
          ttlSeconds: CACHE_TTLS.ADDON_CATALOG,
          onStaleRefreshed: (fresh) => {
            if (!cancelledRef.current) {
              const sorted = row.sortBy === 'alphabetical' ? [...fresh].sort((a, b) => a.title.localeCompare(b.title)) : fresh
              setItems(sorted)
              memCache.set(cacheKey, sorted)
            }
          },
        })

        if (!cancelledRef.current) {
          const sorted = row.sortBy === 'alphabetical' ? [...results].sort((a, b) => a.title.localeCompare(b.title)) : results
          setItems(sorted)
          memCache.set(cacheKey, sorted)
        }
      } catch (e) {
        console.error('[HeroCatalogSection] Failed to load catalog items:', e)
      }
    }

    load()
    return () => { cancelledRef.current = true }
  }, [
    cacheKey,
    isMockCatalog,
    row.addonId,
    row.addonUrl,
    row.catalogType,
    row.catalogId,
    row.catalogExtra,
    row.sourceType,
    row.providerListId,
    row.discoverConfig,
    row.sortBy,
    addons
  ])

  if (items.length === 0) return null
  return <HeroSection items={items} onActiveBackdropChange={onBackdropChange} />
}

// ── Unconfigured shelf customizer (Pic 1) ───────────────────────────────────
function UnconfiguredShelf({
  row,
  onConfigure,
  onRemove,
  headerLeftControls,
}: {
  row: HomeRowConfig
  onConfigure: (row: HomeRowConfig) => void
  onRemove: (id: string) => void
  headerLeftControls?: React.ReactNode
}) {
  return (
    <div className="px-6 mb-8 select-none">
      <div className="flex items-center gap-2.5 mb-3">
        {headerLeftControls}
        <h2 className="text-lg font-semibold text-white/40">{getRowDisplayTitle(row)}</h2>
      </div>
      <div className="px-6">
        <div
          onClick={() => onConfigure(row)}
          className="w-full max-w-4xl border border-dashed border-white/10 hover:border-accent/40 bg-white/[0.01] hover:bg-white/[0.03] rounded-2xl p-6 flex items-center justify-between transition-all duration-200 cursor-pointer group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-white/35 group-hover:text-accent transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="text-left">
              <span className="block text-sm font-bold text-white/55 group-hover:text-white transition-colors">Unconfigured Shelf</span>
              <span className="block text-xs text-white/35 mt-0.5">Click to choose a content source for this row.</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onConfigure(row)
              }}
              className="text-xs font-semibold text-accent bg-accent/10 hover:bg-accent/20 px-3.5 py-2 rounded-xl border border-accent/10 transition-colors cursor-pointer"
            >
              Configure
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Delete shelf "${row.title}"?`)) {
                  onRemove(row.id)
                }
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer"
              title="Delete Shelf"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SortableRowContainerProps {
  row: HomeRowConfig
  isEditing: boolean
  onRemove: (id: string) => void
  children: React.ReactNode
}

function SortableRowContainer({
  row,
  isEditing,
  onRemove,
  children,
}: SortableRowContainerProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  }

  if (!isEditing) {
    return <>{children}</>
  }

  const headerLeftControls = (
    <button
      {...attributes}
      {...listeners}
      className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-hover cursor-grab text-muted active:cursor-grabbing flex-shrink-0"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
        <path d="M4 8h16M4 16h16" />
      </svg>
    </button>
  )

  const headerRightControls = (
    <button
      onClick={(e) => { e.stopPropagation(); onRemove(row.id) }}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer flex-shrink-0"
      title="Remove shelf"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
    </button>
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border border-transparent hover:border-border-subtle/20 rounded-2xl py-1 transition-colors relative"
    >
      {cloneElement(children as React.ReactElement<any>, {
        headerLeftControls,
        headerRightControls,
      })}
    </div>
  )
}

// ── Staggered row renderer ─────────────────────────────────────────────────

function buildRowElement(row: HomeRowConfig): React.ReactNode {
  if (row.layout === 'continue') {
    return <ContinueWatchingRow key={row.id} row={row} />;
  } else if (row.sourceType === 'simkl') {
    return <SimklRow key={row.id} row={row} />;
  } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'mdblist' || row.sourceType === 'anilist') {
    return <ProviderListRow key={row.id} row={row} />;
  } else if (row.sourceType === 'discover') {
    return <DiscoverRow key={row.id} row={row} />;
  } else if (row.addonId && row.addonId !== 'com.example.mockaddon') {
    return <AddonCatalogRow key={row.id} row={row} />;
  }
  return null
}

const INITIAL_VISIBLE = 3;

function LazyRow({ row, isEditing, onRemove, eager }: { row: HomeRowConfig; isEditing: boolean; onRemove: (id: string) => void; eager?: boolean }) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [activated, setActivated] = useState(eager ?? false)

  useEffect(() => {
    if (activated) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setActivated(true)
          observer.disconnect()
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [activated])

  if (!activated) {
    return (
      <div ref={sentinelRef} className="row-contain">
        <MediaRowSkeleton
          title={getRowDisplayTitle(row)}
          layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        />
      </div>
    )
  }

  const element = buildRowElement(row)
  if (!element) return null

  return (
    <div className="row-contain">
      <ErrorBoundary key={row.id} label={row.title}>
        <SortableRowContainer
          row={row}
          isEditing={isEditing}
          onRemove={onRemove}
        >
          {element}
        </SortableRowContainer>
      </ErrorBoundary>
    </div>
  )
}

function StaggeredRows({ rows, isEditing, onRemove }: { rows: HomeRowConfig[]; isEditing: boolean; onRemove: (id: string) => void }) {
  return (
    <div className="space-y-4">
      {rows.map((row, idx) => (
        <LazyRow
          key={row.id}
          row={row}
          isEditing={isEditing}
          onRemove={onRemove}
          eager={idx < INITIAL_VISIBLE}
        />
      ))}
    </div>
  )
}

// ── Main Home Page Component ────────────────────────────────────────────────
const LAYOUT_OPTIONS: { value: HomeRowConfig['layout']; label: string }[] = [
  { value: 'poster', label: 'Poster Carousel' },
  { value: 'landscape', label: 'Landscape Carousel' },
  { value: 'list', label: 'Compact List' },
  { value: 'continue', label: 'Continue Watching' },
];

export default function HomePage() {
  const { homeRows, reorderHomeRows, removeHomeRow, resetHomeRows } = useAppStore();
  const cinematic = useAppStore((state) => state.interfaceTheme === 'cinematic')
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isEditing = searchParams.get('edit') === 'true';
  const [heroBackdrop, setHeroBackdrop] = useState<string | undefined>(undefined)
  const handleBackdropChange = useCallback((url: string | undefined) => setHeroBackdrop(url), [])

  // Batch-load every shelf's sqlite cache entry in a single IPC call and seed
  // the in-memory cache, so all rows paint instantly instead of each doing its
  // own roundtrip (and flashing a skeleton) on mount.
  const [cachePreloaded, setCachePreloaded] = useState(() => {
    const state = useHomeCatalogCache.getState()
    return useAppStore.getState().homeRows
      .filter((row) => row.enabled)
      .map(homeRowCacheKey)
      .every((key) => !key || state.get(key))
  })
  useEffect(() => {
    if (cachePreloaded) return
    let cancelled = false
    const state = useHomeCatalogCache.getState()
    const keys = useAppStore.getState().homeRows
      .filter((row) => row.enabled)
      .map(homeRowCacheKey)
      .filter((key): key is string => !!key && !state.get(key))

    cacheGetMany<SearchResult[]>(keys)
      .then((entries) => {
        if (cancelled) return
        const seed: Record<string, SearchResult[]> = {}
        for (const [key, result] of entries) {
          if (Array.isArray(result.data)) seed[key] = result.data
        }
        if (Object.keys(seed).length > 0) state.setMany(seed)
      })
      .finally(() => { if (!cancelled) setCachePreloaded(true) })

    return () => { cancelled = true }
  }, [cachePreloaded])

  useEffect(() => {
    taskQueue.enqueue({
      id: 'startup-cache-cleanup',
      priority: 'idle',
      dedupKey: 'cache-cleanup',
      execute: async () => { await cacheClearExpired() },
    })
  }, [])

  useGlobalBackdrop(heroBackdrop)

  const setIsEditing = (val: boolean) => {
    if (val) {
      setSearchParams({ edit: 'true' });
    } else {
      setSearchParams({});
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const enabledRows = homeRows.filter((row) => row.enabled);
  const heroRow = homeRows.find((row) => row.layout === 'hero' && row.enabled);

  // Only allow reordering visible content shelves
  const activeRows = enabledRows
    .filter((row) => row.layout !== 'hero')
    .sort((a, b) => a.order - b.order);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = activeRows.findIndex((r) => r.id === active.id);
      const newIndex = activeRows.findIndex((r) => r.id === over.id);
      const reorderedActive = arrayMove(activeRows, oldIndex, newIndex);

      // Reconstruct the full list preserving hero and disabled shelves
      const hero = homeRows.find((row) => row.layout === 'hero');
      const disabled = homeRows.filter((row) => !row.enabled);
      const nextRows = [
        ...(hero ? [hero] : []),
        ...reorderedActive,
        ...disabled,
      ];
      reorderHomeRows(nextRows);
    }
  };

  const shelvesContent = (
    <StaggeredRows rows={activeRows} isEditing={isEditing} onRemove={removeHomeRow} />
  );

  return (
    <div className="pb-12 relative">

      {isEditing && (
        <div className="sticky top-0 z-50 bg-black/90 backdrop-blur-md border-b border-white/10 py-4 px-6 flex items-center justify-center gap-4">
          <button
            onClick={() => setIsEditing(false)}
            className="px-6 py-2.5 bg-accent hover:bg-accent/80 text-black font-bold rounded-xl text-sm transition-all shadow-lg shadow-accent/20 cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {!cachePreloaded ? (
        <div className="pt-6">
          {activeRows.slice(0, INITIAL_VISIBLE).map((row) => (
          <MediaRowSkeleton
            key={row.id}
            title={getRowDisplayTitle(row)}
              layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
            />
          ))}
        </div>
      ) : activeRows.length === 0 && !heroRow ? (
        <EmptyState
          className="min-h-[70vh]"
          icon={<svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" strokeLinecap="round" /></svg>}
          title="Your home screen is empty"
          description="Add trending movies and shows with one click, or browse Discover to find something to watch."
          action={{ label: 'Restore default shelves', onClick: resetHomeRows }}
          secondaryAction={{ label: 'Browse Discover', onClick: () => navigate('/discover') }}
        />
      ) : (
        <>
          {heroRow && <HeroCatalogSection row={heroRow} onBackdropChange={handleBackdropChange} />}

          <div className="relative z-10" style={{ marginTop: heroRow ? (cinematic ? '24px' : '-40px') : undefined }}>
            {isEditing ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={activeRows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                  {shelvesContent}
                </SortableContext>
              </DndContext>
            ) : (
              shelvesContent
            )}
          </div>
        </>
      )}
    </div>
  );
}
