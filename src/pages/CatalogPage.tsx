import { useEffect, useState, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import MediaCard from '../components/MediaCard'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import type { SearchResult } from '../types'
import { discoverTmdb } from '../services/tmdb'
import { getProviderListItems } from '../services/providerLists'

export default function CatalogPage() {
  const { rowId } = useParams<{ rowId: string }>()
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const homeRows = useAppStore((s) => s.homeRows)
  const addons = useAppStore((s) => s.addons)
  const row = homeRows.find((candidate) => candidate.id === rowId)
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

  useEffect(() => {
    setLoading(true)
    setLoadingMore(false)
    setHasMore(false)
    setItems([])

    if (!row) {
      setLoading(false)
      return
    }

    // ─── Discover Row loading ───
    if (row.sourceType === 'discover') {
      if (!row.discoverConfig) {
        setLoading(false)
        return
      }

      let cancelled = false
      let page = 1
      let loadingPage = false
      let canLoadMore = true
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
          const results = await discoverTmdb(row.discoverConfig!, page)
          if (cancelled) return

          const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
          const enriched = await enrichSearchResultsWithAppMetadata(results)
          if (cancelled) return

          if (enriched.length === 0 || enriched.length < 20) {
            canLoadMore = false
            setHasMore(false)
          } else {
            page += 1
            setHasMore(true)
          }

          if (enriched.length > 0) {
            setItems((current) => {
              const merged = [...current, ...enriched]
              return merged.filter((item, idx, self) => self.findIndex(i => i.id === item.id) === idx)
            })
          }
        } catch {
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
          window.setTimeout(onScroll, 0)
        }
      }

      const onScroll = () => {
        const distanceFromBottom = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight
        if (distanceFromBottom < 900) loadNextPage(false)
      }

      loadNextPage(true).then(() => {
        if (!cancelled) window.setTimeout(onScroll, 0)
      })
      scrollRoot.addEventListener('scroll', onScroll, { passive: true })

      return () => {
        cancelled = true
        scrollRoot.removeEventListener('scroll', onScroll)
      }
    }

    if (row.sourceType === 'trakt' || row.sourceType === 'pmdb' || row.sourceType === 'anilist') {
      let cancelled = false
      getProviderListItems(row)
        .then((results) => {
          if (!cancelled) setItems(results)
        })
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
    let page = 0
    let loadingPage = false
    let canLoadMore = true
    const seen = new Set<string>()
    const pageSize = 20
    const scrollRoot = document.querySelector('main') || document.documentElement

    const loadNextPage = async (initial = false) => {
      if (loadingPage || !canLoadMore || cancelled) return
      loadingPage = true
      if (initial) {
        setLoading(true)
      } else {
        setLoadingMore(true)
      }

      const skip = page * pageSize
      const results = await getAddonCatalog(url, row.catalogType!, row.catalogId!, {
        ...(row.catalogExtra || {}),
        skip: String(skip),
      }, row.addonId)

      if (cancelled) return

      const unique = results.filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })

      if (results.length === 0 || unique.length === 0 || results.length < pageSize) {
        canLoadMore = false
        setHasMore(false)
      } else {
        page += 1
        setHasMore(true)
      }

      if (unique.length > 0) {
        setItems((current) => [...current, ...unique])
      }

      loadingPage = false
      if (initial) {
        setLoading(false)
      } else {
        setLoadingMore(false)
      }

      if (canLoadMore && !cancelled) {
        window.setTimeout(onScroll, 0)
      }
    }

    const onScroll = () => {
      const distanceFromBottom = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight
      if (distanceFromBottom < 900) loadNextPage(false)
    }

    loadNextPage(true).then(() => {
      if (!cancelled) window.setTimeout(onScroll, 0)
    })
    scrollRoot.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelled = true
      scrollRoot.removeEventListener('scroll', onScroll)
    }
  }, [row, addons])

  return (
    <div className="p-6 pb-12">
      <div className="mb-6">
        <p className="text-sm uppercase tracking-[0.24em] text-muted mb-2">Catalog</p>
        <h1 className="text-3xl font-bold">{title}</h1>
        {!loading && (
          <p className="text-sm text-muted mt-2">{items.length} titles loaded</p>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid gap-5" style={{ gridTemplateColumns: `repeat(auto-fill, ${gridMinMax})` }}>
            {items.map((item) => (
              <MediaCard key={item.id} item={item} disableArtOverride={true} />
            ))}
          </div>
          {loadingMore && (
            <div className="flex justify-center py-10">
              <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
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
