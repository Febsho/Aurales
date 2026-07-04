import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import { tmdbProvider } from '../services/tmdb'
import MediaRow from '../components/MediaRow'
import { useAppStore } from '../stores/appStore'
import { EmptyState } from '../components/ui'
import { MediaRowSkeleton } from '../components/ui/Skeleton'
import { getAddonCatalog } from '../services/addons'
import { searchEngines, type SearchEngineId } from '../services/searchEngines'

const SEARCH_HISTORY_KEY = 'orynt_search_history'
const MAX_HISTORY = 10

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch (_) {
    return []
  }
}

function saveSearchHistory(history: string[]) {
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)))
}

function addToSearchHistory(query: string) {
  const history = loadSearchHistory().filter((q) => q.toLowerCase() !== query.toLowerCase())
  history.unshift(query)
  saveSearchHistory(history)
}

function removeFromSearchHistory(query: string) {
  const history = loadSearchHistory().filter((q) => q !== query)
  saveSearchHistory(history)
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
}

function baseTitle(value: string): string {
  return normalizeTitle(value)
    .replace(/\b(season|part|series|cour|saison)\s*\d+/g, '')
    .replace(/\bs\d+\b/g, '')
    .replace(/\b(2nd|3rd|\d+th)\s*(season|part|cour)\b/g, '')
    .replace(/\b(final|the final)\s*season\b/g, 'final')
    .replace(/\s+/g, ' ')
    .trim()
}

