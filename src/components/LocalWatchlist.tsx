import { useMemo, useState } from 'react'
import MediaCard from './MediaCard'
import { useLocalWatchlist } from '../hooks/useLocalWatchlist'

type TypeFilter = 'all' | 'movie' | 'series'

export default function LocalWatchlist() {
  const items = useLocalWatchlist()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return items.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false
      return !normalizedQuery || item.title.toLowerCase().includes(normalizedQuery)
    })
  }, [items, query, typeFilter])

  return (
    <section aria-labelledby="local-watchlist-heading">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 21s-7.2-4.35-9.55-8.4C.4 9.05 2.02 4.5 6.15 3.56A5.15 5.15 0 0 1 12 6.18a5.15 5.15 0 0 1 5.85-2.62c4.13.94 5.75 5.49 3.7 9.04C19.2 16.65 12 21 12 21Z" />
              </svg>
            </div>
            <div>
              <h2 id="local-watchlist-heading" className="text-lg font-bold text-white">Local Watchlist</h2>
              <p className="mt-0.5 text-xs text-white/35">{items.length} {items.length === 1 ? 'title' : 'titles'} saved on this device</p>
            </div>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {([['all', 'All'], ['movie', 'Movies'], ['series', 'Shows']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTypeFilter(value)}
                className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition-colors cursor-pointer ${typeFilter === value ? 'border-accent/25 bg-accent/15 text-accent' : 'border-white/[0.07] bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/70'}`}
              >
                {label}
              </button>
            ))}
            <div className="relative ml-1">
              <svg className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-white/25" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter watchlist..."
                aria-label="Filter local watchlist"
                className="w-44 rounded-lg border border-white/[0.07] bg-white/[0.04] py-1.5 pl-8 pr-3 text-[11px] text-white placeholder-white/25 outline-none transition-colors focus:border-white/[0.16] focus:bg-white/[0.07]"
              />
            </div>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.025] px-6 py-20 text-center">
          <div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.04]">
            <svg className="h-8 w-8 text-white/15" fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 21s-7.2-4.35-9.55-8.4C.4 9.05 2.02 4.5 6.15 3.56A5.15 5.15 0 0 1 12 6.18a5.15 5.15 0 0 1 5.85-2.62c4.13.94 5.75 5.49 3.7 9.04C19.2 16.65 12 21 12 21Z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-white/40">Your local watchlist is empty</p>
          <p className="mt-1 max-w-sm text-xs leading-relaxed text-white/25">Heart a movie or show from its hero or detail page and it will appear here.</p>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] py-16 text-center">
          <p className="text-sm font-medium text-white/40">No watchlist titles match this filter</p>
        </div>
      ) : (
        <div className="grid items-start gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(144px, 1fr))' }}>
          {visibleItems.map((item) => <MediaCard key={`${item.type}:${item.id}`} item={item} disableTrailerPreview />)}
        </div>
      )}
    </section>
  )
}
