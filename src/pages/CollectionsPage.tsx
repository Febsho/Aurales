/**
 * Widgets page — visual manager for home-screen shelves.
 *
 * – Hero banner pinned at top with catalog selector
 * – Grid of draggable widget tiles with poster mosaics
 * – Inline "Add Widget" overlay with search, addon catalogs & Simkl lists
 */

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import type { HomeRowConfig, DiscoverConfig, SearchResult } from '../types'
import type { InstalledAddon } from '../services/addons'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import {
  getSimklWatching,
  getSimklWatchlist,
  getSimklCompleted,
  getSimklOnHold,
  getSimklDropped,
  getSimklAnimeWatchlist,
  getSimklAnimeWatching,
  getSimklAnimeCompleted,
  getSimklMoviesWatchlist,
  getSimklMoviesWatching,
  getSimklMoviesCompleted,
  getSimklShowsWatchlist,
  getSimklShowsWatching,
  getSimklShowsCompleted,
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
  discoverTmdbWithCache,
  type TmdbWatchProvider
} from '../services/tmdb'
import { MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { ANILIST_LIST_SOURCES } from '../services/anilist'
import { getAvailablePmdbListSources, getAvailableTraktListSources, getProviderListItems, PMDB_LIST_SOURCES, TRAKT_LIST_SOURCES } from '../services/providerLists'
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

const ANILIST_WIDGET_LISTS = ANILIST_LIST_SOURCES.map((list) => ({ id: list.id, label: list.label.replace(/^AniList - /, ''), type: list.layout }))

// ── Poster fetching ────────────────────────────────────────────────────────────

async function fetchSimklPosters(listId: string): Promise<string[]> {
  let items: { poster?: string | null }[] = []
  switch (listId) {
    case 'watching':         items = await getSimklWatching(); break
    case 'plantowatch':
    case 'watchlist':        items = await getSimklWatchlist(); break
    case 'completed':        items = await getSimklCompleted(); break
    case 'hold':
    case 'on-hold':          items = await getSimklOnHold(); break
    case 'dropped':          items = await getSimklDropped(); break
    case 'anime-watchlist':  items = await getSimklAnimeWatchlist(); break
    case 'anime-watching':   items = await getSimklAnimeWatching(); break
    case 'anime-completed':  items = await getSimklAnimeCompleted(); break
    case 'movies-watchlist': items = await getSimklMoviesWatchlist(); break
    case 'movies-watching':  items = await getSimklMoviesWatching(); break
    case 'movies-completed': items = await getSimklMoviesCompleted(); break
    case 'shows-watchlist':  items = await getSimklShowsWatchlist(); break
    case 'shows-watching':   items = await getSimklShowsWatching(); break
    case 'shows-completed':  items = await getSimklShowsCompleted(); break
    default:                 items = await getSimklWatchlist()
  }
  return items
    .slice(0, 4)
    .map((i) => i.poster || '')
    .filter(Boolean)
}

function useRowPosters(row: HomeRowConfig, addons: InstalledAddon[]): { posters: string[]; count: number; loading: boolean } {
  const [posters, setPosters] = useState<string[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const watchProgress = useAppStore((s) => s.watchProgress)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const load = async () => {
      try {
        let urls: string[] = []
        let total = 0

        if (row.layout === 'continue') {
          const items = Array.from(watchProgress.values())
            .filter((i) => !i.completed && i.progressSeconds > 5)
          total = items.length
          urls = items.slice(0, 4).map((i) => i.backdrop || i.poster || '').filter(Boolean)
          if (!cancelled) { setPosters(urls); setCount(total) }
          return
        }

        const isMock = row.catalogId?.startsWith('mock-')
        if (isMock && row.catalogId) {
          const items = getMockCatalog(row.catalogId)
          total = items.length
          urls = items.slice(0, 4).map((i) => i.poster || '').filter(Boolean)
          if (!cancelled) { setPosters(urls); setCount(total) }
          return
        }

        if (!row.catalogId && !row.addonId && !row.sourceType) {
          const fallback = row.layout === 'landscape' ? MOCK_POPULAR_SHOWS : MOCK_TRENDING
          total = fallback.length
          urls = fallback.slice(0, 4).map((i) => i.poster || '').filter(Boolean)
          if (!cancelled) { setPosters(urls); setCount(total) }
          return
        }

        if (row.sourceType === 'simkl' && row.providerListId) {
          urls = await fetchSimklPosters(row.providerListId)
          total = urls.length // approximate
          if (!cancelled) { setPosters(urls); setCount(total) }
          return
        }

        if ((row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'anilist') && row.providerListId) {
          const items = await getProviderListItems(row)
          total = items.length
          urls = items.slice(0, 4).map((i) => i.poster || i.backdrop || '').filter(Boolean)
          if (!cancelled) { setPosters(urls); setCount(total) }
          return
        }

        if (row.sourceType === 'discover' && row.discoverConfig) {
          try {
            const results = await discoverTmdbWithCache(row.discoverConfig, row.id)
            total = results.length
            urls = results.slice(0, 4).map((i) => i.poster || '').filter(Boolean)
          } catch { /* ignore */ }
          if (!cancelled) { setPosters(urls); setCount(total) }
          return
        }

        if (row.catalogType && row.catalogId) {
          const addon = addons.find((a) => a.enabled && a.manifest.id === row.addonId)
          const url = addon?.url || row.addonUrl
          if (url) {
            const items = await getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra, row.addonId)
            total = items.length
            urls = items.slice(0, 4).map((i) => i.poster || i.backdrop || '').filter(Boolean)
          }
        }

        if (!cancelled) { setPosters(urls); setCount(total) }
      } catch {
        // empty mosaic is fine
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [row.id, row.catalogId, row.addonId, row.sourceType, row.providerListId, addons, row.layout, watchProgress])

  return { posters, count, loading }
}

// ── Poster grid (2×2 mosaic) ───────────────────────────────────────────────────

function PosterGrid({ posters, loading }: { posters: string[]; loading: boolean }) {
  if (loading) {
    return <div className="w-full aspect-square bg-white/5 animate-pulse" />
  }

  if (posters.length === 0) {
    return (
      <div className="w-full aspect-square bg-white/[0.03] flex items-center justify-center">
        <svg className="w-8 h-8 text-white/10" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" rx="0.5" />
          <rect x="14" y="3" width="7" height="7" rx="0.5" />
          <rect x="3" y="14" width="7" height="7" rx="0.5" />
          <rect x="14" y="14" width="7" height="7" rx="0.5" />
        </svg>
      </div>
    )
  }

  if (posters.length === 1) {
    return (
      <div className="w-full aspect-square overflow-hidden">
        <img src={posters[0]} alt="" className="w-full h-full object-cover" loading="lazy" />
      </div>
    )
  }

  return (
    <div className="w-full aspect-square grid grid-cols-2 gap-px bg-black/60 overflow-hidden">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="overflow-hidden bg-black/40">
          {posters[i] ? (
            <img src={posters[i]} alt="" className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full bg-white/5" />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Create tile ────────────────────────────────────────────────────────────────

function CreateTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl overflow-hidden border border-dashed border-white/10 hover:border-white/20 bg-white/[0.01] hover:bg-white/[0.03] transition-all text-left cursor-pointer flex flex-col justify-between"
    >
      <div className="w-full aspect-square flex items-center justify-center">
        <div className="w-10 h-10 rounded-full border-2 border-white/15 flex items-center justify-center transition-colors">
          <svg className="w-4 h-4 text-white/40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
      </div>
      <div className="px-3 pt-1.5 pb-3">
        <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider leading-tight">
          Create a new Collection
        </p>
      </div>
    </button>
  )
}

// ── Sortable widget tile ───────────────────────────────────────────────────────

function SortableWidgetTile({
  row,
  addons,
  onRemove,
  onEdit,
}: {
  row: HomeRowConfig
  addons: InstalledAddon[]
  onRemove: () => void
  onEdit: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const { posters, count, loading } = useRowPosters(row, addons)
  const [hovered, setHovered] = useState(false)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.6 : undefined,
    scale: isDragging ? 1.05 : undefined,
    boxShadow: isDragging ? '0 20px 25px -5px rgb(0 0 0 / 0.5), 0 8px 10px -6px rgb(0 0 0 / 0.5)' : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative rounded-xl overflow-hidden border transition-all cursor-grab active:cursor-grabbing select-none ${
        !row.enabled ? 'opacity-40 border-white/5' : 'border-white/5 hover:border-white/15'
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...attributes}
      {...listeners}
    >
      <PosterGrid posters={posters} loading={loading} />

      {/* Edit Gear Button */}
      <button
        onClick={(e) => { e.stopPropagation(); onEdit() }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-purple-600 hover:bg-purple-500 flex items-center justify-center text-white transition-colors z-10 shadow-md cursor-pointer"
        title="Edit Catalog"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 005 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      {/* Remove button */}
      {hovered && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-red-500/90 hover:bg-red-600 flex items-center justify-center text-white transition-colors z-10 cursor-pointer"
          title="Remove"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}

      <div className="px-2 pt-1.5 pb-2">
        <p className="text-[10px] text-white/30 tabular-nums truncate">
          ({loading ? '...' : count})
        </p>
        <p className="text-[11px] font-semibold text-white/80 truncate leading-tight">
          {row.title}
        </p>
      </div>
    </div>
  )
}

// ── Hero banner section ────────────────────────────────────────────────────────

function HeroBannerSection({
  row,
  addons,
  onUpdate,
}: {
  row: HomeRowConfig | undefined
  addons: InstalledAddon[]
  onUpdate: (id: string, updates: Partial<HomeRowConfig>) => void
}) {
  type CatalogOption = { label: string; addonId: string; addonUrl: string; catalogType: string; catalogId: string }
  const catalogOptions: CatalogOption[] = [
    { label: 'Default (Mock)', addonId: 'com.example.mockaddon', addonUrl: '', catalogType: 'movie', catalogId: 'mock-movies' },
    ...addons.filter((a) => a.enabled).flatMap((a) =>
      (a.manifest.catalogs || []).map((c: any) => ({
        label: `${c.name || c.id} (${a.manifest.name})`,
        addonId: a.manifest.id,
        addonUrl: a.url,
        catalogType: c.type,
        catalogId: c.id,
      }))
    ),
  ]

  const currentValue = row
    ? `${row.addonId || 'com.example.mockaddon'}::${row.catalogType || 'movie'}::${row.catalogId || 'mock-movies'}`
    : 'com.example.mockaddon::movie::mock-movies'

  const handleCatalogChange = (val: string) => {
    if (!row) return
    const opt = catalogOptions.find((o) => `${o.addonId}::${o.catalogType}::${o.catalogId}` === val)
    if (opt) {
      onUpdate(row.id, {
        addonId: opt.addonId,
        addonUrl: opt.addonUrl,
        catalogType: opt.catalogType,
        catalogId: opt.catalogId,
      })
    }
  }

  return (
    <div className="flex items-center justify-between px-3 py-3 bg-white/[0.03] rounded-2xl border border-white/5 mb-5">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 flex-shrink-0 rounded-xl bg-accent/10 flex items-center justify-center">
          <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-white/80">Featured Hero banner</span>
            <span className="px-1.5 py-0.5 text-[9px] font-bold bg-accent/20 text-accent rounded uppercase tracking-widest">Pinned Top</span>
          </div>
          <p className="text-[11px] text-white/30 truncate">
            Choose the main catalog to showcase as the widescreen hero header on your home screen.
          </p>
        </div>
      </div>
      <select
        value={currentValue}
        onChange={(e) => handleCatalogChange(e.target.value)}
        className="bg-white/8 border border-white/10 text-white/70 text-xs rounded-xl px-3 py-2 outline-none cursor-pointer max-w-[220px] truncate flex-shrink-0 ml-4"
      >
        {catalogOptions.map((opt) => {
          const val = `${opt.addonId}::${opt.catalogType}::${opt.catalogId}`
          return <option key={val} value={val} className="bg-neutral-900">{opt.label}</option>
        })}
      </select>
    </div>
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
  onAdd,
  onClose,
}: {
  title: string
  service: 'anilist' | 'trakt' | 'pmdb'
  lists: { id: string; label: string; type: 'poster' | 'landscape' }[]
  isAlreadyAdded: (key: string) => boolean
  onAdd: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  onClose: () => void
}) {
  const label = service === 'anilist' ? 'AniList' : service === 'pmdb' ? 'PMDB' : 'Trakt'
  const color = service === 'anilist' ? 'text-sky-400 bg-sky-400/10' : service === 'pmdb' ? 'text-purple-300 bg-purple-400/10' : 'text-red-300 bg-red-400/10'
  return (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/30 mb-2">{title}</h3>
      <div className="space-y-1.5">
        {lists.map((list) => {
          const added = isAlreadyAdded(`${service}:${list.id}`)
          return (
            <button
              key={`${service}-${list.id}`}
              disabled={added}
              onClick={() => {
                onAdd({
                  title: `${label} - ${list.label}`,
                  sourceType: service,
                  providerListId: list.id,
                  layout: list.type,
                  enabled: true,
                })
                onClose()
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors text-left ${
                added ? 'bg-white/[0.02] opacity-40 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.07] cursor-pointer'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
                  <span className="text-[11px] font-black">{label[0]}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white/80 truncate">{list.label}</p>
                  <p className="text-[10px] text-white/25">{label} - {list.type}</p>
                </div>
              </div>
              <span className="text-[10px] text-white/25 flex-shrink-0">{added ? 'Added' : ''}</span>
            </button>
          )
        })}
      </div>
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
}: {
  open: boolean
  onClose: () => void
  addons: InstalledAddon[]
  homeRows: HomeRowConfig[]
  onAdd: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  editingRow?: HomeRowConfig | null
  onUpdate?: (id: string, updates: Partial<HomeRowConfig>) => void
}) {
  const [mode, setMode] = useState<'preset' | 'discover'>('preset')
  const [search, setSearch] = useState('')
  const [editLayout, setEditLayout] = useState<'poster' | 'landscape' | 'list' | 'continue' | 'hero'>('poster')
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<'all' | 'builtin' | 'addons' | 'simkl' | 'trakt' | 'anilist' | 'pmdb'>('all')
  const [discoverTab, setDiscoverTab] = useState<'setup' | 'filters' | 'streaming' | 'people' | 'ranges'>('setup')

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

  const isAlreadyAdded = useCallback((key: string) =>
    homeRows.some((r) => {
      if (r.sourceType === 'simkl' || r.sourceType === 'trakt' || r.sourceType === 'pmdb' || r.sourceType === 'anilist') return `${r.sourceType}:${r.providerListId}` === key
      return `${r.addonId}::${r.catalogType}::${r.catalogId}` === key
    }), [homeRows])

  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const [traktLists, setTraktLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(TRAKT_LIST_SOURCES)
  const [pmdbLists, setPmdbLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(PMDB_LIST_SOURCES)

  useEffect(() => {
    if (traktConnected) getAvailableTraktListSources().then(setTraktLists).catch(() => setTraktLists(TRAKT_LIST_SOURCES))
  }, [traktConnected])

  useEffect(() => {
    if (pmdbApiKey) getAvailablePmdbListSources().then(setPmdbLists).catch(() => setPmdbLists(PMDB_LIST_SOURCES))
  }, [pmdbApiKey])

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
    if (!search) return SIMKL_LIST_SOURCES
    const q = search.toLowerCase()
    return SIMKL_LIST_SOURCES.filter((l) => l.label.toLowerCase().includes(q))
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

  // ─── Build Your Catalog (Discover) Form State ───
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
  const [presetName, setPresetName] = useState('')

  // Test preview
  const [previewItems, setPreviewItems] = useState<SearchResult[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)

  // Prefill state hooks if in edit mode, reset to defaults otherwise
  useEffect(() => {
    if (open && editingRow) {
      setCatalogName(editingRow.title || '')
      setEditLayout(editingRow.layout || 'poster')
      
      if (editingRow.sourceType === 'discover' && editingRow.discoverConfig) {
        setMode('discover')
        const config = editingRow.discoverConfig
        setSource(config.source || 'TMDB')
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
        setPresetName(config.presetName || '')
      } else {
        setMode('preset')
      }
    } else {
      // Reset to default
      setMode('preset')
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
      setPresetName('')
      setEditLayout('poster')
    }
  }, [open, editingRow])

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

  // Run Discovery Test Preview
  const runPreview = async () => {
    setPreviewLoading(true)
    try {
      const config: DiscoverConfig = {
        source,
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

  // Save Discovery Widget
  const handleSaveDiscover = () => {
    const name = catalogName.trim() || `Discover: ${source} - ${contentType === 'movie' ? 'Movies' : 'TV Shows'}`
    const config: DiscoverConfig = {
      source,
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
      presetName,
    }

    if (editingRow && onUpdate) {
      onUpdate(editingRow.id, {
        title: name,
        layout: contentType === 'movie' ? 'poster' : 'landscape',
        discoverConfig: config,
      })
    } else {
      onAdd({
        title: name,
        sourceType: 'discover',
        layout: contentType === 'movie' ? 'poster' : 'landscape',
        enabled: true,
        discoverConfig: config,
      })
    }
    onClose()
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`bg-[#0f1115] border border-white/10 rounded-2xl w-full flex flex-col overflow-hidden shadow-2xl transition-all duration-300 max-h-[85vh] ${
          mode === 'discover' ? 'max-w-4xl' : 'max-w-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div>
            <h2 className="text-base font-bold text-white">
              {editingRow 
                ? editingRow.sourceType === 'discover' 
                  ? 'Edit Custom Catalog' 
                  : 'Edit Shelf Settings'
                : 'Add Widget'}
            </h2>
            <p className="text-[10px] text-white/30 mt-0.5">
              {editingRow
                ? editingRow.sourceType === 'discover'
                  ? 'Modify filter and search settings for this discover catalog'
                  : 'Rename or change layout for this content shelf'
                : 'Configure home screen content rows'}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Navigation Tabs */}
        {!editingRow && (
          <div className="flex border-b border-white/5 px-5 bg-white/[0.01]">
            <button
              onClick={() => setMode('preset')}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer ${
                mode === 'preset' ? 'border-accent text-accent' : 'border-transparent text-white/40 hover:text-white/70'
              }`}
            >
              Add Standard Shelf
            </button>
            <button
              onClick={() => setMode('discover')}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition-all cursor-pointer ${
                mode === 'discover' ? 'border-accent text-accent' : 'border-transparent text-white/40 hover:text-white/70'
              }`}
            >
              Build Your Catalog
            </button>
          </div>
        )}

        {editingRow && editingRow.sourceType !== 'discover' ? (
          /* Simple Edit Form for standard shelf */
          <>
            <div className="flex-1 overflow-y-auto px-5 py-6 space-y-4" style={{ scrollbarWidth: 'thin' }}>
              <div>
                <label className="block text-[11px] text-white/50 mb-1.5 font-medium">Catalog Name</label>
                <input
                  value={catalogName}
                  onChange={(e) => setCatalogName(e.target.value)}
                  placeholder="Catalog Name"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-accent/40"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[11px] text-white/50 mb-1.5 font-medium">Layout Style</label>
                <select
                  value={editLayout}
                  onChange={(e) => setEditLayout(e.target.value as any)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none focus:border-accent/40"
                >
                  <option value="poster" className="bg-neutral-900">Poster Carousel</option>
                  <option value="landscape" className="bg-neutral-900">Landscape Carousel</option>
                  <option value="list" className="bg-neutral-900">Compact List</option>
                </select>
              </div>
            </div>
            
            {/* Footer */}
            <div className="px-5 py-4 border-t border-white/5 bg-white/[0.01] flex items-center justify-end gap-3">
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl text-xs font-semibold text-white/60 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveStandardEdit}
                className="px-6 py-2.5 bg-accent hover:bg-accent/80 text-black text-xs font-bold rounded-xl shadow-lg transition-all cursor-pointer"
              >
                Save Changes
              </button>
            </div>
          </>
        ) : mode === 'preset' ? (
          (() => {
            const showBuiltin = selectedSourceFilter === 'all' || selectedSourceFilter === 'builtin'
            const showAddons = selectedSourceFilter === 'all' || selectedSourceFilter === 'addons'
            const showSimkl = selectedSourceFilter === 'all' || selectedSourceFilter === 'simkl'
            const showAniList = selectedSourceFilter === 'all' || selectedSourceFilter === 'anilist'
            const showTrakt = selectedSourceFilter === 'all' || selectedSourceFilter === 'trakt'
            const showPmdb = selectedSourceFilter === 'all' || selectedSourceFilter === 'pmdb'

            const builtinCount = (showBuiltin && (!search || 'continue watching'.includes(search.toLowerCase()))) ? 1 : 0
            const pmdbAddonCatalogsCount = (showPmdb || showAddons) ? filteredPmdbAddonCatalogs.length : 0
            const otherAddonCatalogsCount = showAddons ? filteredOtherAddonCatalogs.length : 0
            const simklListsCount = (showSimkl && simklConnected) ? filteredSimklLists.length : 0
            const aniListListsCount = (showAniList && anilistConnected) ? filteredAniListLists.length : 0
            const traktListsCount = (showTrakt && traktConnected) ? filteredTraktLists.length : 0
            const pmdbListsCount = (showPmdb && !!pmdbApiKey) ? filteredPmdbLists.length : 0

            const totalVisible = builtinCount + pmdbAddonCatalogsCount + otherAddonCatalogsCount + simklListsCount + aniListListsCount + traktListsCount + pmdbListsCount

            return (
              <>
                {/* Search */}
                <div className="px-5 py-3 border-b border-white/5">
                  <div className="relative">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search catalogs and lists..."
                      className="w-full bg-white/5 border border-white/8 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-accent/40"
                      autoFocus
                    />
                  </div>
                </div>

                {/* Source Filters */}
                <div className="px-5 py-2 border-b border-white/5 bg-white/[0.01] flex gap-1.5 overflow-x-auto scrollbar-none" style={{ scrollbarWidth: 'none' }}>
                  {([
                    { id: 'all', label: 'All' },
                    { id: 'builtin', label: 'Built-in' },
                    { id: 'addons', label: 'Addons' },
                    { id: 'simkl', label: 'Simkl', connected: simklConnected },
                    { id: 'trakt', label: 'Trakt', connected: traktConnected },
                    { id: 'anilist', label: 'AniList', connected: anilistConnected },
                    { id: 'pmdb', label: 'PMDB', connected: !!pmdbApiKey }
                  ] as const).map((filter) => {
                    const active = selectedSourceFilter === filter.id
                    return (
                      <button
                        key={filter.id}
                        onClick={() => setSelectedSourceFilter(filter.id)}
                        className={`h-8 flex items-center justify-center px-3.5 rounded-xl text-xs font-bold border transition-all cursor-pointer flex-shrink-0 ${
                          active
                            ? 'bg-accent text-black border-accent'
                            : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10 hover:text-white border-transparent'
                        }`}
                      >
                        {filter.label}
                        {('connected' in filter && !filter.connected) && (
                          <span className="ml-1 text-[9px] opacity-60">🔒</span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* Presets List */}
                <div className="flex-1 overflow-y-auto px-5 py-3 space-y-5" style={{ scrollbarWidth: 'thin' }}>
                  {/* Unconnected guidance cards */}
                  {!simklConnected && selectedSourceFilter === 'simkl' && (
                    <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl text-center space-y-3">
                      <div className="w-12 h-12 rounded-full bg-[#2ecc71]/10 flex items-center justify-center mx-auto text-xl font-bold text-[#2ecc71]">S</div>
                      <h4 className="text-sm font-semibold text-white">Simkl is not connected</h4>
                      <p className="text-xs text-muted max-w-sm mx-auto">Connect your Simkl account in Settings &gt; Accounts to access your custom watchlists, anime lists, and history shelves.</p>
                    </div>
                  )}

                  {!traktConnected && selectedSourceFilter === 'trakt' && (
                    <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl text-center space-y-3">
                      <div className="w-12 h-12 rounded-full bg-[#ff3b30]/10 flex items-center justify-center mx-auto text-xl font-bold text-[#ff3b30]">T</div>
                      <h4 className="text-sm font-semibold text-white">Trakt is not connected</h4>
                      <p className="text-xs text-muted max-w-sm mx-auto">Connect your Trakt account in Settings &gt; Accounts to sync your watchlist, custom lists, recommendations, and history shelves.</p>
                    </div>
                  )}

                  {!anilistConnected && selectedSourceFilter === 'anilist' && (
                    <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl text-center space-y-3">
                      <div className="w-12 h-12 rounded-full bg-[#3db4f2]/10 flex items-center justify-center mx-auto text-xl font-bold text-[#3db4f2]">A</div>
                      <h4 className="text-sm font-semibold text-white">AniList is not connected</h4>
                      <p className="text-xs text-muted max-w-sm mx-auto">Connect your AniList account in Settings &gt; Accounts to load your current anime watching, planning, and completed shelves.</p>
                    </div>
                  )}

                  {!pmdbApiKey && selectedSourceFilter === 'pmdb' && (
                    <div className="p-6 bg-white/[0.02] border border-white/5 rounded-2xl text-center space-y-3">
                      <div className="w-12 h-12 rounded-full bg-[#f39c12]/10 flex items-center justify-center mx-auto text-xl font-bold text-[#f39c12]">P</div>
                      <h4 className="text-sm font-semibold text-white">PublicMetaDB is not configured</h4>
                      <p className="text-xs text-muted max-w-sm mx-auto">Set up your PublicMetaDB API Key in Settings &gt; Accounts to access scrobble history and synced lists.</p>
                    </div>
                  )}

                  {/* Built-in */}
                  {showBuiltin && builtinCount > 0 && (
                    <div>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/30 mb-2">Built-in</h3>
                      <div className="space-y-1.5">
                        {(() => {
                          const added = homeRows.some((r) => r.layout === 'continue')
                          return (
                            <button
                              disabled={added}
                              onClick={() => {
                                onAdd({ title: 'Continue Watching', layout: 'continue', enabled: true, sourceType: 'local' })
                                onClose()
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors text-left ${
                                added ? 'bg-white/[0.02] opacity-40 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.07] cursor-pointer'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                                  <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-white/80">Continue Watching</p>
                                  <p className="text-[10px] text-white/30">Resume where you left off</p>
                                </div>
                              </div>
                              <span className="text-[10px] text-white/25">{added ? 'Added' : ''}</span>
                            </button>
                          )
                        })()}
                      </div>
                    </div>
                  )}

                  {/* PMDB Catalogs */}
                  {(showPmdb || showAddons) && filteredPmdbAddonCatalogs.length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/30 mb-2">PMDB Catalogs</h3>
                      <div className="space-y-1.5">
                        {filteredPmdbAddonCatalogs.map((cat) => {
                          const key = `${cat.addonId}::${cat.catalogType}::${cat.catalogId}`
                          const added = isAlreadyAdded(key)
                          return (
                            <button
                              key={key}
                              disabled={added}
                              onClick={() => {
                                onAdd({
                                  title: `${cat.catalogName} (${cat.addonName})`,
                                  addonId: cat.addonId,
                                  addonUrl: cat.addonUrl,
                                  catalogType: cat.catalogType,
                                  catalogId: cat.catalogId,
                                  catalogExtra: cat.catalogExtra,
                                  layout: cat.catalogType === 'movie' ? 'poster' : 'landscape',
                                  enabled: true,
                                })
                                onClose()
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors text-left ${
                                added ? 'bg-white/[0.02] opacity-40 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.07] cursor-pointer'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                                  <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                    <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                  </svg>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-white/80 truncate">{cat.catalogName}</p>
                                  <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className="text-[10px] text-white/25">{cat.addonName}</span>
                                    <span className="text-[10px] text-white/15">·</span>
                                    <span className="text-[10px] text-white/25">{cat.catalogType}</span>
                                  </div>
                                </div>
                              </div>
                              <span className="text-[10px] text-white/25 flex-shrink-0">{added ? 'Added' : ''}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Addon Catalogs */}
                  {showAddons && filteredOtherAddonCatalogs.length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/30 mb-2">Addon Catalogs</h3>
                      <div className="space-y-1.5">
                        {filteredOtherAddonCatalogs.map((cat) => {
                          const key = `${cat.addonId}::${cat.catalogType}::${cat.catalogId}`
                          const added = isAlreadyAdded(key)
                          return (
                            <button
                              key={key}
                              disabled={added}
                              onClick={() => {
                                onAdd({
                                  title: `${cat.catalogName} (${cat.addonName})`,
                                  addonId: cat.addonId,
                                  addonUrl: cat.addonUrl,
                                  catalogType: cat.catalogType,
                                  catalogId: cat.catalogId,
                                  catalogExtra: cat.catalogExtra,
                                  layout: cat.catalogType === 'movie' ? 'poster' : 'landscape',
                                  enabled: true,
                                })
                                onClose()
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors text-left ${
                                added ? 'bg-white/[0.02] opacity-40 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.07] cursor-pointer'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                                  <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                    <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                  </svg>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-white/80 truncate">{cat.catalogName}</p>
                                  <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className="text-[10px] text-white/25">{cat.addonName}</span>
                                    <span className="text-[10px] text-white/15">·</span>
                                    <span className="text-[10px] text-white/25">{cat.catalogType}</span>
                                  </div>
                                </div>
                              </div>
                              <span className="text-[10px] text-white/25 flex-shrink-0">{added ? 'Added' : ''}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Simkl lists */}
                  {showSimkl && simklConnected && filteredSimklLists.length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/30 mb-2">Simkl Lists</h3>
                      <div className="space-y-1.5">
                        {filteredSimklLists.map((list) => {
                          const added = isAlreadyAdded(`simkl:${list.id}`)
                          return (
                            <button
                              key={list.id}
                              disabled={added}
                              onClick={() => {
                                onAdd({
                                  title: `Simkl — ${list.label}`,
                                  sourceType: 'simkl',
                                  providerListId: list.id,
                                  layout: list.type,
                                  enabled: true,
                                })
                                onClose()
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-colors text-left ${
                                added ? 'bg-white/[0.02] opacity-40 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.07] cursor-pointer'
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-[#2ecc71]/10 flex items-center justify-center flex-shrink-0">
                                  <span className="text-[11px] font-bold text-[#2ecc71]">S</span>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-white/80 truncate">{list.label}</p>
                                  <p className="text-[10px] text-white/25">Simkl · {list.type}</p>
                                </div>
                              </div>
                              <span className="text-[10px] text-white/25 flex-shrink-0">{added ? 'Added' : ''}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {showAniList && anilistConnected && filteredAniListLists.length > 0 && (
                    <ProviderListPickerSection
                      title="AniList Lists"
                      service="anilist"
                      lists={filteredAniListLists}
                      isAlreadyAdded={isAlreadyAdded}
                      onAdd={onAdd}
                      onClose={onClose}
                    />
                  )}

                  {showTrakt && traktConnected && filteredTraktLists.length > 0 && (
                    <ProviderListPickerSection
                      title="Trakt Lists"
                      service="trakt"
                      lists={filteredTraktLists.map((l) => ({ id: l.id, label: l.label.replace(/^Trakt - /, ''), type: l.layout }))}
                      isAlreadyAdded={isAlreadyAdded}
                      onAdd={onAdd}
                      onClose={onClose}
                    />
                  )}

                  {showPmdb && !!pmdbApiKey && filteredPmdbLists.length > 0 && (
                    <ProviderListPickerSection
                      title="PMDB Lists"
                      service="pmdb"
                      lists={filteredPmdbLists.map((l) => ({ id: l.id, label: l.label.replace(/^PMDB - /, ''), type: l.layout }))}
                      isAlreadyAdded={isAlreadyAdded}
                      onAdd={onAdd}
                      onClose={onClose}
                    />
                  )}

                  {selectedSourceFilter === 'simkl' && !simklConnected && (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-white/[0.02] border border-white/5 rounded-2xl">
                      <div className="w-12 h-12 rounded-xl bg-[#2ecc71]/10 flex items-center justify-center mb-4">
                        <span className="text-xl font-bold text-[#2ecc71]">S</span>
                      </div>
                      <h4 className="text-sm font-bold text-white mb-1">Simkl not connected</h4>
                      <p className="text-xs text-white/45 max-w-sm leading-relaxed">
                        To add Simkl lists or sync your progress, connect your Simkl account in Settings &gt; Accounts.
                      </p>
                    </div>
                  )}

                  {selectedSourceFilter === 'trakt' && !traktConnected && (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-white/[0.02] border border-white/5 rounded-2xl">
                      <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center mb-4">
                        <span className="text-xl font-bold text-red-500">T</span>
                      </div>
                      <h4 className="text-sm font-bold text-white mb-1">Trakt not connected</h4>
                      <p className="text-xs text-white/45 max-w-sm leading-relaxed">
                        To add Trakt lists or sync your progress, connect your Trakt account in Settings &gt; Accounts.
                      </p>
                    </div>
                  )}

                  {selectedSourceFilter === 'anilist' && !anilistConnected && (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-white/[0.02] border border-white/5 rounded-2xl">
                      <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4">
                        <span className="text-xl font-bold text-blue-400">A</span>
                      </div>
                      <h4 className="text-sm font-bold text-white mb-1">AniList not connected</h4>
                      <p className="text-xs text-white/45 max-w-sm leading-relaxed">
                        To add AniList lists or sync your progress, connect your AniList account in Settings &gt; Accounts.
                      </p>
                    </div>
                  )}

                  {selectedSourceFilter === 'pmdb' && !pmdbApiKey && (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-white/[0.02] border border-white/5 rounded-2xl">
                      <div className="w-12 h-12 rounded-xl bg-green-500/10 flex items-center justify-center mb-4">
                        <span className="text-xl font-bold text-green-400">P</span>
                      </div>
                      <h4 className="text-sm font-bold text-white mb-1">PublicMetaDB not connected</h4>
                      <p className="text-xs text-white/45 max-w-sm leading-relaxed">
                        To add PublicMetaDB lists or sync your progress, enter your PMDB API key in Settings &gt; Accounts.
                      </p>
                    </div>
                  )}

                  {selectedSourceFilter === 'addons' && addons.length === 0 && (
                    <div className="flex flex-col items-center justify-center text-center p-8 bg-white/[0.02] border border-white/5 rounded-2xl">
                      <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center mb-4">
                        <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <h4 className="text-sm font-bold text-white mb-1">No custom addons installed</h4>
                      <p className="text-xs text-white/45 max-w-sm leading-relaxed">
                        To add catalogs from Stremio addons, install them in Settings &gt; Addons.
                      </p>
                    </div>
                  )}

                  {totalVisible === 0 && search && (
                    <div className="text-center py-8 text-sm text-white/25">
                      No results for "{search}"
                    </div>
                  )}

                  {addons.length === 0 && !simklConnected && !traktConnected && !anilistConnected && !pmdbApiKey && (
                    <div className="text-center py-8">
                      <p className="text-sm text-white/30 mb-1">No addons or services connected</p>
                      <p className="text-[11px] text-white/20">Install addons or connect Simkl/Trakt/PMDB/AniList in Settings</p>
                    </div>
                  )}
                </div>
              </>
            )
          })()
        ) : (
          /* Custom Discover Catalog Builder Form */
          <div className="flex-1 flex flex-col min-h-0 bg-neutral-950/20">
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6" style={{ scrollbarWidth: 'thin' }}>
              
              {/* SECTION 1: Catalog Setup */}
              <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">Catalog Setup</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Catalog Name</label>
                    <input
                      value={catalogName}
                      onChange={(e) => setCatalogName(e.target.value)}
                      placeholder="e.g. Cyberpunk Essentials"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Source</label>
                    <select
                      value={source}
                      onChange={(e) => setSource(e.target.value as any)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="TMDB" className="bg-neutral-900">TMDB</option>
                      <option value="TVDB" className="bg-neutral-900">TVDB</option>
                      <option value="Simkl" className="bg-neutral-900">Simkl</option>
                      <option value="AniList" className="bg-neutral-900">AniList</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Content Type</label>
                    <select
                      value={contentType}
                      onChange={(e) => setContentType(e.target.value as any)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="movie" className="bg-neutral-900">Movies</option>
                      <option value="series" className="bg-neutral-900">TV Shows</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Sort By</label>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="popularity.desc" className="bg-neutral-900">Popularity (High to Low)</option>
                      <option value="popularity.asc" className="bg-neutral-900">Popularity (Low to High)</option>
                      <option value="vote_average.desc" className="bg-neutral-900">Rating (High to Low)</option>
                      <option value="vote_average.asc" className="bg-neutral-900">Rating (Low to High)</option>
                      {contentType === 'movie' ? (
                        <>
                          <option value="primary_release_date.desc" className="bg-neutral-900">Release Date (Newest first)</option>
                          <option value="primary_release_date.asc" className="bg-neutral-900">Release Date (Oldest first)</option>
                        </>
                      ) : (
                        <>
                          <option value="first_air_date.desc" className="bg-neutral-900">Air Date (Newest first)</option>
                          <option value="first_air_date.asc" className="bg-neutral-900">Air Date (Oldest first)</option>
                        </>
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Cache TTL (seconds)</label>
                    <input
                      type="number"
                      value={cacheTtl}
                      onChange={(e) => setCacheTtl(Math.max(300, parseInt(e.target.value) || 300))}
                      min="300"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    />
                    <span className="text-[9px] text-white/25 mt-0.5 block">Minimum: 300 seconds (5 minutes)</span>
                  </div>
                  <div className="flex items-center gap-6 h-full pt-4">
                    <label className="flex items-center gap-2 text-xs text-white/70 select-none cursor-pointer">
                      <input
                        type="checkbox"
                        checked={releasedOnly}
                        onChange={(e) => setReleasedOnly(e.target.checked)}
                        className="rounded border-white/10 text-accent focus:ring-accent"
                      />
                      <span>Released Only</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-white/70 select-none cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeAdult}
                        onChange={(e) => setIncludeAdult(e.target.checked)}
                        className="rounded border-white/10 text-accent focus:ring-accent"
                      />
                      <span>Include Adult</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* SECTION 2: Reference Filters */}
              <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">Reference Filters</h3>
                
                {/* Genres multiselect */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Include Genres</label>
                    <select
                      onChange={(e) => {
                        const val = e.target.value
                        if (val && !selectedIncludeGenres.includes(val)) {
                          setSelectedIncludeGenres([...selectedIncludeGenres, val])
                        }
                        e.target.value = ''
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="">Select genre</option>
                      {genresList.map((g) => (
                        <option key={g.id} value={g.id} className="bg-neutral-900">{g.name}</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {selectedIncludeGenres.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No included genres</span>
                      )}
                      {selectedIncludeGenres.map((gid) => {
                        const g = genresList.find((item) => String(item.id) === gid)
                        return (
                          <span key={gid} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-md text-[10px]">
                            {g?.name || gid}
                            <button
                              onClick={() => setSelectedIncludeGenres(selectedIncludeGenres.filter((id) => id !== gid))}
                              className="hover:text-white cursor-pointer ml-1"
                            >
                              &times;
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Exclude Genres</label>
                    <select
                      onChange={(e) => {
                        const val = e.target.value
                        if (val && !selectedExcludeGenres.includes(val)) {
                          setSelectedExcludeGenres([...selectedExcludeGenres, val])
                        }
                        e.target.value = ''
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="">Select genre</option>
                      {genresList.map((g) => (
                        <option key={g.id} value={g.id} className="bg-neutral-900">{g.name}</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {selectedExcludeGenres.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No excluded genres</span>
                      )}
                      {selectedExcludeGenres.map((gid) => {
                        const g = genresList.find((item) => String(item.id) === gid)
                        return (
                          <span key={gid} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md text-[10px]">
                            {g?.name || gid}
                            <button
                              onClick={() => setSelectedExcludeGenres(selectedExcludeGenres.filter((id) => id !== gid))}
                              className="hover:text-white cursor-pointer ml-1"
                            >
                              &times;
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-1">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Genre Match Mode</label>
                    <div className="flex gap-4 h-9 items-center">
                      <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="radio"
                          name="genreMatchMode"
                          checked={genreMatchMode === 'OR'}
                          onChange={() => setGenreMatchMode('OR')}
                          className="text-accent focus:ring-accent"
                        />
                        <span>OR (Any Match)</span>
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="radio"
                          name="genreMatchMode"
                          checked={genreMatchMode === 'AND'}
                          onChange={() => setGenreMatchMode('AND')}
                          className="text-accent focus:ring-accent"
                        />
                        <span>AND (All Match)</span>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Original Language</label>
                    <select
                      value={originalLanguage}
                      onChange={(e) => setOriginalLanguage(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="Any" className="bg-neutral-900">Any</option>
                      {languagesList.map((lang) => (
                        <option key={lang.iso_639_1} value={lang.iso_639_1} className="bg-neutral-900">
                          {lang.english_name} ({lang.iso_639_1})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Origin Country</label>
                    <select
                      value={originCountry}
                      onChange={(e) => setOriginCountry(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="Any" className="bg-neutral-900">Any</option>
                      {countriesList.map((c) => (
                        <option key={c.iso_3166_1} value={c.iso_3166_1} className="bg-neutral-900">
                          {c.english_name} ({c.iso_3166_1})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Release Region (Movies)</label>
                    <select
                      value={releaseRegion}
                      disabled={contentType !== 'movie'}
                      onChange={(e) => setReleaseRegion(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40 disabled:opacity-40"
                    >
                      <option value="Any" className="bg-neutral-900">Any</option>
                      {countriesList.map((c) => (
                        <option key={c.iso_3166_1} value={c.iso_3166_1} className="bg-neutral-900">
                          {c.english_name} ({c.iso_3166_1})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Certification Country</label>
                    <select
                      value={certificationCountry}
                      onChange={(e) => {
                        setCertificationCountry(e.target.value)
                        setCertification('None')
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="None" className="bg-neutral-900">None</option>
                      {certificationCountries.map((country) => (
                        <option key={country} value={country} className="bg-neutral-900">{country}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Certification</label>
                    <select
                      value={certification}
                      disabled={certificationCountry === 'None'}
                      onChange={(e) => setCertification(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40 disabled:opacity-40"
                    >
                      <option value="None" className="bg-neutral-900">None</option>
                      {certificationsForCountry.map((c) => (
                        <option key={c.certification} value={c.certification} className="bg-neutral-900">{c.certification}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Filter Mode</label>
                    <select
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    >
                      <option value="Exact" className="bg-neutral-900">Exact</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* SECTION 3: People, Companies, and Keywords */}
              <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">People, Companies, and Keywords</h3>
                
                {/* People AutoComplete Search */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="relative">
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">People ({peopleList.length})</label>
                    <input
                      value={peopleSearch}
                      onChange={(e) => setPeopleSearch(e.target.value)}
                      placeholder="Search person (e.g. Denis Villeneuve)"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    />
                    {peopleSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 z-20 mt-1 bg-[#14161d] border border-white/10 rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
                        {peopleSuggestions.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => {
                              if (!peopleList.some((item) => item.id === p.id)) {
                                setPeopleList([...peopleList, { id: p.id, name: p.name }])
                              }
                              setPeopleSearch('')
                              setPeopleSuggestions([])
                            }}
                            className="w-full text-left px-3 py-2 text-xs text-white hover:bg-accent/10 transition-colors flex items-center gap-2 cursor-pointer"
                          >
                            {p.profile_path && (
                              <img src={`https://image.tmdb.org/t/p/w92${p.profile_path}`} className="w-5 h-7 object-cover rounded-sm" alt="" />
                            )}
                            <span>{p.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {peopleList.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No people selected</span>
                      )}
                      {peopleList.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent border border-accent/20 rounded-md text-[10px]">
                          {p.name}
                          <button onClick={() => setPeopleList(peopleList.filter((item) => item.id !== p.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">People Match Mode</label>
                    <div className="flex gap-4 h-9 items-center">
                      <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="radio"
                          name="peopleMatchMode"
                          checked={peopleMatchMode === 'OR'}
                          onChange={() => setPeopleMatchMode('OR')}
                          className="text-accent focus:ring-accent"
                        />
                        <span>OR (Any Match)</span>
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="radio"
                          name="peopleMatchMode"
                          checked={peopleMatchMode === 'AND'}
                          onChange={() => setPeopleMatchMode('AND')}
                          className="text-accent focus:ring-accent"
                        />
                        <span>AND (All Match)</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Companies AutoComplete Search */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-3">
                  <div className="relative">
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Companies ({includeCompanies.length} include / {excludeCompanies.length} exclude)</label>
                    <input
                      value={companySearch}
                      onChange={(e) => setCompanySearch(e.target.value)}
                      placeholder="Search company (e.g. Pixar)"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    />
                    {companySuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 z-20 mt-1 bg-[#14161d] border border-white/10 rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
                        {companySuggestions.map((c) => (
                          <div key={c.id} className="flex justify-between items-center px-3 py-1.5 hover:bg-white/5 border-b border-white/5 text-xs">
                            <span className="text-white font-medium">{c.name}</span>
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => {
                                  if (!includeCompanies.some((item) => item.id === c.id)) {
                                    setIncludeCompanies([...includeCompanies, c])
                                  }
                                  setCompanySearch('')
                                  setCompanySuggestions([])
                                }}
                                className="px-2 py-0.5 bg-green-500/20 text-green-400 hover:bg-green-500/30 font-semibold rounded text-[10px] cursor-pointer"
                              >
                                Include
                              </button>
                              <button
                                onClick={() => {
                                  if (!excludeCompanies.some((item) => item.id === c.id)) {
                                    setExcludeCompanies([...excludeCompanies, c])
                                  }
                                  setCompanySearch('')
                                  setCompanySuggestions([])
                                }}
                                className="px-2 py-0.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 font-semibold rounded text-[10px] cursor-pointer"
                              >
                                Exclude
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Included companies</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {includeCompanies.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No included companies</span>
                      )}
                      {includeCompanies.map((c) => (
                        <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-md text-[10px]">
                          {c.name}
                          <button onClick={() => setIncludeCompanies(includeCompanies.filter((item) => item.id !== c.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Excluded companies</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {excludeCompanies.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No excluded companies</span>
                      )}
                      {excludeCompanies.map((c) => (
                        <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md text-[10px]">
                          {c.name}
                          <button onClick={() => setExcludeCompanies(excludeCompanies.filter((item) => item.id !== c.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Company Match Mode</label>
                    <div className="flex gap-4 h-9 items-center">
                      <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="radio"
                          name="companyMatchMode"
                          checked={companyMatchMode === 'OR'}
                          onChange={() => setCompanyMatchMode('OR')}
                          className="text-accent focus:ring-accent"
                        />
                        <span>OR (Any Match)</span>
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="radio"
                          name="companyMatchMode"
                          checked={companyMatchMode === 'AND'}
                          onChange={() => setCompanyMatchMode('AND')}
                          className="text-accent focus:ring-accent"
                        />
                        <span>AND (All Match)</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Keywords AutoComplete Search */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-white/5 pt-3">
                  <div className="relative">
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Keywords ({includeKeywords.length} include / {excludeKeywords.length} exclude)</label>
                    <input
                      value={keywordSearch}
                      onChange={(e) => setKeywordSearch(e.target.value)}
                      placeholder="Search keyword (e.g. time travel)"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                    />
                    {keywordSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 z-20 mt-1 bg-[#14161d] border border-white/10 rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
                        {keywordSuggestions.map((k) => (
                          <div key={k.id} className="flex justify-between items-center px-3 py-1.5 hover:bg-white/5 border-b border-white/5 text-xs">
                            <span className="text-white font-medium">{k.name}</span>
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => {
                                  if (!includeKeywords.some((item) => item.id === k.id)) {
                                    setIncludeKeywords([...includeKeywords, k])
                                  }
                                  setKeywordSearch('')
                                  setKeywordSuggestions([])
                                }}
                                className="px-2 py-0.5 bg-green-500/20 text-green-400 hover:bg-green-500/30 font-semibold rounded text-[10px] cursor-pointer"
                              >
                                Include
                              </button>
                              <button
                                onClick={() => {
                                  if (!excludeKeywords.some((item) => item.id === k.id)) {
                                    setExcludeKeywords([...excludeKeywords, k])
                                  }
                                  setKeywordSearch('')
                                  setKeywordSuggestions([])
                                }}
                                className="px-2 py-0.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 font-semibold rounded text-[10px] cursor-pointer"
                              >
                                Exclude
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Included keywords</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {includeKeywords.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No included keywords</span>
                      )}
                      {includeKeywords.map((k) => (
                        <span key={k.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-md text-[10px]">
                          {k.name}
                          <button onClick={() => setIncludeKeywords(includeKeywords.filter((item) => item.id !== k.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Excluded keywords</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {excludeKeywords.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No excluded keywords</span>
                      )}
                      {excludeKeywords.map((k) => (
                        <span key={k.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md text-[10px]">
                          {k.name}
                          <button onClick={() => setExcludeKeywords(excludeKeywords.filter((item) => item.id !== k.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>
          /* Custom Discover Catalog Builder Form */
          <div className="flex-1 flex flex-col min-h-0 bg-neutral-950/20">
            {/* Discover Sub-tabs */}
            <div className="px-6 py-2 border-b border-white/5 bg-white/[0.01] flex gap-1.5 overflow-x-auto scrollbar-none" style={{ scrollbarWidth: 'none' }}>
              {([
                { id: 'setup', label: 'Setup' },
                { id: 'filters', label: 'Genres & Lang' },
                { id: 'streaming', label: 'Streaming' },
                { id: 'people', label: 'Credits & Keywords' },
                { id: 'ranges', label: 'Ratings & Dates' }
              ] as const).map((tab) => {
                const active = discoverTab === tab.id
                return (
                  <button
                    key={tab.id}
                    onClick={() => setDiscoverTab(tab.id)}
                    className={`h-8 flex items-center justify-center px-3.5 rounded-xl text-xs font-bold border transition-all cursor-pointer flex-shrink-0 ${
                      active
                        ? 'bg-accent text-black border-accent'
                        : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10 hover:text-white border-transparent'
                    }`}
                  >
                    {tab.label}
                  </button>
                )
              })}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6" style={{ scrollbarWidth: 'thin' }}>
              
              {/* SECTION 1: Catalog Setup */}
              {discoverTab === 'setup' && (
                <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                  <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">Catalog Setup</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Catalog Name</label>
                      <input
                        value={catalogName}
                        onChange={(e) => setCatalogName(e.target.value)}
                        placeholder="e.g. Cyberpunk Essentials"
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Source</label>
                      <select
                        value={source}
                        onChange={(e) => setSource(e.target.value as any)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="TMDB" className="bg-neutral-900">TMDB</option>
                        <option value="TVDB" className="bg-neutral-900">TVDB</option>
                        <option value="Simkl" className="bg-neutral-900">Simkl</option>
                        <option value="AniList" className="bg-neutral-900">AniList</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Content Type</label>
                      <select
                        value={contentType}
                        onChange={(e) => setContentType(e.target.value as any)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="movie" className="bg-neutral-900">Movies</option>
                        <option value="series" className="bg-neutral-900">TV Shows</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Sort By</label>
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="popularity.desc" className="bg-neutral-900">Popularity (High to Low)</option>
                        <option value="popularity.asc" className="bg-neutral-900">Popularity (Low to High)</option>
                        <option value="vote_average.desc" className="bg-neutral-900">Rating (High to Low)</option>
                        <option value="vote_average.asc" className="bg-neutral-900">Rating (Low to High)</option>
                        {contentType === 'movie' ? (
                          <>
                            <option value="primary_release_date.desc" className="bg-neutral-900">Release Date (Newest first)</option>
                            <option value="primary_release_date.asc" className="bg-neutral-900">Release Date (Oldest first)</option>
                          </>
                        ) : (
                          <>
                            <option value="first_air_date.desc" className="bg-neutral-900">Air Date (Newest first)</option>
                            <option value="first_air_date.asc" className="bg-neutral-900">Air Date (Oldest first)</option>
                          </>
                        )}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Cache TTL (seconds)</label>
                      <input
                        type="number"
                        value={cacheTtl}
                        onChange={(e) => setCacheTtl(Math.max(300, parseInt(e.target.value) || 300))}
                        min="300"
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                      <span className="text-[9px] text-white/25 mt-0.5 block">Minimum: 300 seconds (5 minutes)</span>
                    </div>
                    <div className="flex items-center gap-6 h-full pt-4">
                      <label className="flex items-center gap-2 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={releasedOnly}
                          onChange={(e) => setReleasedOnly(e.target.checked)}
                          className="rounded border-white/10 text-accent focus:ring-accent"
                        />
                        <span>Released Only</span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-white/70 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeAdult}
                          onChange={(e) => setIncludeAdult(e.target.checked)}
                          className="rounded border-white/10 text-accent focus:ring-accent"
                        />
                        <span>Include Adult</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 2: Reference Filters */}
              {discoverTab === 'filters' && (
                <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                  <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">Reference Filters</h3>
                  
                  {/* Genres multiselect */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Include Genres</label>
                      <select
                        onChange={(e) => {
                          const val = e.target.value
                          if (val && !selectedIncludeGenres.includes(val)) {
                            setSelectedIncludeGenres([...selectedIncludeGenres, val])
                          }
                          e.target.value = ''
                        }}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="">Select genre</option>
                        {genresList.map((g) => (
                          <option key={g.id} value={g.id} className="bg-neutral-900">{g.name}</option>
                        ))}
                      </select>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {selectedIncludeGenres.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No included genres</span>
                        )}
                        {selectedIncludeGenres.map((gid) => {
                          const g = genresList.find((item) => String(item.id) === gid)
                          return (
                            <span key={gid} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-md text-[10px]">
                              {g?.name || gid}
                              <button
                                onClick={() => setSelectedIncludeGenres(selectedIncludeGenres.filter((id) => id !== gid))}
                                className="hover:text-white cursor-pointer ml-1"
                              >
                                &times;
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Exclude Genres</label>
                      <select
                        onChange={(e) => {
                          const val = e.target.value
                          if (val && !selectedExcludeGenres.includes(val)) {
                            setSelectedExcludeGenres([...selectedExcludeGenres, val])
                          }
                          e.target.value = ''
                        }}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="">Select genre</option>
                        {genresList.map((g) => (
                          <option key={g.id} value={g.id} className="bg-neutral-900">{g.name}</option>
                        ))}
                      </select>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {selectedExcludeGenres.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No excluded genres</span>
                        )}
                        {selectedExcludeGenres.map((gid) => {
                          const g = genresList.find((item) => String(item.id) === gid)
                          return (
                            <span key={gid} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md text-[10px]">
                              {g?.name || gid}
                              <button
                                onClick={() => setSelectedExcludeGenres(selectedExcludeGenres.filter((id) => id !== gid))}
                                className="hover:text-white cursor-pointer ml-1"
                              >
                                &times;
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Genre Matching Mode</label>
                      <div className="flex gap-4 items-center h-8">
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="genreMatchMode"
                            checked={genreMatchMode === 'OR'}
                            onChange={() => setGenreMatchMode('OR')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>OR (Any Match)</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="genreMatchMode"
                            checked={genreMatchMode === 'AND'}
                            onChange={() => setGenreMatchMode('AND')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>AND (All Match)</span>
                        </label>
                      </div>
                    </div>
                    
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Original Language</label>
                      <select
                        value={originalLanguage}
                        onChange={(e) => setOriginalLanguage(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="Any" className="bg-neutral-900">Any</option>
                        {languagesList.map((lang) => (
                          <option key={lang.iso_639_1} value={lang.iso_639_1} className="bg-neutral-900">
                            {lang.english_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Origin Country</label>
                      <select
                        value={originCountry}
                        onChange={(e) => setOriginCountry(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="Any" className="bg-neutral-900">Any</option>
                        {countriesList.map((c) => (
                          <option key={c.iso_3166_1} value={c.iso_3166_1} className="bg-neutral-900">
                            {c.english_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Release Region</label>
                      <select
                        value={releaseRegion}
                        onChange={(e) => setReleaseRegion(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="Any" className="bg-neutral-900">Any</option>
                        {countriesList.map((c) => (
                          <option key={c.iso_3166_1} value={c.iso_3166_1} className="bg-neutral-900">
                            {c.english_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Certification Country</label>
                      <select
                        value={certificationCountry}
                        onChange={(e) => {
                          setCertificationCountry(e.target.value)
                          setCertification('None')
                        }}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="None" className="bg-neutral-900">None</option>
                        {certificationCountries.map((c) => (
                          <option key={c} value={c} className="bg-neutral-900">{c}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Certification</label>
                      <select
                        value={certification}
                        disabled={certificationCountry === 'None'}
                        onChange={(e) => setCertification(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40 disabled:opacity-40"
                      >
                        <option value="None" className="bg-neutral-900">None</option>
                        {certificationsForCountry.map((c) => (
                          <option key={c.certification} value={c.certification} className="bg-neutral-900">
                            {c.certification}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 3: People, Companies, and Keywords */}
              {discoverTab === 'people' && (
                <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                  <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">People, Companies, and Keywords</h3>
                  
                  {/* People AutoComplete Search */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="relative">
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">People ({peopleList.length})</label>
                      <input
                        value={peopleSearch}
                        onChange={(e) => setPeopleSearch(e.target.value)}
                        placeholder="Search director/actor..."
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                      {peopleSuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-neutral-900 border border-white/10 rounded-lg shadow-xl" style={{ scrollbarWidth: 'thin' }}>
                          {peopleSuggestions.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => {
                                if (!peopleList.some((item) => item.id === p.id)) {
                                  setPeopleList([...peopleList, { id: p.id, name: p.name }])
                                }
                                setPeopleSearch('')
                                setPeopleSuggestions([])
                              }}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-b border-white/5 last:border-none flex items-center gap-2"
                            >
                              {p.profile_path && (
                                <img
                                  src={`https://image.tmdb.org/t/p/w92${p.profile_path}`}
                                  className="w-5 h-5 rounded-full object-cover"
                                  alt=""
                                />
                              )}
                              <span>{p.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {peopleList.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No people added</span>
                        )}
                        {peopleList.map((p) => (
                          <span key={p.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent border border-accent/20 rounded-md text-[10px]">
                            {p.name}
                            <button onClick={() => setPeopleList(peopleList.filter((item) => item.id !== p.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">People Match Mode</label>
                      <div className="flex gap-4 items-center h-8">
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="peopleMatchMode"
                            checked={peopleMatchMode === 'OR'}
                            onChange={() => setPeopleMatchMode('OR')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>OR (Any Match)</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="peopleMatchMode"
                            checked={peopleMatchMode === 'AND'}
                            onChange={() => setPeopleMatchMode('AND')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>AND (All Match)</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Companies autocomplete */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    <div className="relative">
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Include Production Companies</label>
                      <input
                        value={companySearch}
                        onChange={(e) => setCompanySearch(e.target.value)}
                        placeholder="Search company (e.g. Marvel)..."
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                      {companySuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-neutral-900 border border-white/10 rounded-lg shadow-xl" style={{ scrollbarWidth: 'thin' }}>
                          {companySuggestions.map((c) => (
                            <button
                              key={c.id}
                              onClick={() => {
                                if (!includeCompanies.some((item) => item.id === c.id)) {
                                  setIncludeCompanies([...includeCompanies, { id: c.id, name: c.name }])
                                }
                                setCompanySearch('')
                                setCompanySuggestions([])
                              }}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-b border-white/5 last:border-none"
                            >
                              {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {includeCompanies.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No companies added</span>
                        )}
                        {includeCompanies.map((c) => (
                          <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-md text-[10px]">
                            {c.name}
                            <button onClick={() => setIncludeCompanies(includeCompanies.filter((item) => item.id !== c.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="relative">
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Exclude Production Companies</label>
                      <input
                        value={companySearch}
                        onChange={(e) => setCompanySearch(e.target.value)}
                        placeholder="Search company..."
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                      {companySuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-neutral-900 border border-white/10 rounded-lg shadow-xl" style={{ scrollbarWidth: 'thin' }}>
                          {companySuggestions.map((c) => (
                            <button
                              key={c.id}
                              onClick={() => {
                                if (!excludeCompanies.some((item) => item.id === c.id)) {
                                  setExcludeCompanies([...excludeCompanies, { id: c.id, name: c.name }])
                                }
                                setCompanySearch('')
                                setCompanySuggestions([])
                              }}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-b border-white/5 last:border-none"
                            >
                              {c.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {excludeCompanies.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No excluded companies</span>
                        )}
                        {excludeCompanies.map((c) => (
                          <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md text-[10px]">
                            {c.name}
                            <button onClick={() => setExcludeCompanies(excludeCompanies.filter((item) => item.id !== c.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Company Match Mode</label>
                      <div className="flex gap-4 items-center h-8">
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="companyMatchMode"
                            checked={companyMatchMode === 'OR'}
                            onChange={() => setCompanyMatchMode('OR')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>OR (Any Match)</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="companyMatchMode"
                            checked={companyMatchMode === 'AND'}
                            onChange={() => setCompanyMatchMode('AND')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>AND (All Match)</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Keywords autocomplete */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    <div className="relative">
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Include Keywords</label>
                      <input
                        value={keywordSearch}
                        onChange={(e) => setKeywordSearch(e.target.value)}
                        placeholder="Search keyword (e.g. superhero)..."
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                      {keywordSuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-neutral-900 border border-white/10 rounded-lg shadow-xl" style={{ scrollbarWidth: 'thin' }}>
                          {keywordSuggestions.map((k) => (
                            <button
                              key={k.id}
                              onClick={() => {
                                if (!includeKeywords.some((item) => item.id === k.id)) {
                                  setIncludeKeywords([...includeKeywords, { id: k.id, name: k.name }])
                                }
                                setKeywordSearch('')
                                setKeywordSuggestions([])
                              }}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-b border-white/5 last:border-none"
                            >
                              {k.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {includeKeywords.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No keywords added</span>
                        )}
                        {includeKeywords.map((k) => (
                          <span key={k.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-md text-[10px]">
                            {k.name}
                            <button onClick={() => setIncludeKeywords(includeKeywords.filter((item) => item.id !== k.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="relative">
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Exclude Keywords</label>
                      <input
                        value={keywordSearch}
                        onChange={(e) => setKeywordSearch(e.target.value)}
                        placeholder="Search keyword..."
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                      {keywordSuggestions.length > 0 && (
                        <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-neutral-900 border border-white/10 rounded-lg shadow-xl" style={{ scrollbarWidth: 'thin' }}>
                          {keywordSuggestions.map((k) => (
                            <button
                              key={k.id}
                              onClick={() => {
                                if (!excludeKeywords.some((item) => item.id === k.id)) {
                                  setExcludeKeywords([...excludeKeywords, { id: k.id, name: k.name }])
                                }
                                setKeywordSearch('')
                                setKeywordSuggestions([])
                              }}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors border-b border-white/5 last:border-none"
                            >
                              {k.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {excludeKeywords.length === 0 && (
                          <span className="text-[10px] text-white/20 italic">No excluded keywords</span>
                        )}
                        {excludeKeywords.map((k) => (
                          <span key={k.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded-md text-[10px]">
                            {k.name}
                            <button onClick={() => setExcludeKeywords(excludeKeywords.filter((item) => item.id !== k.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Keyword Match Mode</label>
                      <div className="flex gap-4 items-center h-8">
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="keywordMatchMode"
                            checked={keywordMatchMode === 'OR'}
                            onChange={() => setKeywordMatchMode('OR')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>OR (Any Match)</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="keywordMatchMode"
                            checked={keywordMatchMode === 'AND'}
                            onChange={() => setKeywordMatchMode('AND')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>AND (All Match)</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 4: Streaming and Region */}
              {discoverTab === 'streaming' && (
                <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                  <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">Streaming and Region</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Watch Region</label>
                      <select
                        value={watchRegion}
                        onChange={(e) => setWatchRegion(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      >
                        <option value="US" className="bg-neutral-900">United States (US)</option>
                        <option value="GB" className="bg-neutral-900">United Kingdom (GB)</option>
                        <option value="CA" className="bg-neutral-900">Canada (CA)</option>
                        <option value="AU" className="bg-neutral-900">Australia (AU)</option>
                        <option value="DE" className="bg-neutral-900">Germany (DE)</option>
                        <option value="FR" className="bg-neutral-900">France (FR)</option>
                        <option value="ES" className="bg-neutral-900">Spain (ES)</option>
                        <option value="IT" className="bg-neutral-900">Italy (IT)</option>
                        <option value="BR" className="bg-neutral-900">Brazil (BR)</option>
                        <option value="IN" className="bg-neutral-900">India (IN)</option>
                        <option value="JP" className="bg-neutral-900">Japan (JP)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Provider Match Mode</label>
                      <div className="flex gap-4 items-center h-8">
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="providerMatchMode"
                            checked={providerMatchMode === 'OR'}
                            onChange={() => setProviderMatchMode('OR')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>OR (Any Match)</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-white/70 select-none cursor-pointer">
                          <input
                            type="radio"
                            name="providerMatchMode"
                            checked={providerMatchMode === 'AND'}
                            onChange={() => setProviderMatchMode('AND')}
                            className="text-accent focus:ring-accent"
                          />
                          <span>AND (All Match)</span>
                        </label>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] text-white/50 mb-1 font-medium">Provider Search</label>
                      <input
                        value={providerSearch}
                        onChange={(e) => setProviderSearch(e.target.value)}
                        placeholder="Filter providers..."
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-accent/40"
                      />
                    </div>
                  </div>

                  {/* Popular streaming quick select services */}
                  {quickSelectProviders.length > 0 && (
                    <div className="mb-2">
                      <label className="block text-[10px] text-white/30 mb-1.5 uppercase tracking-wider font-semibold">Popular Services</label>
                      <div className="flex flex-wrap gap-1.5">
                        {quickSelectProviders.map((provider) => {
                          const selected = selectedProviders.some((p) => p.id === provider.provider_id)
                          return (
                            <button
                              key={`quick-${provider.provider_id}`}
                              onClick={() => {
                                if (selected) {
                                  setSelectedProviders(selectedProviders.filter((p) => p.id !== provider.provider_id))
                                } else {
                                  setSelectedProviders([...selectedProviders, { id: provider.provider_id, name: provider.provider_name }])
                                }
                              }}
                              className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] transition-all cursor-pointer ${
                                selected
                                  ? 'bg-accent/20 border-accent text-white'
                                  : 'bg-white/5 border-white/5 text-white/50 hover:bg-white/10 hover:text-white'
                              }`}
                            >
                              {provider.logo_path && (
                                <img
                                  src={`https://image.tmdb.org/t/p/original${provider.logo_path}`}
                                  alt=""
                                  className="w-4 h-4 rounded-sm object-cover"
                                  loading="lazy"
                                />
                              )}
                              <span>{provider.provider_name}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Searchable watch providers list */}
                  <div>
                    <label className="block text-[11px] text-white/50 mb-2 font-medium">Select Watch Providers</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 max-h-40 overflow-y-auto border border-white/5 bg-black/20 p-2.5 rounded-lg" style={{ scrollbarWidth: 'thin' }}>
                      {filteredProviders.map((provider) => {
                        const selected = selectedProviders.some((p) => p.id === provider.provider_id)
                        return (
                          <button
                            key={provider.provider_id}
                            onClick={() => {
                              if (selected) {
                                setSelectedProviders(selectedProviders.filter((p) => p.id !== provider.provider_id))
                              } else {
                                setSelectedProviders([...selectedProviders, { id: provider.provider_id, name: provider.provider_name }])
                              }
                            }}
                            className={`flex items-center gap-2 p-1.5 rounded-lg border text-left text-[10px] transition-all cursor-pointer select-none ${
                              selected
                                ? 'bg-accent/15 border-accent text-white'
                                : 'bg-white/[0.02] border-white/5 text-white/50 hover:bg-white/[0.05]'
                            }`}
                          >
                            {provider.logo_path && (
                              <img
                                src={`https://image.tmdb.org/t/p/original${provider.logo_path}`}
                                alt=""
                                className="w-5 h-5 rounded object-cover flex-shrink-0"
                                loading="lazy"
                              />
                            )}
                            <span className="truncate">{provider.provider_name}</span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {selectedProviders.length === 0 && (
                        <span className="text-[10px] text-white/20 italic">No providers selected</span>
                      )}
                      {selectedProviders.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/10 text-accent border border-accent/20 rounded-md text-[10px]">
                          {p.name}
                          <button onClick={() => setSelectedProviders(selectedProviders.filter((item) => item.id !== p.id))} className="hover:text-white cursor-pointer ml-1">&times;</button>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 5: Numeric and Date Ranges */}
                      <span className="text-white/30 text-xs">to</span>
                      <input
                        type="number"
                        placeholder="Max"
                        value={runtimeMax}
                        onChange={(e) => setRuntimeMax(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t border-white/5">
                  <label className="block text-[11px] text-white/50 font-medium">Primary Release Presets</label>
                  <div className="flex flex-wrap gap-1.5">
                    {['This Month', 'Last Month', 'This Year', 'Last Year', 'Last 5 Years', 'Last 10 Years', '2010s', '2000s', '1990s', '1980s'].map((preset) => (
                      <button
                        key={preset}
                        onClick={() => applyPreset(preset)}
                        className={`px-3 py-1 rounded-md text-[10px] font-semibold border transition-all cursor-pointer ${
                          presetName === preset
                            ? 'bg-accent/15 border-accent text-white'
                            : 'bg-white/5 border-white/5 text-white/60 hover:border-white/10'
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                    <button
                      onClick={() => applyPreset('Clear')}
                      className="px-3 py-1 rounded-md text-[10px] font-semibold bg-red-500/10 border border-red-500/10 text-red-400 hover:bg-red-500/25 transition-all cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Primary Release From</label>
                    <input
                      type="date"
                      value={releaseDateFrom}
                      onChange={(e) => {
                        setReleaseDateFrom(e.target.value)
                        setPresetName('')
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-white/50 mb-1 font-medium">Primary Release To</label>
                    <input
                      type="date"
                      value={releaseDateTo}
                      onChange={(e) => {
                        setReleaseDateTo(e.target.value)
                        setPresetName('')
                      }}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* SECTION 6: Preview Section */}
              <div className="border border-white/5 bg-white/[0.02] p-4 rounded-xl space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold text-accent uppercase tracking-wider text-green-400">Preview</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={runPreview}
                      disabled={previewLoading}
                      className="px-4 py-1.5 bg-white/5 hover:bg-white/10 text-white border border-white/10 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                    >
                      {previewLoading ? 'Loading...' : 'Preview Query'}
                    </button>
                  </div>
                </div>
                <p className="text-[10px] text-white/40">
                  {Object.keys(livePreview).length - 3} active filters plus sorting and adult-content rules.
                </p>
                <div className="bg-black/40 border border-white/5 rounded-lg p-3 text-[10px] font-mono text-white/60 overflow-x-auto">
                  {JSON.stringify(livePreview)}
                </div>

                {previewItems.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-wider">Matching Titles ({previewItems.length})</h4>
                    <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none max-h-36">
                      {previewItems.map((item) => (
                        <div key={item.id} className="w-16 flex-shrink-0 flex flex-col items-center">
                          {item.poster ? (
                            <img src={item.poster} className="w-full aspect-[2/3] object-cover rounded-md border border-white/5" alt="" />
                          ) : (
                            <div className="w-full aspect-[2/3] bg-white/5 border border-white/5 rounded-md flex items-center justify-center text-[9px] text-white/20 text-center px-1">
                              {item.title}
                            </div>
                          )}
                          <span className="text-[9px] text-white/40 truncate w-full text-center mt-1">{item.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer buttons */}
            <div className="px-6 py-4 border-t border-white/5 bg-white/[0.01] flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  if (editingRow) {
                    onClose()
                  } else {
                    setMode('preset')
                  }
                }}
                className="px-5 py-2 rounded-xl text-xs font-semibold text-white/60 hover:text-white hover:bg-white/5 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveDiscover}
                className="px-6 py-2.5 bg-accent hover:bg-accent/80 text-black text-xs font-bold rounded-xl shadow-lg transition-all cursor-pointer"
              >
                {editingRow ? 'Save Changes' : 'Save Catalog'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CollectionsPage() {
  const homeRows = useAppStore((s) => s.homeRows)
  const updateHomeRow = useAppStore((s) => s.updateHomeRow)
  const removeHomeRow = useAppStore((s) => s.removeHomeRow)
  const reorderHomeRows = useAppStore((s) => s.reorderHomeRows)
  const addHomeRow = useAppStore((s) => s.addHomeRow)
  const addons = useAppStore((s) => s.addons)
  const posterSize = useAppStore((s) => s.posterSize)

  const widgetGridMinMax = useMemo(() => {
    switch (posterSize) {
      case 'compact': return 'minmax(112px, 1fr)'
      case 'large': return 'minmax(180px, 1fr)'
      case 'huge': return 'minmax(220px, 1fr)'
      case 'default':
      default:
        return 'minmax(148px, 1fr)'
    }
  }, [posterSize])
  const [addOverlay, setAddOverlay] = useState(false)
  const [editingRow, setEditingRow] = useState<HomeRowConfig | null>(null)

  const heroRow = homeRows.find((r) => r.layout === 'hero')
  const widgetRows = homeRows
    .filter((r) => r.layout !== 'hero')
    .sort((a, b) => a.order - b.order)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      const oldIndex = widgetRows.findIndex((r) => r.id === active.id)
      const newIndex = widgetRows.findIndex((r) => r.id === over.id)
      const reordered = arrayMove(widgetRows, oldIndex, newIndex)

      // Reconstruct full list preserving hero + disabled
      const hero = homeRows.find((r) => r.layout === 'hero')
      const nextRows = [
        ...(hero ? [hero] : []),
        ...reordered,
      ]
      reorderHomeRows(nextRows)
    }
  }

  return (
    <div className="p-6">
      {/* Hero banner config */}
      <HeroBannerSection row={heroRow} addons={addons} onUpdate={updateHomeRow} />

      {/* Widget grid header */}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/35">
          Your Collections
        </h2>
        <button
          className="w-4 h-4 rounded-full border border-white/15 flex items-center justify-center text-[9px] text-white/25 hover:text-white/50 transition-colors"
          title="Drag to reorder. Each tile is a shelf on your home screen."
        >
          ?
        </button>
      </div>

      {/* Draggable widget grid */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={widgetRows.map((r) => r.id)} strategy={rectSortingStrategy}>
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(auto-fill, ${widgetGridMinMax})` }}
          >
            <CreateTile onClick={() => { setEditingRow(null); setAddOverlay(true); }} />

            {widgetRows.map((row) => (
              <SortableWidgetTile
                key={row.id}
                row={row}
                addons={addons}
                onRemove={() => {
                  if (confirm(`Remove "${row.title}" from your home screen?`)) {
                    removeHomeRow(row.id)
                  }
                }}
                onEdit={() => {
                  setEditingRow(row)
                  setAddOverlay(true)
                }}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add widget overlay */}
      <AddWidgetOverlay
        open={addOverlay}
        onClose={() => setAddOverlay(false)}
        addons={addons}
        homeRows={homeRows}
        onAdd={addHomeRow}
        editingRow={editingRow}
        onUpdate={updateHomeRow}
      />
    </div>
  )
}
