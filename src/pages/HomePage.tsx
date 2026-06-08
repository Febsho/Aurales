import { useState, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import HeroSection from '../components/HeroSection'
import MediaRow from '../components/MediaRow'
import { MOCK_HERO_MOVIE, MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { getAddonCatalog, getMockCatalog } from '../services/addons'
import type { SearchResult, HomeRowConfig } from '../types'

function AddonCatalogRow({ row }: { row: HomeRowConfig }) {
  const [items, setItems] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const addons = useAppStore((s) => s.addons)

  useEffect(() => {
    if (row.catalogId?.startsWith('mock-')) {
      setItems(getMockCatalog(row.catalogId))
      setLoading(false)
      return
    }

    if (!row.addonId || !row.catalogType || !row.catalogId) {
      setLoading(false)
      return
    }

    const addon = addons.find((a) => a.manifest.id === row.addonId)
    if (!addon) {
      setLoading(false)
      return
    }

    setLoading(true)
    getAddonCatalog(addon.url, row.catalogType, row.catalogId)
      .then((results) => {
        setItems(results)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [row.addonId, row.catalogType, row.catalogId, addons])

  if (loading) {
    return (
      <div className="px-6 mb-6">
        <h2 className="text-base font-semibold mb-3">{row.title}</h2>
        <div className="flex gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-36 aspect-[2/3] bg-surface-elevated rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  if (items.length === 0) return null

  return (
    <MediaRow
      title={row.title}
      items={items}
      layout={row.layout === 'landscape' ? 'landscape' : row.layout === 'list' ? 'list' : 'poster'}
    />
  )
}

export default function HomePage() {
  const homeRows = useAppStore((s) => s.homeRows)

  return (
    <div className="pb-12">
      {homeRows
        .filter((row) => row.enabled)
        .sort((a, b) => a.order - b.order)
        .map((row) => {
          if (row.layout === 'hero') {
            return (
              <HeroSection
                key={row.id}
                item={MOCK_HERO_MOVIE}
                type="movie"
              />
            )
          }

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
            />
          )
        })}
    </div>
  )
}
