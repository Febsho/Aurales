import { useState, useEffect, useRef, useCallback, cloneElement } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import ErrorBoundary from '../components/ui/ErrorBoundary'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import ContinueWatchingRow from '../components/ContinueWatchingRow'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import {
  getSimklWatchlist,
  getSimklWatching,
  getSimklCompleted,
  getSimklAnimeWatchlist,
  getSimklMoviesWatchlist,
  getSimklMoviesWatching,
  getSimklMoviesCompleted,
  getSimklShowsWatchlist,
  getSimklShowsWatching,
  getSimklShowsCompleted,
  getSimklAnimeWatching,
  getSimklAnimeCompleted,
  getSimklOnHold,
  getSimklDropped,
} from '../services/simkl/lists'
import { getSimklWatchedMovies } from '../services/simkl/history'
import type { SearchResult, HomeRowConfig } from '../types'
import type { SimklWatchlistItem } from '../services/simkl/types'
import { discoverTmdbWithCache } from '../services/tmdb'
import { canonicalizeCatalogItemsWithTvdb, getProviderListItems } from '../services/providerLists'
import { cachedFetch, cacheClearExpired } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../services/cache/constants'
import { taskQueue } from '../services/cache/backgroundTaskQueue'

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
      <div className="flex items-center justify-between px-6 mb-3">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className="text-lg font-semibold text-white/90">{title}</h2>
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
      <div className="flex items-center justify-between px-6 mb-3">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className="text-lg font-semibold text-white/50">{title}</h2>
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
  const cacheKey = `home:simkl:${row.providerListId || 'watchlist'}:${row.sortBy || 'default'}`
  const [items, setItems] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    const load = async () => {
      try {
        const fetcher = async () => {
          let raw: SimklWatchlistItem[] = []
          switch (row.providerListId) {
            case 'watching':          raw = await getSimklWatching(); break
            case 'completed':         raw = await getSimklCompleted(); break
            case 'anime':             raw = await getSimklAnimeWatchlist(); break
            case 'history':           raw = await getSimklWatchedMovies(); break
            case 'movies-watchlist':  raw = await getSimklMoviesWatchlist(); break
            case 'movies-watching':   raw = await getSimklMoviesWatching(); break
            case 'movies-completed':  raw = await getSimklMoviesCompleted(); break
            case 'shows-watchlist':   raw = await getSimklShowsWatchlist(); break
            case 'shows-watching':    raw = await getSimklShowsWatching(); break
            case 'shows-completed':   raw = await getSimklShowsCompleted(); break
            case 'anime-watchlist':   raw = await getSimklAnimeWatchlist(); break
            case 'anime-watching':    raw = await getSimklAnimeWatching(); break
            case 'anime-completed':   raw = await getSimklAnimeCompleted(); break
            case 'on-hold':           raw = await getSimklOnHold(); break
            case 'dropped':           raw = await getSimklDropped(); break
            case 'watchlist':
            default:                  raw = await getSimklWatchlist(); break
          }
          const canonicalized = await canonicalizeCatalogItemsWithTvdb(raw.map(simklItemToSearchResult))
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
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) setItems(fresh) },
        })
        if (!cancelledRef.current) {
          setItems(results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(err?.message || 'Failed to fetch Simkl list.')
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
        title={row.title}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (error) {
    return (
      <MediaRowError
        title={row.title}
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
        title={row.title}
        message="No items found in this list."
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  return (
    <MediaRow
      title={`${row.title} (${items.length})`}
      items={items}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function ProviderListRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = `home:provider:${row.sourceType}:${row.providerListId}:${row.sortBy || 'default'}`
  const [items, setItems] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(true)
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
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) setItems(fresh) },
        })
        if (!cancelledRef.current) {
          setItems(results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(err?.message || `Failed to fetch ${row.sourceType} list.`)
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelledRef.current = true }
  }, [cacheKey, row.providerListId, row.sourceType, row.sortBy])

  const layout = row.layout === 'landscape' ? 'landscape' : 'poster'
  if (loading) return <MediaRowSkeleton title={row.title} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (error) return <MediaRowError title={row.title} message={error} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (!items || items.length === 0) return <MediaRowError title={row.title} message="No items found in this list." layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />

  return (
    <MediaRow
      title={`${row.title} (${items.length})`}
      items={items}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      disableArtOverride={false}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
    />
  )
}

function AddonCatalogRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = `home:addon:${row.addonId}:${row.catalogType}:${row.catalogId}:${JSON.stringify(row.catalogExtra || {})}`
  const [items, setItems] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(true)
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
          return getAddonCatalog(url, row.catalogType!, row.catalogId!, row.catalogExtra, row.addonId)
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.ADDON_CATALOG,
          ttlSeconds: CACHE_TTLS.ADDON_CATALOG,
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) setItems(fresh) },
        })
        if (!cancelledRef.current) {
          setItems(results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(err?.message || 'Failed to load addon catalog.')
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
        title={row.title}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (error) {
    return (
      <MediaRowError
        title={row.title}
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
        title={row.title}
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
      title={`${row.title} (${sortedItems.length})`}
      items={sortedItems}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function DiscoverRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = `home:discover:${row.id}:${JSON.stringify(row.discoverConfig || {})}`
  const [items, setItems] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(true)
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
          onStaleRefreshed: (fresh) => { if (!cancelledRef.current) setItems(fresh) },
        })
        if (!cancelledRef.current) {
          setItems(results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setError(err?.message || 'Failed to load discover catalog.')
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
        title={row.title}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (error) {
    return (
      <MediaRowError
        title={row.title}
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
        title={row.title}
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
      title={`${row.title} (${sortedItems.length})`}
      items={sortedItems}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showRank={row.showRank ?? /trending/i.test(row.title)}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function HeroCatalogSection({ row, onBackdropChange }: { row: HomeRowConfig; onBackdropChange?: (url: string | undefined) => void }) {
  const [items, setItems] = useState<SearchResult[]>([])
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  const cancelledRef = useRef(false)

  const cacheKey = `home:hero:${row.sourceType || 'addon'}:${row.addonId || ''}:${row.catalogId || ''}:${row.providerListId || ''}`

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
            let raw: SimklWatchlistItem[] = []
            switch (row.providerListId) {
              case 'watching':          raw = await getSimklWatching(); break
              case 'completed':         raw = await getSimklCompleted(); break
              case 'anime':             raw = await getSimklAnimeWatchlist(); break
              case 'history':           raw = await getSimklWatchedMovies(); break
              case 'movies-watchlist':  raw = await getSimklMoviesWatchlist(); break
              case 'movies-watching':   raw = await getSimklMoviesWatching(); break
              case 'movies-completed':  raw = await getSimklMoviesCompleted(); break
              case 'shows-watchlist':   raw = await getSimklShowsWatchlist(); break
              case 'shows-watching':    raw = await getSimklShowsWatching(); break
              case 'shows-completed':   raw = await getSimklShowsCompleted(); break
              case 'anime-watchlist':   raw = await getSimklAnimeWatchlist(); break
              case 'anime-watching':    raw = await getSimklAnimeWatching(); break
              case 'anime-completed':   raw = await getSimklAnimeCompleted(); break
              case 'on-hold':           raw = await getSimklOnHold(); break
              case 'dropped':           raw = await getSimklDropped(); break
              case 'watchlist':
              default:                  raw = await getSimklWatchlist(); break
            }
            return canonicalizeCatalogItemsWithTvdb(raw.map(simklItemToSearchResult))
          } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'anilist') {
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
            }
          },
        })

        if (!cancelledRef.current) {
          const sorted = row.sortBy === 'alphabetical' ? [...results].sort((a, b) => a.title.localeCompare(b.title)) : results
          setItems(sorted)
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
        <h2 className="text-lg font-semibold text-white/40">{row.title}</h2>
      </div>
      <div className="px-6">
        <div
          onClick={() => onConfigure(row)}
          className="w-full max-w-4xl border border-dashed border-neutral-700/60 hover:border-accent/40 bg-white/[0.01] hover:bg-white/[0.03] rounded-2xl p-6 flex items-center justify-between transition-all duration-200 cursor-pointer group"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-neutral-900 border border-neutral-800/60 flex items-center justify-center text-neutral-500 group-hover:text-accent transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="text-left">
              <span className="block text-sm font-bold text-neutral-400 group-hover:text-white transition-colors">Unconfigured Shelf</span>
              <span className="block text-xs text-neutral-500 mt-0.5">Click to choose a content source for this row.</span>
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
  } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'anilist') {
    return <ProviderListRow key={row.id} row={row} />;
  } else if (row.sourceType === 'discover') {
    return <DiscoverRow key={row.id} row={row} />;
  } else if (row.addonId && row.addonId !== 'com.example.mockaddon') {
    return <AddonCatalogRow key={row.id} row={row} />;
  }
  return null
}

