/**
 * Widgets page — visual manager for home-screen shelves.
 *
 * – Hero banner pinned at top with catalog selector
 * – Grid of draggable widget tiles with poster mosaics
 * – Inline "Add Widget" overlay with search, addon catalogs & Simkl lists
 */

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { useCatalogStore } from '../stores/catalogStore'
import { useHomeCatalogCache } from '../stores/homeCatalogCache'
import type { HomeRowConfig, DiscoverConfig, SearchResult } from '../types'
import type { InstalledAddon } from '../services/addons'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import {
  getSimklWatchStatusList,
  getSimklDerivedCatalogItems,
  isSimklDerivedCatalogId,
} from '../services/simkl/lists'
import {
  getTmdbGenres,
  getTmdbLanguages,
  getTmdbCountries,
  getTmdbWatchProviders,
  getTmdbCertifications,
  searchTmdbPeople,
  searchTmdbCompanies,
  searchTmdbKeywords,
  discoverTmdb,
  discoverTmdbPreviewWithCache,
  discoverTmdbWithCache,
  type TmdbWatchProvider
} from '../services/tmdb'
import { MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { ANILIST_LIST_SOURCES } from '../services/anilist'
import { canonicalizeCatalogItemsWithTvdb, getAvailableMdblistSources, getAvailablePmdbListSources, getAvailablePmdbPickSources, getAvailableTraktListSources, getProviderListItems, searchTraktPublicListSources, MDBLIST_LIST_SOURCES, PMDB_LIST_SOURCES, TRAKT_LIST_SOURCES } from '../services/providerLists'
import { createMdblistList, hasMdblistOAuth } from '../services/mdblist'
import { getHomeShelfRows, getSmartCollections, newSmartCollectionDefaults, SMART_COLLECTION_TEMPLATES, type SmartCollectionTemplate } from '../services/smartCollections'
import { Modal } from '../components/ui'
import LibraryCalendar from '../components/LibraryCalendar'
import LibraryActivity from '../components/LibraryActivity'
import { v4 as uuid } from 'uuid'
import { getPosterStackItems, inferCatalogContentType, isCatalogUsedByHomeShelf, normalizeShelfDraft, shelfDraftKey, type CatalogContentType, type CatalogPickerItem, type CatalogPickerSource, type PendingShelfSelection, type ShelfDraft } from '../services/homeShelves'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cacheGet, cacheSet } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { homeRowCacheKey, providerCacheScope } from '../services/cache/homeRowCacheKeys'
import { cachedImage } from '../services/imageCache'

// ── Simkl list options (for add-widget overlay) ────────────────────────────────

const SIMKL_LIST_SOURCES = [
  { id: 'watchlist',          label: 'Plan to Watch (All)',       type: 'poster' as const },
  { id: 'watching',           label: 'Currently Watching (All)',  type: 'landscape' as const },
  { id: 'completed',          label: 'Completed (All)',           type: 'poster' as const },
  { id: 'movies-watchlist',   label: 'Movies — Watchlist',        type: 'poster' as const },
  { id: 'movies-watching',    label: 'Movies — Watching',         type: 'landscape' as const },
  { id: 'movies-completed',   label: 'Movies — Completed',        type: 'poster' as const },
  { id: 'shows-watchlist',    label: 'Shows — Watchlist',         type: 'poster' as const },
  { id: 'shows-watching',     label: 'Shows — Watching',          type: 'landscape' as const },
  { id: 'shows-completed',    label: 'Shows — Completed',         type: 'poster' as const },
  { id: 'anime-watchlist',    label: 'Anime — Watchlist',         type: 'poster' as const },
  { id: 'anime-watching',     label: 'Anime — Watching',          type: 'landscape' as const },
  { id: 'anime-completed',    label: 'Anime — Completed',         type: 'poster' as const },
  { id: 'on-hold',            label: 'On Hold',                   type: 'poster' as const },
  { id: 'dropped',            label: 'Dropped',                   type: 'poster' as const },
]

const SIMKL_LIBRARY_CATALOGS = [
  { id: 'movies-watchlist',          label: 'Plan to Watch',             type: 'poster' as const, group: 'watchlist', section: 'Movies' },
  { id: 'movies-completed',          label: 'Completed',                 type: 'poster' as const, group: 'watchlist', section: 'Movies' },
  { id: 'movies-on-hold',            label: 'On Hold',                   type: 'poster' as const, group: 'watchlist', section: 'Movies' },
  { id: 'movies-dropped',            label: 'Dropped',                   type: 'poster' as const, group: 'watchlist', section: 'Movies' },
  { id: 'shows-watching',            label: 'Watching',                  type: 'landscape' as const, group: 'watchlist', section: 'Shows' },
  { id: 'shows-watchlist',           label: 'Plan to Watch',             type: 'poster' as const, group: 'watchlist', section: 'Shows' },
  { id: 'shows-completed',           label: 'Completed',                 type: 'poster' as const, group: 'watchlist', section: 'Shows' },
  { id: 'shows-on-hold',             label: 'On Hold',                   type: 'poster' as const, group: 'watchlist', section: 'Shows' },
  { id: 'shows-dropped',             label: 'Dropped',                   type: 'poster' as const, group: 'watchlist', section: 'Shows' },
  { id: 'anime-watching',            label: 'Watching',                  type: 'landscape' as const, group: 'watchlist', section: 'Anime' },
  { id: 'anime-watchlist',           label: 'Plan to Watch',             type: 'poster' as const, group: 'watchlist', section: 'Anime' },
  { id: 'anime-completed',           label: 'Completed',                 type: 'poster' as const, group: 'watchlist', section: 'Anime' },
  { id: 'anime-on-hold',             label: 'On Hold',                   type: 'poster' as const, group: 'watchlist', section: 'Anime' },
  { id: 'anime-dropped',             label: 'Dropped',                   type: 'poster' as const, group: 'watchlist', section: 'Anime' },
]

const ANILIST_WIDGET_LISTS = ANILIST_LIST_SOURCES.map((list) => ({ id: list.id, label: list.label.replace(/^AniList - /, ''), type: list.layout }))

// ── Poster fetching ────────────────────────────────────────────────────────────

interface LibraryShelfPosterSnapshot {
  posters: string[]
  count: number
}

const libraryShelfPosterMemory = new Map<string, LibraryShelfPosterSnapshot>()
const libraryShelfPostersRefreshed = new Set<string>()

function libraryShelfPosterCacheKey(row: HomeRowConfig): string {
  const contentKey = homeRowCacheKey(row) || JSON.stringify({
    id: row.id,
    layout: row.layout,
    sourceType: row.sourceType,
    providerListId: row.providerListId,
    addonId: row.addonId,
    addonUrl: row.addonUrl,
    catalogType: row.catalogType,
    catalogId: row.catalogId,
    catalogExtra: row.catalogExtra,
    discoverConfig: row.discoverConfig,
    sortBy: row.sortBy,
    accountScope: providerCacheScope(row.sourceType),
  })
  return `library:shelf-posters:v1:${contentKey}`
}

async function fetchSimklPosters(listId: string): Promise<string[]> {
  const rawItems = isSimklDerivedCatalogId(listId)
    ? await getSimklDerivedCatalogItems(listId)
    : (await getSimklWatchStatusList(listId)).map((item) => ({
        id: item.tvdbId ? `tvdb-${item.tvdbId}` : item.imdbId || (item.tmdbId ? `tmdb-${item.tmdbId}` : item.id),
        title: item.title,
        type: item.type === 'movie' ? 'movie' as const : 'series' as const,
        year: item.year,
        poster: item.poster,
        backdrop: item.backdrop,
        provider: 'simkl' as const,
        imdbId: item.imdbId,
        tmdbId: item.tmdbId,
        tvdbId: item.tvdbId,
        malId: item.malId,
      }))
  const canonical = await canonicalizeCatalogItemsWithTvdb(rawItems)
  return canonical
    .slice(0, 5)
    .map((i) => i.poster || '')
    .filter(Boolean)
}

function useRowPosters(row: HomeRowConfig, addons: InstalledAddon[]): { posters: string[]; count: number; loading: boolean } {
  const cacheKey = useMemo(() => libraryShelfPosterCacheKey(row), [row])
  const initial = libraryShelfPosterMemory.get(cacheKey)
  const [posters, setPosters] = useState<string[]>(() => initial?.posters || [])
  const [count, setCount] = useState(() => initial?.count || 0)
  const [loading, setLoading] = useState(() => !initial)
  const watchProgress = useAppStore((s) => s.watchProgress)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      let existing = libraryShelfPosterMemory.get(cacheKey)

      if (!existing) {
        const cached = await cacheGet<LibraryShelfPosterSnapshot>(cacheKey)
        if (cached?.data?.posters?.length) {
          existing = cached.data
          libraryShelfPosterMemory.set(cacheKey, existing)
          if (!cancelled) {
            setPosters(existing.posters)
            setCount(existing.count)
            setLoading(false)
          }
        }
      } else if (!cancelled) {
        setPosters(existing.posters)
        setCount(existing.count)
        setLoading(false)
      }
      let settledWithPosters = Boolean(existing?.posters.length)

      // The local Continue Watching preview should follow live progress and is
      // cheap to derive; remote shelves refresh only once during this session.
      if (row.layout === 'continue') {
        const items = Array.from(watchProgress.values()).filter((item) => !item.completed && item.progressSeconds > 5)
        const snapshot = { posters: items.slice(0, 5).map((item) => item.poster || item.backdrop || '').filter(Boolean), count: items.length }
        libraryShelfPosterMemory.set(cacheKey, snapshot)
        if (!cancelled) { setPosters(snapshot.posters); setCount(snapshot.count); setLoading(false) }
        return
      }

      // Home already owns a durable full-catalog snapshot for these exact row
      // keys. Build the Library mosaic from that snapshot first instead of
      // starting a second provider/addon request that can sit in a busy queue.
      const homeKey = homeRowCacheKey(row)
      if (homeKey) {
        const memoryItems = useHomeCatalogCache.getState().get(homeKey)
        const cachedItems = memoryItems?.length
          ? memoryItems
          : (await cacheGet<SearchResult[]>(homeKey))?.data
        if (cachedItems?.length) {
          const urls = cachedItems.slice(0, 5).map((item) => item.poster || item.backdrop || '').filter(Boolean)
          if (urls.length) {
            const snapshot = { posters: urls, count: cachedItems.length }
            libraryShelfPosterMemory.set(cacheKey, snapshot)
            libraryShelfPostersRefreshed.add(cacheKey)
            void cacheSet(cacheKey, snapshot, { category: CACHE_CATEGORIES.HOME_ROW, ttlSeconds: null })
            if (!cancelled) { setPosters(urls); setCount(cachedItems.length); setLoading(false) }
            return
          }
        }
      }

      if (libraryShelfPostersRefreshed.has(cacheKey)) {
        if (!cancelled) setLoading(false)
        return
      }

      try {
        let urls: string[] = []
        let total = 0

        const isMock = row.catalogId?.startsWith('mock-')
        if (isMock && row.catalogId) {
          const items = getMockCatalog(row.catalogId)
          total = items.length
          urls = items.slice(0, 5).map((i) => i.poster || '').filter(Boolean)
        } else if (!row.catalogId && !row.addonId && !row.sourceType) {
          const fallback = row.layout === 'landscape' ? MOCK_POPULAR_SHOWS : MOCK_TRENDING
          total = fallback.length
          urls = fallback.slice(0, 5).map((i) => i.poster || '').filter(Boolean)
        } else if (row.sourceType === 'simkl' && row.providerListId) {
          urls = await fetchSimklPosters(row.providerListId)
          total = urls.length // approximate
        } else if ((row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'mdblist' || row.sourceType === 'anilist') && row.providerListId) {
          const items = await getProviderListItems(row)
          total = items.length
          urls = items.slice(0, 5).map((i) => i.poster || i.backdrop || '').filter(Boolean)
        } else if (row.sourceType === 'discover' && row.discoverConfig) {
          try {
            const results = await discoverTmdbPreviewWithCache(row.discoverConfig, row.id)
            total = results.length
            urls = results.slice(0, 5).map((i) => i.poster || '').filter(Boolean)
          } catch (_) { /* ignore */ }
        } else if (row.catalogType && row.catalogId) {
          const addon = addons.find((a) => a.enabled && a.manifest.id === row.addonId)
          const url = addon?.url || row.addonUrl
          if (url) {
            const items = await getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra, row.addonId)
            total = items.length
            urls = items.slice(0, 5).map((i) => i.poster || i.backdrop || '').filter(Boolean)
          }
        }

        // Never replace a useful preview with an empty provider/error result.
        if (urls.length > 0) {
          const snapshot = { posters: urls, count: total }
          libraryShelfPosterMemory.set(cacheKey, snapshot)
          settledWithPosters = true
          await cacheSet(cacheKey, snapshot, { category: CACHE_CATEGORIES.HOME_ROW, ttlSeconds: null })
          if (!cancelled) { setPosters(urls); setCount(total) }
        }
      } catch (_) {
        // Keep the last successful preview.
      } finally {
        // Mark the row only after the request has settled. Multiple responsive
        // instances may mount together; marking it before the first result was
        // ready caused the visible instance to stop at the fallback label.
        if (settledWithPosters) libraryShelfPostersRefreshed.add(cacheKey)
        else libraryShelfPostersRefreshed.delete(cacheKey)
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [cacheKey, row, addons, watchProgress])

  return { posters, count, loading }
}

// ── Poster mosaic (card background) ───────────────────────────────────────────

function PosterMosaic({ posters, loading }: { posters: string[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="bg-white/[0.03] animate-pulse" />)}
      </div>
    )
  }
  if (posters.length === 0) {
    return (
      <div className="absolute inset-0 bg-white/[0.03] flex items-center justify-center">
        <svg className="w-10 h-10 text-white/10" fill="none" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 24 24">
          <rect x="2" y="2" width="20" height="20" rx="2.5" />
          <path d="M2 17l5-5 4 4 4-5 7 8" />
          <circle cx="8.5" cy="8.5" r="1.5" />
        </svg>
      </div>
    )
  }
  if (posters.length === 1) {
    return (
      <div className="absolute inset-0">
        <img src={cachedImage(posters[0])} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
      </div>
    )
  }
  if (posters.length === 2) {
    return (
      <div className="absolute inset-0 grid grid-cols-2">
        {posters.map((url, i) => <img key={i} src={cachedImage(url)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />)}
      </div>
    )
  }
  return (
    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
      {[0, 1, 2, 3].map((i) => (
        posters[i]
          ? <img key={i} src={cachedImage(posters[i])} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
          : <div key={i} className="bg-white/[0.04]" />
      ))}
    </div>
  )
}

function shelfSourceLabel(row: HomeRowConfig): string {
  if (row.layout === 'continue') return 'Built-in'
  if (row.sourceType === 'simkl') return 'Simkl'
  if (row.sourceType === 'trakt') return 'Trakt'
  if (row.sourceType === 'anilist') return 'AniList'
  if (row.sourceType === 'pmdb') return 'PMDB'
  if (row.sourceType === 'pmdb-picks') return 'PMDB Picks'
  if (row.sourceType === 'mdblist') return 'MDBList'
  if (row.sourceType === 'discover') return 'Discover'
  if (row.addonId) return 'Addon'
  return 'Catalog'
}

function shelfLayoutLabel(row: HomeRowConfig): string {
  switch (row.layout) {
    case 'poster': return 'Poster'
    case 'landscape': return 'Landscape'
    case 'list': return 'List'
    case 'continue': return 'Continue'
    case 'hero': return 'Hero'
    default: return row.layout || 'Poster'
  }
}

function sourceColor(row: HomeRowConfig): string {
  if (row.sourceType === 'simkl') return 'bg-emerald-500/15 text-emerald-400'
  if (row.sourceType === 'trakt') return 'bg-red-500/15 text-red-400'
  if (row.sourceType === 'anilist') return 'bg-sky-500/15 text-sky-400'
  if (row.sourceType === 'pmdb') return 'bg-purple-500/15 text-purple-300'
  if (row.sourceType === 'pmdb-picks') return 'bg-fuchsia-500/15 text-fuchsia-300'
  if (row.sourceType === 'mdblist') return 'bg-green-500/15 text-green-400'
  if (row.sourceType === 'discover') return 'bg-amber-500/15 text-amber-400'
  if (row.layout === 'continue') return 'bg-accent/15 text-accent'
  return 'bg-white/[0.06] text-white/50'
}

// ── Sortable shelf card (Steam-style grid card) ──────────────────────────────

function SortableShelfCard({
  row,
  addons,
  onRemove,
  onEdit,
  onToggle,
  onOpen,
  draggable = true,
}: {
  row: HomeRowConfig
  addons: InstalledAddon[]
  onRemove: () => void
  onEdit: () => void
  onToggle: () => void
  onOpen?: () => void
  draggable?: boolean
}) {
  const locked = row.layout === 'continue'
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: locked || !draggable })
  const { posters, count, loading } = useRowPosters(row, addons)

  const style = {
    transform: locked ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(!locked && draggable ? attributes : {})}
      {...(!locked && draggable ? listeners : {})}
      onClick={onOpen}
      className={`group relative overflow-hidden rounded-2xl border aspect-[4/3] transition-all duration-200 ${
        locked
          ? 'cursor-default border-accent/15 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]'
          : isDragging
          ? 'scale-[1.05] border-white/20 shadow-[0_20px_60px_rgba(0,0,0,0.6)]'
          : `border-white/[0.08] hover:border-white/[0.15] hover:shadow-[0_8px_32px_rgba(0,0,0,0.4)] hover:scale-[1.02] ${onOpen ? 'cursor-pointer' : ''}`
      } ${!row.enabled ? 'opacity-55 saturate-[0.6] hover:opacity-90' : ''}`}
    >
      {/* Poster mosaic background */}
      <PosterMosaic posters={posters} loading={loading} />

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/10" />

      {/* Source pill (top-left) */}
      <div className="absolute top-2.5 left-2.5 z-10">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-black/50 backdrop-blur-sm ${sourceColor(row).split(' ').find(c => c.startsWith('text-')) || 'text-white/60'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${sourceColor(row).split(' ').find(c => c.startsWith('bg-'))?.replace(/\/\d+/, '') || 'bg-white/40'}`} />
          {locked ? 'Fixed' : shelfSourceLabel(row)}
        </span>
        {!row.enabled && (
          <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold bg-black/50 backdrop-blur-sm text-amber-300/90">
            Hidden
          </span>
        )}
      </div>

      {/* Hover actions (top-right) */}
      <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1 px-1.5 py-1 rounded-xl bg-black/60 backdrop-blur-md opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          onPointerDown={(e) => e.stopPropagation()}
          title={row.enabled ? 'Hide from home' : 'Show on home'}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.12] transition-colors cursor-pointer"
        >
          {row.enabled ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Edit"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.12] transition-colors cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Remove"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>

      {/* Title + count (bottom) */}
      <div className="absolute bottom-0 left-0 right-0 p-3.5 z-10">
        <p className="text-sm font-bold text-white truncate leading-tight drop-shadow-lg">{row.title}</p>
        <p className="text-[11px] text-white/50 mt-0.5 drop-shadow-md">{loading ? '...' : row.sourceType === 'discover' ? (row.discoverConfig?.maxResults ? `Up to ${row.discoverConfig.maxResults} titles` : 'All matching titles') : `${count} items`}</p>
      </div>
    </div>
  )
}

// ── Hero banner section ────────────────────────────────────────────────────────

function HeroBannerSection({
  row,
  addons,
  smartCollections,
  onUpdate,
  onAdd,
}: {
  row: HomeRowConfig | undefined
  addons: InstalledAddon[]
  smartCollections: HomeRowConfig[]
  onUpdate: (id: string, updates: Partial<HomeRowConfig>) => void
  onAdd: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerGroup, setPickerGroup] = useState('All')
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()

  type CatalogOption = {
    group: string
    label: string
    detail: string
    value: string
    row: Partial<HomeRowConfig>
  }

  const addonOptions: CatalogOption[] = [
    {
      group: 'Built-in',
      label: 'Default Movies',
      detail: 'Local sample catalog',
      value: 'addon:com.example.mockaddon:movie:mock-movies',
      row: {
        sourceType: 'addon',
        addonId: 'com.example.mockaddon',
        addonUrl: '',
        catalogType: 'movie',
        catalogId: 'mock-movies',
        catalogExtra: undefined,
        providerListId: undefined,
        showRank: undefined,
      },
    },
    ...addons.filter((a) => a.enabled).flatMap((a) =>
      (a.manifest.catalogs || []).map((c: any) => ({
        group: a.manifest.name || 'Addons',
        label: c.name || c.id,
        detail: `${c.type} catalog`,
        value: `addon:${a.manifest.id}:${c.type}:${c.id}`,
        row: {
          sourceType: 'addon' as const,
          addonId: a.manifest.id,
          addonUrl: a.url,
          catalogType: c.type,
          catalogId: c.id,
          catalogExtra: defaultCatalogExtra(c.extra),
          providerListId: undefined,
          showRank: undefined,
        },
      }))
    ),
  ]

  const serviceOptions: CatalogOption[] = [
    ...(simklConnected ? SIMKL_LIBRARY_CATALOGS.map((list) => ({
      group: 'Simkl',
      label: list.section ? `${list.section} - ${list.label}` : list.label,
      detail: 'Watchlist catalog',
      value: `simkl:${list.id}`,
      row: {
        sourceType: 'simkl' as const,
        providerListId: list.id,
        addonId: undefined,
        addonUrl: undefined,
        catalogType: undefined,
        catalogId: undefined,
        catalogExtra: undefined,
        showRank: false,
      },
    })) : []),
    ...(traktConnected ? TRAKT_LIST_SOURCES.map((list) => ({
      group: 'Trakt',
      label: list.label.replace(/^Trakt - /, ''),
      detail: `${list.layout} list`,
      value: `trakt:${list.id}`,
      row: {
        sourceType: 'trakt' as const,
        providerListId: list.id,
        addonId: undefined,
        addonUrl: undefined,
        catalogType: undefined,
        catalogId: undefined,
        catalogExtra: undefined,
        showRank: undefined,
      },
    })) : []),
    ...(anilistConnected ? ANILIST_WIDGET_LISTS.map((list) => ({
      group: 'AniList',
      label: list.label,
      detail: `${list.type} list`,
      value: `anilist:${list.id}`,
      row: {
        sourceType: 'anilist' as const,
        providerListId: list.id,
        addonId: undefined,
        addonUrl: undefined,
        catalogType: undefined,
        catalogId: undefined,
        catalogExtra: undefined,
        showRank: undefined,
      },
    })) : []),
    ...(pmdbApiKey ? PMDB_LIST_SOURCES.map((list) => ({
      group: 'PMDB',
      label: list.label.replace(/^PMDB - /, ''),
      detail: `${list.layout} list`,
      value: `pmdb:${list.id}`,
      row: {
        sourceType: 'pmdb' as const,
        providerListId: list.id,
        addonId: undefined,
        addonUrl: undefined,
        catalogType: undefined,
        catalogId: undefined,
        catalogExtra: undefined,
        showRank: undefined,
      },
    })) : []),
    ...(mdblistApiKey ? MDBLIST_LIST_SOURCES.map((list) => ({
      group: 'MDBList',
      label: list.label.replace(/^MDBList - /, ''),
      detail: `${list.layout} list`,
      value: `mdblist:${list.id}`,
      row: {
        sourceType: 'mdblist' as const,
        providerListId: list.id,
        addonId: undefined,
        addonUrl: undefined,
        catalogType: undefined,
        catalogId: undefined,
        catalogExtra: undefined,
        showRank: undefined,
      },
    })) : []),
  ]

  const smartCollectionOptions: CatalogOption[] = smartCollections
    .filter((collection) => collection.discoverConfig)
    .map((collection) => ({
      group: 'Smart Collections',
      label: collection.title,
      detail: 'Dynamic TMDB collection',
      value: `smart:${collection.id}`,
      row: {
        sourceType: 'discover' as const,
        discoverConfig: collection.discoverConfig,
        catalogId: collection.id,
        addonId: undefined,
        addonUrl: undefined,
        catalogType: undefined,
        catalogExtra: undefined,
        providerListId: undefined,
        showRank: undefined,
      },
    }))

  const catalogOptions = [...addonOptions, ...serviceOptions, ...smartCollectionOptions]
  const groupedOptions = catalogOptions.reduce<Record<string, CatalogOption[]>>((acc, option) => {
    if (!acc[option.group]) acc[option.group] = []
    acc[option.group].push(option)
    return acc
  }, {})

  const currentValue = row
    ? row.sourceType === 'discover'
      ? `smart:${row.catalogId || ''}`
      : row.sourceType && row.sourceType !== 'addon'
      ? `${row.sourceType}:${row.providerListId || ''}`
      : `addon:${row.addonId || 'com.example.mockaddon'}:${row.catalogType || 'movie'}:${row.catalogId || 'mock-movies'}`
    : 'addon:com.example.mockaddon:movie:mock-movies'
  const selectedOption = catalogOptions.find((option) => option.value === currentValue) || catalogOptions[0]
  const pickerGroups = ['All', ...Object.keys(groupedOptions)]
  const filteredOptions = catalogOptions.filter((option) => {
    if (pickerGroup !== 'All' && option.group !== pickerGroup) return false
    const query = pickerQuery.trim().toLowerCase()
    return !query || `${option.label} ${option.detail} ${option.group}`.toLowerCase().includes(query)
  })

  const handleCatalogChange = (val: string) => {
    const opt = catalogOptions.find((o) => o.value === val)
    if (!opt) return
    const updates: Partial<HomeRowConfig> = {
      ...opt.row,
      title: 'Hero Banner',
      layout: 'hero',
      enabled: true,
    }
    if (row) {
      onUpdate(row.id, updates)
    } else {
      onAdd(updates as Omit<HomeRowConfig, 'id' | 'order'>)
    }
    setPickerOpen(false)
  }

  return (
    <>
      <div className="relative rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
        <div className="absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-accent/0 via-accent/35 to-accent/0" />
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl border border-accent/15 bg-accent/10">
              <svg className="h-5 w-5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
            </div>
            <div className="min-w-0"><p className="text-sm font-bold text-white/85">Hero source</p><p className="mt-0.5 truncate text-[11px] text-white/35">Choose which catalog supplies featured titles.</p></div>
          </div>
          <button type="button" onClick={() => setPickerOpen(true)} className="group flex min-w-0 items-center gap-3 rounded-xl border border-white/[0.09] bg-white/[0.045] px-3.5 py-2.5 text-left transition-all hover:border-white/[0.16] hover:bg-white/[0.075] sm:min-w-[340px] cursor-pointer">
            <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-accent/10 text-[11px] font-black text-accent">{selectedOption?.group.slice(0, 1) || 'H'}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-white/80">{selectedOption?.label || 'Choose a catalog'}</span><span className="mt-0.5 block truncate text-[10px] text-white/30">{selectedOption ? `${selectedOption.group} • ${selectedOption.detail}` : 'No source selected'}</span></span>
            <svg className="h-4 w-4 flex-shrink-0 text-white/25 transition-transform group-hover:translate-x-0.5 group-hover:text-white/55" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
      </div>

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose hero catalog" description="The hero source is independent from your Home shelves, so the same catalog can be used in both places." size="lg" className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <div className="space-y-4">
          <div className="relative"><svg className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/25" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg><input value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Search catalogs and lists…" className="h-11 w-full rounded-xl border border-white/[0.09] bg-white/[0.045] pl-10 pr-4 text-sm text-white outline-none placeholder:text-white/25 focus:border-accent/30 focus:bg-white/[0.065]" autoFocus /></div>
          <div className="flex flex-wrap gap-2 pb-1">{pickerGroups.map((group) => <button key={group} type="button" onClick={() => setPickerGroup(group)} className={`rounded-xl border px-3 py-2 text-[11px] font-bold transition-all cursor-pointer ${pickerGroup === group ? 'border-accent/25 bg-accent/12 text-accent' : 'border-white/[0.06] bg-white/[0.025] text-white/35 hover:bg-white/[0.055] hover:text-white/65'}`}>{group}</button>)}</div>
          <div className="max-h-[min(520px,55vh)] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
            {filteredOptions.length === 0 ? <div className="grid min-h-44 place-items-center rounded-2xl border border-dashed border-white/[0.08] text-center"><div><p className="text-sm font-semibold text-white/45">No matching catalogs</p><p className="mt-1 text-xs text-white/25">Try another source or search term.</p></div></div> : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{filteredOptions.map((option) => {
              const active = option.value === selectedOption?.value
              return <button key={option.value} type="button" onClick={() => handleCatalogChange(option.value)} className={`group flex min-h-[70px] items-center gap-3 rounded-2xl border p-3.5 text-left transition-all cursor-pointer ${active ? 'border-accent/35 bg-accent/[0.09]' : 'border-white/[0.07] bg-white/[0.03] hover:border-white/[0.15] hover:bg-white/[0.06]'}`}><span className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl text-xs font-black ${active ? 'bg-accent text-black' : 'bg-white/[0.06] text-white/45'}`}>{active ? '✓' : option.group.slice(0, 1)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-white/80">{option.label}</span><span className="mt-1 block truncate text-[10px] text-white/30">{option.group} • {option.detail}</span></span></button>
            })}</div>}
          </div>
        </div>
      </Modal>
    </>
  )
}

