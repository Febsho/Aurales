import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router-dom'
import MediaCard from '../components/MediaCard'
import { EmptyState } from '../components/ui'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import { useCatalogStore } from '../stores/catalogStore'
import type { SearchResult } from '../types'
import { discoverTmdb, discoverTmdbWithCache, DISCOVER_ROW_LIMIT, DISCOVER_ROW_PAGES } from '../services/tmdb'
import { getProviderListItems } from '../services/providerLists'
import { SERVICE_PROVIDER_MAP } from './DiscoverPage'
import WatchlistButton from '../components/WatchlistButton'
import { dedupeMediaItems, mediaIdentity } from '../services/mediaPresentation'

export default function CatalogPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const navigationType = useNavigationType()
  const { rowId } = useParams<{ rowId: string }>()
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const homeRows = useAppStore((s) => s.homeRows)
  const addons = useAppStore((s) => s.addons)
  const catalogSetCache = useCatalogStore((s) => s.setCache)
  const catalogGetCache = useCatalogStore((s) => s.getCache)
  const pageRef = useRef(0)
  const restoredRef = useRef(false)
  const loadMoreRef = useRef<(() => void) | null>(null)

  const region = useAppStore((s) => s.discoveryRegion)
  const minRating = useAppStore((s) => s.discoveryMinRating)
  const includeAdult = useAppStore((s) => s.discoveryIncludeAdult)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const [focusedItem, setFocusedItem] = useState<SearchResult | null>(null)

  const row = useMemo(() => {
    const candidate = homeRows.find((r) => r.id === rowId)
    if (candidate) return candidate

    if (rowId?.startsWith('discover-provider-')) {
      const parts = rowId.split('-') // ['discover', 'provider', providerName, contentType]
      const providerName = parts[2]
      const contentType = parts[3] as 'movie' | 'series'
      const mapping = SERVICE_PROVIDER_MAP[providerName]
      const selectedProviders = mapping ? mapping.ids.map(id => ({ id, name: mapping.name })) : []

      return {
        id: rowId,
        title: `${providerName} ${contentType === 'movie' ? 'Movies' : 'Series'}`,
        sourceType: 'discover' as const,
        discoverConfig: {
          source: 'TMDB' as const,
          contentType: contentType,
          sortBy: 'popularity.desc',
          cacheTtl: 43200,
          releasedOnly: true,
          includeAdult,
          includeGenres: [],
          excludeGenres: [],
          genreMatchMode: 'OR' as const,
          originalLanguage: '',
          releaseRegion: region,
          people: [],
          peopleMatchMode: 'OR' as const,
          includeCompanies: [],
          excludeCompanies: [],
          companyMatchMode: 'OR' as const,
          includeKeywords: [],
          excludeKeywords: [],
          keywordMatchMode: 'OR' as const,
          watchRegion: region,
          providerMatchMode: 'OR' as const,
          selectedProviders,
          voteAverageMin: minRating,
          voteAverageMax: 10,
          voteCountMin: 50,
        }
      }
    }
    return undefined
  }, [rowId, homeRows, region, minRating, includeAdult])

  const title = searchParams.get('title') || row?.title || 'Catalog'
  const posterSize = useAppStore((s) => s.posterSize)

  const gridMinMax = useMemo(() => {
    switch (posterSize) {
      case 'compact': return 'minmax(112px, 1fr)'
      case 'large': return 'minmax(176px, 1fr)'
      case 'huge': return 'minmax(208px, 1fr)'
      case 'default':
      default:
        return 'minmax(140px, 1fr)'
    }
  }, [posterSize])

  const saveScrollPosition = useCallback(() => {
    // Never overwrite a seeded/filled cache with an empty snapshot (stale cleanup runs
    // fire with the previous render's state)
    if (!rowId || items.length === 0) return
    const scrollRoot = document.querySelector('main') || document.documentElement
    catalogSetCache(rowId, {
      items,
      page: pageRef.current,
      hasMore,
      scrollTop: scrollRoot.scrollTop,
    })
  }, [rowId, items, hasMore, catalogSetCache])

  useEffect(() => {
    return () => { saveScrollPosition() }
  }, [saveScrollPosition])

  useEffect(() => {
    if (!rowId) return
    restoredRef.current = false
    loadMoreRef.current = null

    const cached = catalogGetCache(rowId)
    const restoredCache = cached && cached.items.length > 0 ? cached : null
    if (restoredCache) {
      setItems(restoredCache.items)
      setHasMore(restoredCache.hasMore)
      pageRef.current = restoredCache.page
      setLoading(false)
      restoredRef.current = true
      // Restore the saved scroll only when returning via back/forward (POP). Opening
      // "Show all" is a fresh PUSH and must start at the top, like Home.
      const targetScroll = navigationType === 'POP' ? restoredCache.scrollTop : 0
      requestAnimationFrame(() => {
        const scrollRoot = document.querySelector('main') || document.documentElement
        scrollRoot.scrollTop = targetScroll
      })
      if (!restoredCache.hasMore) return
    }

    if (!restoredCache) {
      setLoading(true)
      setLoadingMore(false)
      setHasMore(false)
      setItems([])
      pageRef.current = 0

    // Fresh catalog (not a cache restore): start at the top. The shared <main>
    // scroll container otherwise keeps the scroll offset from the previous page.
      const scrollRootReset = document.querySelector('main') || document.documentElement
      scrollRootReset.scrollTop = 0

    // Rows without a config (e.g. Discover's computed sections) pass their items
    // through navigation state — more reliable than the seeded cache alone
      const stateItems = (location.state as { showAllItems?: SearchResult[] } | null)?.showAllItems
      if (!row && stateItems && stateItems.length > 0) {
        setItems(stateItems)
        setHasMore(false)
        setLoading(false)
        return
      }

      if (!row) {
        setLoading(false)
        return
      }
    }

    // ─── Discover Row loading ───
    // A cached partial catalog can outlive its source row. Keep those items
    // visible, but do not fetch another page without its source configuration.
    if (!row) {
      setLoading(false)
      return
    }

    if (row.sourceType === 'discover') {
      if (!row.discoverConfig) {
        setLoading(false)
        return
      }

      let cancelled = false
      let page = restoredCache ? Math.max(1, restoredCache.page) : 1
      let loadingPage = false
      let canLoadMore = true
      let scrollFrame = 0
      const scrollRoot = document.querySelector('main') || document.documentElement

      const loadNextPage = async (initial = false) => {
        if (loadingPage || !canLoadMore || cancelled) return
        loadingPage = true
        if (initial) {
          setLoading(true)
        } else {
          setLoadingMore(true)
        }

        try {
          const isFirst = page === 1
          const results = isFirst
            ? await discoverTmdbWithCache(row.discoverConfig!, `catalog-${rowId}-p${page}`)
            : await discoverTmdb(row.discoverConfig!, page)
          if (cancelled) return

          const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
          const enriched = await enrichSearchResultsWithAppMetadata(results)
          if (cancelled) return

          if (enriched.length === 0 || enriched.length < (isFirst ? DISCOVER_ROW_LIMIT : 20)) {
            canLoadMore = false
            setHasMore(false)
          } else {
            // First load covers TMDB pages 1-DISCOVER_ROW_PAGES via the cached row
            page = isFirst ? DISCOVER_ROW_PAGES + 1 : page + 1
            pageRef.current = page
            setHasMore(true)
          }

          if (enriched.length > 0) {
            setItems((current) => dedupeMediaItems([...current, ...enriched]))
          }
        } catch (_) {
          canLoadMore = false
          setHasMore(false)
        } finally {
          loadingPage = false
          if (initial) {
            setLoading(false)
          } else {
            setLoadingMore(false)
          }
        }

        if (canLoadMore && !cancelled) {
          scheduleScrollCheck()
        }
      }

      const onScroll = () => {
        const distanceFromBottom = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight
        if (distanceFromBottom < 900) loadNextPage(false)
      }
      const scheduleScrollCheck = () => {
        cancelAnimationFrame(scrollFrame)
        scrollFrame = requestAnimationFrame(onScroll)
      }

      loadMoreRef.current = () => loadNextPage(false)
      if (restoredCache) scheduleScrollCheck()
      else loadNextPage(true).then(() => { if (!cancelled) scheduleScrollCheck() })
      scrollRoot.addEventListener('scroll', scheduleScrollCheck, { passive: true })

      return () => {
        cancelled = true
        cancelAnimationFrame(scrollFrame)
        loadMoreRef.current = null
        scrollRoot.removeEventListener('scroll', scheduleScrollCheck)
      }
    }

    if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'pmdb-picks' || row.sourceType === 'mdblist' || row.sourceType === 'anilist') {
      let cancelled = false
      getProviderListItems(row)
        .then((results) => {
          if (!cancelled) setItems(results)
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => { cancelled = true }
    }

    // ─── Standard Presets/Addons loading ───
    if (!row.catalogId) {
      setLoading(false)
      return
    }

    if (row.catalogId.startsWith('mock-')) {
      setItems(getMockCatalog(row.catalogId))
      setLoading(false)
      return
    }

    const addon = addons.find((candidate) => candidate.manifest.id === row.addonId)
    const url = addon?.url || row.addonUrl
    if (!url || !row.catalogType) {
      setLoading(false)
      return
    }

    let cancelled = false
    let page = restoredCache ? Math.max(0, restoredCache.page) : 0
    let loadingPage = false
    let canLoadMore = true
    const seen = new Set<string>((restoredCache?.items || []).map(mediaIdentity))
    const pageSize = 20
    let scrollFrame = 0
    const scrollRoot = document.querySelector('main') || document.documentElement

    const loadNextPage = async (initial = false) => {
      if (loadingPage || !canLoadMore || cancelled) return
      loadingPage = true
      if (initial) {
        setLoading(true)
      } else {
        setLoadingMore(true)
      }

      try {
        const skip = page * pageSize
        const results = await getAddonCatalog(url, row.catalogType!, row.catalogId!, {
          ...(row.catalogExtra || {}),
          skip: String(skip),
        }, row.addonId)

        if (cancelled) return

        const unique = results.filter((item) => {
          const identity = mediaIdentity(item)
          if (seen.has(identity)) return false
          seen.add(identity)
          return true
        })

        if (results.length === 0 || unique.length === 0 || results.length < pageSize) {
          canLoadMore = false
          setHasMore(false)
        } else {
          page += 1
          pageRef.current = page
          setHasMore(true)
        }

        if (unique.length > 0) {
          setItems((current) => [...current, ...unique])
        }
      } catch (_) {
        canLoadMore = false
        setHasMore(false)
      } finally {
        loadingPage = false
        if (initial) {
          setLoading(false)
        } else {
          setLoadingMore(false)
        }
      }

      if (canLoadMore && !cancelled) {
        scheduleScrollCheck()
      }
    }

    const onScroll = () => {
      const distanceFromBottom = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight
      if (distanceFromBottom < 900) loadNextPage(false)
    }
    const scheduleScrollCheck = () => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(onScroll)
    }

    loadMoreRef.current = () => loadNextPage(false)
    if (restoredCache) scheduleScrollCheck()
    else loadNextPage(true).then(() => { if (!cancelled) scheduleScrollCheck() })
    scrollRoot.addEventListener('scroll', scheduleScrollCheck, { passive: true })

    return () => {
      cancelled = true
      cancelAnimationFrame(scrollFrame)
      loadMoreRef.current = null
      scrollRoot.removeEventListener('scroll', scheduleScrollCheck)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, addons])

  return (
    <div className={`p-6 pb-12 ${cinematic ? 'px-8' : ''}`}>
      <div className="mb-6">
        <p className="text-sm uppercase tracking-[0.24em] text-muted mb-2">Catalog</p>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {!loading && items.length > 0 && (
          <p className="text-sm text-muted mt-2">{items.length} titles loaded</p>
        )}
      </div>

      {loading ? (
        <div className="grid gap-5 animate-pulse" style={{ gridTemplateColumns: `repeat(auto-fill, ${gridMinMax})`, contain: 'layout style' }}>
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i}>
              <div className="aspect-[2/3] rounded-2xl bg-white/[0.06]" />
              <div className="h-3 bg-white/[0.04] rounded-md mt-2.5 w-3/4" />
              <div className="h-3 bg-white/[0.04] rounded-md mt-1.5 w-1/3" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" strokeLinecap="round" /></svg>}
          title="Nothing to show here"
          description="This catalog didn't return any titles. It may be temporarily unavailable — try again in a moment."
        />
      ) : (
        <>
          {false && cinematic && (focusedItem || items[0]) && (() => {
            const preview = focusedItem || items[0]
            const open = (autoPlay = false) => navigate(preview.type === 'movie' ? `/movie/${preview.id}` : `/series/${preview.id}`, { state: { ...preview, autoPlay } })
            return <div className="cinematic-focus-panel relative mb-8 min-h-[280px] overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.05]">
              {(preview.backdrop || preview.poster) && <img src={preview.backdrop || preview.poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />}
              <div className="absolute inset-0 bg-gradient-to-r from-black via-black/75 to-transparent" />
              <div className="relative z-10 flex min-h-[280px] max-w-2xl flex-col justify-end p-8">
                {preview.logo ? <img src={preview.logo} alt={preview.title} className="mb-3 max-h-16 max-w-sm object-contain object-left" /> : <h2 className="text-4xl font-black">{preview.title}</h2>}
                <div className="my-3 flex flex-wrap gap-2">{preview.rating != null && <span className="cinematic-pill">★ {Number(preview.rating).toFixed(1)}</span>}{preview.year && <span className="cinematic-pill">{preview.year}</span>}{preview.genres?.slice(0, 2).map((genre) => <span key={genre} className="cinematic-pill">{genre}</span>)}</div>
                {preview.overview && <p className="mb-5 line-clamp-2 text-white/70">{preview.overview}</p>}
                <div className="flex gap-3"><button onClick={() => open(true)} className="focus-ring rounded-full bg-white px-6 py-2.5 font-black text-black">Play</button><button onClick={() => open(false)} className="focus-ring rounded-full bg-white/15 px-6 py-2.5 font-bold text-white">More Info</button><WatchlistButton mediaRef={{ localId: preview.id, title: preview.title, year: preview.year, type: preview.isAnime ? 'anime' : preview.type === 'series' ? 'show' : 'movie', imdbId: preview.imdbId, tmdbId: preview.tmdbId ? Number(preview.tmdbId) : undefined }} mediaType={preview.type} anilistId={preview.anilistId} malId={preview.malId} tvdbId={preview.tvdbId} /></div>
              </div>
            </div>
          })()}
          <div className={cinematic ? 'flex flex-wrap items-start gap-5' : 'grid gap-5'} style={cinematic ? undefined : { gridTemplateColumns: `repeat(auto-fill, ${gridMinMax})`, contain: 'layout style' }}>
            {items.map((item) => (
              <MediaCard
                key={item.id}
                item={item}
                layout="poster"
                disableTrailerPreview
                cinematicMode={cinematic}
                cinematicFocused={cinematic && focusedItem?.id === item.id}
                cinematicExpand={false}
                onFocusItem={cinematic ? setFocusedItem : undefined}
                onUnfocusItem={cinematic ? (unfocused) => setFocusedItem((current) => current?.id === unfocused.id ? null : current) : undefined}
              />
            ))}
          </div>
          {loadingMore && (
            <div className="flex justify-center py-10">
              <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {hasMore && !loadingMore && (
            <div className="flex justify-center py-10">
              <button
                type="button"
                onClick={() => loadMoreRef.current?.()}
                className="rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10"
              >
                Load more
              </button>
            </div>
          )}
          {!hasMore && items.length > 0 && (
            <p className="py-10 text-center text-sm text-muted">End of catalog</p>
          )}
        </>
      )}
    </div>
  )
}
