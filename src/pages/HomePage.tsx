import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import { MOCK_HERO_MOVIE, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import type { SearchResult, HomeRowConfig } from '../types'

function AddonCatalogRow({ row }: { row: HomeRowConfig }) {
  const [items, setItems] = useState<SearchResult[]>([])
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')
  const displayItems = isMockCatalog && row.catalogId ? getMockCatalog(row.catalogId) : items

  useEffect(() => {
    if (isMockCatalog || !row.catalogType || !row.catalogId) return

    const addon = addons.find((a) => a.manifest.id === row.addonId)
    const url = addon?.url || row.addonUrl
    if (!url) return

    let cancelled = false
    getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra)
      .then((results) => {
        if (cancelled) return
        setItems(results)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [isMockCatalog, row.addonId, row.addonUrl, row.catalogType, row.catalogId, row.catalogExtra, addons])

  if (displayItems.length === 0) return null

  return (
    <MediaRow
      title={row.title}
      items={displayItems}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
      showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
    />
  )
}

function HeroCatalogSection({ row }: { row: HomeRowConfig }) {
  const [item, setItem] = useState<SearchResult | null>(null)
  const addons = useAppStore((s) => s.addons)
  const isMockCatalog = row.catalogId?.startsWith('mock-')

  useEffect(() => {
    if (isMockCatalog && row.catalogId) {
      setItem(getMockCatalog(row.catalogId)[0] || null)
      return
    }

    if (!row.catalogType || !row.catalogId) return
    const addon = addons.find((a) => a.manifest.id === row.addonId)
    const url = addon?.url || row.addonUrl
    if (!url) return

    let cancelled = false
    getAddonCatalog(url, row.catalogType, row.catalogId, row.catalogExtra)
      .then((results) => {
        if (!cancelled) setItem(results[0] || null)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [isMockCatalog, row.addonId, row.addonUrl, row.catalogType, row.catalogId, row.catalogExtra, addons])

  const heroItem = item || MOCK_HERO_MOVIE
  const heroType = 'type' in heroItem && heroItem.type === 'series' ? 'series' : 'movie'
  return <HeroSection item={heroItem} type={heroType} />
}

export default function HomePage() {
  const homeRows = useAppStore((s) => s.homeRows)
  const enabledRows = homeRows.filter((row) => row.enabled)
  const heroRow = enabledRows.find((row) => row.layout === 'hero')
  const contentRows = enabledRows
    .filter((row) => row.id !== heroRow?.id)
    .sort((a, b) => a.order - b.order)

  return (
    <div className="pb-12">
      {heroRow ? (
        <HeroCatalogSection row={heroRow} />
      ) : (
        <HeroSection item={MOCK_HERO_MOVIE} type="movie" />
      )}

      {contentRows.map((row) => {
          if (row.layout === 'continue') {
            return null
          }

          if (row.addonId && row.addonId !== 'com.example.mockaddon') {
            return <AddonCatalogRow key={row.id} row={row} />
          }

          const items = row.catalogId === 'mock-series' ? MOCK_POPULAR_SHOWS : MOCK_TRENDING

          return (
            <MediaRow
              key={row.id}
              title={row.title}
              items={items}
              layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
              showAllPath={`/catalog/${row.id}?title=${encodeURIComponent(row.title)}`}
            />
          )
        })}
    </div>
  )
}