// ── Add Widget Overlay ─────────────────────────────────────────────────────────

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

function ProviderListPickerSection({
  title,
  service,
  lists,
  isAlreadyAdded,
  isSelected,
  onAdd,
  onClose,
}: {
  title: string
  service: 'anilist' | 'trakt' | 'pmdb' | 'pmdb-picks' | 'mdblist'
  lists: { id: string; label: string; type: 'poster' | 'landscape' }[]
  isAlreadyAdded: (key: string) => boolean
  isSelected?: (key: string) => boolean
  onAdd: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  onClose: () => void
}) {
  const label = service === 'anilist' ? 'AniList' : service === 'pmdb' ? 'PMDB' : service === 'pmdb-picks' ? 'PMDB Picks' : service === 'mdblist' ? 'MDBList' : 'Trakt'

  const badgeBg = service === 'anilist' ? 'bg-[#3b82f6]/15 text-[#60a5fa] ring-[#3b82f6]/20' : service === 'pmdb' ? 'bg-[#a855f7]/15 text-[#c084fc] ring-[#a855f7]/20' : service === 'pmdb-picks' ? 'bg-[#d946ef]/15 text-[#e879f9] ring-[#d946ef]/20' : service === 'mdblist' ? 'bg-[#22c55e]/15 text-[#4ade80] ring-[#22c55e]/20' : 'bg-[#ef4444]/15 text-[#f87171] ring-[#ef4444]/20'
  return (
    <div className="space-y-1.5">
      {lists.map((list) => {
        const key = `${service}:${list.id}`
        const added = isAlreadyAdded(key)
        const selected = isSelected?.(key) || false
        return (
          <button
            key={`${service}-${list.id}`}
            disabled={added}
            onClick={() => {
              onAdd({
                title: list.label,
                sourceType: service,
                providerListId: list.id,
                layout: list.type,
                enabled: true,
              })
              onClose()
            }}
            className={`group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border text-left transition-all ${
              added ? 'bg-white/[0.025] border-white/[0.05] opacity-60 cursor-default' : selected ? 'border-accent/30 bg-accent/10 cursor-pointer' : 'bg-white/[0.035] border-white/[0.07] hover:bg-white/[0.065] hover:border-white/[0.14] cursor-pointer'
            }`}
          >
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ring-1 ${badgeBg}`}>
              <span className="text-xs font-black">{label[0]}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white/85 truncate">{list.label}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="rounded-md bg-white/[0.055] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/35">poster</span>
                <span className="text-[10px] text-white/20">{label}</span>
              </div>
            </div>
            {added ? (
              <div className="flex items-center gap-1.5 flex-shrink-0 bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                <span className="text-[10px] text-emerald-400/80 font-semibold">Added</span>
              </div>
            ) : (
              <span className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border text-xs font-black transition-colors ${selected ? 'border-accent bg-accent text-black' : 'border-white/[0.14] bg-white/[0.03] text-transparent group-hover:border-white/30'}`}>
                ✓
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function AddWidgetOverlay({
  open,
  onClose,
  addons,
  homeRows,
  onAdd,
  editingRow,
  onUpdate,
  startMode = 'preset',
  onBatchAdd,
}: {
  open: boolean
  onClose: () => void
  addons: InstalledAddon[]
  homeRows: HomeRowConfig[]
  onAdd: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  editingRow?: HomeRowConfig | null
  onUpdate?: (id: string, updates: Partial<HomeRowConfig>) => void
  startMode?: 'preset' | 'discover'
  onBatchAdd?: (selections: PendingShelfSelection[]) => void
}) {
  const navigate = useNavigate()
  const clearCatalogRowCache = useCatalogStore((state) => state.clearRowCache)
  const [mode, setMode] = useState<'preset' | 'discover'>('preset')
  const [search, setSearch] = useState('')
  const [newMdblistName, setNewMdblistName] = useState('')
  const [creatingMdblistList, setCreatingMdblistList] = useState(false)
  const [editLayout, setEditLayout] = useState<'poster' | 'landscape' | 'list' | 'continue' | 'hero'>('poster')
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<'all' | 'builtin' | 'smart' | 'addons' | 'simkl' | 'trakt' | 'anilist' | 'pmdb' | 'pmdb-picks' | 'mdblist'>('all')
  const [selectedShelves, setSelectedShelves] = useState<PendingShelfSelection[]>([])
  const [pickerSource, setPickerSource] = useState<CatalogPickerSource | null>(null)
  const [pickerContentType, setPickerContentType] = useState<'all' | Exclude<CatalogContentType, 'unknown'>>('all')
  const [confirmPickerExit, setConfirmPickerExit] = useState(false)

  const queueShelf = useCallback((row: ShelfDraft, existingId?: string) => {
    const normalized = normalizeShelfDraft(row)
    const key = existingId ? `existing:${existingId}` : shelfDraftKey(normalized)
    setSelectedShelves((current) => current.some((item) => item.key === key)
      ? current.filter((item) => item.key !== key)
      : [...current, { key, row: normalized, existingId }])
  }, [])

  // ─── Standard Presets State ───
  const addonCatalogs = useMemo(() =>
    addons.filter((a) => a.enabled).flatMap((addon) =>
      addon.manifest.catalogs.map((cat: any) => ({
        addonId: addon.manifest.id,
        addonName: addon.manifest.name,
        catalogId: cat.id,
        catalogName: cat.name || cat.id,
        catalogType: cat.type as string,
        catalogExtra: defaultCatalogExtra(cat.extra),
        addonUrl: addon.url,
      }))
    ), [addons])

  const isAlreadyAdded = useCallback((key: string) => isCatalogUsedByHomeShelf(homeRows, key), [homeRows])

  const isPickerSelected = useCallback((key: string) => selectedShelves.some((item) => item.key === key), [selectedShelves])

  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()
  const [traktLists, setTraktLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(TRAKT_LIST_SOURCES)
  const [pmdbLists, setPmdbLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(PMDB_LIST_SOURCES)
  const [pmdbPicks, setPmdbPicks] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>([])
  const [mdblistLists, setMdblistLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(MDBLIST_LIST_SOURCES)
  const [mdblistPublicLists, setMdblistPublicLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>([])
  const [mdblistPublicSearch, setMdblistPublicSearch] = useState('')
  const [mdblistPublicSearching, setMdblistPublicSearching] = useState(false)
  const [traktPublicLists, setTraktPublicLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>([])
  const [traktPublicSearch, setTraktPublicSearch] = useState('')
  const [traktPublicSearching, setTraktPublicSearching] = useState(false)

  useEffect(() => {
    if (traktConnected) getAvailableTraktListSources().then(setTraktLists).catch(() => setTraktLists(TRAKT_LIST_SOURCES))
  }, [traktConnected])

  useEffect(() => {
    if (pmdbApiKey) getAvailablePmdbListSources().then(setPmdbLists).catch(() => setPmdbLists(PMDB_LIST_SOURCES))
  }, [pmdbApiKey])

  useEffect(() => {
    if (pmdbApiKey) getAvailablePmdbPickSources().then(setPmdbPicks).catch(() => setPmdbPicks([]))
    else setPmdbPicks([])
  }, [pmdbApiKey])

  useEffect(() => {
    if (mdblistApiKey) getAvailableMdblistSources().then(setMdblistLists).catch(() => setMdblistLists(MDBLIST_LIST_SOURCES))
    else setMdblistLists(MDBLIST_LIST_SOURCES)
  }, [mdblistApiKey])

  const handleMdblistPublicSearch = useCallback(async () => {
    const q = mdblistPublicSearch.trim()
    if (!q) return
    setMdblistPublicSearching(true)
    try {
      const results = await getAvailableMdblistSources(q)
      const publicOnly = results.filter((r) => !mdblistLists.some((own) => own.id === r.id) && r.id !== 'watchlist')
      setMdblistPublicLists(publicOnly)
    } catch (_) {
      setMdblistPublicLists([])
    } finally {
      setMdblistPublicSearching(false)
    }
  }, [mdblistPublicSearch, mdblistLists])

  const handleTraktPublicSearch = useCallback(async () => {
    const q = traktPublicSearch.trim()
    if (!q) return
    setTraktPublicSearching(true)
    try {
      const results = await searchTraktPublicListSources(q)
      const publicOnly = results.filter((r) => !traktLists.some((own) => own.id === r.id))
      setTraktPublicLists(publicOnly)
    } catch (_) {
      setTraktPublicLists([])
    } finally {
      setTraktPublicSearching(false)
    }
  }, [traktPublicSearch, traktLists])

  // ─── Global public-list search ───
  // The main search bar also searches Trakt/MDBList public lists, so users
  // don't have to discover the per-provider search boxes buried in sections.
  const [globalPublicTrakt, setGlobalPublicTrakt] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>([])
  const [globalPublicMdblist, setGlobalPublicMdblist] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>([])
  const [globalPublicSearching, setGlobalPublicSearching] = useState(false)

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2 || (!traktConnected && !mdblistApiKey)) {
      setGlobalPublicTrakt([])
      setGlobalPublicMdblist([])
      setGlobalPublicSearching(false)
      return
    }
    let cancelled = false
    setGlobalPublicSearching(true)
    const timer = setTimeout(async () => {
      const [traktResults, mdblistResults] = await Promise.all([
        traktConnected ? searchTraktPublicListSources(q).catch(() => []) : Promise.resolve([]),
        mdblistApiKey ? getAvailableMdblistSources(q).catch(() => []) : Promise.resolve([]),
      ])
      if (cancelled) return
      setGlobalPublicTrakt(traktResults.filter((r) => !traktLists.some((own) => own.id === r.id)))
      setGlobalPublicMdblist(mdblistResults.filter((r) => !mdblistLists.some((own) => own.id === r.id) && r.id !== 'watchlist'))
      setGlobalPublicSearching(false)
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, traktConnected, mdblistApiKey, traktLists, mdblistLists])

  const handleCreateMdblistList = async () => {
    const name = newMdblistName.trim()
    if (!name || creatingMdblistList) return
    setCreatingMdblistList(true)
    try {
      const created = await createMdblistList(name)
      if (created) {
        setMdblistLists((current) => [
          ...current,
          { id: `list:${created.id}`, label: `MDBList - ${created.name}`, layout: 'poster' as const },
        ])
        setNewMdblistName('')
      }
    } finally {
      setCreatingMdblistList(false)
    }
  }

  const filteredPmdbAddonCatalogs = useMemo(() => {
    const pmdbCatalogs = addonCatalogs.filter((c) => {
      const name = (c.catalogName || '').toLowerCase()
      const id = (c.catalogId || '').toLowerCase()
      const addonId = (c.addonId || '').toLowerCase()
      const addonName = (c.addonName || '').toLowerCase()
      return (
        name.includes('pmdb') || name.includes('publicmetadb') || name.includes('aiometadata') || name.includes('picks') ||
        id.includes('pmdb') || id.includes('publicmetadb') || id.includes('aiometadata') || id.includes('picks') ||
        addonId.includes('publicmetadb') || addonId.includes('aiometadata') ||
        addonName.includes('pmdb') || addonName.includes('publicmetadb') || addonName.includes('aiometadata')
      )
    })
    if (!search) return pmdbCatalogs
    const q = search.toLowerCase()
    return pmdbCatalogs.filter((c) =>
      c.catalogName.toLowerCase().includes(q) ||
      c.addonName.toLowerCase().includes(q) ||
      c.catalogType.toLowerCase().includes(q)
    )
  }, [addonCatalogs, search])

  const filteredOtherAddonCatalogs = useMemo(() => {
    const otherCatalogs = addonCatalogs.filter((c) => {
      const name = (c.catalogName || '').toLowerCase()
      const id = (c.catalogId || '').toLowerCase()
      const addonId = (c.addonId || '').toLowerCase()
      const addonName = (c.addonName || '').toLowerCase()
      return !(
        name.includes('pmdb') || name.includes('publicmetadb') || name.includes('aiometadata') || name.includes('picks') ||
        id.includes('pmdb') || id.includes('publicmetadb') || id.includes('aiometadata') || id.includes('picks') ||
        addonId.includes('publicmetadb') || addonId.includes('aiometadata') ||
        addonName.includes('pmdb') || addonName.includes('publicmetadb') || addonName.includes('aiometadata')
      )
    })
    if (!search) return otherCatalogs
    const q = search.toLowerCase()
    return otherCatalogs.filter((c) =>
      c.catalogName.toLowerCase().includes(q) ||
      c.addonName.toLowerCase().includes(q) ||
      c.catalogType.toLowerCase().includes(q)
    )
  }, [addonCatalogs, search])

  const filteredSimklLists = useMemo(() => {
    if (!search) return SIMKL_LIBRARY_CATALOGS
    const q = search.toLowerCase()
    return SIMKL_LIBRARY_CATALOGS.filter((l) =>
      l.label.toLowerCase().includes(q) ||
      l.group.toLowerCase().includes(q) ||
      l.section?.toLowerCase().includes(q)
    )
  }, [search])

  const filteredAniListLists = useMemo(() => {
    if (!search) return ANILIST_WIDGET_LISTS
    const q = search.toLowerCase()
    return ANILIST_WIDGET_LISTS.filter((l) => l.label.toLowerCase().includes(q))
  }, [search])

  const filteredTraktLists = useMemo(() => {
    if (!search) return traktLists
    const q = search.toLowerCase()
    return traktLists.filter((l) => l.label.toLowerCase().includes(q))
  }, [search, traktLists])

  const filteredPmdbLists = useMemo(() => {
    if (!search) return pmdbLists
    const q = search.toLowerCase()
    return pmdbLists.filter((l) => l.label.toLowerCase().includes(q))
  }, [search, pmdbLists])

  const filteredPmdbPicks = useMemo(() => {
    if (!search) return pmdbPicks
    const q = search.toLowerCase()
    return pmdbPicks.filter((pick) => pick.label.toLowerCase().includes(q))
  }, [search, pmdbPicks])

  const filteredMdblistLists = useMemo(() => {
    if (!search) return mdblistLists
    const q = search.toLowerCase()
    return mdblistLists.filter((l) => l.label.toLowerCase().includes(q))
  }, [search, mdblistLists])

  const filteredMdblistPublicLists = useMemo(() => {
    if (!search) return mdblistPublicLists
    const q = search.toLowerCase()
    return mdblistPublicLists.filter((l) => l.label.toLowerCase().includes(q))
  }, [search, mdblistPublicLists])

  // ─── Smart Collection form state ───
  const [catalogName, setCatalogName] = useState('')
  const [source, setSource] = useState<'TMDB' | 'TVDB' | 'Simkl' | 'AniList'>('TMDB')
  const [contentType, setContentType] = useState<'movie' | 'series'>('movie')
  const [sortBy, setSortBy] = useState('popularity.desc')
  const [cacheTtl, setCacheTtl] = useState(43200)
  const [releasedOnly, setReleasedOnly] = useState(true)
  const [includeAdult, setIncludeAdult] = useState(false)

  // Reference lists fetched dynamically
  const [genresList, setGenresList] = useState<{ id: number; name: string }[]>([])
  const [languagesList, setLanguagesList] = useState<{ iso_639_1: string; english_name: string }[]>([])
  const [countriesList, setCountriesList] = useState<{ iso_3166_1: string; english_name: string }[]>([])
  const [certificationsMap, setCertificationsMap] = useState<Record<string, { certification: string; order: number }[]>>({})
  const [allProviders, setAllProviders] = useState<TmdbWatchProvider[]>([])

  const quickSelectProviders = useMemo(() => {
    const quickNames = ['netflix', 'amazon prime video', 'disney plus', 'apple tv', 'crunchyroll', 'max', 'hulu', 'peacock']
    return allProviders.filter((p) =>
      quickNames.some((name) => p.provider_name.toLowerCase().includes(name))
    ).slice(0, 12)
  }, [allProviders])

  // Selected filters
  const [selectedIncludeGenres, setSelectedIncludeGenres] = useState<string[]>([])
  const [selectedExcludeGenres, setSelectedExcludeGenres] = useState<string[]>([])
  const [genreMatchMode, setGenreMatchMode] = useState<'AND' | 'OR'>('OR')
  const [originalLanguage, setOriginalLanguage] = useState('Any')
  const [originCountry, setOriginCountry] = useState('Any')
  const [releaseRegion, setReleaseRegion] = useState('Any')
  const [certificationCountry, setCertificationCountry] = useState('None')
  const [certification, setCertification] = useState('None')

  // People autocomplete suggestions
  const [peopleList, setPeopleList] = useState<{ id: number; name: string }[]>([])
  const [peopleMatchMode, setPeopleMatchMode] = useState<'AND' | 'OR'>('OR')
  const [peopleSearch, setPeopleSearch] = useState('')
  const [peopleSuggestions, setPeopleSuggestions] = useState<{ id: number; name: string; profile_path?: string }[]>([])

  // Companies autocomplete suggestions
  const [includeCompanies, setIncludeCompanies] = useState<{ id: number; name: string }[]>([])
  const [excludeCompanies, setExcludeCompanies] = useState<{ id: number; name: string }[]>([])
  const [companyMatchMode, setCompanyMatchMode] = useState<'AND' | 'OR'>('OR')
  const [companySearch, setCompanySearch] = useState('')
  const [companySuggestions, setCompanySuggestions] = useState<{ id: number; name: string }[]>([])

  // Keywords autocomplete suggestions
  const [includeKeywords, setIncludeKeywords] = useState<{ id: number; name: string }[]>([])
  const [excludeKeywords, setExcludeKeywords] = useState<{ id: number; name: string }[]>([])
  const [keywordMatchMode, setKeywordMatchMode] = useState<'AND' | 'OR'>('OR')
  const [keywordSearch, setKeywordSearch] = useState('')
  const [keywordSuggestions, setKeywordSuggestions] = useState<{ id: number; name: string }[]>([])

  // Streaming selection
  const [watchRegion, setWatchRegion] = useState('US')
  const [providerMatchMode, setProviderMatchMode] = useState<'AND' | 'OR'>('OR')
  const [providerSearch, setProviderSearch] = useState('')
  const [selectedProviders, setSelectedProviders] = useState<{ id: number; name: string; logo?: string }[]>([])

  // Numeric and ranges
  const [voteAverageMin, setVoteAverageMin] = useState(0)
  const [voteAverageMax, setVoteAverageMax] = useState(10)
  const [voteCountMin, setVoteCountMin] = useState('')
  const [runtimeMin, setRuntimeMin] = useState('')
  const [runtimeMax, setRuntimeMax] = useState('')
  const [releaseDateFrom, setReleaseDateFrom] = useState('')
  const [releaseDateTo, setReleaseDateTo] = useState('')
  const [maxResults, setMaxResults] = useState('')
  const [presetName, setPresetName] = useState('')
  const [showOnHome, setShowOnHome] = useState(false)

  // Test preview
  const [previewItems, setPreviewItems] = useState<SearchResult[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [advancedBuilderOpen, setAdvancedBuilderOpen] = useState(false)
  const [quickEditor, setQuickEditor] = useState<string | null>(null)
  const [savingDiscover, setSavingDiscover] = useState(false)

  // Prefill state hooks if in edit mode, reset to defaults otherwise
  useEffect(() => {
    if (open && editingRow) {
      setCatalogName(editingRow.title || '')
      setEditLayout(editingRow.layout || 'poster')
      setShowOnHome(editingRow.enabled)
      
      if (editingRow.sourceType === 'discover' && editingRow.discoverConfig) {
        setMode('discover')
        const config = editingRow.discoverConfig
        setSource('TMDB')
        setContentType(config.contentType || 'movie')
        setSortBy(config.sortBy || 'popularity.desc')
        setCacheTtl(config.cacheTtl ?? 43200)
        setReleasedOnly(config.releasedOnly ?? true)
        setIncludeAdult(config.includeAdult ?? false)
        setSelectedIncludeGenres(config.includeGenres || [])
        setSelectedExcludeGenres(config.excludeGenres || [])
        setGenreMatchMode(config.genreMatchMode || 'OR')
        setOriginalLanguage(config.originalLanguage || 'Any')
        setOriginCountry(config.originCountry || 'Any')
        setReleaseRegion(config.releaseRegion || 'Any')
        setCertificationCountry(config.certificationCountry || 'None')
        setCertification(config.certification || 'None')
        setPeopleList((config.people || []).map((p) => ({ id: Number(p.id), name: p.name })))
        setPeopleMatchMode(config.peopleMatchMode || 'OR')
        setIncludeCompanies((config.includeCompanies || []).map((c) => ({ id: Number(c.id), name: c.name })))
        setExcludeCompanies((config.excludeCompanies || []).map((c) => ({ id: Number(c.id), name: c.name })))
        setCompanyMatchMode(config.companyMatchMode || 'OR')
        setIncludeKeywords((config.includeKeywords || []).map((k) => ({ id: Number(k.id), name: k.name })))
        setExcludeKeywords((config.excludeKeywords || []).map((k) => ({ id: Number(k.id), name: k.name })))
        setKeywordMatchMode(config.keywordMatchMode || 'OR')
        setWatchRegion(config.watchRegion || 'US')
        setProviderMatchMode(config.providerMatchMode || 'OR')
        setSelectedProviders((config.selectedProviders || []).map((p) => ({ id: Number(p.id), name: p.name, logo: p.logo })))
        setVoteAverageMin(config.voteAverageMin ?? 0)
        setVoteAverageMax(config.voteAverageMax ?? 10)
        setVoteCountMin(config.voteCountMin !== undefined ? String(config.voteCountMin) : '')
        setRuntimeMin(config.runtimeMin !== undefined ? String(config.runtimeMin) : '')
        setRuntimeMax(config.runtimeMax !== undefined ? String(config.runtimeMax) : '')
        setReleaseDateFrom(config.releaseDateFrom || '')
        setReleaseDateTo(config.releaseDateTo || '')
        setMaxResults(config.maxResults !== undefined ? String(config.maxResults) : '')
        setPresetName(config.presetName || '')
      } else {
        setMode('preset')
      }
    } else {
      // Reset to default
      setQuickEditor(null)
      setMode(startMode)
      setCatalogName('')
      setSource('TMDB')
      setContentType('movie')
      setSortBy('popularity.desc')
      setCacheTtl(43200)
      setReleasedOnly(true)
      setIncludeAdult(false)
      setSelectedIncludeGenres([])
      setSelectedExcludeGenres([])
      setGenreMatchMode('OR')
      setOriginalLanguage('Any')
      setOriginCountry('Any')
      setReleaseRegion('Any')
      setCertificationCountry('None')
      setCertification('None')
      setPeopleList([])
      setPeopleMatchMode('OR')
      setIncludeCompanies([])
      setExcludeCompanies([])
      setCompanyMatchMode('OR')
      setIncludeKeywords([])
      setExcludeKeywords([])
      setKeywordMatchMode('OR')
      setWatchRegion('US')
      setProviderMatchMode('OR')
      setSelectedProviders([])
      setVoteAverageMin(0)
      setVoteAverageMax(10)
      setVoteCountMin('')
      setRuntimeMin('')
      setRuntimeMax('')
      setReleaseDateFrom('')
      setReleaseDateTo('')
      setMaxResults('')
      setPresetName('')
      setEditLayout('poster')
      setShowOnHome(newSmartCollectionDefaults().enabled)
      setSelectedShelves([])
      setPickerSource(null)
      setPickerContentType('all')
    }
  }, [open, editingRow, startMode])

  const applySmartCollectionTemplate = (template: SmartCollectionTemplate) => {
    const rules = template.rules
    setCatalogName(template.label)
    setSource('TMDB')
    setContentType(template.contentType)
    setSortBy(rules.sortBy || 'popularity.desc')
    setReleasedOnly(true)
    setIncludeAdult(false)
    setSelectedIncludeGenres(rules.includeGenres || [])
    setSelectedExcludeGenres(rules.excludeGenres || [])
    setGenreMatchMode(rules.genreMatchMode || 'OR')
    setOriginalLanguage('Any')
    setOriginCountry('Any')
    setReleaseRegion('Any')
    setCertificationCountry(rules.certificationCountry || 'None')
    setCertification(rules.certification || 'None')
    setPeopleList([])
    setPeopleMatchMode('OR')
    setIncludeCompanies([])
    setExcludeCompanies([])
    setCompanyMatchMode('OR')
    setIncludeKeywords([])
    setExcludeKeywords([])
    setKeywordMatchMode('OR')
    setWatchRegion('US')
    setProviderMatchMode('OR')
    setSelectedProviders([])
    setVoteAverageMin(rules.voteAverageMin ?? 0)
    setVoteAverageMax(rules.voteAverageMax ?? 10)
    setVoteCountMin(rules.voteCountMin !== undefined ? String(rules.voteCountMin) : '')
    setRuntimeMin(rules.runtimeMin !== undefined ? String(rules.runtimeMin) : '')
    setRuntimeMax(rules.runtimeMax !== undefined ? String(rules.runtimeMax) : '')
    setReleaseDateFrom(rules.releaseDateFrom || '')
    setReleaseDateTo(rules.releaseDateTo || '')
    setMaxResults('')
    setPresetName(template.id)
  }

  // Autocomplete debouncing hooks
  useEffect(() => {
    if (!peopleSearch.trim()) { setPeopleSuggestions([]); return }
    const t = setTimeout(async () => {
      const results = await searchTmdbPeople(peopleSearch)
      setPeopleSuggestions(results.slice(0, 5))
    }, 350)
    return () => clearTimeout(t)
  }, [peopleSearch])

  useEffect(() => {
    if (originalLanguage === '') setOriginalLanguage('Any')
  }, [originalLanguage])

  useEffect(() => {
    if (!companySearch.trim()) { setCompanySuggestions([]); return }
    const t = setTimeout(async () => {
      const results = await searchTmdbCompanies(companySearch)
      setCompanySuggestions(results.slice(0, 5))
    }, 350)
    return () => clearTimeout(t)
  }, [companySearch])

  useEffect(() => {
    if (!keywordSearch.trim()) { setKeywordSuggestions([]); return }
    const t = setTimeout(async () => {
      const results = await searchTmdbKeywords(keywordSearch)
      setKeywordSuggestions(results.slice(0, 5))
    }, 350)
    return () => clearTimeout(t)
  }, [keywordSearch])

  // Load TMDB Reference Lists
  useEffect(() => {
    if (!open || mode !== 'discover') return
    const loadData = async () => {
      try {
        const type = contentType === 'movie' ? 'movie' : 'tv'
        const [gList, lList, cList, certs, pList] = await Promise.all([
          getTmdbGenres(type),
          getTmdbLanguages(),
          getTmdbCountries(),
          getTmdbCertifications(type),
          getTmdbWatchProviders(type, watchRegion),
        ])
        setGenresList(gList)
        setLanguagesList(lList)
        setCountriesList(cList)
        setCertificationsMap(certs)
        setAllProviders(pList)
      } catch (e) {
        console.error('Failed to load TMDB reference lists', e)
      }
    }
    loadData()
  }, [open, mode, contentType, watchRegion])

  // Filtered providers listing
  const filteredProviders = useMemo(() => {
    if (!providerSearch.trim()) return allProviders
    const q = providerSearch.toLowerCase()
    return allProviders.filter((p) => p.provider_name.toLowerCase().includes(q))
  }, [allProviders, providerSearch])

  // Certification Options
  const certificationCountries = Object.keys(certificationsMap)
  const certificationsForCountry = certificationCountry && certificationsMap[certificationCountry]
    ? certificationsMap[certificationCountry].sort((a, b) => a.order - b.order)
    : []

  // Presets trigger
  const applyPreset = (preset: string) => {
    const now = new Date()
    const currentYear = now.getFullYear()
    let from = ''
    let to = ''

    switch (preset) {
      case 'This Month': {
        const firstDay = new Date(currentYear, now.getMonth(), 1)
        const lastDay = new Date(currentYear, now.getMonth() + 1, 0)
        from = firstDay.toISOString().split('T')[0]
        to = lastDay.toISOString().split('T')[0]
        break
      }
      case 'Last Month': {
        const firstDay = new Date(currentYear, now.getMonth() - 1, 1)
        const lastDay = new Date(currentYear, now.getMonth(), 0)
        from = firstDay.toISOString().split('T')[0]
        to = lastDay.toISOString().split('T')[0]
        break
      }
      case 'This Year': {
        from = `${currentYear}-01-01`
        to = `${currentYear}-12-31`
        break
      }
      case 'Last Year': {
        from = `${currentYear - 1}-01-01`
        to = `${currentYear - 1}-12-31`
        break
      }
      case 'Last 5 Years': {
        from = `${currentYear - 5}-01-01`
        to = now.toISOString().split('T')[0]
        break
      }
      case 'Last 10 Years': {
        from = `${currentYear - 10}-01-01`
        to = now.toISOString().split('T')[0]
        break
      }
      case '2010s': {
        from = '2010-01-01'
        to = '2019-12-31'
        break
      }
      case '2000s': {
        from = '2000-01-01'
        to = '2009-12-31'
        break
      }
      case '1990s': {
        from = '1990-01-01'
        to = '1999-12-31'
        break
      }
      case '1980s': {
        from = '1980-01-01'
        to = '1989-12-31'
        break
      }
      case 'Clear':
      default:
        from = ''
        to = ''
        break
    }

    setReleaseDateFrom(from)
    setReleaseDateTo(to)
    setPresetName(preset)
  }

  // Active filters JSON preview
  const livePreview = useMemo(() => {
    const obj: Record<string, any> = {
      sort_by: sortBy,
      include_adult: includeAdult,
      watch_region: watchRegion,
    }
    if (selectedIncludeGenres.length > 0) {
      obj.with_genres = selectedIncludeGenres.join(genreMatchMode === 'AND' ? ',' : '|')
    }
    if (selectedExcludeGenres.length > 0) {
      obj.without_genres = selectedExcludeGenres.join(',')
    }
    if (originalLanguage && originalLanguage !== 'Any') {
      obj.with_original_language = originalLanguage
    }
    if (originCountry && originCountry !== 'Any') {
      obj.with_origin_country = originCountry
    }
    if (releaseRegion && releaseRegion !== 'Any') {
      obj.region = releaseRegion
    }
    if (certificationCountry && certificationCountry !== 'None') {
      obj.certification_country = certificationCountry
      if (certification && certification !== 'None') {
        obj.certification = certification
      }
    }
    if (peopleList.length > 0) {
      obj.with_people = peopleList.map((p) => p.id).join(peopleMatchMode === 'AND' ? ',' : '|')
    }
    if (includeCompanies.length > 0) {
      obj.with_companies = includeCompanies.map((c) => c.id).join(companyMatchMode === 'AND' ? ',' : '|')
    }
    if (excludeCompanies.length > 0) {
      obj.without_companies = excludeCompanies.map((c) => c.id).join(',')
    }
    if (includeKeywords.length > 0) {
      obj.with_keywords = includeKeywords.map((k) => k.id).join(keywordMatchMode === 'AND' ? ',' : '|')
    }
    if (excludeKeywords.length > 0) {
      obj.without_keywords = excludeKeywords.map((k) => k.id).join(',')
    }
    if (selectedProviders.length > 0) {
      obj.with_watch_providers = selectedProviders.map((p) => p.id).join(providerMatchMode === 'AND' ? ',' : '|')
    }
    if (voteAverageMin > 0 || voteAverageMax < 10) {
      obj.vote_average = `${voteAverageMin} - ${voteAverageMax}`
    }
    if (voteCountMin) {
      obj.vote_count_gte = voteCountMin
    }
    if (runtimeMin || runtimeMax) {
      obj.runtime = `${runtimeMin || 0} - ${runtimeMax || 'Any'}`
    }
    if (releaseDateFrom || releaseDateTo) {
      obj.release_date = `${releaseDateFrom || 'Any'} to ${releaseDateTo || 'Any'}`
    }
    return obj
  }, [
    sortBy, includeAdult, watchRegion, selectedIncludeGenres, selectedExcludeGenres, genreMatchMode,
    originalLanguage, originCountry, releaseRegion, certificationCountry, certification,
    peopleList, peopleMatchMode, includeCompanies, excludeCompanies, companyMatchMode,
    includeKeywords, excludeKeywords, keywordMatchMode, selectedProviders, providerMatchMode,
    voteAverageMin, voteAverageMax, voteCountMin, runtimeMin, runtimeMax, releaseDateFrom, releaseDateTo
  ])

  const builderPrompt = useMemo(() => {
    const sortLabel: Record<string, string> = {
      'popularity.desc': 'popular',
      'vote_average.desc': 'highly rated',
      'primary_release_date.desc': 'recent',
      'release_date.desc': 'recent',
    }
    const parts: string[] = [sortLabel[sortBy] || 'matching']
    if (voteAverageMin > 0) parts.push(`rated ${voteAverageMin}+`)
    if (voteCountMin) parts.push(`with at least ${voteCountMin} votes`)
    if (selectedIncludeGenres.length) parts.push(`${genreMatchMode === 'AND' ? 'with all of' : 'with'} ${selectedIncludeGenres.map((id) => genresList.find((genre) => String(genre.id) === id)?.name || id).join(', ')}`)
    if (selectedExcludeGenres.length) parts.push(`but not ${selectedExcludeGenres.map((id) => genresList.find((genre) => String(genre.id) === id)?.name || id).join(', ')}`)
    if (originalLanguage !== 'Any') parts.push(`in ${languagesList.find((language) => language.iso_639_1 === originalLanguage)?.english_name || originalLanguage}`)
    if (originCountry !== 'Any') parts.push(`from ${countriesList.find((country) => country.iso_3166_1 === originCountry)?.english_name || originCountry}`)
    if (peopleList.length) parts.push(`featuring ${peopleList.map((person) => person.name).join(', ')}`)
    if (includeCompanies.length) parts.push(`from ${includeCompanies.map((company) => company.name).join(', ')}`)
    if (includeKeywords.length) parts.push(`about ${includeKeywords.map((keyword) => keyword.name).join(', ')}`)
    if (excludeKeywords.length) parts.push(`excluding ${excludeKeywords.map((keyword) => keyword.name).join(', ')}`)
    if (selectedProviders.length) parts.push(`available on ${selectedProviders.map((provider) => provider.name).join(', ')}`)
    if (runtimeMax) parts.push(`under ${runtimeMax} minutes`)
    else if (runtimeMin) parts.push(`over ${runtimeMin} minutes`)
    if (releaseDateFrom || releaseDateTo) parts.push(releaseDateFrom && releaseDateTo ? `released from ${releaseDateFrom} to ${releaseDateTo}` : releaseDateFrom ? `released after ${releaseDateFrom}` : `released before ${releaseDateTo}`)
    return `${parts.join(', ')} ${contentType === 'movie' ? 'movies' : 'TV shows'}${releasedOnly ? ' that are released' : ''}.`
  }, [sortBy, voteAverageMin, voteCountMin, selectedIncludeGenres, selectedExcludeGenres, genreMatchMode, genresList, originalLanguage, languagesList, originCountry, countriesList, peopleList, includeCompanies, includeKeywords, excludeKeywords, selectedProviders, runtimeMin, runtimeMax, releaseDateFrom, releaseDateTo, contentType, releasedOnly])

  // Run Discovery Test Preview
  const runPreview = async () => {
    setPreviewLoading(true)
    try {
      const config: DiscoverConfig = {
        source: 'TMDB',
        contentType,
        sortBy,
        cacheTtl,
        releasedOnly,
        includeAdult,
        includeGenres: selectedIncludeGenres,
        excludeGenres: selectedExcludeGenres,
        genreMatchMode,
        originalLanguage,
        originCountry,
        releaseRegion,
        certificationCountry,
        certification,
        people: peopleList,
        peopleMatchMode,
        includeCompanies,
        excludeCompanies,
        companyMatchMode,
        includeKeywords,
        excludeKeywords,
        keywordMatchMode,
        watchRegion,
        providerMatchMode,
        selectedProviders: selectedProviders.map((p) => ({ id: p.id, name: p.name })),
        voteAverageMin,
        voteAverageMax,
        voteCountMin: voteCountMin ? parseInt(voteCountMin) : undefined,
        runtimeMin: runtimeMin ? parseInt(runtimeMin) : undefined,
        runtimeMax: runtimeMax ? parseInt(runtimeMax) : undefined,
        releaseDateFrom,
        releaseDateTo,
        maxResults: maxResults ? parseInt(maxResults) : undefined,
        presetName,
      }
      const results = await discoverTmdb(config, 1)
      setPreviewItems(results)
    } catch (e) {
      console.error(e)
    } finally {
      setPreviewLoading(false)
    }
  }

  // Save Smart Collection
  const handleSaveDiscover = async () => {
    if (savingDiscover) return
    const name = catalogName.trim() || `Discover: ${source} - ${contentType === 'movie' ? 'Movies' : 'TV Shows'}`
    const config: DiscoverConfig = {
      source: 'TMDB',
      contentType,
      sortBy,
      cacheTtl,
      releasedOnly,
      includeAdult,
      includeGenres: selectedIncludeGenres,
      excludeGenres: selectedExcludeGenres,
      genreMatchMode,
      originalLanguage,
      originCountry,
      releaseRegion,
      certificationCountry,
      certification,
      people: peopleList,
      peopleMatchMode,
      includeCompanies,
      excludeCompanies,
      companyMatchMode,
      includeKeywords,
      excludeKeywords,
      keywordMatchMode,
      watchRegion,
      providerMatchMode,
      selectedProviders: selectedProviders.map((p) => ({ id: p.id, name: p.name })),
      voteAverageMin,
      voteAverageMax,
      voteCountMin: voteCountMin ? parseInt(voteCountMin) : undefined,
      runtimeMin: runtimeMin ? parseInt(runtimeMin) : undefined,
      runtimeMax: runtimeMax ? parseInt(runtimeMax) : undefined,
      releaseDateFrom,
      releaseDateTo,
      maxResults: maxResults ? parseInt(maxResults) : undefined,
      presetName,
    }

    setSavingDiscover(true)
    try {
      // An edited Smart Collection keeps its row ID. Warm its new cache entry before
      // updating the row so CatalogPage renders the new rule set immediately.
      if (editingRow) {
        clearCatalogRowCache(editingRow.id)
        try {
          await discoverTmdbWithCache(config, `catalog-${editingRow.id}-p1`, true)
        } catch (error) {
          // Persist the new rules even while offline; CatalogPage will fetch when it can.
          console.warn('Unable to warm Smart Collection cache', error)
        }
        onUpdate?.(editingRow.id, {
          title: name,
          layout: contentType === 'movie' ? 'poster' : 'landscape',
          discoverConfig: config,
          enabled: showOnHome,
        })
      } else {
        onAdd({
          title: name,
          sourceType: 'discover',
          layout: contentType === 'movie' ? 'poster' : 'landscape',
          enabled: showOnHome,
          discoverConfig: config,
        })
      }
      onClose()
    } catch (error) {
      console.error('Unable to refresh Smart Collection results', error)
    } finally {
      setSavingDiscover(false)
    }
  }

  // Save Standard Shelf (non-discover) Edit
  const handleSaveStandardEdit = () => {
    if (editingRow && onUpdate) {
      onUpdate(editingRow.id, {
        title: catalogName.trim() || editingRow.title,
        layout: editLayout,
      })
    }
    onClose()
  }

  if (!open) return null

  // Source color helpers
  const sourceColors: Record<string, { bg: string; text: string; border: string; dot: string }> = {
    simkl: { bg: 'bg-[#0ea5e9]/15', text: 'text-[#0ea5e9]', border: 'border-l-[#0ea5e9]', dot: 'bg-[#0ea5e9]' },
    trakt: { bg: 'bg-[#ef4444]/15', text: 'text-[#ef4444]', border: 'border-l-[#ef4444]', dot: 'bg-[#ef4444]' },
    anilist: { bg: 'bg-[#3b82f6]/15', text: 'text-[#3b82f6]', border: 'border-l-[#3b82f6]', dot: 'bg-[#3b82f6]' },
    pmdb: { bg: 'bg-[#a855f7]/15', text: 'text-[#a855f7]', border: 'border-l-[#a855f7]', dot: 'bg-[#a855f7]' },
    'pmdb-picks': { bg: 'bg-[#d946ef]/15', text: 'text-[#d946ef]', border: 'border-l-[#d946ef]', dot: 'bg-[#d946ef]' },
    mdblist: { bg: 'bg-[#22c55e]/15', text: 'text-[#22c55e]', border: 'border-l-[#22c55e]', dot: 'bg-[#22c55e]' },
    builtin: { bg: 'bg-accent/15', text: 'text-accent', border: 'border-l-accent', dot: 'bg-accent' },
    addons: { bg: 'bg-orange-500/15', text: 'text-orange-400', border: 'border-l-orange-400', dot: 'bg-orange-400' },
    smart: { bg: 'bg-amber-500/15', text: 'text-amber-300', border: 'border-l-amber-400', dot: 'bg-amber-400' },
  }

  const addSimklCatalog = (list: typeof SIMKL_LIBRARY_CATALOGS[number]) => {
    queueShelf({
      title: list.label,
      sourceType: 'simkl',
      providerListId: list.id,
      layout: 'poster',
      enabled: true,
      showRank: false,
    })
  }

  const renderSimklCatalogButton = (list: typeof SIMKL_LIBRARY_CATALOGS[number]) => {
    const added = isAlreadyAdded(`simkl:${list.id}`)
    const selected = isPickerSelected(`simkl:${list.id}`)
    return (
      <button
        key={list.id}
        disabled={added}
        onClick={() => addSimklCatalog(list)}
        className={`group min-h-10 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-white/[0.06] backdrop-blur-sm transition-all ${
          added ? 'bg-white/[0.025] opacity-55 cursor-default' : selected ? 'border-accent/30 bg-accent/10 cursor-pointer' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] cursor-pointer'
        }`}
      >
        {added || selected ? (
          <svg className="w-3 h-3 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
        ) : (
          <svg className="w-3 h-3 text-white/35 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24"><path d="M12 5v14m7-7H5" /></svg>
        )}
        <span className="text-[11px] font-bold text-white/75 truncate">{list.label}</span>
      </button>
    )
  }

  const visibleSimklCatalogs = {
    watchlist: filteredSimklLists.filter((list) => list.group === 'watchlist'),
  }

  // Toggle component for checkboxes
  const PillToggle = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all cursor-pointer select-none ${
        checked
          ? 'bg-accent/15 border-accent/40 text-accent'
          : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:text-white/60'
      }`}
    >
      <div className={`w-7 h-4 rounded-full flex items-center transition-all ${checked ? 'bg-accent justify-end' : 'bg-white/10 justify-start'}`}>
        <div className={`w-3 h-3 rounded-full mx-0.5 transition-all ${checked ? 'bg-black' : 'bg-white/30'}`} />
      </div>
      {label}
    </button>
  )

  // Match mode toggle
  const MatchModeToggle = ({ value, onChange, name }: { value: 'AND' | 'OR'; onChange: (v: 'AND' | 'OR') => void; name: string }) => (
    <div className="flex rounded-lg border border-white/[0.06] overflow-hidden">
      {(['OR', 'AND'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`px-3 py-1.5 text-[10px] font-bold transition-all cursor-pointer ${
            value === m ? 'bg-accent/20 text-accent' : 'bg-white/[0.02] text-white/30 hover:text-white/50'
          }`}
        >
          {m === 'OR' ? 'Any' : 'All'}
        </button>
      ))}
    </div>
  )

  // Styled select component
  const styledSelect = "w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40 transition-colors"
  const styledInput = "w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-accent/40 transition-colors"

  const renderCatalogBrowser = () => {
    const providerItems = (
      source: Exclude<CatalogPickerSource, 'builtin' | 'smart' | 'addons' | 'simkl'>,
      lists: { id: string; label: string; layout: 'poster' | 'landscape' }[],
      group: string,
      isPublic = false,
    ): CatalogPickerItem[] => lists.map((list) => {
      const row: ShelfDraft = { title: list.label, sourceType: source, providerListId: list.id, layout: 'poster', enabled: true }
      const key = shelfDraftKey(row)
      return { key, source, group, title: list.label.replace(/^(Trakt|PMDB|MDBList|AniList)\s*-\s*/i, ''), subtitle: isPublic ? `Public ${source} list` : `${source} account list`, contentType: inferCatalogContentType(list.id, list.label), row, added: isAlreadyAdded(`${source}:${list.id}`), isPublic }
    })

    const items: CatalogPickerItem[] = []
    const continueRow: ShelfDraft = { title: 'Continue Watching', sourceType: 'local', layout: 'continue', enabled: true }
    items.push({ key: 'builtin:continue', source: 'builtin', group: 'Built-in', title: 'Continue Watching', subtitle: 'Resume where you left off', contentType: 'unknown', row: continueRow, added: homeRows.some((row) => row.layout === 'continue') })

    homeRows.filter((row) => row.sourceType === 'discover').forEach((row) => {
      items.push({ key: `existing:${row.id}`, source: 'smart', group: 'Smart Collections', title: row.title, subtitle: 'Dynamic collection', contentType: row.discoverConfig?.contentType === 'movie' ? 'movie' : 'series', row: { ...row, layout: 'poster', enabled: true }, existingId: row.id, added: row.enabled })
    })

    addonCatalogs.forEach((catalog) => {
      const row: ShelfDraft = { title: catalog.catalogName, addonId: catalog.addonId, addonUrl: catalog.addonUrl, catalogType: catalog.catalogType, catalogId: catalog.catalogId, catalogExtra: catalog.catalogExtra, layout: 'poster', enabled: true }
      items.push({ key: shelfDraftKey(row), source: 'addons', group: catalog.addonName, title: catalog.catalogName, subtitle: `${catalog.addonName} • ${catalog.catalogType}`, contentType: inferCatalogContentType(catalog.catalogId, catalog.catalogName, catalog.catalogType), row, added: isAlreadyAdded(`${catalog.addonId}::${catalog.catalogType}::${catalog.catalogId}`) })
    })

    SIMKL_LIBRARY_CATALOGS.forEach((list) => {
      const row: ShelfDraft = { title: list.label, sourceType: 'simkl', providerListId: list.id, layout: 'poster', enabled: true, showRank: false }
      items.push({ key: shelfDraftKey(row), source: 'simkl', group: list.section || list.group, title: list.label, subtitle: `Simkl • ${list.group}`, contentType: inferCatalogContentType(list.id, `${list.label} ${list.section || ''}`), row, added: isAlreadyAdded(`simkl:${list.id}`) })
    })

    items.push(...providerItems('trakt', traktLists, 'My Trakt Lists'))
    items.push(...providerItems('anilist', ANILIST_WIDGET_LISTS.map((list) => ({ id: list.id, label: list.label, layout: list.type })), 'My Anime Lists'))
    items.push(...providerItems('pmdb', pmdbLists, 'My PMDB Lists'))
    items.push(...providerItems('pmdb-picks', pmdbPicks.map((list) => ({ id: list.id, label: list.label, layout: list.layout })), 'Personalized Picks'))
    items.push(...providerItems('mdblist', mdblistLists, 'My MDBList Lists'))
    items.push(...providerItems('trakt', [...traktPublicLists, ...globalPublicTrakt], 'Public Trakt Lists', true))
    items.push(...providerItems('mdblist', [...mdblistPublicLists, ...globalPublicMdblist], 'Public MDBList Lists', true))

    const deduplicated = items.filter((item, index, all) => all.findIndex((candidate) => candidate.key === item.key) === index)
    const sourceMeta: Record<CatalogPickerSource, { label: string; description: string; connected: boolean; letter: string }> = {
      builtin: { label: 'Built-in', description: 'Essential Aurales shelves', connected: true, letter: 'A' },
      smart: { label: 'Smart Collections', description: 'Your dynamic collections', connected: true, letter: 'S' },
      addons: { label: 'Addons', description: 'Catalogs from installed Stremio addons', connected: addons.length > 0, letter: 'A' },
      simkl: { label: 'Simkl', description: 'Watchlists, trending, and curated picks', connected: simklConnected, letter: 'S' },
      trakt: { label: 'Trakt', description: 'Account lists and public collections', connected: traktConnected, letter: 'T' },
      anilist: { label: 'AniList', description: 'Watching, planning, and completed anime', connected: anilistConnected, letter: 'A' },
      pmdb: { label: 'PMDB', description: 'Native PMDB account lists', connected: !!pmdbApiKey, letter: 'P' },
      'pmdb-picks': { label: 'PMDB Picks', description: 'Personalized recommendation catalogs', connected: !!pmdbApiKey, letter: 'P' },
      mdblist: { label: 'MDBList', description: 'Account lists and public collections', connected: !!mdblistApiKey, letter: 'M' },
    }
    const sourceOrder = Object.keys(sourceMeta) as CatalogPickerSource[]
    const query = search.trim().toLowerCase()
    const browsingItems = deduplicated.filter((item) => {
      if (pickerSource && item.source !== pickerSource) return false
      if (pickerContentType !== 'all' && item.contentType !== pickerContentType) return false
      if (query && !`${item.title} ${item.subtitle} ${item.group} ${sourceMeta[item.source].label}`.toLowerCase().includes(query)) return false
      return true
    })
    const grouped = browsingItems.reduce<Record<string, CatalogPickerItem[]>>((result, item) => {
      const key = `${item.source}:${item.group}`
      ;(result[key] ||= []).push(item)
      return result
    }, {})
    const overview = !pickerSource && !query

    const requestSmartCollection = () => {
      if (selectedShelves.length) setConfirmPickerExit(true)
      else { setMode('discover'); setPickerSource(null); setSearch('') }
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-shrink-0 border-b border-white/[0.07] px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            {!overview && (
              <button type="button" onClick={() => { if (query && !pickerSource) setSearch(''); else setPickerSource(null); setPickerContentType('all') }} className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-white/45 hover:bg-white/[0.08] hover:text-white cursor-pointer" aria-label="Back to sources">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
              </button>
            )}
            <div className="relative min-w-[240px] flex-1">
              <svg className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search catalogs, lists, and public collections…" className="h-11 w-full rounded-xl border border-white/[0.10] bg-white/[0.05] pl-11 pr-10 text-sm text-white outline-none placeholder:text-white/25 focus:border-accent/35 focus:bg-white/[0.07]" autoFocus />
              {search && <button type="button" onClick={() => setSearch('')} className="absolute right-3 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-lg text-white/30 hover:bg-white/10 hover:text-white cursor-pointer">×</button>}
            </div>
            <button type="button" onClick={requestSmartCollection} className="h-11 rounded-xl border border-amber-400/15 bg-amber-400/[0.07] px-4 text-xs font-bold text-amber-200/75 transition-all hover:bg-amber-400/12 hover:text-amber-100 cursor-pointer">Create Smart Collection</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6" style={{ scrollbarWidth: 'thin', scrollbarGutter: 'stable' }}>
          {overview ? (
            <div>
              <div className="mb-5"><h3 className="text-base font-bold text-white/90">Choose a source</h3><p className="mt-1 text-xs text-white/35">Browse the catalogs available from Aurales and your connected services.</p></div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sourceOrder.map((source) => {
                  const meta = sourceMeta[source]
                  const count = deduplicated.filter((item) => item.source === source).length
                  const colors = sourceColors[source] || sourceColors.builtin
                  return (
                    <div key={source} role={meta.connected ? 'button' : undefined} tabIndex={meta.connected ? 0 : -1} onClick={() => meta.connected ? setPickerSource(source) : undefined} onKeyDown={(event) => { if (meta.connected && (event.key === 'Enter' || event.key === ' ')) setPickerSource(source) }} className={`group rounded-2xl border p-4 text-left transition-all ${meta.connected ? 'cursor-pointer border-white/[0.08] bg-white/[0.035] hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-white/[0.065] focus:outline-none focus:ring-1 focus:ring-accent/35' : 'cursor-default border-white/[0.05] bg-white/[0.018] opacity-65'}`}>
                      <div className="flex items-start gap-3"><span className={`grid h-11 w-11 flex-shrink-0 place-items-center rounded-xl text-sm font-black ${colors.bg} ${colors.text}`}>{meta.letter}</span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-white/80">{meta.label}</span><span className="rounded-lg bg-white/[0.06] px-2 py-1 text-[10px] font-bold text-white/40">{count}</span></span><span className="mt-1 block text-[11px] leading-relaxed text-white/30">{meta.description}</span></span></div>
                      {!meta.connected && <span className="mt-3 flex items-center justify-between border-t border-white/[0.05] pt-3 text-[10px] font-semibold text-white/30"><span>Not connected</span><button type="button" onClick={(event) => { event.stopPropagation(); onClose(); navigate('/settings') }} className="text-accent/70 hover:text-accent cursor-pointer">Open Settings →</button></span>}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/25">{query && !pickerSource ? 'Global search' : 'Browsing source'}</p><h3 className="mt-1 text-lg font-bold text-white/90">{query && !pickerSource ? `Results for “${search.trim()}”` : pickerSource ? sourceMeta[pickerSource].label : 'Catalogs'}</h3><p className="mt-1 text-xs text-white/30">{browsingItems.length} available {browsingItems.length === 1 ? 'catalog' : 'catalogs'}</p></div>
                <div className="flex rounded-xl border border-white/[0.07] bg-white/[0.025] p-1">
                  {(['all', 'movie', 'series', 'anime'] as const).map((type) => <button key={type} type="button" onClick={() => setPickerContentType(type)} className={`rounded-lg px-3 py-2 text-[11px] font-bold capitalize transition-all cursor-pointer ${pickerContentType === type ? 'bg-white/[0.10] text-white' : 'text-white/30 hover:text-white/60'}`}>{type === 'all' ? 'All' : type === 'movie' ? 'Movies' : type === 'series' ? 'Series' : 'Anime'}</button>)}
                </div>
              </div>

              {Object.keys(grouped).length === 0 ? <div className="grid min-h-56 place-items-center rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.015] text-center"><div><p className="text-sm font-semibold text-white/45">No matching catalogs</p><p className="mt-1 text-xs text-white/25">Try another search or content filter.</p></div></div> : (
                <div className="space-y-6">
                  {Object.entries(grouped).map(([groupKey, groupItems]) => {
                    const first = groupItems[0]
                    const colors = sourceColors[first.source] || sourceColors.builtin
                    return <section key={groupKey}><div className="mb-2.5 flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${colors.dot}`} /><h4 className="text-xs font-bold text-white/55">{first.group}</h4><span className="text-[10px] text-white/20">{groupItems.length}</span></div><div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">{groupItems.map((item) => {
                      const selected = selectedShelves.some((selection) => selection.key === item.key)
                      return <button key={item.key} type="button" disabled={item.added} onClick={() => queueShelf(item.row, item.existingId)} className={`group flex min-h-[72px] items-center gap-3 rounded-2xl border p-3.5 text-left transition-all ${item.added ? 'cursor-default border-white/[0.05] bg-white/[0.02] opacity-55' : selected ? 'cursor-pointer border-accent/35 bg-accent/[0.09] shadow-[0_0_0_1px_rgba(16,185,129,0.08)]' : 'cursor-pointer border-white/[0.08] bg-white/[0.035] hover:border-white/[0.16] hover:bg-white/[0.065]'}`}><span className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl text-xs font-black ${colors.bg} ${colors.text}`}>{sourceMeta[item.source].letter}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-white/80">{item.title}</span><span className="mt-1 block truncate text-[10px] text-white/30">{item.subtitle}</span></span>{item.added ? <span className="rounded-lg bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300/70">On Home</span> : <span className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border text-xs font-black ${selected ? 'border-accent bg-accent text-black' : 'border-white/[0.16] bg-white/[0.025] text-transparent group-hover:border-white/30'}`}>✓</span>}</button>
                    })}</div></section>
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 backdrop-blur-md sm:p-5" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        className="glass-panel flex h-[min(860px,calc(100dvh-1rem))] w-full max-w-[1080px] flex-col overflow-hidden rounded-2xl border border-white/[0.11] shadow-2xl shadow-black/70 transition-all duration-300 sm:h-[min(860px,calc(100dvh-2.5rem))]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent line */}
        <div className="h-px bg-gradient-to-r from-accent/0 via-accent/50 to-accent/0" />

        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 sm:px-6 py-4 border-b border-white/[0.06] flex-shrink-0 bg-black/15">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-accent/12 border border-accent/15 flex items-center justify-center flex-shrink-0 shadow-[0_0_28px_rgba(34,197,94,0.08)]">
              {editingRow ? (
                <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              ) : (
                <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
              )}
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                {editingRow
                  ? editingRow.sourceType === 'discover'
                    ? 'Edit Smart Collection'
                    : 'Edit Shelf Settings'
                  : startMode === 'discover' || mode === 'discover' ? 'Create Smart Collection' : 'Add shelves to Home'}
              </h2>
              <p className="text-xs text-white/40 mt-0.5">
                {editingRow
                  ? editingRow.sourceType === 'discover'
                    ? 'Modify this collection\'s rules and Home visibility'
                    : 'Rename or change layout'
                  : mode === 'discover' ? 'Build a dynamic collection with precise catalog rules' : 'Choose catalogs and lists for your Home screen'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-xl bg-white/[0.05] hover:bg-white/[0.10] flex items-center justify-center transition-all text-white/40 hover:text-white/75 duration-200 cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Navigation Tabs */}
        {false && !editingRow && (
          <div className="grid grid-cols-2 gap-2 px-5 sm:px-6 py-3 border-b border-white/[0.06] flex-shrink-0 bg-black/10">
            <button
              onClick={() => setMode('preset')}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all cursor-pointer border ${
                mode === 'preset'
                  ? 'bg-accent/15 border-accent/25 backdrop-blur-sm'
                  : 'bg-white/[0.025] hover:bg-white/[0.05] border-white/[0.04]'
              }`}
            >
              <svg className={`w-4 h-4 flex-shrink-0 ${mode === 'preset' ? 'text-accent' : 'text-white/40'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
              <span className="min-w-0">
                <span className={`block text-xs sm:text-sm font-semibold ${mode === 'preset' ? 'text-accent' : 'text-white/60'}`}>Browse Shelves</span>
                <span className="hidden sm:block text-[10px] text-white/30 mt-0.5 truncate">Catalogs & lists from your addons, Trakt, Simkl, MDBList…</span>
              </span>
            </button>
            <button
              onClick={() => setMode('discover')}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all cursor-pointer border ${
                mode === 'discover'
                  ? 'bg-accent/15 border-accent/25 backdrop-blur-sm'
                  : 'bg-white/[0.025] hover:bg-white/[0.05] border-white/[0.04]'
              }`}
            >
              <svg className={`w-4 h-4 flex-shrink-0 ${mode === 'discover' ? 'text-accent' : 'text-white/40'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
              <span className="min-w-0">
                <span className={`block text-xs sm:text-sm font-semibold ${mode === 'discover' ? 'text-accent' : 'text-white/60'}`}>Create Smart Collection</span>
                <span className="hidden sm:block text-[10px] text-white/30 mt-0.5 truncate">Build a dynamic collection with genre, rating & streaming rules</span>
              </span>
            </button>
          </div>
        )}

        {editingRow && editingRow.sourceType !== 'discover' ? (
          /* Simple Edit Form for standard shelf */
          <>
            <div className="flex-1 overflow-y-auto px-6 py-8 space-y-6" style={{ scrollbarWidth: 'thin' }}>
              <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
                <div>
                  <label className="block text-[11px] text-white/40 mb-2 font-medium uppercase tracking-wider">Catalog Name</label>
                  <input
                    value={catalogName}
                    onChange={(e) => setCatalogName(e.target.value)}
                    placeholder="Catalog Name"
                    className={styledInput}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-white/40 mb-2 font-medium uppercase tracking-wider">Layout Style</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { value: 'poster', label: 'Poster', icon: 'M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z' },
                      { value: 'landscape', label: 'Landscape', icon: 'M2 6h20v12H2z' },
                      { value: 'list', label: 'Compact', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
                    ] as const).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setEditLayout(opt.value)}
                        className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all cursor-pointer ${
                          editLayout === opt.value
                            ? 'bg-accent/15 border-accent/25 text-accent'
                            : 'bg-white/[0.02] border-white/[0.06] text-white/30 hover:bg-white/[0.04] hover:text-white/50'
                        }`}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d={opt.icon} /></svg>
                        <span className="text-[11px] font-semibold">{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-end gap-3">
              <button onClick={onClose} className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white/40 hover:text-white hover:bg-white/[0.04] transition-all cursor-pointer">
                Cancel
              </button>
              <button onClick={handleSaveStandardEdit} className="px-6 py-2.5 bg-accent hover:bg-accent/80 text-black text-xs font-bold rounded-xl shadow-lg shadow-accent/10 transition-all cursor-pointer">
                Save Changes
              </button>
            </div>
          </>
        ) : mode === 'preset' ? (
          renderCatalogBrowser()
        ) : false ? (
          (() => {
            const showBuiltin = selectedSourceFilter === 'all' || selectedSourceFilter === 'builtin'
            const showSmart = selectedSourceFilter === 'all' || selectedSourceFilter === 'smart'
            const showAddons = selectedSourceFilter === 'all' || selectedSourceFilter === 'addons'
            const showSimkl = selectedSourceFilter === 'all' || selectedSourceFilter === 'simkl'
            const showAniList = selectedSourceFilter === 'all' || selectedSourceFilter === 'anilist'
            const showTrakt = selectedSourceFilter === 'all' || selectedSourceFilter === 'trakt'
            const showPmdb = selectedSourceFilter === 'all' || selectedSourceFilter === 'pmdb'
            const showPmdbPicks = selectedSourceFilter === 'all' || selectedSourceFilter === 'pmdb-picks'
            const showMdblist = selectedSourceFilter === 'all' || selectedSourceFilter === 'mdblist'

            const builtinCount = (showBuiltin && (!search || 'continue watching'.includes(search.toLowerCase()))) ? 1 : 0
            const smartRows = homeRows.filter((row) => row.sourceType === 'discover' && (!search || row.title.toLowerCase().includes(search.toLowerCase())))
            const smartCount = showSmart ? smartRows.length : 0
            const pmdbAddonCatalogsCount = (showPmdb || showAddons) ? filteredPmdbAddonCatalogs.length : 0
            const otherAddonCatalogsCount = showAddons ? filteredOtherAddonCatalogs.length : 0
            const simklListsCount = (showSimkl && simklConnected) ? filteredSimklLists.length : 0
            const aniListListsCount = (showAniList && anilistConnected) ? filteredAniListLists.length : 0
            const traktListsCount = (showTrakt && traktConnected) ? filteredTraktLists.length : 0
            const pmdbListsCount = (showPmdb && !!pmdbApiKey) ? filteredPmdbLists.length : 0
            const pmdbPicksCount = (showPmdbPicks && !!pmdbApiKey) ? filteredPmdbPicks.length : 0
            const mdblistListsCount = (showMdblist && !!mdblistApiKey) ? filteredMdblistLists.length : 0

            const totalVisible = builtinCount + smartCount + pmdbAddonCatalogsCount + otherAddonCatalogsCount + simklListsCount + aniListListsCount + traktListsCount + pmdbListsCount + pmdbPicksCount + mdblistListsCount
            const sourceFilters = [
              { id: 'all' as const, label: 'All sources', shortLabel: 'All', count: totalVisible, color: null, connected: true },
              { id: 'builtin' as const, label: 'Built-in', shortLabel: 'Built-in', count: builtinCount, color: sourceColors.builtin, connected: true },
              { id: 'smart' as const, label: 'Smart Collections', shortLabel: 'Smart', count: smartRows.length, color: sourceColors.smart, connected: true },
              { id: 'addons' as const, label: 'Addons', shortLabel: 'Addons', count: pmdbAddonCatalogsCount + otherAddonCatalogsCount, color: sourceColors.addons, connected: addons.length > 0 },
              { id: 'simkl' as const, label: 'Simkl', shortLabel: 'Simkl', count: simklConnected ? filteredSimklLists.length : 0, color: sourceColors.simkl, connected: simklConnected },
              { id: 'trakt' as const, label: 'Trakt', shortLabel: 'Trakt', count: traktConnected ? filteredTraktLists.length : 0, color: sourceColors.trakt, connected: traktConnected },
              { id: 'anilist' as const, label: 'AniList', shortLabel: 'AniList', count: anilistConnected ? filteredAniListLists.length : 0, color: sourceColors.anilist, connected: anilistConnected },
              { id: 'pmdb' as const, label: 'PMDB', shortLabel: 'PMDB', count: pmdbApiKey ? filteredPmdbLists.length + filteredPmdbAddonCatalogs.length : 0, color: sourceColors.pmdb, connected: !!pmdbApiKey },
              { id: 'pmdb-picks' as const, label: 'PMDB Picks', shortLabel: 'Picks', count: pmdbApiKey ? filteredPmdbPicks.length : 0, color: sourceColors['pmdb-picks'], connected: !!pmdbApiKey },
              { id: 'mdblist' as const, label: 'MDBList', shortLabel: 'MDBList', count: mdblistApiKey ? filteredMdblistLists.length : 0, color: sourceColors.mdblist, connected: !!mdblistApiKey },
            ]

            const DisconnectedCard = ({ source, letter, name, desc }: { source: string; letter: string; name: string; desc: string }) => {
              const c = sourceColors[source] || sourceColors.builtin
              return (
                <div className="glass-panel-light rounded-2xl flex flex-col items-center justify-center text-center py-12 px-8">
                  <div className={`w-16 h-16 rounded-2xl ${c.bg} border border-white/[0.06] flex items-center justify-center mb-5`}>
                    <span className={`text-2xl font-black ${c.text}`}>{letter}</span>
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-2">{name} not connected</h4>
                  <p className="text-xs text-white/25 max-w-xs leading-relaxed">{desc}</p>
                  <div className="mt-4 px-4 py-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] text-[11px] text-white/30 font-medium hover:bg-white/[0.08] transition-colors cursor-default">
                    Go to Settings &rarr; Accounts
                  </div>
                </div>
              )
            }

            return (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="border-b border-white/[0.06] bg-black/10 px-5 sm:px-6 py-4 flex-shrink-0">
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                    <div className="relative">
                      <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={traktConnected || mdblistApiKey
                          ? 'Search shelves — also finds public Trakt & MDBList lists...'
                          : 'Search shelves, catalogs, lists...'}
                        className="w-full bg-white/[0.055] border border-white/[0.08] rounded-xl pl-11 pr-10 py-3 text-sm text-white placeholder-white/28 outline-none focus:border-accent/35 focus:bg-white/[0.07] focus:ring-1 focus:ring-accent/20 transition-all"
                        autoFocus
                      />
                      {search && (
                        <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] flex items-center justify-center text-white/40 hover:text-white/75 transition-all cursor-pointer">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-white/35">
                      <span className="rounded-lg border border-white/[0.07] bg-white/[0.04] px-2.5 py-1.5 font-semibold text-white/55">{totalVisible} shelves</span>
                      <span className="hidden sm:inline">Click any row to add it to Home</span>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5 md:hidden" style={{ scrollbarWidth: 'none' }}>
                    {sourceFilters.map((filter) => {
                      const active = selectedSourceFilter === filter.id
                      return (
                        <button
                          key={filter.id}
                          type="button"
                          onClick={() => setSelectedSourceFilter(filter.id)}
                          className={`flex h-9 flex-shrink-0 items-center gap-2 rounded-xl border px-3 text-[11px] font-bold transition-all ${
                            active
                              ? 'border-accent/25 bg-accent/15 text-accent'
                              : 'border-white/[0.06] bg-white/[0.035] text-white/45 hover:bg-white/[0.065] hover:text-white/70'
                          }`}
                        >
                          {filter.color && <span className={`h-2 w-2 rounded-full ${filter.connected ? filter.color.dot : 'bg-white/18'}`} />}
                          <span>{filter.shortLabel}</span>
                          <span className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[10px] text-white/45">{filter.count}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="grid flex-1 min-h-0 md:grid-cols-[190px_minmax(0,1fr)]">
                  <aside className="hidden border-r border-white/[0.06] bg-black/10 p-3 md:block">
                    <div className="space-y-1">
                      {sourceFilters.map((filter) => {
                        const active = selectedSourceFilter === filter.id
                        return (
                          <button
                            key={filter.id}
                            type="button"
                            onClick={() => setSelectedSourceFilter(filter.id)}
                            className={`group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all ${
                              active
                                ? 'border-accent/25 bg-accent/12 text-white'
                                : 'border-transparent text-white/45 hover:border-white/[0.06] hover:bg-white/[0.045] hover:text-white/70'
                            }`}
                          >
                            <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${filter.color ? (filter.connected ? filter.color.dot : 'bg-white/15') : 'bg-accent'}`} />
                            <span className="min-w-0 flex-1 truncate text-xs font-bold">{filter.label}</span>
                            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${active ? 'bg-black/20 text-white/55' : 'bg-white/[0.06] text-white/30 group-hover:text-white/50'}`}>{filter.count}</span>
                          </button>
                        )
                      })}
                    </div>
                  </aside>

                  {/* Catalog List */}
                  <div className="min-h-0 overflow-y-auto overscroll-contain px-5 sm:px-6 py-5 space-y-5" style={{ scrollbarWidth: 'thin', scrollbarGutter: 'stable' }}>

                  {/* Not-connected empty states -- shown only when that specific filter is selected */}
                  {selectedSourceFilter === 'simkl' && !simklConnected && (
                    <DisconnectedCard source="simkl" letter="S" name="Simkl" desc="Connect your Simkl account in Settings > Accounts to access watchlists, anime lists, and history." />
                  )}
                  {selectedSourceFilter === 'trakt' && !traktConnected && (
                    <DisconnectedCard source="trakt" letter="T" name="Trakt" desc="Connect your Trakt account in Settings > Accounts to sync watchlists, custom lists, and recommendations." />
                  )}
                  {selectedSourceFilter === 'anilist' && !anilistConnected && (
                    <DisconnectedCard source="anilist" letter="A" name="AniList" desc="Connect your AniList account in Settings > Accounts to load your anime watching, planning, and completed lists." />
                  )}
                  {selectedSourceFilter === 'pmdb' && !pmdbApiKey && (
                    <DisconnectedCard source="pmdb" letter="P" name="PMDB" desc="Enter your PublicMetaDB API key in Settings > Accounts to access scrobble history and synced lists." />
                  )}
                  {selectedSourceFilter === 'pmdb-picks' && !pmdbApiKey && (
                    <DisconnectedCard source="pmdb-picks" letter="P" name="PMDB Picks" desc="Enter your PublicMetaDB API key in Settings > Accounts to access your personalized pick catalogs." />
                  )}
                  {selectedSourceFilter === 'mdblist' && !mdblistApiKey && (
                    <DisconnectedCard source="mdblist" letter="M" name="MDBList" desc="Enter your MDBList API key in Settings > Accounts to access watchlists, account lists, public list search, and history." />
                  )}
                  {selectedSourceFilter === 'addons' && addons.length === 0 && (
                    <div className="glass-panel-light rounded-2xl flex flex-col items-center justify-center text-center py-12 px-6">
                      <div className="w-14 h-14 rounded-2xl bg-orange-500/15 border border-white/[0.06] flex items-center justify-center mb-4">
                        <svg className="w-6 h-6 text-orange-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                        </svg>
                      </div>
                      <h4 className="text-sm font-semibold text-white mb-1">No addons installed</h4>
                      <p className="text-xs text-white/30 max-w-xs leading-relaxed">Install Stremio addons in Settings to browse their catalogs here.</p>
                    </div>
                  )}

                  {/* Built-in Section */}
                  {showBuiltin && builtinCount > 0 && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.builtin.bg} flex items-center justify-center flex-shrink-0`}>
                          <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Built-in</h3>
                      </div>
                      {(() => {
                        const added = homeRows.some((r) => r.layout === 'continue')
                        return (
                          <button
                            disabled={added}
                            onClick={() => {
                              queueShelf({ title: 'Continue Watching', layout: 'continue', enabled: true, sourceType: 'local' })
                            }}
                            className={`group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-white/[0.06] backdrop-blur-sm transition-all text-left ${
                              added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] hover:translate-y-[-1px] cursor-pointer'
                            }`}
                          >
                            <div className={`w-9 h-9 rounded-xl ${sourceColors.builtin.bg} flex items-center justify-center flex-shrink-0`}>
                              <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-white/80">Continue Watching</p>
                              <p className="text-[10px] text-white/25 mt-0.5">Resume where you left off</p>
                            </div>
                            {added ? (
                              <div className="flex items-center gap-1.5 flex-shrink-0 bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                                <span className="text-[10px] text-emerald-400/80 font-semibold">Added</span>
                              </div>
                            ) : (
                              <svg className="w-4 h-4 text-white/10 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
                            )}
                          </button>
                        )
                      })()}
                    </div>
                  )}

                  {/* PMDB Catalogs */}
                  {(showPmdb || showAddons) && filteredPmdbAddonCatalogs.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.pmdb.bg} flex items-center justify-center flex-shrink-0`}>
                          <span className={`text-[10px] font-black ${sourceColors.pmdb.text}`}>P</span>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">PMDB Catalogs</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredPmdbAddonCatalogs.length}</span>
                      </div>
                      <div className="space-y-1.5">
                        {filteredPmdbAddonCatalogs.map((cat) => {
                          const key = `${cat.addonId}::${cat.catalogType}::${cat.catalogId}`
                          const added = isAlreadyAdded(key)
                          const selected = isPickerSelected(`addon:${cat.addonId}:${cat.catalogType}:${cat.catalogId}`)
                          return (
                            <button
                              key={key}
                              disabled={added}
                              onClick={() => {
                                queueShelf({
                                  title: cat.catalogName,
                                  addonId: cat.addonId,
                                  addonUrl: cat.addonUrl,
                                  catalogType: cat.catalogType,
                                  catalogId: cat.catalogId,
                                  catalogExtra: cat.catalogExtra,
                                  layout: 'poster',
                                  enabled: true,
                                })
                              }}
                              className={`group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-white/[0.06] backdrop-blur-sm transition-all text-left ${
                                added ? 'bg-white/[0.025] opacity-55 cursor-default' : selected ? 'border-accent/30 bg-accent/10 cursor-pointer' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] hover:translate-y-[-1px] cursor-pointer'
                              }`}
                            >
                              <div className={`w-9 h-9 rounded-xl ${sourceColors.pmdb.bg} flex items-center justify-center flex-shrink-0`}>
                                <span className={`text-xs font-black ${sourceColors.pmdb.text}`}>P</span>
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-white/80 truncate">{cat.catalogName}</p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[10px] text-white/25">{cat.addonName}</span>
                                  <span className="text-[10px] text-white/10">·</span>
                                  <span className="text-[10px] text-white/25">{cat.catalogType}</span>
                                </div>
                              </div>
                              {added || selected ? (
                                <div className="flex items-center gap-1.5 flex-shrink-0 bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                                  <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                                  <span className="text-[10px] text-emerald-400/80 font-semibold">{added ? 'Added' : 'Selected'}</span>
                                </div>
                              ) : (
                                <svg className="w-4 h-4 text-white/10 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Smart Collections */}
                  {showSmart && smartRows.length > 0 && (
                    <div>
                      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-2.5">
                        <div className={`grid h-6 w-6 place-items-center rounded-lg ${sourceColors.smart.bg}`}><span className={`text-[10px] font-black ${sourceColors.smart.text}`}>S</span></div>
                        <h3 className="flex-1 text-xs font-bold uppercase tracking-wider text-white/50">Smart Collections</h3>
                        <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/25">{smartRows.length}</span>
                      </div>
                      <div className="space-y-1.5">
                        {smartRows.map((row) => {
                          const selected = selectedShelves.some((item) => item.existingId === row.id)
                          return (
                            <button
                              key={row.id}
                              type="button"
                              disabled={row.enabled}
                              onClick={() => queueShelf({ ...row, layout: 'poster', enabled: true }, row.id)}
                              className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all ${row.enabled ? 'cursor-default border-white/[0.05] bg-white/[0.02] opacity-50' : selected ? 'cursor-pointer border-accent/30 bg-accent/10' : 'cursor-pointer border-white/[0.06] bg-white/[0.03] hover:border-white/[0.12] hover:bg-white/[0.06]'}`}
                            >
                              <span className={`grid h-9 w-9 place-items-center rounded-xl ${selected ? 'bg-accent/20 text-accent' : sourceColors.smart.bg + ' ' + sourceColors.smart.text}`}>
                                {selected ? '✓' : 'S'}
                              </span>
                              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-white/80">{row.title}</span><span className="mt-0.5 block text-[10px] text-white/25">Dynamic TMDB collection • Poster</span></span>
                              <span className="text-[10px] font-bold text-white/30">{row.enabled ? 'On Home' : selected ? 'Selected' : 'Select'}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Addon Catalogs */}
                  {showAddons && filteredOtherAddonCatalogs.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.addons.bg} flex items-center justify-center flex-shrink-0`}>
                          <svg className="w-3.5 h-3.5 text-orange-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">Addon Catalogs</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredOtherAddonCatalogs.length}</span>
                      </div>
                      <div className="space-y-1.5">
                        {filteredOtherAddonCatalogs.map((cat) => {
                          const key = `${cat.addonId}::${cat.catalogType}::${cat.catalogId}`
                          const added = isAlreadyAdded(key)
                          const selected = isPickerSelected(`addon:${cat.addonId}:${cat.catalogType}:${cat.catalogId}`)
                          return (
                            <button
                              key={key}
                              disabled={added}
                              onClick={() => {
                                queueShelf({
                                  title: cat.catalogName,
                                  addonId: cat.addonId,
                                  addonUrl: cat.addonUrl,
                                  catalogType: cat.catalogType,
                                  catalogId: cat.catalogId,
                                  catalogExtra: cat.catalogExtra,
                                  layout: 'poster',
                                  enabled: true,
                                })
                              }}
                              className={`group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-white/[0.06] backdrop-blur-sm transition-all text-left ${
                                added ? 'bg-white/[0.025] opacity-55 cursor-default' : selected ? 'border-accent/30 bg-accent/10 cursor-pointer' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] hover:translate-y-[-1px] cursor-pointer'
                              }`}
                            >
                              <div className={`w-9 h-9 rounded-xl ${sourceColors.addons.bg} flex items-center justify-center flex-shrink-0`}>
                                <svg className="w-4 h-4 text-orange-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                  <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                </svg>
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-white/80 truncate">{cat.catalogName}</p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[10px] text-white/25">{cat.addonName}</span>
                                  <span className="text-[10px] text-white/10">·</span>
                                  <span className="text-[10px] text-white/25">{cat.catalogType}</span>
                                </div>
                              </div>
                              {added || selected ? (
                                <div className="flex items-center gap-1.5 flex-shrink-0 bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                                  <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                                  <span className="text-[10px] text-emerald-400/80 font-semibold">{added ? 'Added' : 'Selected'}</span>
                                </div>
                              ) : (
                                <svg className="w-4 h-4 text-white/10 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Simkl Catalogs */}
                  {showSimkl && simklConnected && filteredSimklLists.length > 0 && (
                    <div className="space-y-4">
                      {visibleSimklCatalogs.watchlist.length > 0 && (
                        <div className="glass-panel-light rounded-2xl p-5">
                          <div className="flex items-start gap-3 mb-4">
                            <div className="w-8 h-8 rounded-xl bg-violet-500/15 text-violet-300 flex items-center justify-center flex-shrink-0">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6 4h12v16l-6-3-6 3V4z" /></svg>
                            </div>
                            <div>
                              <h3 className="text-sm font-bold text-white/85">Watchlist Catalogs</h3>
                              <p className="text-[10px] text-white/35">Add watchlist catalogs for movies, shows, and anime by status</p>
                            </div>
                          </div>
                          <div className="space-y-2.5">
                            {['Movies', 'Shows', 'Anime'].map((section) => {
                              const items = visibleSimklCatalogs.watchlist.filter((list) => list.section === section)
                              if (!items.length) return null
                              return (
                                <div key={section}>
                                  <p className="text-[10px] font-bold text-white/45 mb-1.5">{section}</p>
                                  <div className="grid grid-cols-2 gap-2">{items.map(renderSimklCatalogButton)}</div>
                                </div>
                              )
                            })}
                          </div>
                          <p className="text-[9px] text-white/25 mt-3">These catalogs show your Simkl watchlist items by status. Page size must match your Simkl settings.</p>
                        </div>
                      )}

                    </div>
                  )}

                  {/* Simkl Lists */}
                  {false && showSimkl && simklConnected && filteredSimklLists.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.simkl.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">Simkl Lists</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredSimklLists.length}</span>
                      </div>
                      <div className="space-y-1.5">
                        {filteredSimklLists.map((list) => {
                          const added = isAlreadyAdded(`simkl:${list.id}`)
                          return (
                            <button
                              key={list.id}
                              disabled={added}
                              onClick={() => {
                                queueShelf({
                                  title: list.label,
                                  sourceType: 'simkl',
                                  providerListId: list.id,
                                  layout: 'poster',
                                  enabled: true,
                                })
                              }}
                              className={`group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-white/[0.06] backdrop-blur-sm transition-all text-left ${
                                added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] hover:translate-y-[-1px] cursor-pointer'
                              }`}
                            >
                              <div className={`w-9 h-9 rounded-xl ${sourceColors.simkl.bg} flex items-center justify-center flex-shrink-0`}>
                                <span className={`text-xs font-black ${sourceColors.simkl.text}`}>S</span>
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-white/80 truncate">{list.label}</p>
                                <p className="text-[10px] text-white/25 mt-0.5">{list.type} layout</p>
                              </div>
                              {added ? (
                                <div className="flex items-center gap-1.5 flex-shrink-0 bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                                  <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                                  <span className="text-[10px] text-emerald-400/80 font-semibold">Added</span>
                                </div>
                              ) : (
                                <svg className="w-4 h-4 text-white/10 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* AniList Lists */}
                  {showAniList && anilistConnected && filteredAniListLists.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.anilist.bg} flex items-center justify-center flex-shrink-0`}>
                          <span className={`text-[10px] font-black ${sourceColors.anilist.text}`}>A</span>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">AniList Lists</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredAniListLists.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="AniList Lists"
                        service="anilist"
                        lists={filteredAniListLists}
                        isAlreadyAdded={isAlreadyAdded}
                        isSelected={isPickerSelected}
                        onAdd={queueShelf}
                        onClose={() => {}}
                      />
                    </div>
                  )}

                  {/* Trakt Lists */}
                  {showTrakt && traktConnected && (filteredTraktLists.length > 0 || selectedSourceFilter === 'trakt') && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.trakt.bg} flex items-center justify-center flex-shrink-0`}>
                          <span className={`text-[10px] font-black ${sourceColors.trakt.text}`}>T</span>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">Trakt Lists</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredTraktLists.length}</span>
                      </div>
                      {filteredTraktLists.length > 0 && (
                        <ProviderListPickerSection
                          title="Trakt Lists"
                          service="trakt"
                          lists={filteredTraktLists.map((l) => ({ id: l.id, label: l.label.replace(/^Trakt - /, ''), type: l.layout }))}
                          isAlreadyAdded={isAlreadyAdded}
                          isSelected={isPickerSelected}
                          onAdd={queueShelf}
                          onClose={() => {}}
                        />
                      )}
                      {/* Trakt public list search */}
                      <div className="mt-4 pt-4 border-t border-white/[0.06]">
                        <div className="flex items-center gap-2 mb-2">
                          <svg className="w-3.5 h-3.5 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/30">Search Public Lists</h4>
                          <span className="text-[10px] text-white/20 ml-auto">Find lists by other Trakt users</span>
                        </div>
                        <div className="flex gap-2 mb-3">
                          <input
                            value={traktPublicSearch}
                            onChange={(e) => setTraktPublicSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleTraktPublicSearch() }}
                            placeholder="Search Trakt public lists..."
                            className="min-w-0 flex-1 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5 text-xs text-white outline-none placeholder-white/25 focus:border-[#ef4444]/35 focus:ring-1 focus:ring-[#ef4444]/15 backdrop-blur-sm transition-all"
                          />
                          <button
                            type="button"
                            onClick={handleTraktPublicSearch}
                            disabled={!traktPublicSearch.trim() || traktPublicSearching}
                            className="rounded-xl border border-[#ef4444]/20 bg-[#ef4444]/10 px-4 py-2.5 text-xs font-bold text-[#ef4444] transition-all hover:bg-[#ef4444]/15 backdrop-blur-sm disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {traktPublicSearching ? 'Searching...' : 'Search'}
                          </button>
                        </div>
                        {traktPublicLists.length > 0 && (
                          <ProviderListPickerSection
                            title="Public Trakt Lists"
                            service="trakt"
                            lists={traktPublicLists.map((l) => ({ id: l.id, label: l.label, type: l.layout }))}
                            isAlreadyAdded={isAlreadyAdded}
                            isSelected={isPickerSelected}
                            onAdd={queueShelf}
                            onClose={() => {}}
                          />
                        )}
                        {traktPublicSearch.trim() && !traktPublicSearching && traktPublicLists.length === 0 && (
                          <p className="text-xs text-white/25 text-center py-3">No public lists found</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* PMDB Lists */}
                  {showPmdb && !!pmdbApiKey && filteredPmdbLists.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.pmdb.bg} flex items-center justify-center flex-shrink-0`}>
                          <span className={`text-[10px] font-black ${sourceColors.pmdb.text}`}>P</span>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">PMDB Lists</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredPmdbLists.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="PMDB Lists"
                        service="pmdb"
                        lists={filteredPmdbLists.map((l) => ({ id: l.id, label: l.label.replace(/^PMDB - /, ''), type: l.layout }))}
                        isAlreadyAdded={isAlreadyAdded}
                        isSelected={isPickerSelected}
                        onAdd={queueShelf}
                        onClose={() => {}}
                      />
                    </div>
                  )}

                  {/* MDBList Lists */}
                  {showMdblist && !!mdblistApiKey && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors.mdblist.bg} flex items-center justify-center flex-shrink-0`}>
                          <span className={`text-[10px] font-black ${sourceColors.mdblist.text}`}>M</span>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">MDBList Lists</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredMdblistLists.length}</span>
                      </div>
                      <div className="mb-3 flex gap-2">
                        <input
                          value={newMdblistName}
                          onChange={(e) => setNewMdblistName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateMdblistList() }}
                          placeholder="New MDBList list name"
                          className="min-w-0 flex-1 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5 text-xs text-white outline-none placeholder-white/25 focus:border-[#22c55e]/35 focus:ring-1 focus:ring-[#22c55e]/15 backdrop-blur-sm transition-all"
                        />
                        <button
                          type="button"
                          onClick={handleCreateMdblistList}
                          disabled={!newMdblistName.trim() || creatingMdblistList}
                          className="rounded-xl border border-[#22c55e]/20 bg-[#22c55e]/10 px-4 py-2.5 text-xs font-bold text-[#22c55e] transition-all hover:bg-[#22c55e]/15 backdrop-blur-sm disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {creatingMdblistList ? 'Creating...' : 'Create'}
                        </button>
                      </div>
                      <ProviderListPickerSection
                        title="MDBList Lists"
                        service="mdblist"
                        lists={filteredMdblistLists.map((l) => ({ id: l.id, label: l.label.replace(/^MDBList - /, ''), type: l.layout }))}
                        isAlreadyAdded={isAlreadyAdded}
                        isSelected={isPickerSelected}
                        onAdd={queueShelf}
                        onClose={() => {}}
                      />
                      {/* Public list search */}
                      <div className="mt-4 pt-4 border-t border-white/[0.06]">
                        <div className="flex items-center gap-2 mb-2">
                          <svg className="w-3.5 h-3.5 text-white/30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/30">Search Public Lists</h4>
                          <span className="text-[10px] text-white/20 ml-auto">Find lists by other MDBList users</span>
                        </div>
                        <div className="flex gap-2 mb-3">
                          <input
                            value={mdblistPublicSearch}
                            onChange={(e) => setMdblistPublicSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleMdblistPublicSearch() }}
                            placeholder="Search public MDBList lists..."
                            className="min-w-0 flex-1 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-2.5 text-xs text-white outline-none placeholder-white/25 focus:border-[#22c55e]/35 focus:ring-1 focus:ring-[#22c55e]/15 backdrop-blur-sm transition-all"
                          />
                          <button
                            type="button"
                            onClick={handleMdblistPublicSearch}
                            disabled={!mdblistPublicSearch.trim() || mdblistPublicSearching}
                            className="rounded-xl border border-[#22c55e]/20 bg-[#22c55e]/10 px-4 py-2.5 text-xs font-bold text-[#22c55e] transition-all hover:bg-[#22c55e]/15 backdrop-blur-sm disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {mdblistPublicSearching ? 'Searching...' : 'Search'}
                          </button>
                        </div>
                        {filteredMdblistPublicLists.length > 0 && (
                          <ProviderListPickerSection
                            title="Public MDBList Lists"
                            service="mdblist"
                            lists={filteredMdblistPublicLists.map((l) => ({ id: l.id, label: l.label.replace(/^MDBList - /, ''), type: l.layout }))}
                            isAlreadyAdded={isAlreadyAdded}
                            isSelected={isPickerSelected}
                            onAdd={queueShelf}
                            onClose={() => {}}
                          />
                        )}
                        {mdblistPublicSearch.trim() && !mdblistPublicSearching && filteredMdblistPublicLists.length === 0 && (
                          <p className="text-xs text-white/25 text-center py-3">No public lists found</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* PMDB Picks */}
                  {showPmdbPicks && !!pmdbApiKey && filteredPmdbPicks.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className={`w-6 h-6 rounded-lg ${sourceColors['pmdb-picks'].bg} flex items-center justify-center flex-shrink-0`}>
                          <span className={`text-[10px] font-black ${sourceColors['pmdb-picks'].text}`}>P</span>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">PMDB Picks</h3>
                        <span className="text-[10px] text-white/25 bg-white/[0.06] px-2 py-0.5 rounded-full font-medium">{filteredPmdbPicks.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="PMDB Picks"
                        service="pmdb-picks"
                        lists={filteredPmdbPicks.map((pick) => ({ id: pick.id, label: pick.label, type: pick.layout }))}
                        isAlreadyAdded={isAlreadyAdded}
                        isSelected={isPickerSelected}
                        onAdd={queueShelf}
                        onClose={() => {}}
                      />
                    </div>
                  )}

                  {/* Public lists found via the main search bar */}
                  {search.trim().length >= 2 && (globalPublicSearching || globalPublicTrakt.length > 0 || globalPublicMdblist.length > 0) && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-3 bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-2.5">
                        <div className="w-6 h-6 rounded-lg bg-sky-500/15 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3.5 h-3.5 text-sky-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                        </div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/50 flex-1">Public Lists</h3>
                        <span className="text-[10px] text-white/25">
                          {globalPublicSearching ? 'Searching Trakt & MDBList…' : `${globalPublicTrakt.length + globalPublicMdblist.length} found for “${search.trim()}”`}
                        </span>
                      </div>
                      {globalPublicTrakt.length > 0 && (
                        <div className="mb-3">
                          <p className="text-[10px] font-bold text-white/40 mb-1.5 px-1">From Trakt</p>
                          <ProviderListPickerSection
                            title="Public Trakt Lists"
                            service="trakt"
                            lists={globalPublicTrakt.map((l) => ({ id: l.id, label: l.label, type: l.layout }))}
                            isAlreadyAdded={isAlreadyAdded}
                            isSelected={isPickerSelected}
                            onAdd={queueShelf}
                            onClose={() => {}}
                          />
                        </div>
                      )}
                      {globalPublicMdblist.length > 0 && (
                        <div>
                          <p className="text-[10px] font-bold text-white/40 mb-1.5 px-1">From MDBList</p>
                          <ProviderListPickerSection
                            title="Public MDBList Lists"
                            service="mdblist"
                            lists={globalPublicMdblist.map((l) => ({ id: l.id, label: l.label.replace(/^MDBList - /, ''), type: l.layout }))}
                            isAlreadyAdded={isAlreadyAdded}
                            isSelected={isPickerSelected}
                            onAdd={queueShelf}
                            onClose={() => {}}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Search empty state */}
                  {totalVisible === 0 && search && !globalPublicSearching && globalPublicTrakt.length === 0 && globalPublicMdblist.length === 0 && (
                    <div className="glass-panel-light rounded-2xl flex flex-col items-center justify-center text-center py-14">
                      <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center mb-4">
                        <svg className="w-6 h-6 text-white/15" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                      </div>
                      <p className="text-sm text-white/30 font-medium">No results for &ldquo;{search}&rdquo;</p>
                      <p className="text-xs text-white/15 mt-1">
                        {traktConnected || mdblistApiKey
                          ? 'Nothing local and no public Trakt/MDBList lists matched'
                          : 'Try a different search term'}
                      </p>
                    </div>
                  )}

                  {/* Nothing connected at all */}
                  {selectedSourceFilter === 'all' && totalVisible === 0 && addons.length === 0 && !simklConnected && !traktConnected && !anilistConnected && !pmdbApiKey && !search && (
                    <div className="glass-panel-light rounded-2xl flex flex-col items-center justify-center text-center py-14">
                      <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center mb-5">
                        <svg className="w-7 h-7 text-white/10" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                        </svg>
                      </div>
                      <p className="text-sm text-white/30 font-medium mb-1">No services connected</p>
                      <p className="text-xs text-white/15 leading-relaxed max-w-xs">Install addons or connect accounts in Settings to start adding shelves</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
            )
          })()
        ) : (
          /* Smart Collection Builder Form */
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5" style={{ scrollbarWidth: 'thin' }}>
              <section className="relative overflow-hidden rounded-3xl border border-white/[0.10] bg-gradient-to-br from-white/[0.09] via-white/[0.045] to-accent/[0.08] p-5 sm:p-7 shadow-[0_20px_70px_rgba(0,0,0,0.28)]">
                <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-accent/15 blur-3xl" />
                <div className="relative flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">Smart collection</p>
                    <h3 className="mt-1 text-xl font-bold text-white">{editingRow ? 'Edit catalog' : 'Build a catalog'}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="rounded-full border border-white/[0.10] bg-black/20 px-3 py-2 text-xs font-semibold text-white/70"><span className="mr-2 text-white/35">Style</span><select value={contentType} onChange={(e) => setContentType(e.target.value as 'movie' | 'series')} className="bg-transparent text-white outline-none"><option value="movie" className="bg-[#0a0b0e]">Movies</option><option value="series" className="bg-[#0a0b0e]">TV Shows</option></select></label>
                    <span className="rounded-full border border-white/[0.10] bg-black/20 px-3 py-2 text-xs font-semibold text-white/70"><span className="mr-2 text-white/35">Catalog</span>TMDB</span>
                  </div>
                </div>
                <p className="relative mt-6 text-[11px] font-bold uppercase tracking-[0.16em] text-white/30">Your collection will show</p>
                <p className="relative mt-2 max-w-5xl text-xl font-semibold leading-relaxed text-white/92 sm:text-2xl">{builderPrompt}</p>
                <div className="relative mt-5 flex flex-wrap items-center gap-2 text-xs"><span className="text-white/35">Call it</span><input value={catalogName} onChange={(e) => setCatalogName(e.target.value)} placeholder="Popular movies" aria-label="Collection name" className="min-w-44 border-b border-white/20 bg-transparent px-1 py-1 font-bold text-white outline-none placeholder:text-white/25 focus:border-accent" /><span className="text-white/35">— you can change any rule below.</span></div>
              </section>

              <div>
                <div className="mb-3 flex items-end justify-between gap-4">
                  <div><h3 className="text-sm font-bold text-white/75">Shape your collection</h3><p className="mt-1 text-[11px] text-white/30">Pick a card to edit that rule here.</p></div>
                  <span className="hidden text-[10px] font-semibold text-white/25 sm:block">All filters are optional</span>
                </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  { key: 'ordering', label: 'Ordering', value: sortBy.startsWith('popularity') ? 'Popular' : sortBy.startsWith('vote_average') ? 'Highest rated' : sortBy.includes('asc') ? 'Oldest first' : 'Newest first', icon: '↕' },
                  { key: 'period', label: 'Period', value: presetName || (releaseDateFrom || releaseDateTo ? `${releaseDateFrom || 'Any'} – ${releaseDateTo || 'now'}` : 'Any period'), icon: '▣' },
                  { key: 'genres', label: 'Genres', value: selectedIncludeGenres.length ? `${selectedIncludeGenres.length} included${selectedExcludeGenres.length ? ` · ${selectedExcludeGenres.length} excluded` : ''}` : 'Any genre', icon: '◆' },
                  { key: 'rating', label: 'Rating & votes', value: voteAverageMin > 0 || voteCountMin ? `${voteAverageMin > 0 ? `${voteAverageMin}+ rating` : 'Any rating'}${voteCountMin ? ` · ${voteCountMin}+ votes` : ''}` : 'Any rating', icon: '★' },
                  { key: 'language', label: 'Language & country', value: originalLanguage !== 'Any' || originCountry !== 'Any' ? [languagesList.find((item) => item.iso_639_1 === originalLanguage)?.english_name, countriesList.find((item) => item.iso_3166_1 === originCountry)?.english_name].filter(Boolean).join(' · ') : 'Any language or country', icon: 'A' },
                  { key: 'providers', label: 'Streaming providers', value: selectedProviders.length ? selectedProviders.map((provider) => provider.name).join(', ') : `Any provider · ${watchRegion}`, icon: '▰' },
                  { key: 'cast', label: 'Cast', value: peopleList.length ? peopleList.map((person) => person.name).join(', ') : 'Anyone', icon: '●' },
                  { key: 'studios', label: 'Studios', value: includeCompanies.length ? includeCompanies.map((company) => company.name).join(', ') : 'Any studio', icon: '▥' },
                  { key: 'include-keywords', label: 'Include keywords', value: includeKeywords.length ? includeKeywords.map((keyword) => keyword.name).join(', ') : 'Anything', icon: '⌕' },
                  { key: 'exclude-keywords', label: 'Exclude keywords', value: excludeKeywords.length ? excludeKeywords.map((keyword) => keyword.name).join(', ') : 'Nothing specific', icon: '−' },
                  { key: 'runtime', label: 'Runtime', value: runtimeMin || runtimeMax ? `${runtimeMin || '0'}–${runtimeMax || 'any'} min` : 'Any length', icon: '◷' },
                  { key: 'visibility', label: 'Visibility', value: showOnHome ? 'Library and Home' : 'Library only', icon: '⌂' },
                  { key: 'max-results', label: 'Maximum results', value: maxResults ? `${maxResults} titles` : 'Uncapped', icon: '#' },
                ].map((item) => (
                  <button key={item.key} type="button" aria-expanded={quickEditor === item.key} onClick={() => setQuickEditor((current) => current === item.key ? null : item.key)} className={`group flex min-w-0 items-center gap-3 rounded-2xl border p-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${quickEditor === item.key ? 'border-accent/40 bg-accent/[0.10]' : 'border-white/[0.09] bg-white/[0.045] hover:-translate-y-0.5 hover:border-accent/35 hover:bg-accent/[0.08]'}`}>
                    <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-white/[0.08] text-base font-bold text-accent">{item.icon}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold text-white/80">{item.label}</span><span className="block truncate text-xs text-white/38">{item.value}</span></span><span className="text-xl text-white/30 transition-transform group-hover:translate-x-0.5 group-hover:text-accent">›</span>
                  </button>
                ))}
              </div>
              {quickEditor && (
                <div className="mt-3 rounded-2xl border border-accent/25 bg-white/[0.045] p-4 sm:p-5">
                  {quickEditor === 'max-results' && <label className="mb-4 block max-w-xs text-xs text-white/45">Maximum titles<input type="number" min="1" max="10000" value={maxResults} onChange={(e) => setMaxResults(e.target.value)} placeholder="Uncapped" className={`${styledInput} mt-1.5`} /><span className="mt-1.5 block text-[11px] text-white/30">Leave empty to load every matching title.</span></label>}
                  <div className="mb-4 flex items-center justify-between"><p className="text-sm font-bold text-white/80">Edit {quickEditor.replace(/-/g, ' ')}</p><button type="button" onClick={() => setQuickEditor(null)} className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.06] text-white/45 hover:bg-white/[0.10] hover:text-white">×</button></div>
                  {quickEditor === 'ordering' && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{[
                    ['popularity.desc', 'Popular'], ['vote_average.desc', 'Highest rated'],
                    [contentType === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc', 'Newest'],
                    [contentType === 'movie' ? 'primary_release_date.asc' : 'first_air_date.asc', 'Oldest'],
                  ].map(([value, label]) => <button type="button" key={value} onClick={() => setSortBy(value)} className={`rounded-xl border px-4 py-3 text-left text-xs font-semibold ${sortBy === value ? 'border-accent/40 bg-accent/15 text-accent' : 'border-white/[0.08] bg-black/10 text-white/55 hover:text-white'}`}>{label}</button>)}</div>}
                  {quickEditor === 'period' && <div className="space-y-4"><div className="flex flex-wrap gap-2">{['This Month', 'This Year', 'Last Year', 'Last 5 Years', '2010s', '2000s', '1990s', '1980s'].map((value) => <button type="button" key={value} onClick={() => applyPreset(value)} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${presetName === value ? 'border-accent/35 bg-accent/15 text-accent' : 'border-white/[0.08] bg-white/[0.03] text-white/50'}`}>{value}</button>)}<button type="button" onClick={() => applyPreset('Clear')} className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-white/45">Any period</button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-[11px] text-white/40">From<input type="date" value={releaseDateFrom} onChange={(e) => { setReleaseDateFrom(e.target.value); setPresetName('') }} className={`${styledInput} mt-1.5`} /></label><label className="text-[11px] text-white/40">To<input type="date" value={releaseDateTo} onChange={(e) => { setReleaseDateTo(e.target.value); setPresetName('') }} className={`${styledInput} mt-1.5`} /></label></div></div>}
                  {quickEditor === 'genres' && <div className="grid gap-4 sm:grid-cols-2"><div><div className="mb-2 flex items-center justify-between"><label className="text-xs text-white/50">Include genres</label><MatchModeToggle value={genreMatchMode} onChange={setGenreMatchMode} name="quick-genre" /></div><select value="" onChange={(e) => { if (e.target.value && !selectedIncludeGenres.includes(e.target.value)) setSelectedIncludeGenres([...selectedIncludeGenres, e.target.value]) }} className={styledSelect}><option value="">Add genre…</option>{genresList.map((genre) => <option key={genre.id} value={genre.id} className="bg-[#0a0b0e]">{genre.name}</option>)}</select><div className="mt-2 flex flex-wrap gap-1.5">{selectedIncludeGenres.map((id) => <button type="button" key={id} onClick={() => setSelectedIncludeGenres(selectedIncludeGenres.filter((item) => item !== id))} className="rounded-lg bg-accent/10 px-2.5 py-1 text-[11px] text-accent">{genresList.find((genre) => String(genre.id) === id)?.name || id} ×</button>)}</div></div><div><label className="mb-2 block text-xs text-white/50">Exclude genres</label><select value="" onChange={(e) => { if (e.target.value && !selectedExcludeGenres.includes(e.target.value)) setSelectedExcludeGenres([...selectedExcludeGenres, e.target.value]) }} className={styledSelect}><option value="">Exclude genre…</option>{genresList.map((genre) => <option key={genre.id} value={genre.id} className="bg-[#0a0b0e]">{genre.name}</option>)}</select><div className="mt-2 flex flex-wrap gap-1.5">{selectedExcludeGenres.map((id) => <button type="button" key={id} onClick={() => setSelectedExcludeGenres(selectedExcludeGenres.filter((item) => item !== id))} className="rounded-lg bg-red-500/10 px-2.5 py-1 text-[11px] text-red-300">{genresList.find((genre) => String(genre.id) === id)?.name || id} ×</button>)}</div></div></div>}
                  {quickEditor === 'rating' && <div className="grid gap-4 sm:grid-cols-3"><label className="text-xs text-white/45">Minimum rating<input type="number" min="0" max="10" step="0.5" value={voteAverageMin} onChange={(e) => setVoteAverageMin(Math.min(10, Math.max(0, Number(e.target.value))))} className={`${styledInput} mt-1.5`} /></label><label className="text-xs text-white/45">Maximum rating<input type="number" min="0" max="10" step="0.5" value={voteAverageMax} onChange={(e) => setVoteAverageMax(Math.min(10, Math.max(0, Number(e.target.value))))} className={`${styledInput} mt-1.5`} /></label><label className="text-xs text-white/45">Minimum votes<input type="number" min="0" value={voteCountMin} onChange={(e) => setVoteCountMin(e.target.value)} placeholder="Any" className={`${styledInput} mt-1.5`} /></label></div>}
                  {quickEditor === 'language' && <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-white/45">Original language<select value={originalLanguage} onChange={(e) => setOriginalLanguage(e.target.value)} className={`${styledSelect} mt-1.5`}><option value="">Any language</option>{languagesList.map((language) => <option key={language.iso_639_1} value={language.iso_639_1} className="bg-[#0a0b0e]">{language.english_name}</option>)}</select></label><label className="text-xs text-white/45">Country of origin<select value={originCountry} onChange={(e) => setOriginCountry(e.target.value)} className={`${styledSelect} mt-1.5`}><option value="Any">Any country</option>{countriesList.map((country) => <option key={country.iso_3166_1} value={country.iso_3166_1} className="bg-[#0a0b0e]">{country.english_name}</option>)}</select></label></div>}
                  {quickEditor === 'providers' && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><select value={watchRegion} onChange={(e) => setWatchRegion(e.target.value)} className={styledSelect}>{[['US','United States'],['GB','United Kingdom'],['DE','Germany'],['FR','France'],['CA','Canada'],['AU','Australia'],['JP','Japan']].map(([code, name]) => <option key={code} value={code} className="bg-[#0a0b0e]">{name} ({code})</option>)}</select><input value={providerSearch} onChange={(e) => setProviderSearch(e.target.value)} placeholder="Search providers…" className={styledInput} /></div><div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto">{filteredProviders.slice(0, 80).map((provider) => { const selected = selectedProviders.some((item) => item.id === provider.provider_id); return <button type="button" key={provider.provider_id} onClick={() => setSelectedProviders(selected ? selectedProviders.filter((item) => item.id !== provider.provider_id) : [...selectedProviders, { id: provider.provider_id, name: provider.provider_name }])} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${selected ? 'border-accent/35 bg-accent/15 text-accent' : 'border-white/[0.08] text-white/45'}`}>{provider.provider_name}</button> })}</div></div>}
                  {quickEditor === 'cast' && <div className="relative"><input value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} placeholder="Search actors, directors, or people…" className={styledInput} />{peopleSuggestions.length > 0 && <div className="mt-2 overflow-hidden rounded-xl border border-white/10 bg-[#14161d]">{peopleSuggestions.map((person) => <button type="button" key={person.id} onClick={() => { if (!peopleList.some((item) => item.id === person.id)) setPeopleList([...peopleList, { id: person.id, name: person.name }]); setPeopleSearch(''); setPeopleSuggestions([]) }} className="block w-full border-b border-white/[0.05] px-3 py-2 text-left text-xs text-white/70 last:border-0 hover:bg-white/[0.05]">{person.name}</button>)}</div>}<div className="mt-3 flex flex-wrap gap-2">{peopleList.map((person) => <button type="button" key={person.id} onClick={() => setPeopleList(peopleList.filter((item) => item.id !== person.id))} className="rounded-lg bg-accent/10 px-2.5 py-1.5 text-xs text-accent">{person.name} ×</button>)}</div></div>}
                  {quickEditor === 'studios' && <div><input value={companySearch} onChange={(e) => setCompanySearch(e.target.value)} placeholder="Search studios or companies…" className={styledInput} />{companySuggestions.length > 0 && <div className="mt-2 overflow-hidden rounded-xl border border-white/10 bg-[#14161d]">{companySuggestions.map((company) => <button type="button" key={company.id} onClick={() => { if (!includeCompanies.some((item) => item.id === company.id)) setIncludeCompanies([...includeCompanies, company]); setCompanySearch(''); setCompanySuggestions([]) }} className="block w-full border-b border-white/[0.05] px-3 py-2 text-left text-xs text-white/70 last:border-0 hover:bg-white/[0.05]">{company.name}</button>)}</div>}<div className="mt-3 flex flex-wrap gap-2">{includeCompanies.map((company) => <button type="button" key={company.id} onClick={() => setIncludeCompanies(includeCompanies.filter((item) => item.id !== company.id))} className="rounded-lg bg-accent/10 px-2.5 py-1.5 text-xs text-accent">{company.name} ×</button>)}</div></div>}
                  {(quickEditor === 'include-keywords' || quickEditor === 'exclude-keywords') && <div><input value={keywordSearch} onChange={(e) => setKeywordSearch(e.target.value)} placeholder="Search keywords…" className={styledInput} />{keywordSuggestions.length > 0 && <div className="mt-2 overflow-hidden rounded-xl border border-white/10 bg-[#14161d]">{keywordSuggestions.map((keyword) => <button type="button" key={keyword.id} onClick={() => { const excluding = quickEditor === 'exclude-keywords'; if (excluding && !excludeKeywords.some((item) => item.id === keyword.id)) setExcludeKeywords([...excludeKeywords, keyword]); if (!excluding && !includeKeywords.some((item) => item.id === keyword.id)) setIncludeKeywords([...includeKeywords, keyword]); setKeywordSearch(''); setKeywordSuggestions([]) }} className="block w-full border-b border-white/[0.05] px-3 py-2 text-left text-xs text-white/70 last:border-0 hover:bg-white/[0.05]">{keyword.name}</button>)}</div>}<div className="mt-3 flex flex-wrap gap-2">{(quickEditor === 'exclude-keywords' ? excludeKeywords : includeKeywords).map((keyword) => <button type="button" key={keyword.id} onClick={() => quickEditor === 'exclude-keywords' ? setExcludeKeywords(excludeKeywords.filter((item) => item.id !== keyword.id)) : setIncludeKeywords(includeKeywords.filter((item) => item.id !== keyword.id))} className={`rounded-lg px-2.5 py-1.5 text-xs ${quickEditor === 'exclude-keywords' ? 'bg-red-500/10 text-red-300' : 'bg-accent/10 text-accent'}`}>{keyword.name} ×</button>)}</div></div>}
                  {quickEditor === 'runtime' && <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-white/45">Minimum minutes<input type="number" min="0" value={runtimeMin} onChange={(e) => setRuntimeMin(e.target.value)} placeholder="Any" className={`${styledInput} mt-1.5`} /></label><label className="text-xs text-white/45">Maximum minutes<input type="number" min="0" value={runtimeMax} onChange={(e) => setRuntimeMax(e.target.value)} placeholder="Any" className={`${styledInput} mt-1.5`} /></label></div>}
                  {quickEditor === 'visibility' && <div className="grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => setShowOnHome(false)} className={`rounded-xl border p-4 text-left ${!showOnHome ? 'border-accent/35 bg-accent/15' : 'border-white/[0.08]'}`}><span className="block text-sm font-bold text-white/80">Library only</span><span className="mt-1 block text-xs text-white/35">Keep it out of the Home screen.</span></button><button type="button" onClick={() => setShowOnHome(true)} className={`rounded-xl border p-4 text-left ${showOnHome ? 'border-accent/35 bg-accent/15' : 'border-white/[0.08]'}`}><span className="block text-sm font-bold text-white/80">Library and Home</span><span className="mt-1 block text-xs text-white/35">Also add this collection as a Home shelf.</span></button></div>}
                </div>
              )}
              </div>

              {false && <details open={advancedBuilderOpen} onToggle={(event) => setAdvancedBuilderOpen(event.currentTarget.open)} className="rounded-2xl border border-white/[0.07] bg-black/[0.12]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-bold text-white/70 marker:hidden"><span>Templates &amp; uncommon settings</span><span className="text-lg text-white/35">{advancedBuilderOpen ? '−' : '+'}</span></summary>
                <div className="space-y-5 border-t border-white/[0.06] p-4 sm:p-5">

              {/* ── Setup Tab ── */}
              {(
                <div className="space-y-5">
                  {!editingRow && (
                    <div className="space-y-3">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/55">Start with a template</h3>
                        <p className="text-[11px] text-white/25 mt-1">Choose a starting point, then adjust any rule before saving.</p>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                        {SMART_COLLECTION_TEMPLATES.map((template) => (
                          <button
                            key={template.id}
                            type="button"
                            onClick={() => applySmartCollectionTemplate(template)}
                            className={`rounded-xl border p-3.5 text-left transition-all cursor-pointer ${presetName === template.id ? 'bg-accent/12 border-accent/30' : 'bg-white/[0.025] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12]'}`}
                          >
                            <span className={`block text-xs font-bold ${presetName === template.id ? 'text-accent' : 'text-white/75'}`}>{template.label}</span>
                            <span className="block text-[10px] leading-relaxed text-white/30 mt-1">{template.description}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div id="smart-setup" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><circle cx="12" cy="12" r="3" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Collection Setup</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Name</label>
                        <input value={catalogName} onChange={(e) => setCatalogName(e.target.value)} placeholder="e.g. Cyberpunk Essentials" className={styledInput} />
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Source</label>
                        <div className={`${styledInput} text-white/60`}>TMDB <span className="ml-2 text-[10px] text-white/25">Smart Collections currently use TMDB</span></div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Content Type</label>
                        <select value={contentType} onChange={(e) => setContentType(e.target.value as any)} className={styledSelect}>
                          <option value="movie" className="bg-[#0a0b0e]">Movies</option>
                          <option value="series" className="bg-[#0a0b0e]">TV Shows</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Sort By</label>
                        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={styledSelect}>
                          <option value="popularity.desc" className="bg-[#0a0b0e]">Popularity (High to Low)</option>
                          <option value="popularity.asc" className="bg-[#0a0b0e]">Popularity (Low to High)</option>
                          <option value="vote_average.desc" className="bg-[#0a0b0e]">Rating (High to Low)</option>
                          <option value="vote_average.asc" className="bg-[#0a0b0e]">Rating (Low to High)</option>
                          {contentType === 'movie' ? (
                            <>
                              <option value="primary_release_date.desc" className="bg-[#0a0b0e]">Release Date (Newest)</option>
                              <option value="primary_release_date.asc" className="bg-[#0a0b0e]">Release Date (Oldest)</option>
                            </>
                          ) : (
                            <>
                              <option value="first_air_date.desc" className="bg-[#0a0b0e]">Air Date (Newest)</option>
                              <option value="first_air_date.asc" className="bg-[#0a0b0e]">Air Date (Oldest)</option>
                            </>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Cache TTL (seconds)</label>
                        <input type="number" value={cacheTtl} onChange={(e) => setCacheTtl(Math.max(300, parseInt(e.target.value) || 300))} min="300" className={styledInput} />
                        <span className="text-[9px] text-white/20 mt-1 block">Min 300s (5 min)</span>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Maximum results</label>
                        <input type="number" min="1" max="10000" value={maxResults} onChange={(e) => setMaxResults(e.target.value)} placeholder="Uncapped" className={styledInput} />
                        <span className="text-[9px] text-white/20 mt-1 block">Leave empty to load all matching results.</span>
                      </div>
                      <div className="flex items-start gap-3 pt-5">
                        <PillToggle checked={releasedOnly} onChange={setReleasedOnly} label="Released Only" />
                        <PillToggle checked={includeAdult} onChange={setIncludeAdult} label="Adult" />
                      </div>
                    </div>
                    <div className="pt-3 border-t border-white/[0.06]">
                      <PillToggle checked={showOnHome} onChange={setShowOnHome} label="Show on Home" />
                      <p className="text-[10px] text-white/25 mt-2">The collection always remains available in Library.</p>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Filters Tab ── */}
              {(
                <div className="space-y-5">
                  <div id="smart-genres" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Genres & Language</h3>
                    </div>

                    {/* Genre Include/Exclude */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[11px] text-white/40 font-medium">Include Genres</label>
                          <MatchModeToggle value={genreMatchMode} onChange={setGenreMatchMode} name="genre" />
                        </div>
                        <select onChange={(e) => { const v = e.target.value; if (v && !selectedIncludeGenres.includes(v)) setSelectedIncludeGenres([...selectedIncludeGenres, v]); e.target.value = '' }} className={styledSelect}>
                          <option value="">+ Add genre</option>
                          {genresList.map((g) => (<option key={g.id} value={g.id} className="bg-[#0a0b0e]">{g.name}</option>))}
                        </select>
                        <div className="flex flex-wrap gap-1.5 mt-2 min-h-[28px]">
                          {selectedIncludeGenres.length === 0 && <span className="text-[10px] text-white/15 italic">No genres selected</span>}
                          {selectedIncludeGenres.map((gid) => {
                            const g = genresList.find((item) => String(item.id) === gid)
                            return (
                              <span key={gid} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-[11px] font-medium">
                                {g?.name || gid}
                                <button onClick={() => setSelectedIncludeGenres(selectedIncludeGenres.filter((id) => id !== gid))} className="hover:text-white cursor-pointer text-emerald-400/60 hover:text-emerald-300 transition-colors">&times;</button>
                              </span>
                            )
                          })}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Exclude Genres</label>
                        <select onChange={(e) => { const v = e.target.value; if (v && !selectedExcludeGenres.includes(v)) setSelectedExcludeGenres([...selectedExcludeGenres, v]); e.target.value = '' }} className={styledSelect}>
                          <option value="">+ Exclude genre</option>
                          {genresList.map((g) => (<option key={g.id} value={g.id} className="bg-[#0a0b0e]">{g.name}</option>))}
                        </select>
                        <div className="flex flex-wrap gap-1.5 mt-2 min-h-[28px]">
                          {selectedExcludeGenres.length === 0 && <span className="text-[10px] text-white/15 italic">None excluded</span>}
                          {selectedExcludeGenres.map((gid) => {
                            const g = genresList.find((item) => String(item.id) === gid)
                            return (
                              <span key={gid} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-[11px] font-medium">
                                {g?.name || gid}
                                <button onClick={() => setSelectedExcludeGenres(selectedExcludeGenres.filter((id) => id !== gid))} className="hover:text-white cursor-pointer text-red-400/60 hover:text-red-300 transition-colors">&times;</button>
                              </span>
                            )
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Language / Country / Region / Certification */}
                    <div className="border-t border-white/[0.06] pt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Original Language</label>
                        <select value={originalLanguage} onChange={(e) => setOriginalLanguage(e.target.value)} className={styledSelect}>
                          <option value="Any" className="bg-[#0a0b0e]">Any</option>
                          {languagesList.map((lang) => (<option key={lang.iso_639_1} value={lang.iso_639_1} className="bg-[#0a0b0e]">{lang.english_name}</option>))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Origin Country</label>
                        <select value={originCountry} onChange={(e) => setOriginCountry(e.target.value)} className={styledSelect}>
                          <option value="Any" className="bg-[#0a0b0e]">Any</option>
                          {countriesList.map((c) => (<option key={c.iso_3166_1} value={c.iso_3166_1} className="bg-[#0a0b0e]">{c.english_name}</option>))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Release Region</label>
                        <select value={releaseRegion} onChange={(e) => setReleaseRegion(e.target.value)} className={styledSelect}>
                          <option value="Any" className="bg-[#0a0b0e]">Any</option>
                          {countriesList.map((c) => (<option key={c.iso_3166_1} value={c.iso_3166_1} className="bg-[#0a0b0e]">{c.english_name}</option>))}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Certification Country</label>
                        <select value={certificationCountry} onChange={(e) => { setCertificationCountry(e.target.value); setCertification('None') }} className={styledSelect}>
                          <option value="None" className="bg-[#0a0b0e]">None</option>
                          {certificationCountries.map((c) => (<option key={c} value={c} className="bg-[#0a0b0e]">{c}</option>))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Certification</label>
                        <select value={certification} disabled={certificationCountry === 'None'} onChange={(e) => setCertification(e.target.value)} className={`${styledSelect} disabled:opacity-30`}>
                          <option value="None" className="bg-[#0a0b0e]">None</option>
                          {certificationsForCountry.map((c) => (<option key={c.certification} value={c.certification} className="bg-[#0a0b0e]">{c.certification}</option>))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Streaming Tab ── */}
              {(
                <div className="space-y-5">
                  <div id="smart-streaming" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Streaming & Region</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Watch Region</label>
                        <select value={watchRegion} onChange={(e) => setWatchRegion(e.target.value)} className={styledSelect}>
                          <option value="US" className="bg-[#0a0b0e]">United States (US)</option>
                          <option value="GB" className="bg-[#0a0b0e]">United Kingdom (GB)</option>
                          <option value="CA" className="bg-[#0a0b0e]">Canada (CA)</option>
                          <option value="AU" className="bg-[#0a0b0e]">Australia (AU)</option>
                          <option value="DE" className="bg-[#0a0b0e]">Germany (DE)</option>
                          <option value="FR" className="bg-[#0a0b0e]">France (FR)</option>
                          <option value="ES" className="bg-[#0a0b0e]">Spain (ES)</option>
                          <option value="IT" className="bg-[#0a0b0e]">Italy (IT)</option>
                          <option value="BR" className="bg-[#0a0b0e]">Brazil (BR)</option>
                          <option value="IN" className="bg-[#0a0b0e]">India (IN)</option>
                          <option value="JP" className="bg-[#0a0b0e]">Japan (JP)</option>
                        </select>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[11px] text-white/40 font-medium">Provider Matching</label>
                          <MatchModeToggle value={providerMatchMode} onChange={setProviderMatchMode} name="provider" />
                        </div>
                        <input value={providerSearch} onChange={(e) => setProviderSearch(e.target.value)} placeholder="Filter providers..." className={styledInput} />
                      </div>
                    </div>

                    {/* Quick select popular */}
                    {quickSelectProviders.length > 0 && (
                      <div>
                        <label className="block text-[10px] text-white/25 mb-2 uppercase tracking-wider font-semibold">Popular Services</label>
                        <div className="flex flex-wrap gap-2">
                          {quickSelectProviders.map((provider) => {
                            const selected = selectedProviders.some((p) => p.id === provider.provider_id)
                            return (
                              <button
                                key={`quick-${provider.provider_id}`}
                                onClick={() => {
                                  if (selected) setSelectedProviders(selectedProviders.filter((p) => p.id !== provider.provider_id))
                                  else setSelectedProviders([...selectedProviders, { id: provider.provider_id, name: provider.provider_name }])
                                }}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all cursor-pointer ${
                                  selected
                                    ? 'bg-accent/15 border-accent/30 text-white'
                                    : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:bg-white/[0.06] hover:text-white/60'
                                }`}
                              >
                                {provider.logo_path && (
                                  <img src={`https://image.tmdb.org/t/p/original${provider.logo_path}`} alt="" className="w-5 h-5 rounded object-cover" loading="lazy" />
                                )}
                                <span>{provider.provider_name}</span>
                                {selected && <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Full provider grid */}
                    <div>
                      <label className="block text-[11px] text-white/40 mb-2 font-medium">All Providers</label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-1.5 max-h-44 overflow-y-auto border border-white/[0.04] bg-black/20 p-2.5 rounded-xl" style={{ scrollbarWidth: 'thin' }}>
                        {filteredProviders.map((provider) => {
                          const selected = selectedProviders.some((p) => p.id === provider.provider_id)
                          return (
                            <button
                              key={provider.provider_id}
                              onClick={() => {
                                if (selected) setSelectedProviders(selectedProviders.filter((p) => p.id !== provider.provider_id))
                                else setSelectedProviders([...selectedProviders, { id: provider.provider_id, name: provider.provider_name }])
                              }}
                              className={`flex items-center gap-2 p-2 rounded-lg border text-left text-[11px] transition-all cursor-pointer select-none ${
                                selected
                                  ? 'bg-accent/10 border-accent/25 text-white'
                                  : 'bg-white/[0.02] border-white/[0.04] text-white/35 hover:bg-white/[0.04]'
                              }`}
                            >
                              {provider.logo_path && (
                                <img src={`https://image.tmdb.org/t/p/original${provider.logo_path}`} alt="" className="w-5 h-5 rounded object-cover flex-shrink-0" loading="lazy" />
                              )}
                              <span className="truncate">{provider.provider_name}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {/* Selected providers chips */}
                    {selectedProviders.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedProviders.map((p) => (
                          <span key={p.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-accent/10 text-accent border border-accent/20 rounded-lg text-[11px] font-medium">
                            {p.name}
                            <button onClick={() => setSelectedProviders(selectedProviders.filter((item) => item.id !== p.id))} className="text-accent/50 hover:text-accent cursor-pointer transition-colors">&times;</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── People & Tags Tab ── */}
              {(
                <div className="space-y-5">
                  <div id="smart-people" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">People</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
                      <div className="relative">
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Search People</label>
                        <input value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} placeholder="e.g. Denis Villeneuve, Timothee Chalamet..." className={styledInput} />
                        {peopleSuggestions.length > 0 && (
                          <div className="absolute z-50 left-0 right-0 mt-1 max-h-44 overflow-y-auto bg-[#14161d] border border-white/10 rounded-xl shadow-2xl" style={{ scrollbarWidth: 'thin' }}>
                            {peopleSuggestions.map((p) => (
                              <button key={p.id} onClick={() => { if (!peopleList.some((item) => item.id === p.id)) setPeopleList([...peopleList, { id: p.id, name: p.name }]); setPeopleSearch(''); setPeopleSuggestions([]) }} className="w-full text-left px-3 py-2.5 text-sm hover:bg-white/[0.05] transition-colors border-b border-white/[0.04] last:border-none flex items-center gap-3 cursor-pointer">
                                {p.profile_path && (<img src={`https://image.tmdb.org/t/p/w92${p.profile_path}`} className="w-6 h-6 rounded-full object-cover" alt="" />)}
                                <span className="text-white/80">{p.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-end pb-0.5">
                        <MatchModeToggle value={peopleMatchMode} onChange={setPeopleMatchMode} name="people" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                      {peopleList.length === 0 && <span className="text-[10px] text-white/15 italic">No people selected</span>}
                      {peopleList.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-accent/10 text-accent border border-accent/20 rounded-lg text-[11px] font-medium">
                          {p.name}
                          <button onClick={() => setPeopleList(peopleList.filter((item) => item.id !== p.id))} className="text-accent/50 hover:text-accent cursor-pointer transition-colors">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Companies */}
                  <div id="smart-companies" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-md bg-accent/10 flex items-center justify-center"><svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg></div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Companies</h3>
                      </div>
                      <MatchModeToggle value={companyMatchMode} onChange={setCompanyMatchMode} name="company" />
                    </div>
                    <div className="relative">
                      <input value={companySearch} onChange={(e) => setCompanySearch(e.target.value)} placeholder="Search company (e.g. Pixar, Marvel)..." className={styledInput} />
                      {companySuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-44 overflow-y-auto bg-[#14161d] border border-white/10 rounded-xl shadow-2xl" style={{ scrollbarWidth: 'thin' }}>
                          {companySuggestions.map((c) => (
                            <div key={c.id} className="flex justify-between items-center px-3 py-2 hover:bg-white/[0.04] border-b border-white/[0.04] last:border-none">
                              <span className="text-sm text-white/80">{c.name}</span>
                              <div className="flex gap-1.5">
                                <button onClick={() => { if (!includeCompanies.some((item) => item.id === c.id)) setIncludeCompanies([...includeCompanies, c]); setCompanySearch(''); setCompanySuggestions([]) }} className="px-2.5 py-1 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 font-semibold rounded-md text-[10px] cursor-pointer transition-colors">Include</button>
                                <button onClick={() => { if (!excludeCompanies.some((item) => item.id === c.id)) setExcludeCompanies([...excludeCompanies, c]); setCompanySearch(''); setCompanySuggestions([]) }} className="px-2.5 py-1 bg-red-500/15 text-red-400 hover:bg-red-500/25 font-semibold rounded-md text-[10px] cursor-pointer transition-colors">Exclude</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] text-white/25 mb-1.5 font-medium uppercase tracking-wider">Included</label>
                        <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                          {includeCompanies.length === 0 && <span className="text-[10px] text-white/15 italic">None</span>}
                          {includeCompanies.map((c) => (
                            <span key={c.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-[11px] font-medium">
                              {c.name}
                              <button onClick={() => setIncludeCompanies(includeCompanies.filter((item) => item.id !== c.id))} className="text-emerald-400/50 hover:text-emerald-300 cursor-pointer transition-colors">&times;</button>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] text-white/25 mb-1.5 font-medium uppercase tracking-wider">Excluded</label>
                        <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                          {excludeCompanies.length === 0 && <span className="text-[10px] text-white/15 italic">None</span>}
                          {excludeCompanies.map((c) => (
                            <span key={c.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-[11px] font-medium">
                              {c.name}
                              <button onClick={() => setExcludeCompanies(excludeCompanies.filter((item) => item.id !== c.id))} className="text-red-400/50 hover:text-red-300 cursor-pointer transition-colors">&times;</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Keywords */}
                  <div id="smart-keywords" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-md bg-accent/10 flex items-center justify-center"><svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg></div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Keywords</h3>
                      </div>
                      <MatchModeToggle value={keywordMatchMode} onChange={setKeywordMatchMode} name="keyword" />
                    </div>
                    <div className="relative">
                      <input value={keywordSearch} onChange={(e) => setKeywordSearch(e.target.value)} placeholder="Search keyword (e.g. time travel, dystopia)..." className={styledInput} />
                      {keywordSuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-44 overflow-y-auto bg-[#14161d] border border-white/10 rounded-xl shadow-2xl" style={{ scrollbarWidth: 'thin' }}>
                          {keywordSuggestions.map((k) => (
                            <div key={k.id} className="flex justify-between items-center px-3 py-2 hover:bg-white/[0.04] border-b border-white/[0.04] last:border-none">
                              <span className="text-sm text-white/80">{k.name}</span>
                              <div className="flex gap-1.5">
                                <button onClick={() => { if (!includeKeywords.some((item) => item.id === k.id)) setIncludeKeywords([...includeKeywords, k]); setKeywordSearch(''); setKeywordSuggestions([]) }} className="px-2.5 py-1 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 font-semibold rounded-md text-[10px] cursor-pointer transition-colors">Include</button>
                                <button onClick={() => { if (!excludeKeywords.some((item) => item.id === k.id)) setExcludeKeywords([...excludeKeywords, k]); setKeywordSearch(''); setKeywordSuggestions([]) }} className="px-2.5 py-1 bg-red-500/15 text-red-400 hover:bg-red-500/25 font-semibold rounded-md text-[10px] cursor-pointer transition-colors">Exclude</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] text-white/25 mb-1.5 font-medium uppercase tracking-wider">Included</label>
                        <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                          {includeKeywords.length === 0 && <span className="text-[10px] text-white/15 italic">None</span>}
                          {includeKeywords.map((k) => (
                            <span key={k.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-[11px] font-medium">
                              {k.name}
                              <button onClick={() => setIncludeKeywords(includeKeywords.filter((item) => item.id !== k.id))} className="text-emerald-400/50 hover:text-emerald-300 cursor-pointer transition-colors">&times;</button>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] text-white/25 mb-1.5 font-medium uppercase tracking-wider">Excluded</label>
                        <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                          {excludeKeywords.length === 0 && <span className="text-[10px] text-white/15 italic">None</span>}
                          {excludeKeywords.map((k) => (
                            <span key={k.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg text-[11px] font-medium">
                              {k.name}
                              <button onClick={() => setExcludeKeywords(excludeKeywords.filter((item) => item.id !== k.id))} className="text-red-400/50 hover:text-red-300 cursor-pointer transition-colors">&times;</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Date & Rating Tab ── */}
              {(
                <div className="space-y-5">
                  {/* Rating & Runtime */}
                  <div id="smart-rating" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Rating & Runtime</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-2 font-medium">Vote Average: {voteAverageMin} - {voteAverageMax}</label>
                        <div className="flex items-center gap-3">
                          <input type="range" min="0" max="10" step="0.5" value={voteAverageMin} onChange={(e) => setVoteAverageMin(parseFloat(e.target.value))} className="flex-1 accent-accent" />
                          <span className="text-white/20 text-xs">to</span>
                          <input type="range" min="0" max="10" step="0.5" value={voteAverageMax} onChange={(e) => setVoteAverageMax(parseFloat(e.target.value))} className="flex-1 accent-accent" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Min Vote Count</label>
                        <input type="number" placeholder="e.g. 100" value={voteCountMin} onChange={(e) => setVoteCountMin(e.target.value)} className={styledInput} />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Runtime (min)</label>
                        <div className="flex items-center gap-2">
                          <input type="number" placeholder="Min" value={runtimeMin} onChange={(e) => setRuntimeMin(e.target.value)} className={styledInput} />
                          <span className="text-white/20 text-xs flex-shrink-0">to</span>
                          <input type="number" placeholder="Max" value={runtimeMax} onChange={(e) => setRuntimeMax(e.target.value)} className={styledInput} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Release Date */}
                  <div id="smart-dates" className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Release Date</h3>
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/25 mb-2 uppercase tracking-wider font-semibold">Quick Presets</label>
                      <div className="flex flex-wrap gap-1.5">
                        {['This Month', 'Last Month', 'This Year', 'Last Year', 'Last 5 Years', 'Last 10 Years', '2010s', '2000s', '1990s', '1980s'].map((preset) => (
                          <button
                            key={preset}
                            onClick={() => applyPreset(preset)}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer ${
                              presetName === preset
                                ? 'bg-accent/15 border-accent/30 text-accent'
                                : 'bg-white/[0.03] border-white/[0.06] text-white/35 hover:border-white/10 hover:text-white/50'
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                        <button onClick={() => applyPreset('Clear')} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-500/10 border border-red-500/15 text-red-400/70 hover:bg-red-500/20 hover:text-red-400 transition-all cursor-pointer">
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">From</label>
                        <input type="date" value={releaseDateFrom} onChange={(e) => { setReleaseDateFrom(e.target.value); setPresetName('') }} className={styledInput} />
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">To</label>
                        <input type="date" value={releaseDateTo} onChange={(e) => { setReleaseDateTo(e.target.value); setPresetName('') }} className={styledInput} />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Preview Section (always visible) ── */}
                </div>
              </details>}

              <div className="bg-gradient-to-b from-accent/[0.04] to-white/[0.02] border border-accent/10 p-5 rounded-xl space-y-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    </div>
                    <div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Preview</h3>
                      <p className="text-[10px] text-white/30 mt-0.5">{Object.keys(livePreview).length - 3} active filters</p>
                    </div>
                  </div>
                  <button
                    onClick={runPreview}
                    disabled={previewLoading}
                    className="px-5 py-2.5 bg-accent/15 hover:bg-accent/25 text-accent border border-accent/20 text-xs font-bold rounded-xl transition-all cursor-pointer disabled:opacity-30 flex items-center gap-2"
                  >
                    {previewLoading ? (
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    )}
                    {previewLoading ? 'Testing...' : 'Test Query'}
                  </button>
                </div>

                <details className="group">
                  <summary className="text-[10px] text-white/25 font-medium cursor-pointer hover:text-white/40 transition-colors flex items-center gap-1.5 select-none">
                    <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>
                    Raw Query Parameters
                  </summary>
                  <div className="mt-2 bg-black/30 border border-white/[0.04] rounded-lg p-3 text-[10px] font-mono text-white/35 overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
                    {JSON.stringify(livePreview, null, 2)}
                  </div>
                </details>

                {previewItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <h4 className="text-[10px] font-bold text-white/35 uppercase tracking-wider">Matching Titles</h4>
                      <span className="text-[10px] text-accent/70 bg-accent/10 px-2 py-0.5 rounded-md font-bold">{previewItems.length}</span>
                    </div>
                    <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
                      {previewItems.map((item) => (
                        <div key={item.id} className="w-20 flex-shrink-0 flex flex-col items-center group">
                          {item.poster ? (
                            <img src={item.poster} className="w-full aspect-[2/3] object-cover rounded-lg border border-white/[0.06] group-hover:border-accent/30 group-hover:shadow-lg group-hover:shadow-accent/5 transition-all" alt="" />
                          ) : (
                            <div className="w-full aspect-[2/3] bg-white/[0.04] border border-white/[0.06] rounded-lg flex items-center justify-center text-[8px] text-white/15 text-center px-1">
                              {item.title}
                            </div>
                          )}
                          <span className="text-[9px] text-white/30 group-hover:text-white/50 truncate w-full text-center mt-1.5 transition-colors">{item.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-between">
              <p className="text-[10px] text-white/20">{catalogName ? `"${catalogName}"` : 'Untitled collection'} &middot; {source} &middot; {contentType === 'movie' ? 'Movies' : 'TV Shows'}</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { if (editingRow || startMode === 'discover') onClose(); else setMode('preset') }}
                  className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white/40 hover:text-white hover:bg-white/[0.04] transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveDiscover}
                  disabled={savingDiscover}
                  className="px-6 py-2.5 bg-accent hover:bg-accent/80 text-black text-xs font-bold rounded-xl shadow-lg shadow-accent/10 transition-all cursor-pointer disabled:cursor-wait disabled:opacity-60"
                >
                  {savingDiscover ? 'Updating catalog…' : editingRow ? 'Save Changes' : 'Save Collection'}
                </button>
              </div>
            </div>
          </div>
        )}

        {mode === 'preset' && !editingRow && (
          <div className="flex-shrink-0 border-t border-white/[0.08] bg-black/40 px-5 py-3 backdrop-blur-xl sm:px-6">
            {selectedShelves.length > 0 && (
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
                {selectedShelves.map((selection) => (
                  <button key={selection.key} type="button" onClick={() => setSelectedShelves((current) => current.filter((item) => item.key !== selection.key))} className="group/chip flex max-w-52 flex-shrink-0 items-center gap-2 rounded-lg border border-accent/15 bg-accent/[0.07] px-2.5 py-1.5 text-[10px] font-semibold text-white/60 hover:border-red-400/20 hover:bg-red-400/[0.07] hover:text-white cursor-pointer">
                    <span className="truncate">{selection.row.title}</span><span className="text-white/25 group-hover/chip:text-red-300">×</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-white/70">{selectedShelves.length ? `${selectedShelves.length} ${selectedShelves.length === 1 ? 'shelf' : 'shelves'} selected` : 'Select catalogs to add'}</p>
                <p className="mt-0.5 truncate text-[10px] text-white/25">New shelves use Poster layout and can be changed after adding.</p>
              </div>
              {selectedShelves.length > 0 && <button type="button" onClick={() => setSelectedShelves([])} className="px-3 py-2 text-xs font-semibold text-white/35 hover:text-white/65 cursor-pointer">Clear</button>}
              <button
                type="button"
                disabled={selectedShelves.length === 0}
                onClick={() => { onBatchAdd?.(selectedShelves); setSelectedShelves([]); onClose() }}
                className="rounded-xl bg-accent px-5 py-2.5 text-xs font-bold text-black shadow-lg shadow-accent/15 transition-all hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
              >
                Add {selectedShelves.length || ''} {selectedShelves.length === 1 ? 'Shelf' : 'Shelves'}
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal open={confirmPickerExit} onClose={() => setConfirmPickerExit(false)} title="Discard selected shelves?" description="Your current catalog selections will be cleared before opening the Smart Collection builder." size="sm">
        <div className="flex justify-end gap-2.5">
          <button type="button" onClick={() => setConfirmPickerExit(false)} className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-xs font-bold text-white/55 hover:bg-white/[0.08] hover:text-white cursor-pointer">Keep Browsing</button>
          <button type="button" onClick={() => { setSelectedShelves([]); setConfirmPickerExit(false); setPickerSource(null); setSearch(''); setMode('discover') }} className="rounded-xl bg-accent px-4 py-2.5 text-xs font-bold text-black hover:bg-accent/80 cursor-pointer">Discard and Continue</button>
        </div>
      </Modal>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CollectionsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const homeRows = useAppStore((s) => s.homeRows)
  const updateHomeRow = useAppStore((s) => s.updateHomeRow)
  const removeHomeRow = useAppStore((s) => s.removeHomeRow)
  const reorderHomeRows = useAppStore((s) => s.reorderHomeRows)
  const setHomeRows = useAppStore((s) => s.setHomeRows)
  const addHomeRow = useAppStore((s) => s.addHomeRow)
  const addons = useAppStore((s) => s.addons)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'

  const [addOverlay, setAddOverlay] = useState(false)
  const [overlayStartMode, setOverlayStartMode] = useState<'preset' | 'discover'>('preset')
  const activeTab: 'collections' | 'shelves' | 'calendar' | 'activity' = searchParams.get('tab') === 'calendar' ? 'calendar' : searchParams.get('tab') === 'activity' ? 'activity' : searchParams.get('tab') === 'collections' ? 'collections' : 'shelves'
  const [editingRow, setEditingRow] = useState<HomeRowConfig | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<HomeRowConfig | null>(null)
  const [shelfQuery, setShelfQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('All')
  const [heroExpanded, setHeroExpanded] = useState(false)

  const heroRow = homeRows.find((r) => r.layout === 'hero')
  const allWidgetRows = homeRows
    .filter((r) => r.layout !== 'hero')
    .sort((a, b) => a.order - b.order)
  const smartCollectionRows = getSmartCollections(allWidgetRows)
  const allHomeShelfRows = getHomeShelfRows(allWidgetRows)
  const activeRows = activeTab === 'collections' ? smartCollectionRows : allHomeShelfRows
  const enabledWidgetRows = activeRows
  const fixedWidgetRows = enabledWidgetRows.filter((r) => r.layout === 'continue')
  const movableWidgetRows = enabledWidgetRows.filter((r) => r.layout !== 'continue')
  const widgetRows = [...fixedWidgetRows, ...movableWidgetRows]
  const hiddenCount = activeTab === 'shelves' ? activeRows.filter((row) => !row.enabled).length : 0

  const sourceOptions = useMemo(
    () => ['All', ...new Set(activeRows.map(shelfSourceLabel))],
    [activeRows],
  )
  const filtering = shelfQuery.trim() !== '' || sourceFilter !== 'All'
  const visibleRows = useMemo(() => {
    let rows = activeTab === 'collections' ? smartCollectionRows : widgetRows
    if (sourceFilter !== 'All') rows = rows.filter((r) => shelfSourceLabel(r) === sourceFilter)
    const q = shelfQuery.trim().toLowerCase()
    if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q))
    return rows
  }, [activeTab, smartCollectionRows, widgetRows, sourceFilter, shelfQuery])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    // Reordering while a filter narrows the grid would corrupt the saved
    // order — the indices wouldn't line up with the full list.
    if (filtering || activeTab === 'collections') return
    const { active, over } = event
    if (over && active.id !== over.id) {
      const activeRow = widgetRows.find((r) => r.id === active.id)
      const overRow = widgetRows.find((r) => r.id === over.id)
      if (activeRow?.layout === 'continue' || overRow?.layout === 'continue') return
      const oldIndex = movableWidgetRows.findIndex((r) => r.id === active.id)
      const newIndex = movableWidgetRows.findIndex((r) => r.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      const reordered = arrayMove(movableWidgetRows, oldIndex, newIndex)
      const hero = homeRows.find((r) => r.layout === 'hero')
      const managedIds = new Set(activeRows.map((row) => row.id))
      const excluded = allWidgetRows.filter((row) => !managedIds.has(row.id))
      reorderHomeRows([...(hero ? [hero] : []), ...fixedWidgetRows, ...reordered, ...excluded])
    }
  }

  const handleBatchAdd = (selections: PendingShelfSelection[]) => {
    if (!selections.length) return
    const current = [...useAppStore.getState().homeRows].sort((a, b) => a.order - b.order)
    const existingIds = new Set(selections.flatMap((selection) => selection.existingId ? [selection.existingId] : []))
    const base = current.filter((row) => !existingIds.has(row.id))
    const additions = selections.map((selection) => {
      const existing = selection.existingId ? current.find((row) => row.id === selection.existingId) : undefined
      return existing
        ? { ...existing, enabled: true, layout: 'poster' as const }
        : { ...selection.row, id: uuid(), order: 0, enabled: true, layout: selection.row.layout === 'continue' ? 'continue' as const : 'poster' as const }
    })
    setHomeRows([...base, ...additions].map((row, index) => ({ ...row, order: index })))
  }

  return (
    <div className={`pb-12 ${cinematic ? 'cinematic-library' : ''}`}>
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Library</h1>
            <p className="text-sm text-white/35">Build dynamic collections and curate your home screen</p>
          </div>
          {activeTab !== 'calendar' && activeTab !== 'activity' && <button
            onClick={() => { setEditingRow(null); setOverlayStartMode(activeTab === 'collections' ? 'discover' : 'preset'); setAddOverlay(true) }}
            className="flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent/80 text-black text-sm font-bold rounded-xl transition-all cursor-pointer shadow-lg shadow-accent/20"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {activeTab === 'collections' ? 'New Smart Collection' : 'New Shelf'}
          </button>}
        </div>
      </div>

      <div className="px-8 space-y-6">
        <div className="inline-flex rounded-xl border border-white/[0.07] bg-white/[0.03] p-1">
          {([['shelves', 'Home Shelves'], ['collections', 'Smart Collections'], ['calendar', 'Calendar'], ['activity', 'Activity']] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => { setSearchParams(id === 'shelves' ? {} : { tab: id }); setShelfQuery(''); setSourceFilter('All') }}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${activeTab === id ? 'bg-accent/15 text-accent shadow-sm' : 'text-white/35 hover:text-white/65 hover:bg-white/[0.04]'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {activeTab === 'calendar' ? <LibraryCalendar /> : activeTab === 'activity' ? <LibraryActivity /> : <>
        {/* Hero banner config */}
        {activeTab === 'shelves' && (
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent/10 text-accent">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 18V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12" /><path d="m4 15 4-4 3 3 3-4 6 6" /></svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-white/80">Home Hero</p>
                <p className="mt-0.5 truncate text-[11px] text-white/30">{heroRow ? `${heroRow.enabled ? 'Visible' : 'Hidden'} • ${heroRow.title} • ${shelfSourceLabel(heroRow)}` : 'Not configured'}</p>
              </div>
              <button type="button" onClick={() => setHeroExpanded((value) => !value)} className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-bold text-white/55 transition-all hover:bg-white/[0.08] hover:text-white cursor-pointer">{heroExpanded ? 'Done' : 'Configure'}</button>
            </div>
            {heroExpanded && <div className="mt-4 border-t border-white/[0.06] pt-4"><HeroBannerSection row={heroRow} addons={addons} smartCollections={smartCollectionRows} onUpdate={updateHomeRow} onAdd={addHomeRow} /></div>}
          </div>
        )}

        {/* Shelves grid */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/35">
                {activeTab === 'collections' ? 'Smart Collections' : 'Shelves'} ({visibleRows.length})
              </h2>
              {activeTab === 'shelves' && hiddenCount > 0 && <span className="rounded-lg border border-amber-500/15 bg-amber-500/[0.07] px-2.5 py-1 text-[10px] font-semibold text-amber-300/70">{hiddenCount} hidden</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {activeTab === 'shelves' && sourceOptions.length > 2 && sourceOptions.map((src) => (
                <button
                  key={src}
                  onClick={() => setSourceFilter(src)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer border ${
                    sourceFilter === src
                      ? 'bg-accent/15 text-accent border-accent/25'
                      : 'text-white/40 hover:text-white/70 bg-white/[0.03] hover:bg-white/[0.06] border-white/[0.06]'
                  }`}
                >
                  {src}
                </button>
              ))}
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-white/25" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={shelfQuery}
                  onChange={(e) => setShelfQuery(e.target.value)}
                  placeholder={activeTab === 'collections' ? 'Filter collections...' : 'Filter shelves...'}
                  className="w-44 pl-8 pr-7 py-1.5 bg-white/[0.04] border border-white/[0.06] rounded-lg text-[11px] text-white placeholder-white/25 focus:outline-none focus:bg-white/[0.07] focus:border-white/[0.12] transition-all"
                />
                {shelfQuery && (
                  <button
                    onClick={() => setShelfQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors cursor-pointer"
                    aria-label="Clear filter"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>

          {activeRows.length === 0 && hiddenCount === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 glass-panel-light rounded-2xl">
              <div className="w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center mb-5">
                <svg className="w-8 h-8 text-white/15" fill="none" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 24 24">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </div>
              <p className="text-sm font-medium text-white/35 mb-1">{activeTab === 'collections' ? 'No smart collections yet' : 'No shelves yet'}</p>
              <p className="text-xs text-white/20 mb-6">{activeTab === 'collections' ? 'Create a dynamic collection from a template or your own rules.' : 'Add catalogs and lists to your home screen.'}</p>
              <button
                onClick={() => { setEditingRow(null); setOverlayStartMode(activeTab === 'collections' ? 'discover' : 'preset'); setAddOverlay(true) }}
                className="flex items-center gap-2 px-5 py-2.5 bg-accent/15 hover:bg-accent/25 text-accent text-xs font-bold rounded-xl border border-accent/20 transition-all cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {activeTab === 'collections' ? 'Create your first collection' : 'Add your first shelf'}
              </button>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 glass-panel-light rounded-2xl">
              <p className="text-sm font-medium text-white/35 mb-1">No {activeTab === 'collections' ? 'collections' : 'shelves'} match</p>
              <p className="text-xs text-white/20">Try a different name or source filter.</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visibleRows.map((r) => r.id)} strategy={rectSortingStrategy}>
                <div className={activeTab === 'collections' ? `grid gap-4 ${cinematic ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'}` : 'space-y-2'}>
                  {visibleRows.map((row, index) => activeTab === 'collections' ? (
                    <SortableShelfCard
                      key={row.id}
                      row={row}
                      addons={addons}
                      draggable={false}
                      onOpen={activeTab === 'collections' ? () => navigate(`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`) : undefined}
                      onRemove={() => {
                        if (row.sourceType === 'discover') setDeleteCandidate(row)
                        else removeHomeRow(row.id)
                      }}
                      onEdit={() => {
                        setEditingRow(row)
                        setOverlayStartMode(row.sourceType === 'discover' ? 'discover' : 'preset')
                        setAddOverlay(true)
                      }}
                      onToggle={() => {
                        updateHomeRow(row.id, { enabled: !row.enabled })
                      }}
                    />
                  ) : (
                    <CompactShelfRow
                      key={row.id}
                      row={row}
                      index={index}
                      addons={addons}
                      onUpdate={(updates) => updateHomeRow(row.id, updates)}
                      onRemove={() => setDeleteCandidate(row)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
        </>}
      </div>

      {/* Add widget overlay */}
      <AddWidgetOverlay
        open={addOverlay}
        onClose={() => setAddOverlay(false)}
        addons={addons}
        homeRows={homeRows}
        onAdd={addHomeRow}
        editingRow={editingRow}
        onUpdate={updateHomeRow}
        startMode={overlayStartMode}
        onBatchAdd={handleBatchAdd}
      />

      <Modal
        open={deleteCandidate !== null}
        onClose={() => setDeleteCandidate(null)}
        title={deleteCandidate?.sourceType === 'discover' ? 'Delete smart collection?' : 'Delete home shelf?'}
        description={deleteCandidate ? (deleteCandidate.sourceType === 'discover' ? `“${deleteCandidate.title}” will be removed from Library and Home.` : `“${deleteCandidate.title}” will be permanently removed from Home.`) : undefined}
        size="sm"
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3 rounded-xl border border-red-500/15 bg-red-500/[0.06] p-4">
            <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-red-500/15 text-red-300">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12 9v4m0 4h.01" />
                <path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white/80">This action cannot be undone.</p>
              <p className="mt-1 text-xs leading-relaxed text-white/40">{deleteCandidate?.sourceType === 'discover' ? 'The collection rules and its linked Home shelf will be permanently deleted.' : 'You can add this catalog again later from the catalog drawer.'}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setDeleteCandidate(null)}
              className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-xs font-bold text-white/55 transition-all hover:bg-white/[0.08] hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (deleteCandidate) removeHomeRow(deleteCandidate.id)
                setDeleteCandidate(null)
              }}
              className="rounded-xl border border-red-400/20 bg-red-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-red-500/15 transition-all hover:bg-red-400 cursor-pointer"
            >
              {deleteCandidate?.sourceType === 'discover' ? 'Delete Collection' : 'Delete Shelf'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CompactPosterStack({ posters, loading, fallback }: { posters: string[]; loading: boolean; fallback: string }) {
  const items = getPosterStackItems(posters)

  if (loading) {
    return (
      <div className="shelf-poster-stack" aria-hidden="true">
        {[4, 3, 2, 1, 0].map((index) => <div key={index} className={`shelf-stack-card shelf-stack-card-${index} animate-pulse bg-white/[0.09]`} />)}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="grid h-[52px] w-[88px] place-items-center rounded-xl border border-white/[0.07] bg-white/[0.04] text-[9px] font-black uppercase tracking-wider text-white/20 sm:w-[104px]">
        {fallback.slice(0, 3)}
      </div>
    )
  }

  return (
    <div className="shelf-poster-stack" aria-hidden="true">
      {[...items].reverse().map((url, reversedIndex) => {
        const index = items.length - reversedIndex - 1
        return <img key={`${url}-${index}`} src={cachedImage(url)} alt="" loading="lazy" decoding="async" className={`shelf-stack-card shelf-stack-card-${index}`} />
      })}
    </div>
  )
}


function CompactShelfRow({
  row,
  index,
  addons,
  onUpdate,
  onRemove,
}: {
  row: HomeRowConfig
  index: number
  addons: InstalledAddon[]
  onUpdate: (updates: Partial<HomeRowConfig>) => void
  onRemove: () => void
}) {
  const locked = row.layout === 'continue'
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: locked })
  const { posters, loading } = useRowPosters(row, addons)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(row.title)

  useEffect(() => setTitle(row.title), [row.title])

  const commitTitle = () => {
    const next = title.trim()
    if (next && next !== row.title) onUpdate({ title: next })
    else setTitle(row.title)
    setEditing(false)
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group grid grid-cols-[36px_88px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-3 py-2.5 transition-all sm:grid-cols-[36px_104px_minmax(0,1fr)_auto] md:grid-cols-[36px_104px_minmax(0,1fr)_150px_48px_40px] ${isDragging ? 'z-50 border-accent/35 bg-surface-elevated shadow-2xl' : 'border-white/[0.07] bg-white/[0.025] hover:border-white/[0.13] hover:bg-white/[0.045]'} ${!row.enabled ? 'opacity-60' : ''}`}
    >
      <button
        {...(!locked ? attributes : {})}
        {...(!locked ? listeners : {})}
        type="button"
        disabled={locked}
        className={`grid h-9 w-9 place-items-center rounded-xl text-xs font-black ${locked ? 'cursor-default bg-accent/10 text-accent/70' : 'cursor-grab bg-white/[0.045] text-white/30 hover:bg-white/[0.09] hover:text-white/65 active:cursor-grabbing'}`}
        aria-label={locked ? 'Fixed shelf' : `Drag shelf ${index + 1}`}
      >
        {locked ? <span>•</span> : <span>{index + 1}</span>}
      </button>

      <CompactPosterStack posters={posters} loading={loading} fallback={shelfSourceLabel(row)} />

      <div className="min-w-0">
        {editing ? (
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => { if (event.key === 'Enter') commitTitle(); if (event.key === 'Escape') { setTitle(row.title); setEditing(false) } }}
            className="w-full rounded-lg border border-accent/30 bg-black/25 px-2.5 py-1.5 text-sm font-semibold text-white outline-none"
            autoFocus
          />
        ) : (
          <button type="button" onClick={() => !locked && setEditing(true)} className="block w-full truncate text-left text-sm font-bold text-white/80 hover:text-white cursor-text">{row.title}</button>
        )}
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/28">
          <span>{locked ? 'Built-in' : shelfSourceLabel(row)}</span>
          <span>•</span>
          <span>{row.discoverConfig?.contentType === 'series' || row.catalogType === 'series' ? 'Series' : row.catalogType === 'movie' || row.discoverConfig?.contentType === 'movie' ? 'Movies' : 'Catalog'}</span>
          {!row.enabled && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-bold text-amber-300/70">Hidden</span>}
        </div>
      </div>

      {!locked ? (
        <select
          value={row.layout}
          onChange={(event) => onUpdate({ layout: event.target.value as HomeRowConfig['layout'] })}
          className="hidden h-9 rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 text-xs font-semibold text-white/60 outline-none hover:bg-white/[0.07] md:block"
          aria-label={`Layout for ${row.title}`}
        >
          <option value="poster" className="bg-[#111318]">Poster</option>
          <option value="landscape" className="bg-[#111318]">Landscape</option>
          <option value="list" className="bg-[#111318]">Compact list</option>
        </select>
      ) : <span className="hidden text-center text-[10px] font-bold uppercase tracking-wider text-white/20 md:block">Fixed</span>}

      <button
        type="button"
        onClick={() => onUpdate({ enabled: !row.enabled })}
        className={`grid h-9 w-9 place-items-center rounded-xl border transition-all cursor-pointer ${row.enabled ? 'border-accent/20 bg-accent/10 text-accent' : 'border-white/[0.06] bg-white/[0.03] text-white/25 hover:text-white/60'}`}
        title={row.enabled ? 'Hide from Home' : 'Show on Home'}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" /><circle cx="12" cy="12" r="3" />{!row.enabled && <path d="M3 3l18 18" />}</svg>
      </button>

      <button
        type="button"
        onClick={onRemove}
        disabled={locked}
        className="hidden h-9 w-9 place-items-center rounded-xl border border-transparent text-white/20 transition-all hover:border-red-500/15 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-default disabled:opacity-0 md:grid cursor-pointer"
        title="Delete shelf"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>
      </button>

      {!locked && (
        <div className="col-span-4 flex items-center gap-2 border-t border-white/[0.05] pt-2 md:hidden">
          <select
            value={row.layout}
            onChange={(event) => onUpdate({ layout: event.target.value as HomeRowConfig['layout'] })}
            className="h-9 min-w-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 text-xs font-semibold text-white/60 outline-none"
          >
            <option value="poster" className="bg-[#111318]">Poster</option>
            <option value="landscape" className="bg-[#111318]">Landscape</option>
            <option value="list" className="bg-[#111318]">Compact list</option>
          </select>
          <button type="button" onClick={onRemove} className="h-9 rounded-xl border border-red-500/15 bg-red-500/[0.07] px-3 text-xs font-bold text-red-300 cursor-pointer">Delete</button>
        </div>
      )}
    </div>
  )
}