const STAGGER_BATCH = 3;
const STAGGER_DELAY = 80;

function StaggeredRows({ rows, isEditing, onRemove }: { rows: HomeRowConfig[]; isEditing: boolean; onRemove: (id: string) => void }) {
  const [visibleCount, setVisibleCount] = useState(STAGGER_BATCH)

  useEffect(() => {
    if (visibleCount >= rows.length) return
    const timer = setTimeout(() => {
      setVisibleCount((c) => Math.min(c + STAGGER_BATCH, rows.length))
    }, STAGGER_DELAY)
    return () => clearTimeout(timer)
  }, [visibleCount, rows.length])

  useEffect(() => {
    setVisibleCount(STAGGER_BATCH)
  }, [rows.length])

  return (
    <div className="space-y-4">
      {rows.slice(0, visibleCount).map((row) => {
        const element = buildRowElement(row)
        if (!element) return null
        return (
          <ErrorBoundary key={row.id} label={row.title}>
            <SortableRowContainer
              row={row}
              isEditing={isEditing}
              onRemove={onRemove}
            >
              {element}
            </SortableRowContainer>
          </ErrorBoundary>
        )
      })}
      {visibleCount < rows.length && (
        <div className="space-y-4">
          {rows.slice(visibleCount).map((row) => (
            <MediaRowSkeleton
              key={row.id}
              title={row.title}
              layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
            />
          ))}
        </div>
      )}
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
  const { homeRows, reorderHomeRows, removeHomeRow } = useAppStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const isEditing = searchParams.get('edit') === 'true';
  const [heroBackdrop, setHeroBackdrop] = useState<string | undefined>(undefined)
  const handleBackdropChange = useCallback((url: string | undefined) => setHeroBackdrop(url), [])

  useEffect(() => {
    taskQueue.enqueue({
      id: 'startup-cache-cleanup',
      priority: 'idle',
      dedupKey: 'cache-cleanup',
      execute: async () => { await cacheClearExpired() },
    })
  }, [])

  // Set blurred hero backdrop as page background via CSS custom property
  useEffect(() => {
    const root = document.documentElement
    if (heroBackdrop) {
      const url = heroBackdrop.replace('/w780/', '/original/').replace('/w1280/', '/original/')
      root.style.setProperty('--hero-bg', `url(${url})`)
      root.classList.add('hero-bg-active')
    } else {
      root.classList.remove('hero-bg-active')
      root.style.removeProperty('--hero-bg')
    }
    return () => {
      root.classList.remove('hero-bg-active')
      root.style.removeProperty('--hero-bg')
    }
  }, [heroBackdrop])

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
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-sm transition-all shadow-lg cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {heroRow && <HeroCatalogSection row={heroRow} onBackdropChange={handleBackdropChange} />}

      <div className="relative">
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
    </div>
  );
}
