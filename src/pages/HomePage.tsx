import { lazy, memo, Suspense, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import ErrorBoundary from '../components/ui/ErrorBoundary'
import { EmptyState } from '../components/ui'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import ContinueWatchingRow from '../components/ContinueWatchingRow'
import UpcomingHomeRow from '../components/UpcomingHomeRow'
import CatalogKeyNotice from '../components/CatalogKeyNotice'
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
import { cachedFetch, cacheClearExpired, cacheGetMany, cacheSet } from '../services/cache/sqliteCache'
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
import { streamPreloadManager } from '../services/streams/preloadManager'
import { useVisibilityOnce } from '../hooks/useVisibilityOnce'
import { catalogContentFingerprint, getContinueWatchingAccountScope, readContinueWatchingStartupSnapshot, readHeroStartupSnapshot, writeHeroStartupSnapshot } from '../services/cache/homeStartupSnapshot'
import { readHomeShelfStartupSnapshot, writeHomeShelfStartupSnapshots } from '../services/cache/homeShelfStartupSnapshot'
import { markContinueWatchingSettled, markHeroImageSettled } from '../services/cache/homeStartupCoordinator'
import { markPerformance, measurePerformance } from '../services/performanceMetrics'
import { SERVER_INTEGRATIONS_ENABLED } from '../services/serverIntegrations'
import { getActiveProfileId } from '../services/profiles'
import { getHomeShelfId, rememberHomeShelfId } from '../services/sessionViewState'
import { HomeEditRowContext } from '../components/home/HomeEditRowContext'

const HomeEditList = lazy(() => import('../components/home/HomeEditList'))

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

function cacheKeyForHomeRow(row: HomeRowConfig, addons: ReturnType<typeof useAppStore.getState>['addons']): string | null {
  const resolvedAddonUrl = row.addonId
    ? addons.find((addon) => addon.enabled && addon.manifest.id === row.addonId)?.url || row.addonUrl
    : row.addonUrl
  return homeRowCacheKey(row, resolvedAddonUrl)
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
    overview: item.overview,
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

function MediaRowError({ title, message, layout, headerLeftControls, headerRightControls, onRetry }: { title: string; message: string; layout: 'poster' | 'landscape'; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode; onRetry?: () => void }) {
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
            {onRetry && <button type="button" onClick={onRetry} className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10">Retry</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

function SimklRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = simklRowCacheKey(row)
  const memCacheGet = useHomeCatalogCache((state) => state.get)
  const memCacheSet = useHomeCatalogCache((state) => state.set)
  const cached = memCacheGet(cacheKey) || readHomeShelfStartupSnapshot(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [itemsCacheKey, setItemsCacheKey] = useState(cacheKey)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  useEffect(() => {
    setError(null)
    let cancelled = false
    let staleRefreshApplied = false
    const load = async () => {
      try {
        const fetcher = async () => {
          const listId = row.providerListId || 'watchlist'
          const rawResults = isSimklDerivedCatalogId(listId)
            ? await getSimklDerivedCatalogItems(listId)
            : (listId === 'history' ? await getSimklWatchedMovies() : await getSimklWatchStatusList(listId)).map(simklItemToSearchResult)
          const canonicalized = await canonicalizeCatalogItemsWithTvdb(rawResults)
          const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
          // SIMKL's list payload is intentionally compact and often has no
          // synopsis. Resolve missing metadata here so expanded cards do not
          // need a detail-page visit before they can display a description.
          const results = await enrichSearchResultsWithAppMetadata(canonicalized, { mode: 'visible-card' })
          if (row.sortBy === 'alphabetical') {
            results.sort((a, b) => a.title.localeCompare(b.title))
          }
          return results
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.SIMKL_LIST,
          ttlSeconds: null,
          queue: 'startup',
          revalidate: 'once-per-session',
          onStaleRefreshed: (fresh) => {
            if (!cancelled) {
              staleRefreshApplied = true
              const changed = catalogContentFingerprint(fresh) !== catalogContentFingerprint(memCacheGet(cacheKey) || [])
              memCacheSet(cacheKey, fresh)
              setItemsCacheKey(cacheKey)
              if (changed) setItems(fresh)
            }
          },
        })
        if (!cancelled) {
          const visible = staleRefreshApplied ? memCacheGet(cacheKey) || results : results
          setItems(visible)
          setItemsCacheKey(cacheKey)
          if (!staleRefreshApplied) memCacheSet(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(friendlyRowError(err, "Couldn't load this Simkl list right now."))
          setItemsCacheKey(cacheKey)
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [cacheKey, row.providerListId, row.sortBy, retryNonce, memCacheGet, memCacheSet])

  const currentItems = itemsCacheKey === cacheKey ? items : cached

  if ((loading || itemsCacheKey !== cacheKey) && !currentItems) {
    return (
      <MediaRowSkeleton
        title={getRowDisplayTitle(row)}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (itemsCacheKey === cacheKey && error) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message={error}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
        onRetry={() => { setError(null); setLoading(true); setRetryNonce((value) => value + 1) }}
      />
    )
  }

  if (!currentItems || currentItems.length === 0) {
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
      items={currentItems}
      layout={row.layout === 'landscape' || row.layout === 'ranked' || row.layout === 'feature' || row.layout === 'list' ? row.layout : 'poster'}
      showRank={row.layout === 'ranked'}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={currentItems.length >= 20}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function ProviderListRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = providerRowCacheKey(row)
  const memCacheGet = useHomeCatalogCache((state) => state.get)
  const memCacheSet = useHomeCatalogCache((state) => state.set)
  const cached = memCacheGet(cacheKey) || readHomeShelfStartupSnapshot(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [itemsCacheKey, setItemsCacheKey] = useState(cacheKey)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  useEffect(() => {
    setError(null)
    let cancelled = false
    let staleRefreshApplied = false
    const load = async () => {
      try {
        const fetcher = async () => {
          const results = await getProviderListItems(row, false, 40)
          if (row.sortBy === 'alphabetical') results.sort((a, b) => a.title.localeCompare(b.title))
          return results
        }
        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.PROVIDER_LIST,
          ttlSeconds: null,
          queue: 'startup',
          revalidate: 'once-per-session',
          onStaleRefreshed: (fresh) => {
            if (!cancelled) {
              staleRefreshApplied = true
              const changed = catalogContentFingerprint(fresh) !== catalogContentFingerprint(memCacheGet(cacheKey) || [])
              memCacheSet(cacheKey, fresh)
              setItemsCacheKey(cacheKey)
              if (changed) setItems(fresh)
            }
          },
        })
        if (!cancelled) {
          const visible = staleRefreshApplied ? memCacheGet(cacheKey) || results : results
          setItems(visible)
          setItemsCacheKey(cacheKey)
          if (!staleRefreshApplied) memCacheSet(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(friendlyRowError(err, "Couldn't load this list right now."))
          setItemsCacheKey(cacheKey)
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  // `row` is read only through the listed scalar fields; depending on its
  // object identity would refetch when an unrelated Home setting replaces it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, row.providerListId, row.sourceType, row.sortBy, retryNonce, memCacheGet, memCacheSet])

  const layout = row.layout === 'landscape' ? 'landscape' : 'poster'
  const currentItems = itemsCacheKey === cacheKey ? items : cached
  if ((loading || itemsCacheKey !== cacheKey) && !currentItems) return <MediaRowSkeleton title={getRowDisplayTitle(row)} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />
  if (itemsCacheKey === cacheKey && error) return <MediaRowError title={getRowDisplayTitle(row)} message={error} layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} onRetry={() => { setError(null); setLoading(true); setRetryNonce((value) => value + 1) }} />
  if (!currentItems || currentItems.length === 0) return <MediaRowError title={getRowDisplayTitle(row)} message="No items found in this list." layout={layout} headerLeftControls={headerLeftControls} headerRightControls={headerRightControls} />

  return (
    <MediaRow
      title={getRowDisplayTitle(row)}
      items={currentItems}
      layout={row.layout === 'landscape' || row.layout === 'ranked' || row.layout === 'feature' || row.layout === 'list' ? row.layout : 'poster'}
      disableArtOverride={false}
      showRank={row.layout === 'ranked'}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={currentItems.length >= 20}
    />
  )
}

function AddonCatalogRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const memCacheGet = useHomeCatalogCache((state) => state.get)
  const memCacheSet = useHomeCatalogCache((state) => state.set)
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  const addonUrl = addons.find((a) => a.enabled && a.manifest.id === row.addonId)?.url || row.addonUrl
  const cacheKey = addonRowCacheKey(row, addonUrl)
  const cached = memCacheGet(cacheKey) || readHomeShelfStartupSnapshot(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [itemsCacheKey, setItemsCacheKey] = useState(cacheKey)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  useEffect(() => {
    setError(null)
    let cancelled = false

    if (isMockCatalog && row.catalogId) {
      setItems(getMockCatalog(row.catalogId))
      setItemsCacheKey(cacheKey)
      setLoading(false)
      return
    }

    if (!row.catalogType || !row.catalogId) {
      setError('Shelf is unconfigured.')
      setItemsCacheKey(cacheKey)
      setLoading(false)
      return
    }

    if (!addonUrl) {
      setError('Addon not found or disabled.')
      setItemsCacheKey(cacheKey)
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        const fetcher = async () => {
          const firstPage = await getAddonCatalog(addonUrl, row.catalogType!, row.catalogId!, row.catalogExtra, row.addonId)
          // One addon page already fills a Home shelf. Fetching page 2 for every
          // visible row doubles startup traffic and can overwhelm self-hosted
          // addons; the full Catalog page retains on-demand pagination.
          return firstPage
        }
        // getAddonCatalog already owns the durable catalog cache. A second
        // cachedFetch here made first paint depend on two SQLite reads and two
        // writes; a stalled outer write left successful addon responses behind
        // skeletons. Publish the first page directly and persist the row only as
        // write-behind startup data.
        const results = await fetcher()
        if (!cancelled) {
          setItems(results)
          setItemsCacheKey(cacheKey)
          memCacheSet(cacheKey, results)
          setLoading(false)
          if (results.length > 0) {
            void cacheSet(cacheKey, results, { category: CACHE_CATEGORIES.ADDON_CATALOG, ttlSeconds: CACHE_TTLS.ADDON_CATALOG })
          }
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(friendlyRowError(err, "Couldn't load this catalog right now."))
          setItemsCacheKey(cacheKey)
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [cacheKey, isMockCatalog, addonUrl, row.addonId, row.catalogType, row.catalogId, row.catalogExtra, retryNonce, memCacheSet])

  const displayItems = itemsCacheKey === cacheKey
    ? (isMockCatalog && row.catalogId ? getMockCatalog(row.catalogId) : items)
    : cached

  if ((loading || itemsCacheKey !== cacheKey) && !displayItems) {
    return (
      <MediaRowSkeleton
        title={getRowDisplayTitle(row)}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (itemsCacheKey === cacheKey && error) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message={error}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
        onRetry={() => { setError(null); setLoading(true); setRetryNonce((value) => value + 1) }}
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
      layout={row.layout === 'landscape' || row.layout === 'ranked' || row.layout === 'feature' || row.layout === 'list' ? row.layout : 'poster'}
      showRank={row.layout === 'ranked'}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={sortedItems.length >= 20}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function DiscoverRow({ row, headerLeftControls, headerRightControls }: { row: HomeRowConfig; headerLeftControls?: React.ReactNode; headerRightControls?: React.ReactNode }) {
  const cacheKey = discoverRowCacheKey(row)
  const memCacheGet = useHomeCatalogCache((state) => state.get)
  const memCacheSet = useHomeCatalogCache((state) => state.set)
  const cached = memCacheGet(cacheKey) || readHomeShelfStartupSnapshot(cacheKey)
  const [items, setItems] = useState<SearchResult[] | null>(cached)
  const [itemsCacheKey, setItemsCacheKey] = useState(cacheKey)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  useEffect(() => {
    setError(null)
    let cancelled = false
    let staleRefreshApplied = false

    if (!row.discoverConfig) {
      setError('Shelf is unconfigured.')
      setItemsCacheKey(cacheKey)
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
          ttlSeconds: null,
          queue: 'startup',
          revalidate: 'once-per-session',
          onStaleRefreshed: (fresh) => {
            if (!cancelled) {
              staleRefreshApplied = true
              const changed = catalogContentFingerprint(fresh) !== catalogContentFingerprint(memCacheGet(cacheKey) || [])
              memCacheSet(cacheKey, fresh)
              setItemsCacheKey(cacheKey)
              if (changed) setItems(fresh)
            }
          },
        })
        if (!cancelled) {
          const visible = staleRefreshApplied ? memCacheGet(cacheKey) || results : results
          setItems(visible)
          setItemsCacheKey(cacheKey)
          if (!staleRefreshApplied) memCacheSet(cacheKey, results)
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(friendlyRowError(err, "Couldn't load recommendations right now."))
          setItemsCacheKey(cacheKey)
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [cacheKey, row.id, row.discoverConfig, retryNonce, memCacheGet, memCacheSet])

  const currentItems = itemsCacheKey === cacheKey ? items : cached

  if ((loading || itemsCacheKey !== cacheKey) && !currentItems) {
    return (
      <MediaRowSkeleton
        title={getRowDisplayTitle(row)}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
      />
    )
  }

  if (itemsCacheKey === cacheKey && error) {
    return (
      <MediaRowError
        title={getRowDisplayTitle(row)}
        message={error}
        layout={row.layout === 'landscape' ? 'landscape' : 'poster'}
        headerLeftControls={headerLeftControls}
        headerRightControls={headerRightControls}
        onRetry={() => { setError(null); setLoading(true); setRetryNonce((value) => value + 1) }}
      />
    )
  }

  if (!currentItems || currentItems.length === 0) {
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

  const sortedItems = [...currentItems]
  if (row.sortBy === 'alphabetical') {
    sortedItems.sort((a, b) => a.title.localeCompare(b.title))
  }

  return (
    <MediaRow
      title={getRowDisplayTitle(row)}
      items={sortedItems}
      layout={row.layout === 'landscape' || row.layout === 'ranked' || row.layout === 'feature' || row.layout === 'list' ? row.layout : 'poster'}
      showRank={row.layout === 'ranked'}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(getRowDisplayTitle(row))}`}
      forceShowAll={sortedItems.length >= 20}
      headerLeftControls={headerLeftControls}
      headerRightControls={headerRightControls}
    />
  )
}

function HeroCatalogSection({ row, onBackdropChange, focusedItem }: { row: HomeRowConfig; onBackdropChange?: (url: string | undefined) => void; focusedItem?: SearchResult | null }) {
  const memCacheGet = useHomeCatalogCache((state) => state.get)
  const memCacheSet = useHomeCatalogCache((state) => state.set)
  const addons = useAppStore((s) => s.addons)
  const addonUrl = addons.find((a) => a.enabled && a.manifest.id === row.addonId)?.url || row.addonUrl
  const cacheKey = heroRowCacheKey(row, addonUrl)
  const cached = memCacheGet(cacheKey) || readHeroStartupSnapshot(row, addonUrl)
  const [items, setItems] = useState<SearchResult[]>(cached || [])
  const [itemsCacheKey, setItemsCacheKey] = useState(cacheKey)
  const heroMode = useAppStore((s) => s.homeHeroMode)
  const heroSource = useAppStore((s) => s.fixedHeroSource)
  const manualItem = useAppStore((s) => s.fixedHeroManualItem)
  const recentlyWatched = useAppStore((s) => s.recentlyWatched)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  useEffect(() => {
    const snapshotProfileId = getActiveProfileId()
    let cancelled = false
    let staleRefreshApplied = false

    const load = async () => {
      try {
        if (isMockCatalog && row.catalogId) {
          const mockItems = getMockCatalog(row.catalogId)
          setItems(mockItems)
          setItemsCacheKey(cacheKey)
          writeHeroStartupSnapshot(row, mockItems, snapshotProfileId, addonUrl)
          return
        }

        const fetcher = async (): Promise<SearchResult[]> => {
          if (row.sourceType === 'simkl') {
            const listId = row.providerListId || 'watchlist'
            const rawResults = isSimklDerivedCatalogId(listId)
              ? await getSimklDerivedCatalogItems(listId)
              : (listId === 'history' ? await getSimklWatchedMovies() : await getSimklWatchStatusList(listId)).map(simklItemToSearchResult)
            return canonicalizeCatalogItemsWithTvdb(rawResults)
          } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'mdblist' || row.sourceType === 'anilist' || row.sourceType === 'jellyfin' || row.sourceType === 'webdav') {
            return getProviderListItems(row, false, 15)
          } else if (row.sourceType === 'discover') {
            if (row.discoverConfig) {
              const rawDiscover = await discoverTmdbWithCache(row.discoverConfig, row.id)
              const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
              return enrichSearchResultsWithAppMetadata(rawDiscover)
            }
            return []
          } else if (row.addonId) {
            if (addonUrl && row.catalogType && row.catalogId) {
              return getAddonCatalog(addonUrl, row.catalogType, row.catalogId, row.catalogExtra, row.addonId)
            }
            return []
          }
          return []
        }

        const results = await cachedFetch<SearchResult[]>(cacheKey, fetcher, {
          category: CACHE_CATEGORIES.ADDON_CATALOG,
          ttlSeconds: null,
          queue: 'startup',
          revalidate: 'once-per-session',
          priority: 'high',
          onStaleRefreshed: (fresh) => {
            if (!cancelled) {
              staleRefreshApplied = true
              const sorted = row.sortBy === 'alphabetical' ? [...fresh].sort((a, b) => a.title.localeCompare(b.title)) : fresh
              writeHeroStartupSnapshot(row, sorted, snapshotProfileId, addonUrl)
              memCacheSet(cacheKey, sorted)
              setItemsCacheKey(cacheKey)
              setItems((current) => catalogContentFingerprint(sorted) !== catalogContentFingerprint(current) ? sorted : current)
            }
          },
        })

        if (!cancelled && !staleRefreshApplied) {
          const sorted = row.sortBy === 'alphabetical' ? [...results].sort((a, b) => a.title.localeCompare(b.title)) : results
          memCacheSet(cacheKey, sorted)
          setItemsCacheKey(cacheKey)
          writeHeroStartupSnapshot(row, sorted, snapshotProfileId, addonUrl)
          setItems((current) => catalogContentFingerprint(sorted) !== catalogContentFingerprint(current) ? sorted : current)
        }
      } catch (e) {
        console.error('[HeroCatalogSection] Failed to load catalog items:', e)
      }
    }

    load()
    return () => { cancelled = true }
  // `row` is read through the listed fields and `cacheKey`; its object identity
  // changes for unrelated Home edits and must not trigger another provider fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    addonUrl,
    row.id,
    memCacheGet,
    memCacheSet
  ])

  if (heroMode === 'disabled') return null
  const currentItems = itemsCacheKey === cacheKey ? items : cached || []
  if (currentItems.length === 0) return null
  let heroItems = currentItems.filter((item) => Boolean(item.backdrop && item.backdrop !== item.poster))
  if (heroMode === 'fixed') {
    if (heroSource === 'manual' && manualItem?.backdrop && manualItem.backdrop !== manualItem.poster) heroItems = [manualItem]
    else if (heroSource === 'continue-watching') heroItems = recentlyWatched.filter((item) => Boolean(item.backdrop && item.backdrop !== item.poster))
    else if (heroSource === 'recently-added') heroItems = [...heroItems].sort((a, b) => (b.releaseDate || String(b.year || '')).localeCompare(a.releaseDate || String(a.year || '')))
    else if (heroSource === 'recommended') heroItems = heroItems.filter((item) => item.rating == null || item.rating >= 6.5).sort((a, b) => (b.rating || 0) - (a.rating || 0))
    const selectionKey = `aurales_fixed_hero_selection:${heroSource}`
    if (heroSource !== 'manual' && heroItems.length) {
      try {
        const cachedSelection = JSON.parse(localStorage.getItem(selectionKey) || 'null') as { item: SearchResult; expires: number } | null
        if (cachedSelection && cachedSelection.expires > Date.now() && cachedSelection.item.backdrop && cachedSelection.item.backdrop !== cachedSelection.item.poster) heroItems = [cachedSelection.item]
        else {
          const selected = heroItems[Math.floor(Math.random() * Math.min(heroItems.length, 8))]
          localStorage.setItem(selectionKey, JSON.stringify({ item: selected, expires: Date.now() + 12 * 60 * 60 * 1000 }))
          heroItems = [selected]
        }
      } catch { heroItems = heroItems.slice(0, 1) }
    }
    if (focusedItem?.backdrop && focusedItem.backdrop !== focusedItem.poster) heroItems = [focusedItem]
  }
  if (heroItems.length === 0) return null
  return <HeroSection items={heroItems} fixed={heroMode === 'fixed'} enableTrailers onActiveBackdropChange={onBackdropChange} onActiveImageSettled={markHeroImageSettled} />
}

// ── Staggered row renderer ─────────────────────────────────────────────────

function buildRowElement(row: HomeRowConfig): React.ReactNode {
  if (row.layout === 'continue') {
    return <ContinueWatchingRow key={row.id} row={row} />;
  } else if (row.layout === 'upcoming') {
    return <UpcomingHomeRow key={row.id} />;
  } else if (row.sourceType === 'simkl') {
    return <SimklRow key={row.id} row={row} />;
  } else if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'mdblist' || row.sourceType === 'anilist' || row.sourceType === 'jellyfin' || row.sourceType === 'webdav') {
    return <ProviderListRow key={row.id} row={row} />;
  } else if (row.sourceType === 'discover') {
    return <DiscoverRow key={row.id} row={row} />;
  } else if (row.addonId && row.addonId !== 'com.example.mockaddon') {
    return <AddonCatalogRow key={row.id} row={row} />;
  }
  return null
}

const INITIAL_VISIBLE = 3;
const ROW_ACTIVATION_GAP_MS = 90

type PendingRowActivation = { cancelled: boolean; activate: () => void }
const pendingRowActivations: PendingRowActivation[] = []
let rowActivationTimer: number | null = null

function drainRowActivationQueue() {
  rowActivationTimer = null
  const scheduler = (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling
  if (scheduler?.isInputPending?.()) {
    rowActivationTimer = window.setTimeout(drainRowActivationQueue, 48)
    return
  }

  let pending = pendingRowActivations.shift()
  while (pending?.cancelled) pending = pendingRowActivations.shift()
  pending?.activate()
  if (pendingRowActivations.length > 0) {
    rowActivationTimer = window.setTimeout(drainRowActivationQueue, ROW_ACTIVATION_GAP_MS)
  }
}

function scheduleRowActivation(activate: () => void): () => void {
  const pending: PendingRowActivation = { cancelled: false, activate }
  pendingRowActivations.push(pending)
  if (rowActivationTimer === null) {
    rowActivationTimer = window.setTimeout(drainRowActivationQueue, 0)
  }
  return () => { pending.cancelled = true }
}

const LazyRow = memo(function LazyRow({ row, isEditing, onRemove, eager, motionClass = '' }: { row: HomeRowConfig; isEditing: boolean; onRemove: (id: string) => void; eager?: boolean; motionClass?: string }) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const SortableHomeRow = useContext(HomeEditRowContext)
  // Keep a generous ahead-of-scroll buffer for shelves that are added after
  // the startup preloader yields, including very long custom Home layouts.
  const approaching = useVisibilityOnce(sentinelRef, { eager: eager ?? false, rootMargin: '1600px' })
  const [activated, setActivated] = useState(eager ?? false)

  useEffect(() => {
    if (activated) return
    if (eager) {
      setActivated(true)
      return
    }
    if (!approaching) return
    // A fast jump to the bottom can put several deferred shelves inside the
    // preload margin together. Mount one per short idle slice so their cards,
    // provider loaders and image decoders cannot monopolize the UI thread.
    return scheduleRowActivation(() => setActivated(true))
  }, [activated, approaching, eager])

  // Activation is intentionally one-way. Once a shelf is mounted, retain its
  // component, metadata and decoded image state for the rest of the session.
  // A proximity observer here would turn revisited shelves back into skeletons
  // and cancel their in-flight poster work during a fast vertical scroll.
  if (!activated) {
    return (
      <div ref={sentinelRef} className={`row-contain ${motionClass}`} data-fixed-hero-row>
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
    <div className={`row-contain ${motionClass}`} data-fixed-hero-row>
      <ErrorBoundary key={row.id} label={row.title}>
        {isEditing && SortableHomeRow
          ? <SortableHomeRow row={row} onRemove={onRemove}>{element}</SortableHomeRow>
          : element}
      </ErrorBoundary>
    </div>
  )
})

function StaggeredRows({ rows, isEditing, onRemove, fixed = false, activeIndex = 0, previousIndex = null, direction = 1 }: { rows: HomeRowConfig[]; isEditing: boolean; onRemove: (id: string) => void; fixed?: boolean; activeIndex?: number; previousIndex?: number | null; direction?: 1 | -1 }) {
  const [preloadRemainingRows, setPreloadRemainingRows] = useState(false)

  useEffect(() => {
    // Give the first paint an idle turn, then prepare exactly one shelf ahead.
    // Mounting every configured shelf here caused all of their poster batches
    // to decode at once on large Home layouts, freezing the WebView. The
    // generous LazyRow visibility margin activates subsequent shelves well
    // before they can be scrolled into view.
    const timer = window.setTimeout(() => setPreloadRemainingRows(true), 850)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="space-y-4">
      {rows.map((row, idx) => (
        <LazyRow
          key={row.id}
          row={row}
          isEditing={isEditing}
          onRemove={onRemove}
          eager={idx < INITIAL_VISIBLE || (preloadRemainingRows && idx === INITIAL_VISIBLE)}
          motionClass={!fixed ? 'fixed-hero-row-active' : idx === activeIndex ? `fixed-hero-row-active ${previousIndex != null ? `fixed-hero-row-enter-${direction > 0 ? 'up' : 'down'}` : ''}` : idx === previousIndex ? `fixed-hero-row-active fixed-hero-row-exit-${direction > 0 ? 'up' : 'down'}` : ''}
        />
      ))}
    </div>
  )
}

// ── Main Home Page Component ────────────────────────────────────────────────
export default function HomePage() {
  const homeRootRef = useRef<HTMLDivElement>(null)
  // Do not subscribe Home to the entire app store. Playback progress, player
  // state and background sync update frequently; subscribing here used to
  // re-render every shelf and card for each unrelated store change.
  const homeRows = useAppStore((state) => state.homeRows)
  const reorderHomeRows = useAppStore((state) => state.reorderHomeRows)
  const removeHomeRow = useAppStore((state) => state.removeHomeRow)
  const resetHomeRows = useAppStore((state) => state.resetHomeRows)
  const cinematic = useAppStore((state) => state.interfaceTheme === 'cinematic')
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isEditing = searchParams.get('edit') === 'true';
  const [heroBackdrop, setHeroBackdrop] = useState<string | undefined>(undefined)
  const homeHeroMode = useAppStore((s) => s.homeHeroMode)
  const homeCardAnimations = useAppStore((s) => s.homeCardAnimations)
  const handleBackdropChange = useCallback((url: string | undefined) => setHeroBackdrop(url), [])
  const usesTopNav = useAppStore((s) => s.navigationStyle) === 'topbar'

  useEffect(() => {
    if (SERVER_INTEGRATIONS_ENABLED || !homeRows.some((row) => row.enabled && (row.sourceType === 'jellyfin' || row.sourceType === 'webdav'))) return
    // Preserve the configured shelf records, but persist them as disabled so
    // they cannot return through profile hydration or sync while the feature
    // is parked.
    useAppStore.getState().setHomeRows(homeRows.map((row) => (
      row.sourceType === 'jellyfin' || row.sourceType === 'webdav'
        ? { ...row, enabled: false }
        : row
    )))
  }, [homeRows])

  useEffect(() => {
    if (!homeRows.some((row) => row.enabled && row.layout === 'continue')) markContinueWatchingSettled()
  }, [homeRows])

  const [focusedHeroItem, setFocusedHeroItem] = useState<SearchResult | null>(null)
  const [activeShelfIndex, setActiveShelfIndex] = useState(() => {
    const savedId = getHomeShelfId()
    if (!savedId) return 0
    return Math.max(0, homeRows.filter((row) => row.enabled && row.layout !== 'hero' && (SERVER_INTEGRATIONS_ENABLED || (row.sourceType !== 'jellyfin' && row.sourceType !== 'webdav'))).sort((a, b) => a.order - b.order).findIndex((row) => row.id === savedId))
  })
  const [previousShelfIndex, setPreviousShelfIndex] = useState<number | null>(null)
  const [shelfDirection, setShelfDirection] = useState<1 | -1>(1)
  const activeShelfRef = useRef(activeShelfIndex)

  useEffect(() => {
    const row = homeRows.filter((item) => item.enabled && item.layout !== 'hero' && (SERVER_INTEGRATIONS_ENABLED || (item.sourceType !== 'jellyfin' && item.sourceType !== 'webdav'))).sort((a, b) => a.order - b.order)[activeShelfIndex]
    if (row) rememberHomeShelfId(row.id)
  }, [activeShelfIndex, homeRows])

  useEffect(() => {
    // Fixed Focus always hands the active shelf item to the hero. The motion
    // preference only decides whether that handoff is animated; it must never
    // disable selection, artwork replacement, or the focused metadata itself.
    if (homeHeroMode !== 'fixed') { setFocusedHeroItem(null); return }
    const handleFocus = (event: Event) => {
      const item = (event as CustomEvent<SearchResult>).detail
      setFocusedHeroItem(item)
      if (item.backdrop && item.backdrop !== item.poster) setHeroBackdrop(item.backdrop)
    }
    window.addEventListener('aurales:media-focus', handleFocus)
    return () => window.removeEventListener('aurales:media-focus', handleFocus)
  }, [homeHeroMode])

  useEffect(() => {
    if (homeHeroMode !== 'fixed' || isEditing) return
    const scrollContainer = homeRootRef.current?.closest('main') as HTMLElement | null
    if (!scrollContainer) return
    let locked = false
    let settleTimer = 0
    const transitionTo = (index: number, direction: 1 | -1) => {
      if (locked) return
      locked = true
      setPreviousShelfIndex(activeShelfRef.current)
      setShelfDirection(direction)
      activeShelfRef.current = index
      setActiveShelfIndex(index)
      settleTimer = window.setTimeout(() => { setPreviousShelfIndex(null); locked = false }, 520)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (locked) { event.preventDefault(); return }
      if (Math.abs(event.deltaY) < 10) return
      event.preventDefault()
      const rows = Array.from(homeRootRef.current?.querySelectorAll<HTMLElement>('[data-fixed-hero-row]') || [])
      if (!rows.length) return
      const next = Math.max(0, Math.min(activeShelfRef.current + (event.deltaY > 0 ? 1 : -1), rows.length - 1))
      if (next === activeShelfRef.current) return
      transitionTo(next, event.deltaY > 0 ? 1 : -1)
    }
    scrollContainer.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      scrollContainer.removeEventListener('wheel', onWheel)
      window.clearTimeout(settleTimer)
    }
  }, [homeHeroMode, isEditing])

  // Batch-load every shelf's sqlite cache entry in a single IPC call and seed
  // the in-memory cache, so all rows paint instantly instead of each doing its
  // own roundtrip (and flashing a skeleton) on mount.
  const [cachePreloaded, setCachePreloaded] = useState(() => {
    const state = useHomeCatalogCache.getState()
    const rows = useAppStore.getState().homeRows
      .filter((row) => row.enabled)
      .sort((a, b) => a.order - b.order)
    const visibleKeys = rows.filter((row) => row.layout !== 'hero' && row.layout !== 'continue').slice(0, 3).map((row) => cacheKeyForHomeRow(row, useAppStore.getState().addons)).filter((key): key is string => !!key)
    const hasCachedShelf = visibleKeys.some((key) => state.get(key) || readHomeShelfStartupSnapshot(key))
    const store = useAppStore.getState()
    const hasCachedContinue = rows.some((row) => row.layout === 'continue') && Boolean(readContinueWatchingStartupSnapshot(
      store.primaryProgressProvider,
      getContinueWatchingAccountScope(store.primaryProgressProvider),
      store.continueWatchingLimit,
    ))
    return hasCachedShelf || hasCachedContinue
  })
  const initiallyPreloadedRef = useRef(cachePreloaded)

  useEffect(() => {
    const snapshotProfileId = getActiveProfileId()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = null
      writeHomeShelfStartupSnapshots(
        homeRows,
        (key) => useHomeCatalogCache.getState().get(key),
        snapshotProfileId,
        (row) => cacheKeyForHomeRow(row, useAppStore.getState().addons),
      )
    }
    const unsubscribe = useHomeCatalogCache.subscribe(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 250)
    })
    window.addEventListener('pagehide', flush)
    return () => { unsubscribe(); window.removeEventListener('pagehide', flush); if (timer) flush() }
  }, [homeRows])

  useEffect(() => {
    if (!cachePreloaded) return
    markPerformance('home-content-visible')
    measurePerformance('shell-to-home-content', 'app-shell-visible', 'home-content-visible')
  }, [cachePreloaded])
  useEffect(() => {
    let cancelled = false
    const hydrationStartedAt = performance.now()
    // Cache hydration is an optimization, not a prerequisite for Home. A
    // delayed SQLite IPC must never leave every shelf behind permanent
    // skeletons; mount the row loaders after a short bounded wait.
    const hydrationFallback = initiallyPreloadedRef.current ? null : window.setTimeout(() => {
      if (!cancelled) setCachePreloaded(true)
    }, 1200)
    const state = useHomeCatalogCache.getState()
    const keys = useAppStore.getState().homeRows
      .filter((row) => row.enabled)
      .map((row) => cacheKeyForHomeRow(row, useAppStore.getState().addons))
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
      .finally(() => {
        if (hydrationFallback) window.clearTimeout(hydrationFallback)
        if (import.meta.env.DEV) console.debug(`[PERF] Home cache hydration ${Math.round(performance.now() - hydrationStartedAt)}ms`)
        if (!cancelled) setCachePreloaded(true)
      })

    return () => {
      cancelled = true
      if (hydrationFallback) window.clearTimeout(hydrationFallback)
    }
  }, [])

  // Fixed Focus always has one authoritative selection. Moving to another
  // shelf focuses its first card, which updates the full-screen artwork and
  // opens the inline metadata panel without requiring an initial mouse move.
  useEffect(() => {
    if (homeHeroMode !== 'fixed' || isEditing || !cachePreloaded) return
    const focusTimer = window.setTimeout(() => {
      const firstCard = homeRootRef.current?.querySelector<HTMLElement>('.fixed-hero-row-active :is(.cinematic-row-track, .cw-track) > button')
      if (!firstCard) {
        const rows = Array.from(homeRootRef.current?.querySelectorAll<HTMLElement>('[data-fixed-hero-row]') || [])
        const firstPopulatedShelf = rows.findIndex((row) => row.querySelector(':is(.cinematic-row-track, .cw-track) > button'))
        if (firstPopulatedShelf >= 0 && firstPopulatedShelf !== activeShelfRef.current) {
          activeShelfRef.current = firstPopulatedShelf
          setPreviousShelfIndex(null)
          setActiveShelfIndex(firstPopulatedShelf)
        }
        return
      }
      firstCard?.focus({ preventScroll: true })
    }, 120)
    return () => window.clearTimeout(focusTimer)
  }, [activeShelfIndex, cachePreloaded, homeHeroMode, isEditing])

  // Startup stream prediction must not compete with Home's initial cache
  // hydration or first paint. ContinueWatchingRow independently marks its
  // enrichment complete; the manager starts only after both gates and idle.
  useEffect(() => {
    if (!cachePreloaded) return
    let cancelled = false
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!cancelled) streamPreloadManager.markHomeReady()
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
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

  const serverRowEnabled = (row: HomeRowConfig) => SERVER_INTEGRATIONS_ENABLED || (row.sourceType !== 'jellyfin' && row.sourceType !== 'webdav')
  const enabledRows = homeRows.filter((row) => row.enabled && serverRowEnabled(row));
  const heroRow = homeRows.find((row) => row.layout === 'hero' && row.enabled && serverRowEnabled(row));

  // Only allow reordering visible content shelves
  const activeRows = enabledRows
    .filter((row) => row.layout !== 'hero')
    .sort((a, b) => a.order - b.order);

  const handleReorder = (activeId: string, overId: string) => {
    const oldIndex = activeRows.findIndex((row) => row.id === activeId)
    const newIndex = activeRows.findIndex((row) => row.id === overId)
    if (oldIndex < 0 || newIndex < 0) return
    const reorderedActive = [...activeRows]
    const [moved] = reorderedActive.splice(oldIndex, 1)
    reorderedActive.splice(newIndex, 0, moved)

    // Reconstruct the full list preserving hero and disabled shelves.
    const hero = homeRows.find((row) => row.layout === 'hero')
    const disabled = homeRows.filter((row) => !row.enabled)
    reorderHomeRows([...(hero ? [hero] : []), ...reorderedActive, ...disabled])
  }

  const shelvesContent = cachePreloaded ? (
    <StaggeredRows rows={activeRows} isEditing={isEditing} onRemove={removeHomeRow} fixed={homeHeroMode === 'fixed' && !isEditing} activeIndex={activeShelfIndex} previousIndex={previousShelfIndex} direction={shelfDirection} />
  ) : (
    <div className="space-y-8">
      {activeRows.slice(0, 3).map((row) => (
        <MediaRowSkeleton key={row.id} title={getRowDisplayTitle(row)} layout={row.layout === 'landscape' ? 'landscape' : 'poster'} />
      ))}
    </div>
  );

  return (
    <div ref={homeRootRef} data-home-card-motion={homeCardAnimations ? 'on' : 'off'} className={`pb-12 relative ${homeHeroMode === 'fixed' && !isEditing ? 'fixed-hero-home' : ''} ${homeHeroMode === 'disabled' && usesTopNav ? 'pt-24' : ''}`}>

      <CatalogKeyNotice />

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

      {heroRow && homeHeroMode !== 'disabled' && <HeroCatalogSection row={heroRow} focusedItem={focusedHeroItem} onBackdropChange={handleBackdropChange} />}

      {activeRows.length === 0 && !heroRow ? (
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
          <div data-home-shelves className="relative z-10" style={{ marginTop: heroRow && homeHeroMode !== 'disabled' ? (cinematic ? '24px' : '-40px') : undefined }}>
            {isEditing ? (
              <Suspense fallback={shelvesContent}>
                <HomeEditList rows={activeRows} onReorder={handleReorder}>{shelvesContent}</HomeEditList>
              </Suspense>
            ) : shelvesContent}
          </div>
        </>
      )}
    </div>
  );
}
