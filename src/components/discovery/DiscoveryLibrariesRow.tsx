import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, LibraryBig } from 'lucide-react'
import type { HomeRowConfig, SearchResult } from '../../types'
import { homeRowCacheKey } from '../../services/cache/homeRowCacheKeys'
import { useHomeCatalogCache } from '../../stores/homeCatalogCache'

interface DiscoveryLibrariesRowProps {
  rows: HomeRowConfig[]
}

interface LibraryCard {
  row: HomeRowConfig
  items: SearchResult[]
}

/** Quick links to the catalogs the user already configured for Aurales Home. */
export default function DiscoveryLibrariesRow({ rows }: DiscoveryLibrariesRowProps) {
  const navigate = useNavigate()
  const cachedRows = useHomeCatalogCache((state) => state.rows)
  const libraries = useMemo<LibraryCard[]>(() => rows
    .filter((row) => row.enabled && !['hero', 'continue', 'upcoming'].includes(row.layout))
    .sort((left, right) => left.order - right.order)
    .map((row) => {
      const cacheKey = homeRowCacheKey(row)
      const items = cacheKey ? cachedRows[cacheKey]?.items || [] : []
      return { row, items: items.filter((item) => item.poster || item.backdrop).slice(0, 4) }
    }), [cachedRows, rows])

  if (!libraries.length) return null

  return <section className="discover-libraries row-contain" aria-labelledby="discover-libraries-title">
    <div className="discover-libraries__heading">
      <div><p className="discover-section-eyebrow">Your collections</p><h2 id="discover-libraries-title">Libraries</h2></div>
      <button type="button" onClick={() => navigate('/collections')} aria-label="Browse all libraries">Browse all <ArrowUpRight size={14} aria-hidden="true" /></button>
    </div>
    <div className="discover-libraries__track" aria-label="Configured Aurales catalogs">
      {libraries.map(({ row, items }) => <button type="button" className="discover-library-card" key={row.id} onClick={() => navigate(`/catalog/${encodeURIComponent(row.id)}?title=${encodeURIComponent(row.title)}`)} aria-label={`Open ${row.title} library`}>
        <span className="discover-library-card__art" aria-hidden="true">
          {items.length > 0 ? <span className="discover-library-card__posters">{items.slice(0, 3).map((item, index) => <img key={`${item.id}-${index}`} src={item.poster || item.backdrop} alt="" loading="lazy" decoding="async" />)}</span> : <LibraryBig size={30} strokeWidth={1.5} />}
        </span>
        <span className="discover-library-card__copy"><strong>{row.title}</strong><small>{items.length ? `${items.length} featured titles` : row.sourceType === 'discover' ? 'Popular catalog' : 'Your catalog'}</small></span>
        <span className="discover-library-card__source">{row.sourceType === 'discover' ? 'Aurales' : row.sourceType || 'Library'}</span>
      </button>)}
    </div>
  </section>
}
