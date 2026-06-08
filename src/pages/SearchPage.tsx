import { useState, useCallback } from 'react'
import type { SearchResult } from '../types'
import { MOCK_TRENDING, MOCK_POPULAR_SHOWS } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import MediaCard from '../components/MediaCard'

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setSearched(true)

    try {
      const tmdbResults = await tmdbProvider.search(query)
      setResults(tmdbResults)
    } catch {
      const allMock = [...MOCK_TRENDING, ...MOCK_POPULAR_SHOWS]
      const filtered = allMock.filter((m) =>
        m.title.toLowerCase().includes(query.toLowerCase())
      )
      setResults(filtered.length > 0 ? filtered : allMock.slice(0, 6))
    } finally {
      setLoading(false)
    }
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch()
  }

  return (
    <div className="p-6">
      <div className="max-w-2xl mx-auto mb-8">
        <div className="relative">
          <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search movies, series..."
            className="w-full pl-12 pr-4 py-3.5 bg-surface-elevated border border-border-subtle rounded-2xl text-white placeholder-muted focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 transition-all"
          />
          <button
            onClick={handleSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-accent hover:bg-accent-hover text-black font-medium text-sm rounded-xl transition-colors"
          >
            Search
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && searched && results.length === 0 && (
        <div className="text-center py-12 text-muted">
          No results found for "{query}"
        </div>
      )}

      {!loading && results.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">
            {searched ? `Results for "${query}"` : 'Trending'}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
            {results.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {!searched && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Trending</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
            {MOCK_TRENDING.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
