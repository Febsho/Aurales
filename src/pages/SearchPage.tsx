import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SearchResult } from '../types'
import { MOCK_POPULAR_SHOWS, MOCK_TRENDING } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import MediaRow from '../components/MediaRow'
import { useAppStore } from '../stores/appStore'
import { EmptyState } from '../components/ui'
import { getAddonCatalog } from '../services/addons'
import { resolveAnimeIds } from '../services/animeLists'
import { searchEngines, type SearchEngineId } from '../services/searchEngines'

function normalizeTitle(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
}

function baseTitle(value: string): string {
  return normalizeTitle(value)
    .replace(/\b(season|part|series|cour|saison)\s*\d+/g, '')
    .replace(/\bs\d+\b/g, '')
    .replace(/\b(2nd|3rd|\d+th)\s*(season|part|cour)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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
      if (item.id.startsWith('tvdb-') || item.id.startsWith('tmdb-')) keys.push(item.id)
      if (item.imdbId) keys.push(`imdb:${item.imdbId}`)
      if (item.tmdbId) keys.push(`tmdb:${item.tmdbId}`)
      if (item.tvdbId) keys.push(`tvdb:${String(item.tvdbId).replace('tvdb-', '')}`)
      if (keys.some((k) => seen.has(k))) return false
      keys.forEach((k) => seen.add(k))
      return true
    })
}

