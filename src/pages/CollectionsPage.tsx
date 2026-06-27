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
import { canonicalizeCatalogItemsWithTvdb, getAvailablePmdbListSources, getAvailablePmdbPickSources, getAvailableTraktListSources, getProviderListItems, PMDB_LIST_SOURCES, TRAKT_LIST_SOURCES } from '../services/providerLists'
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
  let items: import('../services/simkl/types').SimklWatchlistItem[] = []
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
  const canonical = await canonicalizeCatalogItemsWithTvdb(items.map((item) => ({
    id: item.tvdbId ? `tvdb-${item.tvdbId}` : item.imdbId || (item.tmdbId ? `tmdb-${item.tmdbId}` : item.id),
    title: item.title,
    type: item.type === 'movie' ? 'movie' as const : 'series' as const,
    year: item.year,
    poster: item.poster,
    backdrop: item.backdrop,
    provider: 'simkl',
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
  })))
  return canonical
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

        if ((row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'anilist') && row.providerListId) {
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
          } catch (_) { /* ignore */ }
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
      } catch (_) {
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

// ── Poster strip (horizontal row for list items) ──────────────────────────────

function PosterStrip({ posters, loading }: { posters: string[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => <div key={i} className="w-9 h-[52px] rounded-md bg-white/5 animate-pulse flex-shrink-0" />)}
      </div>
    )
  }
  if (posters.length === 0) {
    return (
      <div className="w-9 h-[52px] rounded-md bg-white/[0.04] flex items-center justify-center flex-shrink-0">
        <svg className="w-4 h-4 text-white/15" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 16l5-5 4 4 4-5 5 6" />
        </svg>
      </div>
    )
  }
  return (
    <div className="flex gap-1 flex-shrink-0">
      {posters.slice(0, 3).map((url, i) => (
        <img key={i} src={url} alt="" className="w-9 h-[52px] rounded-md object-cover flex-shrink-0" loading="lazy" />
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
  if (row.sourceType === 'discover') return 'bg-amber-500/15 text-amber-400'
  if (row.layout === 'continue') return 'bg-accent/15 text-accent'
  return 'bg-white/[0.06] text-white/50'
}

// ── Sortable shelf row ────────────────────────────────────────────────────────

function SortableShelfRow({
  row,
  addons,
  onRemove,
  onEdit,
  onToggle,
}: {
  row: HomeRowConfig
  addons: InstalledAddon[]
  onRemove: () => void
  onEdit: () => void
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const { posters, count, loading } = useRowPosters(row, addons)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-4 px-4 py-3 rounded-xl border transition-all ${
        isDragging
          ? 'bg-white/[0.06] border-white/15 shadow-[0_12px_40px_rgba(0,0,0,0.5)] scale-[1.01]'
          : !row.enabled
            ? 'bg-white/[0.01] border-white/[0.04] opacity-50'
            : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:border-white/[0.1]'
      }`}
    >
      {/* Drag handle */}
      <div
        className="flex-shrink-0 cursor-grab active:cursor-grabbing text-white/20 hover:text-white/40 transition-colors touch-none"
        {...attributes}
        {...listeners}
      >
        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="5" cy="3" r="1.5" /><circle cx="11" cy="3" r="1.5" />
          <circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" />
          <circle cx="5" cy="13" r="1.5" /><circle cx="11" cy="13" r="1.5" />
        </svg>
      </div>

      {/* Poster thumbnails */}
      <PosterStrip posters={posters} loading={loading} />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white/85 truncate leading-tight">{row.title}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${sourceColor(row)}`}>
            {shelfSourceLabel(row)}
          </span>
          <span className="text-[10px] text-white/25">{shelfLayoutLabel(row)}</span>
          <span className="text-[10px] text-white/25">{loading ? '...' : `${count} items`}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          onPointerDown={(e) => e.stopPropagation()}
          title={row.enabled ? 'Hide from home' : 'Show on home'}
          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
            row.enabled ? 'text-white/40 hover:text-white hover:bg-white/[0.08]' : 'text-white/20 hover:text-accent hover:bg-accent/10'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            {row.enabled ? (
              <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
            ) : (
              <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
            )}
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Edit"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
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
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
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
    <div className="flex items-center gap-4 px-4 py-3 bg-white/[0.02] rounded-xl border border-white/[0.06]">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-8 h-8 flex-shrink-0 rounded-lg bg-accent/10 flex items-center justify-center">
          <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white/80">Hero Banner</p>
          <p className="text-[11px] text-white/30 truncate">Featured catalog at the top of your home screen</p>
        </div>
      </div>
      <select
        value={currentValue}
        onChange={(e) => handleCatalogChange(e.target.value)}
        className="bg-white/[0.06] border border-white/[0.08] text-white/70 text-xs rounded-lg px-3 py-2 outline-none cursor-pointer max-w-[240px] truncate flex-shrink-0"
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
  service: 'anilist' | 'trakt' | 'pmdb' | 'pmdb-picks'
  lists: { id: string; label: string; type: 'poster' | 'landscape' }[]
  isAlreadyAdded: (key: string) => boolean
  onAdd: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  onClose: () => void
}) {
  const label = service === 'anilist' ? 'AniList' : service === 'pmdb' ? 'PMDB' : service === 'pmdb-picks' ? 'PMDB Picks' : 'Trakt'
  const borderColor = service === 'anilist' ? 'border-l-[#3b82f6]' : service === 'pmdb' ? 'border-l-[#a855f7]' : service === 'pmdb-picks' ? 'border-l-[#d946ef]' : 'border-l-[#ef4444]'
  const badgeBg = service === 'anilist' ? 'bg-[#3b82f6]/15 text-[#3b82f6]' : service === 'pmdb' ? 'bg-[#a855f7]/15 text-[#a855f7]' : service === 'pmdb-picks' ? 'bg-[#d946ef]/15 text-[#d946ef]' : 'bg-[#ef4444]/15 text-[#ef4444]'
  return (
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
            className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/[0.04] border-l-[3px] ${borderColor} transition-all text-left ${
              added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.08] hover:translate-x-0.5 cursor-pointer'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${badgeBg}`}>
              <span className="text-[11px] font-black">{label[0]}</span>
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
              <svg className="w-4 h-4 text-white/15 group-hover:text-white/30 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
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
  const [selectedSourceFilter, setSelectedSourceFilter] = useState<'all' | 'builtin' | 'addons' | 'simkl' | 'trakt' | 'anilist' | 'pmdb' | 'pmdb-picks'>('all')
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
      if (r.sourceType === 'simkl' || r.sourceType === 'trakt' || r.sourceType === 'pmdb' || r.sourceType === 'pmdb-picks' || r.sourceType === 'anilist') return `${r.sourceType}:${r.providerListId}` === key
      return `${r.addonId}::${r.catalogType}::${r.catalogId}` === key
    }), [homeRows])

  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const [traktLists, setTraktLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(TRAKT_LIST_SOURCES)
  const [pmdbLists, setPmdbLists] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>(PMDB_LIST_SOURCES)
  const [pmdbPicks, setPmdbPicks] = useState<{ id: string; label: string; layout: 'poster' | 'landscape' }[]>([])

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

  const filteredPmdbPicks = useMemo(() => {
    if (!search) return pmdbPicks
    const q = search.toLowerCase()
    return pmdbPicks.filter((pick) => pick.label.toLowerCase().includes(q))
  }, [search, pmdbPicks])

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

  // Source color helpers
  const sourceColors: Record<string, { bg: string; text: string; border: string; dot: string }> = {
    simkl: { bg: 'bg-[#0ea5e9]/15', text: 'text-[#0ea5e9]', border: 'border-l-[#0ea5e9]', dot: 'bg-[#0ea5e9]' },
    trakt: { bg: 'bg-[#ef4444]/15', text: 'text-[#ef4444]', border: 'border-l-[#ef4444]', dot: 'bg-[#ef4444]' },
    anilist: { bg: 'bg-[#3b82f6]/15', text: 'text-[#3b82f6]', border: 'border-l-[#3b82f6]', dot: 'bg-[#3b82f6]' },
    pmdb: { bg: 'bg-[#a855f7]/15', text: 'text-[#a855f7]', border: 'border-l-[#a855f7]', dot: 'bg-[#a855f7]' },
    'pmdb-picks': { bg: 'bg-[#d946ef]/15', text: 'text-[#d946ef]', border: 'border-l-[#d946ef]', dot: 'bg-[#d946ef]' },
    builtin: { bg: 'bg-accent/15', text: 'text-accent', border: 'border-l-accent', dot: 'bg-accent' },
    addons: { bg: 'bg-orange-500/15', text: 'text-orange-400', border: 'border-l-orange-400', dot: 'bg-orange-400' },
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div
        className={`bg-[#0c0d12] border border-white/[0.08] rounded-2xl w-full flex flex-col overflow-hidden shadow-2xl shadow-black/50 transition-all duration-300 h-[min(800px,calc(100dvh-2rem))] ${
          mode === 'discover' ? 'max-w-4xl' : 'max-w-3xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent line */}
        <div className="h-px bg-gradient-to-r from-accent/0 via-accent/50 to-accent/0" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/10 flex items-center justify-center flex-shrink-0">
              {editingRow ? (
                <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              ) : (
                <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
              )}
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">
                {editingRow
                  ? editingRow.sourceType === 'discover'
                    ? 'Edit Custom Catalog'
                    : 'Edit Shelf Settings'
                  : 'Add to Home'}
              </h2>
              <p className="text-xs text-white/30 mt-0.5">
                {editingRow
                  ? editingRow.sourceType === 'discover'
                    ? 'Modify your discover catalog filters'
                    : 'Rename or change layout'
                  : 'Browse catalogs or build a custom discover shelf'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-all text-white/30 hover:text-white/60 hover:rotate-90 duration-200 cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Navigation Tabs */}
        {!editingRow && (
          <div className="flex gap-2 px-5 sm:px-6 py-2.5 border-b border-white/[0.06] flex-shrink-0">
            <button
              onClick={() => setMode('preset')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                mode === 'preset'
                  ? 'bg-accent/15 text-accent border border-accent/20'
                  : 'text-white/35 hover:bg-white/[0.04] hover:text-white/55 border border-transparent'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
              Standard Shelf
            </button>
            <button
              onClick={() => setMode('discover')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                mode === 'discover'
                  ? 'bg-accent/15 text-accent border border-accent/20'
                  : 'text-white/35 hover:bg-white/[0.04] hover:text-white/55 border border-transparent'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
              Build Your Catalog
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
          (() => {
            const showBuiltin = selectedSourceFilter === 'all' || selectedSourceFilter === 'builtin'
            const showAddons = selectedSourceFilter === 'all' || selectedSourceFilter === 'addons'
            const showSimkl = selectedSourceFilter === 'all' || selectedSourceFilter === 'simkl'
            const showAniList = selectedSourceFilter === 'all' || selectedSourceFilter === 'anilist'
            const showTrakt = selectedSourceFilter === 'all' || selectedSourceFilter === 'trakt'
            const showPmdb = selectedSourceFilter === 'all' || selectedSourceFilter === 'pmdb'
            const showPmdbPicks = selectedSourceFilter === 'all' || selectedSourceFilter === 'pmdb-picks'

            const builtinCount = (showBuiltin && (!search || 'continue watching'.includes(search.toLowerCase()))) ? 1 : 0
            const pmdbAddonCatalogsCount = (showPmdb || showAddons) ? filteredPmdbAddonCatalogs.length : 0
            const otherAddonCatalogsCount = showAddons ? filteredOtherAddonCatalogs.length : 0
            const simklListsCount = (showSimkl && simklConnected) ? filteredSimklLists.length : 0
            const aniListListsCount = (showAniList && anilistConnected) ? filteredAniListLists.length : 0
            const traktListsCount = (showTrakt && traktConnected) ? filteredTraktLists.length : 0
            const pmdbListsCount = (showPmdb && !!pmdbApiKey) ? filteredPmdbLists.length : 0
            const pmdbPicksCount = (showPmdbPicks && !!pmdbApiKey) ? filteredPmdbPicks.length : 0

            const totalVisible = builtinCount + pmdbAddonCatalogsCount + otherAddonCatalogsCount + simklListsCount + aniListListsCount + traktListsCount + pmdbListsCount + pmdbPicksCount

            const DisconnectedCard = ({ source, letter, name, desc }: { source: string; letter: string; name: string; desc: string }) => {
              const c = sourceColors[source] || sourceColors.builtin
              return (
                <div className="flex flex-col items-center justify-center text-center py-14 px-8">
                  <div className={`w-16 h-16 rounded-2xl ${c.bg} border border-white/[0.04] flex items-center justify-center mb-5`}>
                    <span className={`text-2xl font-black ${c.text}`}>{letter}</span>
                  </div>
                  <h4 className="text-sm font-semibold text-white mb-2">{name} not connected</h4>
                  <p className="text-xs text-white/25 max-w-xs leading-relaxed">{desc}</p>
                  <div className="mt-4 px-4 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-[11px] text-white/30 font-medium">
                    Go to Settings &rarr; Accounts
                  </div>
                </div>
              )
            }

            return (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Search */}
                <div className="px-5 sm:px-6 py-3 border-b border-white/[0.06] flex-shrink-0">
                  <div className="relative">
                    <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search catalogs and lists..."
                      className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-10 pr-10 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-accent/30 focus:bg-white/[0.05] transition-all"
                      autoFocus
                    />
                    {search && (
                      <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md bg-white/[0.08] hover:bg-white/[0.12] flex items-center justify-center text-white/30 hover:text-white/60 transition-all cursor-pointer">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    )}
                  </div>
                </div>

                {/* Source selector */}
                <div className="px-5 sm:px-6 py-3 border-b border-white/[0.06] grid grid-cols-2 sm:grid-cols-4 gap-2 flex-shrink-0 bg-white/[0.01]">
                  {([
                    { id: 'all' as const, label: 'All', color: null, connected: undefined },
                    { id: 'builtin' as const, label: 'Built-in', color: sourceColors.builtin, connected: undefined },
                    { id: 'addons' as const, label: 'Addons', color: sourceColors.addons, connected: undefined },
                    { id: 'simkl' as const, label: 'Simkl', color: sourceColors.simkl, connected: simklConnected },
                    { id: 'trakt' as const, label: 'Trakt', color: sourceColors.trakt, connected: traktConnected },
                    { id: 'anilist' as const, label: 'AniList', color: sourceColors.anilist, connected: anilistConnected },
                    { id: 'pmdb' as const, label: 'PMDB', color: sourceColors.pmdb, connected: !!pmdbApiKey },
                    { id: 'pmdb-picks' as const, label: 'PMDB Picks', color: sourceColors['pmdb-picks'], connected: !!pmdbApiKey },
                  ]).map((filter) => {
                    const active = selectedSourceFilter === filter.id
                    const activeBg = filter.color ? `${filter.color.bg} ${filter.color.text}` : 'bg-accent/15 text-accent'
                    const activeBorder = filter.color
                      ? filter.id === 'simkl' ? 'border-[#0ea5e9]/25'
                        : filter.id === 'trakt' ? 'border-[#ef4444]/25'
                        : filter.id === 'anilist' ? 'border-[#3b82f6]/25'
                        : filter.id === 'pmdb' ? 'border-[#a855f7]/25'
                        : filter.id === 'pmdb-picks' ? 'border-[#d946ef]/25'
                        : filter.id === 'addons' ? 'border-orange-400/25'
                        : 'border-accent/20'
                      : 'border-accent/20'
                    return (
                      <button
                        key={filter.id}
                        onClick={() => setSelectedSourceFilter(filter.id)}
                        className={`h-9 min-w-0 flex items-center justify-center gap-2 px-3 rounded-lg text-[11px] font-bold transition-all cursor-pointer border ${
                          active
                            ? `${activeBg} ${activeBorder}`
                            : 'bg-white/[0.03] text-white/35 hover:bg-white/[0.06] hover:text-white/55 border-white/[0.04]'
                        }`}
                      >
                        {filter.connected !== undefined && (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${filter.connected ? (filter.color?.dot || 'bg-emerald-400') : 'bg-white/15'}`} />
                        )}
                        <span className="truncate">{filter.label}</span>
                      </button>
                    )
                  })}
                </div>

                {/* Catalog List */}
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 sm:px-6 py-4 space-y-5" style={{ scrollbarWidth: 'thin', scrollbarGutter: 'stable' }}>

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
                  {selectedSourceFilter === 'addons' && addons.length === 0 && (
                    <div className="flex flex-col items-center justify-center text-center py-10 px-6">
                      <div className="w-14 h-14 rounded-2xl bg-orange-500/15 flex items-center justify-center mb-4">
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
                      <div className="flex items-center gap-2 mb-3">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.builtin.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">Built-in</h3>
                      </div>
                      {(() => {
                        const added = homeRows.some((r) => r.layout === 'continue')
                        return (
                          <button
                            disabled={added}
                            onClick={() => {
                              onAdd({ title: 'Continue Watching', layout: 'continue', enabled: true, sourceType: 'local' })
                              onClose()
                            }}
                            className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/[0.04] border-l-[3px] ${sourceColors.builtin.border} transition-all text-left ${
                              added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.08] hover:translate-x-0.5 cursor-pointer'
                            }`}
                          >
                            <div className={`w-8 h-8 rounded-lg ${sourceColors.builtin.bg} flex items-center justify-center flex-shrink-0`}>
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
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.pmdb.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">PMDB Catalogs</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredPmdbAddonCatalogs.length}</span>
                      </div>
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
                              className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/[0.04] border-l-[3px] ${sourceColors.pmdb.border} transition-all text-left ${
                                added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.08] hover:translate-x-0.5 cursor-pointer'
                              }`}
                            >
                              <div className={`w-8 h-8 rounded-lg ${sourceColors.pmdb.bg} flex items-center justify-center flex-shrink-0`}>
                                <span className={`text-[11px] font-black ${sourceColors.pmdb.text}`}>P</span>
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-white/80 truncate">{cat.catalogName}</p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[10px] text-white/25">{cat.addonName}</span>
                                  <span className="text-[10px] text-white/10">·</span>
                                  <span className="text-[10px] text-white/25">{cat.catalogType}</span>
                                </div>
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

                  {/* Addon Catalogs */}
                  {showAddons && filteredOtherAddonCatalogs.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.addons.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">Addon Catalogs</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredOtherAddonCatalogs.length}</span>
                      </div>
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
                              className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/[0.04] border-l-[3px] ${sourceColors.addons.border} transition-all text-left ${
                                added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.08] hover:translate-x-0.5 cursor-pointer'
                              }`}
                            >
                              <div className={`w-8 h-8 rounded-lg ${sourceColors.addons.bg} flex items-center justify-center flex-shrink-0`}>
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

                  {/* Simkl Lists */}
                  {showSimkl && simklConnected && filteredSimklLists.length > 0 && (
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
                                onAdd({
                                  title: `Simkl — ${list.label}`,
                                  sourceType: 'simkl',
                                  providerListId: list.id,
                                  layout: list.type,
                                  enabled: true,
                                })
                                onClose()
                              }}
                              className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/[0.04] border-l-[3px] ${sourceColors.simkl.border} transition-all text-left ${
                                added ? 'bg-white/[0.025] opacity-55 cursor-default' : 'bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.08] hover:translate-x-0.5 cursor-pointer'
                              }`}
                            >
                              <div className={`w-8 h-8 rounded-lg ${sourceColors.simkl.bg} flex items-center justify-center flex-shrink-0`}>
                                <span className={`text-[11px] font-black ${sourceColors.simkl.text}`}>S</span>
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
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.anilist.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">AniList Lists</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredAniListLists.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="AniList Lists"
                        service="anilist"
                        lists={filteredAniListLists}
                        isAlreadyAdded={isAlreadyAdded}
                        onAdd={onAdd}
                        onClose={onClose}
                      />
                    </div>
                  )}

                  {/* Trakt Lists */}
                  {showTrakt && traktConnected && filteredTraktLists.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.trakt.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">Trakt Lists</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredTraktLists.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="Trakt Lists"
                        service="trakt"
                        lists={filteredTraktLists.map((l) => ({ id: l.id, label: l.label.replace(/^Trakt - /, ''), type: l.layout }))}
                        isAlreadyAdded={isAlreadyAdded}
                        onAdd={onAdd}
                        onClose={onClose}
                      />
                    </div>
                  )}

                  {/* PMDB Lists */}
                  {showPmdb && !!pmdbApiKey && filteredPmdbLists.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors.pmdb.dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">PMDB Lists</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredPmdbLists.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="PMDB Lists"
                        service="pmdb"
                        lists={filteredPmdbLists.map((l) => ({ id: l.id, label: l.label.replace(/^PMDB - /, ''), type: l.layout }))}
                        isAlreadyAdded={isAlreadyAdded}
                        onAdd={onAdd}
                        onClose={onClose}
                      />
                    </div>
                  )}

                  {/* PMDB Picks */}
                  {showPmdbPicks && !!pmdbApiKey && filteredPmdbPicks.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-1.5 h-5 rounded-full ${sourceColors['pmdb-picks'].dot}`} />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">PMDB Picks</h3>
                        <span className="text-[10px] text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-md font-medium">{filteredPmdbPicks.length}</span>
                      </div>
                      <ProviderListPickerSection
                        title="PMDB Picks"
                        service="pmdb-picks"
                        lists={filteredPmdbPicks.map((pick) => ({ id: pick.id, label: pick.label, type: pick.layout }))}
                        isAlreadyAdded={isAlreadyAdded}
                        onAdd={onAdd}
                        onClose={onClose}
                      />
                    </div>
                  )}

                  {/* Search empty state */}
                  {totalVisible === 0 && search && (
                    <div className="flex flex-col items-center justify-center text-center py-16">
                      <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
                        <svg className="w-6 h-6 text-white/15" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                      </div>
                      <p className="text-sm text-white/30 font-medium">No results for &ldquo;{search}&rdquo;</p>
                      <p className="text-xs text-white/15 mt-1">Try a different search term</p>
                    </div>
                  )}

                  {/* Nothing connected at all */}
                  {selectedSourceFilter === 'all' && addons.length === 0 && !simklConnected && !traktConnected && !anilistConnected && !pmdbApiKey && !search && (
                    <div className="flex flex-col items-center justify-center text-center py-16">
                      <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-5">
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
            )
          })()
        ) : (
          /* Custom Discover Catalog Builder Form */
          <div className="flex-1 flex flex-col min-h-0">
            {/* Discover Sub-tabs */}
            <div className="px-6 py-3 border-b border-white/[0.06] flex gap-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              {([
                { id: 'setup' as const, label: 'Setup', step: 1 },
                { id: 'filters' as const, label: 'Genres & Language', step: 2 },
                { id: 'streaming' as const, label: 'Streaming', step: 3 },
                { id: 'people' as const, label: 'People & Tags', step: 4 },
                { id: 'ranges' as const, label: 'Date & Rating', step: 5 },
              ]).map((tab, i, arr) => {
                const active = discoverTab === tab.id
                const tabOrder = ['setup', 'filters', 'streaming', 'people', 'ranges']
                const currentIdx = tabOrder.indexOf(discoverTab)
                const completed = tabOrder.indexOf(tab.id) < currentIdx
                return (
                  <button
                    key={tab.id}
                    onClick={() => setDiscoverTab(tab.id)}
                    className={`h-9 flex items-center gap-2 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer flex-shrink-0 border ${
                      active
                        ? 'bg-accent/15 text-accent border-accent/20'
                        : completed
                          ? 'bg-white/[0.04] text-white/45 border-white/[0.06] hover:bg-white/[0.06]'
                          : 'bg-white/[0.02] text-white/30 hover:bg-white/[0.05] hover:text-white/50 border-transparent'
                    }`}
                  >
                    <span className={`w-5 h-5 rounded-md text-[10px] font-black flex items-center justify-center flex-shrink-0 ${
                      active ? 'bg-accent/25 text-accent' : completed ? 'bg-white/[0.06] text-white/30' : 'bg-white/[0.04] text-white/20'
                    }`}>{tab.step}</span>
                    {tab.label}
                  </button>
                )
              })}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5" style={{ scrollbarWidth: 'thin' }}>

              {/* ── Setup Tab ── */}
              {discoverTab === 'setup' && (
                <div className="space-y-5">
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center"><svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><circle cx="12" cy="12" r="3" /></svg></div>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Catalog Setup</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Name</label>
                        <input value={catalogName} onChange={(e) => setCatalogName(e.target.value)} placeholder="e.g. Cyberpunk Essentials" className={styledInput} />
                      </div>
                      <div>
                        <label className="block text-[11px] text-white/40 mb-1.5 font-medium">Source</label>
                        <select value={source} onChange={(e) => setSource(e.target.value as any)} className={styledSelect}>
                          <option value="TMDB" className="bg-[#0a0b0e]">TMDB</option>
                          <option value="TVDB" className="bg-[#0a0b0e]">TVDB</option>
                          <option value="Simkl" className="bg-[#0a0b0e]">Simkl</option>
                          <option value="AniList" className="bg-[#0a0b0e]">AniList</option>
                        </select>
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
                      <div className="flex items-start gap-3 pt-5">
                        <PillToggle checked={releasedOnly} onChange={setReleasedOnly} label="Released Only" />
                        <PillToggle checked={includeAdult} onChange={setIncludeAdult} label="Adult" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Filters Tab ── */}
              {discoverTab === 'filters' && (
                <div className="space-y-5">
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
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
              {discoverTab === 'streaming' && (
                <div className="space-y-5">
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
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
              {discoverTab === 'people' && (
                <div className="space-y-5">
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
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
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
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
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
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
              {discoverTab === 'ranges' && (
                <div className="space-y-5">
                  {/* Rating & Runtime */}
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-5">
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
                  <div className="bg-white/[0.03] border border-white/[0.06] p-5 rounded-xl space-y-4">
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
              <p className="text-[10px] text-white/20">{catalogName ? `"${catalogName}"` : 'Untitled catalog'} &middot; {source} &middot; {contentType === 'movie' ? 'Movies' : 'TV Shows'}</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { if (editingRow) onClose(); else setMode('preset') }}
                  className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white/40 hover:text-white hover:bg-white/[0.04] transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveDiscover}
                  className="px-6 py-2.5 bg-accent hover:bg-accent/80 text-black text-xs font-bold rounded-xl shadow-lg shadow-accent/10 transition-all cursor-pointer"
                >
                  {editingRow ? 'Save Changes' : 'Save Catalog'}
                </button>
              </div>
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
      const hero = homeRows.find((r) => r.layout === 'hero')
      reorderHomeRows([...(hero ? [hero] : []), ...reordered])
    }
  }

  return (
    <div className="pb-12">
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Library</h1>
            <p className="text-sm text-white/35">Manage your home screen shelves and collections</p>
          </div>
          <button
            onClick={() => { setEditingRow(null); setAddOverlay(true) }}
            className="flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent/80 text-black text-sm font-bold rounded-xl transition-all cursor-pointer shadow-lg shadow-accent/20"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Shelf
          </button>
        </div>
      </div>

      <div className="px-8 space-y-6">
        {/* Hero banner config */}
        <HeroBannerSection row={heroRow} addons={addons} onUpdate={updateHomeRow} />

        {/* Shelves list */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/35">
              Shelves ({widgetRows.length})
            </h2>
            <span className="text-[10px] text-white/20">Drag to reorder</span>
          </div>

          {widgetRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 bg-white/[0.01] border border-dashed border-white/[0.08] rounded-2xl">
              <svg className="w-10 h-10 text-white/10 mb-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <p className="text-sm text-white/30 mb-1">No shelves yet</p>
              <p className="text-xs text-white/20 mb-5">Add catalogs, lists, or custom discover shelves to your home screen</p>
              <button
                onClick={() => { setEditingRow(null); setAddOverlay(true) }}
                className="flex items-center gap-2 px-4 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-white/70 text-xs font-semibold rounded-xl border border-white/[0.08] transition-all cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add your first shelf
              </button>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={widgetRows.map((r) => r.id)} strategy={rectSortingStrategy}>
                <div className="space-y-2">
                  {widgetRows.map((row) => (
                    <SortableShelfRow
                      key={row.id}
                      row={row}
                      addons={addons}
                      onRemove={() => removeHomeRow(row.id)}
                      onEdit={() => {
                        setEditingRow(row)
                        setAddOverlay(true)
                      }}
                      onToggle={() => {
                        updateHomeRow(row.id, { enabled: !row.enabled })
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
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
      />
    </div>
  )
}