function animeFamilyTitle(value: string, query?: string): string {
  let title = baseTitle(value)
    .replace(/\b(kimetsu no yaiba|shingeki no kyojin)\b/g, '')
    .replace(/\b(the final chapters?|final chapters?|final arc|finale)\b/g, '')
    .replace(/\b(movie|ova|special|tv|animation|anime)\b/g, '')
    .replace(/\b(arc|chapter|chapters|edition|version)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const needle = query ? normalizeTitle(query) : ''
  if (needle) {
    const queryWords = needle.split(' ').filter((word) => word.length >= 3)
    const titleWords = title.split(' ')
    const prefix: string[] = []
    for (const word of titleWords) {
      if (queryWords.includes(word) || queryWords.some((queryWord) => word.startsWith(queryWord) || queryWord.startsWith(word))) {
        prefix.push(word)
        continue
      }
      if (prefix.length > 0) break
    }
    if (prefix.length >= Math.min(2, queryWords.length)) {
      title = prefix.join(' ')
    }
  }

  return title || baseTitle(value)
}

function dedupeKey(item: SearchResult): string {
  const ids = [
    item.imdbId ? `imdb:${item.imdbId}` : '',
    item.tmdbId ? `tmdb:${String(item.tmdbId).replace('tmdb-', '')}` : '',
    item.tvdbId ? `tvdb:${String(item.tvdbId).replace('tvdb-', '')}` : '',
    item.anilistId ? `anilist:${item.anilistId}` : '',
    item.malId ? `mal:${item.malId}` : '',
  ].filter(Boolean)
  return ids[0] || `${item.type}:${baseTitle(item.title)}`
}

function relevanceScore(item: SearchResult, query: string): number {
  const title = normalizeTitle(item.title)
  const needle = normalizeTitle(query)
  if (!needle) return 0
  let score = 0
  if (title === needle) score += 1000
  else if (title.startsWith(`${needle} `)) score += 700
  else if (title.split(' ').includes(needle)) score += 500
  else if (title.includes(needle)) score += 300
  const words = needle.split(' ').filter((word) => word.length >= 2)
  const titleWords = title.split(' ')
  const matchedWords = words.filter((word) => titleWords.some((titleWord) => titleWord === word || titleWord.startsWith(word)))
  score += matchedWords.length * 90
  if (item.provider === 'tmdb') score += 20
  if (item.poster) score += 10
  score += Math.min(10, Number(item.rating || 0))
  return score
}

function rankResults(items: SearchResult[], query: string): SearchResult[] {
  const seen = new Set<string>()
  const needle = normalizeTitle(query)
  const queryWords = needle.split(' ').filter((word) => word.length >= 2)
  return items
    .map((item) => ({ item, score: relevanceScore(item, query) }))
    .filter(({ item, score }) => {
      const title = normalizeTitle(item.title)
      const strongTextMatch = title.includes(needle)
        || queryWords.every((word) => title.split(' ').some((titleWord) => titleWord === word || titleWord.startsWith(word)))
      return score >= 180 && strongTextMatch
    })
    .sort((a, b) => b.score - a.score || (b.item.rating || 0) - (a.item.rating || 0))
    .map(({ item }) => item)
    .filter((item) => {
      const keys: string[] = []
      const base = baseTitle(item.title)
      keys.push(`${item.type}:${base}`)
      keys.push(dedupeKey(item))
      if (item.year) keys.push(`${item.type}:${base}:${item.year}`)
      if (item.id.startsWith('tvdb-') || item.id.startsWith('tmdb-')) keys.push(item.id)
      if (item.imdbId) keys.push(`imdb:${item.imdbId}`)
      if (item.tmdbId) keys.push(`tmdb:${item.tmdbId}`)
      if (item.tvdbId) keys.push(`tvdb:${String(item.tvdbId).replace('tvdb-', '')}`)
      if (keys.some((k) => seen.has(k))) return false
      keys.forEach((k) => seen.add(k))
      return true
    })
}

function isAnime(item: SearchResult): boolean {
  if (item.provider === 'mal') return true
  if (item.malId || item.anilistId) return true
  return false
}

function dedupeAnimeResults(items: SearchResult[], query: string): SearchResult[] {
  const seen = new Set<string>()
  const output: SearchResult[] = []
  for (const item of items) {
    const family = animeFamilyTitle(item.title, query)
    const keys = [
      item.type === 'series' ? `${item.type}:anime-family:${family}` : `${item.type}:anime-title:${baseTitle(item.title)}`,
      item.tvdbId ? `${item.type}:anime-tvdb:${String(item.tvdbId).replace('tvdb-', '')}` : '',
      item.tmdbId ? `${item.type}:anime-tmdb:${String(item.tmdbId).replace('tmdb-', '')}` : '',
      item.imdbId ? `${item.type}:anime-imdb:${item.imdbId}` : '',
      item.poster ? `${item.type}:anime-poster:${normalizePoster(item.poster)}` : '',
    ].filter(Boolean)
    if (keys.some((key) => seen.has(key))) continue
    keys.forEach((key) => seen.add(key))
    output.push(item)
  }
  return output
}

function normalizePoster(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname}`.toLowerCase().replace(/\/(w\d+|original)\//g, '/')
  } catch (_) {
    return value.toLowerCase().replace(/\/(w\d+|original)\//g, '/')
  }
}

export default function SearchPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const query = searchParams.get('q')?.trim() || ''
  const [results, setResults] = useState<SearchResult[]>([])
  const [aiResults, setAiResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [aiRequested, setAiRequested] = useState(false)
  const [searchHistory, setSearchHistory] = useState(loadSearchHistory)
  const apiKey = useAppStore((state) => state.openrouterApiKey)
  const model = useAppStore((state) => state.openrouterModel)
  const addons = useAppStore((state) => state.addons)
  const movieSearchEngine = useAppStore((s) => s.movieSearchEngine) as SearchEngineId
  const seriesSearchEngine = useAppStore((s) => s.seriesSearchEngine) as SearchEngineId
  const animeSeriesSearchEngine = useAppStore((s) => s.animeSeriesSearchEngine) as SearchEngineId
  const animeMovieSearchEngine = useAppStore((s) => s.animeMovieSearchEngine) as SearchEngineId
  const movieSearchEnabled = useAppStore((s) => s.movieSearchEnabled)
  const seriesSearchEnabled = useAppStore((s) => s.seriesSearchEnabled)
  const animeSeriesSearchEnabled = useAppStore((s) => s.animeSeriesSearchEnabled)
  const animeMovieSearchEnabled = useAppStore((s) => s.animeMovieSearchEnabled)
  const requestIdRef = useRef(0)

  const movies = useMemo(() => results.filter((item) => item.type === 'movie' && !isAnime(item)).slice(0, 24), [results])
  const series = useMemo(() => results.filter((item) => item.type === 'series' && !isAnime(item)).slice(0, 24), [results])
  const animeMovies = useMemo(() => dedupeAnimeResults(results.filter((item) => item.type === 'movie' && isAnime(item)), query).slice(0, 24), [results, query])
  const animeSeries = useMemo(() => dedupeAnimeResults(results.filter((item) => item.type === 'series' && isAnime(item)), query).slice(0, 24), [results, query])
  const aiMovies = useMemo(() => aiResults.filter((item) => item.type === 'movie'), [aiResults])
  const aiSeries = useMemo(() => aiResults.filter((item) => item.type === 'series'), [aiResults])

  const executeSearch = useCallback(async (text: string) => {
    const requestId = ++requestIdRef.current
    if (!text) {
      setResults([])
      setSearched(false)
      return
    }
    setLoading(true)
    setSearched(true)
    setAiResults([])
    setAiRequested(false)
    addToSearchHistory(text)
    setSearchHistory(loadSearchHistory())

    const allResults: SearchResult[] = []
    const pending: Promise<void>[] = []

    const mergeAndShow = (newItems: SearchResult[]) => {
      if (requestId !== requestIdRef.current) return
      allResults.push(...newItems)
      const ranked = rankResults([...allResults], text)
      setResults(ranked)
    }

    const fireEngine = (engineId: SearchEngineId, type: 'movie' | 'series') => {
      const engine = searchEngines[engineId]
      if (!engine) return
      const p = engine.search(text, type).then(mergeAndShow).catch(() => {})
      pending.push(p)
    }

    const usedEngines = new Set<string>()

    if (movieSearchEnabled) {
      fireEngine(movieSearchEngine, 'movie')
      usedEngines.add(movieSearchEngine)
    }

    if (seriesSearchEnabled) {
      fireEngine(seriesSearchEngine, 'series')
      usedEngines.add(seriesSearchEngine)
    }

    if (animeSeriesSearchEnabled && !usedEngines.has(animeSeriesSearchEngine)) {
      fireEngine(animeSeriesSearchEngine, 'series')
      usedEngines.add(animeSeriesSearchEngine)
    }

    if (animeMovieSearchEnabled && !usedEngines.has(animeMovieSearchEngine)) {
      fireEngine(animeMovieSearchEngine, 'movie')
      usedEngines.add(animeMovieSearchEngine)
    }

    // Addon searches
    const addonSearches = addons
      .filter((addon) => addon.enabled)
      .flatMap((addon) => addon.manifest.catalogs
        .filter((catalog) => catalog.extra?.some((extra) => extra.name === 'search'))
        .map((catalog) => getAddonCatalog(addon.url, catalog.type, catalog.id, { search: text }, addon.manifest.id)))
    for (const addonP of addonSearches) {
      const p = addonP.then(mergeAndShow).catch(() => {})
      pending.push(p)
    }

    await Promise.allSettled(pending)
    if (requestId !== requestIdRef.current) return

    // Final enrichment pass
    try {
      const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
      const enriched = await enrichSearchResultsWithAppMetadata(allResults.length > 0 ? rankResults(allResults, text) : [])
      if (requestId !== requestIdRef.current) return
      if (enriched.length > 0) {
        setResults(rankResults(enriched, text))
      }
    } catch (_) {
      if (requestId === requestIdRef.current && allResults.length === 0) {
        setResults([])
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [addons, movieSearchEngine, seriesSearchEngine, animeSeriesSearchEngine, animeMovieSearchEngine, movieSearchEnabled, seriesSearchEnabled, animeSeriesSearchEnabled, animeMovieSearchEnabled])

  const askAi = async () => {
    if (!apiKey || !query || aiLoading) return
    setAiRequested(true)
    setAiLoading(true)
    setAiResults([])
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/itsrenoria/aurales',
          'X-Title': 'Aurales Media Player',
        },
        body: JSON.stringify({
          model: model || 'google/gemini-2.5-flash',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Suggest up to 6 real movie or TV titles matching the request. Return JSON only: {"titles":["Exact title"]}.',
            },
            { role: 'user', content: query },
          ],
        }),
      })
      if (!response.ok) throw new Error('AI search failed')
      const data = await response.json()
      const parsed = JSON.parse(String(data.choices?.[0]?.message?.content || '').replace(/```json|```/gi, '').trim())
      const titles = Array.isArray(parsed.titles) ? parsed.titles.slice(0, 6) : []

      const aiEngine = searchEngines[movieSearchEngine] || tmdbProvider
      const titleSearches = await Promise.allSettled(titles.map(async (title: string) => {
        const found = await aiEngine.search(title)
        return rankResults(found, title)[0]
      }))
      setAiResults(titleSearches.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []))
    } catch (_) {
      setAiResults([])
    } finally {
      setAiLoading(false)
    }
  }

  useEffect(() => {
    requestIdRef.current += 1
    const timer = setTimeout(() => executeSearch(query), 150)
    return () => clearTimeout(timer)
  }, [query, executeSearch])

  const totalMovies = movies.length + animeMovies.length
  const totalSeries = series.length + animeSeries.length
  const noResults = searched && !loading && totalMovies === 0 && totalSeries === 0

  return (
    <div className="py-8 space-y-4">
      {searched && (
        <div className="px-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Results for &ldquo;{query}&rdquo;</h1>
            <p className="text-sm text-white/35 mt-1">{totalMovies} movies · {totalSeries} series</p>
          </div>
        </div>
      )}

      {loading && results.length === 0 && (
        <div className="pt-2">
          <MediaRowSkeleton title="Movies" />
          <MediaRowSkeleton title="Series" />
        </div>
      )}

      {movies.length > 0 && <MediaRow title="Movies" items={movies} layout="poster" disableArtOverride={false} />}
      {series.length > 0 && <MediaRow title="Series" items={series} layout="poster" disableArtOverride={false} />}
      {animeMovies.length > 0 && <MediaRow title="Anime Movies" items={animeMovies} layout="poster" disableArtOverride={false} />}
      {animeSeries.length > 0 && <MediaRow title="Anime Series" items={animeSeries} layout="poster" disableArtOverride={false} />}

      {noResults && (
        <EmptyState
          icon={<svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>}
          title="No strong matches found"
          description="Try the exact title, original title, or fewer words."
        />
      )}

      {searched && !loading && (
        <section className="mx-6 mt-4 rounded-2xl border border-purple-500/15 bg-purple-500/[0.05] p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-bold text-white">AI suggestions</h2>
              <p className="text-xs text-white/40 mt-1">Optional. Uses OpenRouter credits only when you press Ask AI.</p>
            </div>
            <button
              onClick={askAi}
              disabled={!apiKey || aiLoading}
              className="px-4 py-2 rounded-xl bg-purple-500/20 border border-purple-400/20 text-sm font-semibold text-purple-200 disabled:opacity-40"
            >
              {aiLoading ? 'Searching…' : aiRequested ? 'Search again' : 'Ask AI'}
            </button>
          </div>
          {!apiKey && <p className="mt-3 text-xs text-amber-300/70">Add an OpenRouter API key in Settings to enable optional AI search.</p>}
        </section>
      )}

      {!aiLoading && aiMovies.length > 0 && <MediaRow title="AI · Movies" items={aiMovies} layout="poster" disableArtOverride={false} />}
      {!aiLoading && aiSeries.length > 0 && <MediaRow title="AI · Series" items={aiSeries} layout="poster" disableArtOverride={false} />}

      {!searched && !loading && (
        searchHistory.length > 0 ? (
          <div className="px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white/80">Recent Searches</h2>
              <button
                onClick={() => {
                  saveSearchHistory([])
                  setSearchHistory([])
                }}
                className="text-xs text-white/30 hover:text-white/60 transition-colors cursor-pointer"
              >
                Clear all
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {searchHistory.map((q) => (
                <div key={q} className="group flex items-center gap-1 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.06] rounded-xl transition-colors">
                  <button
                    onClick={() => navigate(`/search?q=${encodeURIComponent(q)}`)}
                    className="flex items-center gap-2 px-3.5 py-2 cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5 text-white/25 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M12 8v4l3 3" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="12" cy="12" r="10" />
                    </svg>
                    <span className="text-sm text-white/65 group-hover:text-white transition-colors">{q}</span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFromSearchHistory(q)
                      setSearchHistory(loadSearchHistory())
                    }}
                    className="pr-2.5 py-2 text-white/15 hover:text-white/50 transition-colors cursor-pointer"
                    title="Remove"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>}
            title="Search your media"
            description="Type a title above to search movies and shows."
          />
        )
      )}
    </div>
  )
}