export default function SearchPage() {
  const [searchParams] = useSearchParams()
  const query = searchParams.get('q')?.trim() || ''
  const [results, setResults] = useState<SearchResult[]>([])
  const [aiResults, setAiResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [aiRequested, setAiRequested] = useState(false)
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

  const movies = useMemo(() => results.filter((item) => item.type === 'movie').slice(0, 24), [results])
  const series = useMemo(() => results.filter((item) => item.type === 'series').slice(0, 24), [results])
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
    try {
      const searches: Promise<SearchResult[]>[] = []

      // Configured search engines
      const usedEngines = new Set<string>()

      if (movieSearchEnabled) {
        const engine = searchEngines[movieSearchEngine]
        if (engine) {
          searches.push(engine.search(text, 'movie').catch(() => []))
          usedEngines.add(movieSearchEngine)
        }
      }

      if (seriesSearchEnabled) {
        const engine = searchEngines[seriesSearchEngine]
        if (engine) {
          searches.push(engine.search(text, 'series').catch(() => []))
          usedEngines.add(seriesSearchEngine)
        }
      }

      if (animeSeriesSearchEnabled && !usedEngines.has(animeSeriesSearchEngine)) {
        const engine = searchEngines[animeSeriesSearchEngine]
        if (engine) {
          searches.push(engine.search(text, 'series').catch(() => []))
          usedEngines.add(animeSeriesSearchEngine)
        }
      }

      if (animeMovieSearchEnabled && !usedEngines.has(animeMovieSearchEngine)) {
        const engine = searchEngines[animeMovieSearchEngine]
        if (engine) {
          searches.push(engine.search(text, 'movie').catch(() => []))
          usedEngines.add(animeMovieSearchEngine)
        }
      }

      // Addon searches
      const addonSearches = addons
        .filter((addon) => addon.enabled)
        .flatMap((addon) => addon.manifest.catalogs
          .filter((catalog) => catalog.extra?.some((extra) => extra.name === 'search'))
          .map((catalog) => getAddonCatalog(addon.url, catalog.type, catalog.id, { search: text }, addon.manifest.id)))
      searches.push(...addonSearches.map((p) => p.catch(() => [])))

      const settled = await Promise.allSettled(searches)
      if (requestId !== requestIdRef.current) return
      const merged = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])

      // Resolve anime IDs for series items
      const mappedMerged = await Promise.all(merged.map(async (item) => {
        if (item.type === 'series') {
          try {
            const anilistId = item.anilistId ? Number(item.anilistId) : undefined
            const malId = item.malId ? Number(item.malId) : undefined
            const tvdbId = item.tvdbId ? Number(item.tvdbId.toString().replace('tvdb-', '')) : undefined
            const imdbId = item.imdbId || (item.id.startsWith('imdb:') ? item.id.replace('imdb:', '') : undefined)

            if (!tvdbId && (anilistId || malId || imdbId)) {
              const mapped = await resolveAnimeIds({ anilistId, malId, imdbId })
              if (mapped?.tvdbId) {
                return {
                  ...item,
                  id: `tvdb-${mapped.tvdbId}`,
                  provider: 'tvdb',
                  tvdbId: mapped.tvdbId,
                  tmdbId: mapped.tmdbId || item.tmdbId,
                  imdbId: mapped.imdbId || item.imdbId,
                  anilistId: mapped.anilistId || item.anilistId,
                  malId: mapped.malId || item.malId,
                }
              }
            }
          } catch { /* ignore */ }
        }
        return item
      }))
      const ranked = rankResults(mappedMerged, text)
      const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
      const enriched = await enrichSearchResultsWithAppMetadata(ranked)
      if (requestId !== requestIdRef.current) return
      if (enriched.length > 0) {
        setResults(enriched)
      } else {
        const defaultFallback = rankResults([...MOCK_TRENDING, ...MOCK_POPULAR_SHOWS], text)
        const enrichedFallback = await enrichSearchResultsWithAppMetadata(defaultFallback)
        if (requestId !== requestIdRef.current) return
        setResults(enrichedFallback)
      }
    } catch {
      if (requestId !== requestIdRef.current) return
      const defaultFallback = rankResults([...MOCK_TRENDING, ...MOCK_POPULAR_SHOWS], text)
      const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
      enrichSearchResultsWithAppMetadata(defaultFallback).then((enriched) => {
        if (requestId === requestIdRef.current) setResults(enriched)
      }).catch(() => {
        if (requestId === requestIdRef.current) setResults(defaultFallback)
      })
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
          'HTTP-Referer': 'https://github.com/itsrenoria/orynt',
          'X-Title': 'Orynt Media Player',
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

      // AI uses the configured movie engine to resolve titles
      const aiEngine = searchEngines[movieSearchEngine] || tmdbProvider
      const titleSearches = await Promise.allSettled(titles.map(async (title: string) => {
        const found = await aiEngine.search(title)
        return rankResults(found, title)[0]
      }))
      setAiResults(titleSearches.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []))
    } catch {
      setAiResults([])
    } finally {
      setAiLoading(false)
    }
  }

  useEffect(() => {
    requestIdRef.current += 1
    const timer = setTimeout(() => executeSearch(query), 300)
    return () => clearTimeout(timer)
  }, [query, executeSearch])

  const noResults = searched && !loading && movies.length === 0 && series.length === 0

  return (
    <div className="py-8 space-y-4">
      {searched && (
        <div className="px-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Results for &ldquo;{query}&rdquo;</h1>
            <p className="text-sm text-white/35 mt-1">{movies.length} movies · {series.length} series</p>
          </div>
        </div>
      )}

      {loading && <div className="mx-auto my-16 w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />}

      {!loading && movies.length > 0 && <MediaRow title="Movies" items={movies} layout="poster" disableArtOverride={false} />}
      {!loading && series.length > 0 && <MediaRow title="Series" items={series} layout="poster" disableArtOverride={false} />}

      {noResults && (
        <EmptyState
          icon={<svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>}
          title="No strong matches found"
          description="Try the exact title, original title, or fewer words."
        />
      )}

      {searched && !loading && (
        <section className="mx-8 mt-4 rounded-2xl border border-purple-500/15 bg-purple-500/[0.05] p-5">
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
        <>
          <MediaRow title="Trending Movies" items={MOCK_TRENDING} layout="poster" disableArtOverride={false} />
          <MediaRow title="Popular Series" items={MOCK_POPULAR_SHOWS} layout="poster" disableArtOverride={false} />
        </>
      )}
    </div>
  )
}
