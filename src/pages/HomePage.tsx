import { useState, useEffect, cloneElement } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import ContinueWatchingRow from '../components/ContinueWatchingRow'
import { MOCK_HERO_MOVIE, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
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

const HOME_ROW_CACHE_TTL = 5 * 60 * 1000
const homeRowCache = new Map<string, { items: SearchResult[]; timestamp: number }>()

function readHomeRowCache(key: string): SearchResult[] | null {
  const cached = homeRowCache.get(key)
  return cached ? cached.items : null
}

function isHomeRowCacheFresh(key: string): boolean {
  const cached = homeRowCache.get(key)
  return !!cached && Date.now() - cached.timestamp < HOME_ROW_CACHE_TTL
}

function writeHomeRowCache(key: string, items: SearchResult[]): void {
  homeRowCache.set(key, { items, timestamp: Date.now() })
}

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
  const cacheKey = `tvdb-v1:simkl:${row.providerListId || 'watchlist'}:${row.sortBy || 'default'}`
  const cachedItems = readHomeRowCache(cacheKey)
  const [items, setItems] = useState<SearchResult[]>(cachedItems || [])
  const [loading, setLoading] = useState(!cachedItems)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (isHomeRowCacheFresh(cacheKey)) {
        setItems(readHomeRowCache(cacheKey) || [])
        setError(null)
        setLoading(false)
        return
      }
      setLoading(!readHomeRowCache(cacheKey))
      setError(null)
      try {
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
        if (!cancelled) {
          const results = await canonicalizeCatalogItemsWithTvdb(raw.map(simklItemToSearchResult))
          if (row.sortBy === 'alphabetical') {
            results.sort((a, b) => a.title.localeCompare(b.title))
          }
          setItems(results)
          writeHomeRowCache(cacheKey, results)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to fetch Simkl list.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
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

  if (items.length === 0) {
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
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function ProviderListRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = `tvdb-v1:provider:${row.sourceType}:${row.providerListId}:${row.sortBy || 'default'}`
  const cachedItems = readHomeRowCache(cacheKey)
  const [items, setItems] = useState<SearchResult[]>(cachedItems || [])
  const [loading, setLoading] = useState(!cachedItems)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (isHomeRowCacheFresh(cacheKey)) {
      setItems(readHomeRowCache(cacheKey) || [])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(!readHomeRowCache(cacheKey))
    setError(null)
    getProviderListItems(row)
      .then((results) => {
        if (cancelled) return
        const sorted = [...results]
        if (row.sortBy === 'alphabetical') sorted.sort((a, b) => a.title.localeCompare(b.title))
        setItems(sorted)
        writeHomeRowCache(cacheKey, sorted)
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || `Failed to fetch ${row.sourceType} list.`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [cacheKey, row.providerListId, row.sourceType, row.sortBy])

  const layout = row.layout === 'landscape' ? 'landscape' : 'poster'
  if (loading) return <MediaRowSkeleton title={row.title} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (error) return <MediaRowError title={row.title} message={error} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (items.length === 0) return <MediaRowError title={row.title} message="No items found in this list." layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />

  return (
    <MediaRow
      title={`${row.title} (${items.length})`}
      items={items}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      disableArtOverride={false}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
    />
  )
}

function AddonCatalogRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = `addon:${row.addonId}:${row.catalogType}:${row.catalogId}:${JSON.stringify(row.catalogExtra || {})}`
  const cachedItems = readHomeRowCache(cacheKey)
  const [items, setItems] = useState<SearchResult[]>(cachedItems || [])
  const [loading, setLoading] = useState(!cachedItems)
  const [error, setError] = useState<string | null>(null)
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  const displayItems = isMockCatalog && row.catalogId ? getMockCatalog(row.catalogId) : items

  useEffect(() => {
    if (isMockCatalog) {
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

    let cancelled = false
    if (isHomeRowCacheFresh(cacheKey)) {
      setItems(readHomeRowCache(cacheKey) || [])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(!readHomeRowCache(cacheKey))
    setError(null)
    getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra, row.addonId)
      .then((results) => {
        if (cancelled) return
        setItems(results)
        writeHomeRowCache(cacheKey, results)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || 'Failed to load addon catalog.')
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [cacheKey, isMockCatalog, row.addonId, row.addonUrl, row.catalogType, row.catalogId, row.catalogExtra, addons])

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

  if (displayItems.length === 0) {
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
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function DiscoverRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = `discover:${row.id}:${JSON.stringify(row.discoverConfig || {})}`
  const cachedItems = readHomeRowCache(cacheKey)
  const [items, setItems] = useState<SearchResult[]>(cachedItems || [])
  const [loading, setLoading] = useState(!cachedItems)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row.discoverConfig) {
      setError('Shelf is unconfigured.')
      setLoading(false)
      return
    }

    let cancelled = false
    if (isHomeRowCacheFresh(cacheKey)) {
      setItems(readHomeRowCache(cacheKey) || [])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(!readHomeRowCache(cacheKey))
    setError(null)
    discoverTmdbWithCache(row.discoverConfig, row.id)
      .then(async (results) => {
        if (cancelled) return
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(results)
        if (cancelled) return
        setItems(enriched)
        writeHomeRowCache(cacheKey, enriched)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || 'Failed to load discover catalog.')
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
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

  if (items.length === 0) {
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
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function HeroCatalogSection({ row }: { row: HomeRowConfig }) {
  const [items, setItems] = useState<SearchResult[]>([])
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')

  useEffect(() => {
    if (isMockCatalog && row.catalogId) {
      setItems(getMockCatalog(row.catalogId))
      return
    }

    if (!row.catalogType || !row.catalogId) return
    const addon = addons.find((a) => a.manifest.id === row.addonId)
    const url = addon?.url || row.addonUrl
    if (!url) return

    let cancelled = false
    getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra, row.addonId)
      .then((results) => {
        if (!cancelled) setItems(results)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [isMockCatalog, row.addonId, row.addonUrl, row.catalogType, row.catalogId, row.catalogExtra, addons])

  const mockFallback: SearchResult = {
    id: MOCK_HERO_MOVIE.id,
    title: MOCK_HERO_MOVIE.title,
    type: 'movie',
    year: MOCK_HERO_MOVIE.year,
    poster: MOCK_HERO_MOVIE.poster,
    backdrop: MOCK_HERO_MOVIE.backdrop,
    overview: MOCK_HERO_MOVIE.overview,
    rating: MOCK_HERO_MOVIE.rating,
    provider: 'mock',
  }
  const heroItems = items.length > 0 ? items : [mockFallback]
  return <HeroSection items={heroItems} />
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
  children: React.ReactNode
}

function SortableRowContainer({
  row,
  isEditing,
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border border-transparent hover:border-border-subtle/20 rounded-2xl py-1 transition-colors relative"
    >
      {cloneElement(children as React.ReactElement<any>, {
        headerLeftControls,
        headerRightControls: null,
      })}
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
  const { homeRows, reorderHomeRows } = useAppStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const isEditing = searchParams.get('edit') === 'true';

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
    <div className="space-y-4">
      {activeRows.map((row) => {
        let rowEl = null;

        if (row.layout === 'continue') {
          rowEl = <ContinueWatchingRow key={row.id} row={row} />;
        } else if (row.sourceType === 'simkl') {
          rowEl = <SimklRow key={row.id} row={row} />;
        } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'anilist') {
          rowEl = <ProviderListRow key={row.id} row={row} />;
        } else if (row.sourceType === 'discover') {
          rowEl = <DiscoverRow key={row.id} row={row} />;
        } else if (row.addonId && row.addonId !== 'com.example.mockaddon') {
          rowEl = <AddonCatalogRow key={row.id} row={row} />;
        } else {
          const rawItems = row.catalogId === 'mock-series' ? MOCK_POPULAR_SHOWS : MOCK_TRENDING;
          const sortedItems = [...rawItems];
          if (row.sortBy === 'alphabetical') {
            sortedItems.sort((a, b) => a.title.localeCompare(b.title));
          }

          rowEl = (
            <MediaRow
              key={row.id}
              title={`${row.title} (${sortedItems.length})`}
              items={sortedItems}
              layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
              showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
            />
          );
        }

        return (
          <SortableRowContainer
            key={row.id}
            row={row}
            isEditing={isEditing}
          >
            {rowEl}
          </SortableRowContainer>
        );
      })}
    </div>
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

      {/* Floating Edit Home Button */}
      {!isEditing && (
        <div className="absolute top-6 right-6 z-40">
          <button
            onClick={() => setIsEditing(true)}
            className="px-4 py-2 bg-black/60 hover:bg-black/85 border border-white/10 hover:border-white/20 text-white font-semibold rounded-xl text-xs transition-all shadow-lg backdrop-blur-md cursor-pointer flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit Home
          </button>
        </div>
      )}

      {heroRow ? (
        <HeroCatalogSection row={heroRow} />
      ) : (
        <HeroSection items={[{
          id: MOCK_HERO_MOVIE.id,
          title: MOCK_HERO_MOVIE.title,
          type: 'movie',
          year: MOCK_HERO_MOVIE.year,
          poster: MOCK_HERO_MOVIE.poster,
          backdrop: MOCK_HERO_MOVIE.backdrop,
          overview: MOCK_HERO_MOVIE.overview,
          rating: MOCK_HERO_MOVIE.rating,
          provider: 'mock',
        }]} />
      )}

      <div className="mt-4">
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
