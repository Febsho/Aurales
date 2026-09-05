import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import { searchTmdbPeople, type TmdbPersonSearchResult } from '../services/tmdb'
import MediaRow from '../components/MediaRow'
import { useAppStore } from '../stores/appStore'
import { EmptyState } from '../components/ui'
import { MediaRowSkeleton } from '../components/ui/Skeleton'
import { getAddonCatalog } from '../services/addons'
import { searchEngines, type SearchEngineId } from '../services/searchEngines'
import { cancelRequestGroup } from '../services/network/requestCoordinator'

const SEARCH_HISTORY_KEY = 'orynt_search_history'
const MAX_HISTORY = 10
const DEFAULT_SEARCH_ENGINES = {
  movie: 'tmdb' as SearchEngineId,
  series: 'tvdb' as SearchEngineId,
  anime: 'mal' as SearchEngineId,
}

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
  const lowered = query.toLowerCase()
  // Drop exact duplicates and shorter prefixes left behind while typing
  // (e.g. "inter", "interst" once "interstellar" lands).
  const history = loadSearchHistory().filter((q) => {
    const existing = q.toLowerCase()
    return existing !== lowered && !lowered.startsWith(existing)
  })
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
  if (item.isAnime) return true
  if (item.provider === 'mal') return true
  if (item.provider === 'anilist' || item.malId || item.anilistId) return true
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
  const [people, setPeople] = useState<TmdbPersonSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searchHistory, setSearchHistory] = useState(loadSearchHistory)
  const [typeFilter, setTypeFilter] = useState<'all' | 'movies' | 'series' | 'anime' | 'people'>('all')
  const addons = useAppStore((state) => state.addons)
  const usesTopNav = useAppStore((s) => s.navigationStyle) === 'topbar'
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const requestIdRef = useRef(0)
  const activeRequestGroupRef = useRef<string | null>(null)

  const movies = useMemo(() => results.filter((item) => item.type === 'movie' && !isAnime(item)).slice(0, 24), [results])
  const series = useMemo(() => results.filter((item) => item.type === 'series' && !isAnime(item)).slice(0, 24), [results])
  const animeMovies = useMemo(() => dedupeAnimeResults(results.filter((item) => item.type === 'movie' && isAnime(item)), query).slice(0, 24), [results, query])
  const animeSeries = useMemo(() => dedupeAnimeResults(results.filter((item) => item.type === 'series' && isAnime(item)), query).slice(0, 24), [results, query])

  const executeSearch = useCallback(async (text: string) => {
    const requestId = ++requestIdRef.current
    if (activeRequestGroupRef.current) cancelRequestGroup(activeRequestGroupRef.current)
    const requestGroup = `search:${requestId}`
    activeRequestGroupRef.current = requestGroup
    if (!text) {
      setResults([])
      setPeople([])
      setSearched(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setSearched(true)
    setPeople([])

    const allResults: SearchResult[] = []
    const pending: Promise<void>[] = []
    let foundPeople: TmdbPersonSearchResult[] = []

    const mergeAndShow = (newItems: SearchResult[]) => {
      if (requestId !== requestIdRef.current) return
      allResults.push(...newItems)
      const ranked = rankResults([...allResults], text)
      setResults(ranked)
    }

    const fireEngine = (engineId: SearchEngineId, type: 'movie' | 'series') => {
      const engine = searchEngines[engineId]
      if (!engine) return
      const p = engine.search(text, type, { cancelGroup: requestGroup }).then(mergeAndShow).catch(() => {})
      pending.push(p)
    }

    const usedEngines = new Set<string>()

    const peopleSearch = searchTmdbPeople(text, { cancelGroup: requestGroup })
      .then((matches) => {
        if (requestId !== requestIdRef.current) return
        foundPeople = matches
        setPeople(matches)
      })
      .catch(() => {})
    pending.push(peopleSearch)

    fireEngine(DEFAULT_SEARCH_ENGINES.movie, 'movie')
    usedEngines.add(DEFAULT_SEARCH_ENGINES.movie)

    fireEngine(DEFAULT_SEARCH_ENGINES.series, 'series')
    usedEngines.add(DEFAULT_SEARCH_ENGINES.series)

    // Jikan's anime search returns both anime movies and series in one result
    // set, so one request keeps the default search fast without dropping either.
    if (!usedEngines.has(DEFAULT_SEARCH_ENGINES.anime)) {
      fireEngine(DEFAULT_SEARCH_ENGINES.anime, 'series')
    }

    // Addon searches
    const addonSearches = addons
      .filter((addon) => addon.enabled)
      .flatMap((addon) => addon.manifest.catalogs
        .filter((catalog) => catalog.extra?.some((extra) => extra.name === 'search'))
        .map((catalog) => getAddonCatalog(
          addon.url,
          catalog.type,
          catalog.id,
          { search: text },
          addon.manifest.id,
          false,
          { cancelGroup: requestGroup, priority: 'interactive' },
        )))
    for (const addonP of addonSearches) {
      const p = addonP.then(mergeAndShow).catch(() => {})
      pending.push(p)
    }

    await Promise.allSettled(pending)
    if (requestId !== requestIdRef.current) return

    // Only remember searches that finished and found something â€” recording on
    // keystroke fills the history with partial queries.
    if (allResults.length > 0 || foundPeople.length > 0) {
      addToSearchHistory(text)
      setSearchHistory(loadSearchHistory())
    }

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
  }, [addons])

  useEffect(() => {
    requestIdRef.current += 1
    setTypeFilter('all')
    // 300ms: long enough to skip most mid-typing queries (each one fans out to
    // every engine and addon), short enough to still feel instant.
    const timer = setTimeout(() => executeSearch(query), 300)
    return () => {
      clearTimeout(timer)
      if (activeRequestGroupRef.current) cancelRequestGroup(activeRequestGroupRef.current)
    }
  }, [query, executeSearch])

  const totalMovies = movies.length + animeMovies.length
  const totalSeries = series.length + animeSeries.length
  const totalResults = totalMovies + totalSeries + people.length
  const noResults = searched && !loading && totalResults === 0

  const filters = [
    { id: 'all' as const, label: 'All', count: totalResults },
    { id: 'movies' as const, label: 'Movies', count: movies.length },
    { id: 'series' as const, label: 'Series', count: series.length },
    { id: 'anime' as const, label: 'Anime', count: animeMovies.length + animeSeries.length },
    { id: 'people' as const, label: 'People', count: people.length },
  ]

  return (
    <div className={`search-page ${cinematic ? 'search-page--cinematic' : 'search-page--default'} ${usesTopNav ? 'pt-44' : 'pt-20'} pb-12`}>
      <section className="search-overview mx-5 sm:mx-8 mb-7" aria-live="polite">
        <div className="min-w-0">
          <p className="search-eyebrow">Explore Aurales</p>
          <h1 className="search-title">
            {searched ? <>Results for <span>&ldquo;{query}&rdquo;</span></> : 'Find your next story'}
          </h1>
          <p className="search-summary">
            {searched
              ? loading
                ? 'Searching across your enabled sources…'
                : `${totalResults} ${totalResults === 1 ? 'match' : 'matches'} across titles and people`
              : 'Search movies, series, anime, actors, directors, and creators.'}
          </p>
        </div>
        {loading && (
          <span className="search-spinner" aria-label="Refining results" />
        )}
      </section>

      {searched && totalResults > 0 && (
        <nav className="search-filters mx-5 sm:mx-8 mb-8" aria-label="Search result types">
          {filters.map(({ id, label, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTypeFilter(id)}
              disabled={count === 0 && id !== 'all'}
              className={`search-filter ${typeFilter === id ? 'search-filter--active' : ''}`}
              aria-pressed={typeFilter === id}
            >
              <span>{label}</span>
              <span className="search-filter__count">{count}</span>
            </button>
          ))}
        </nav>
      )}

      {loading && totalResults === 0 && (
        <div className="search-loading">
          <MediaRowSkeleton title="Movies and shows" />
          <PeopleSkeleton />
        </div>
      )}

      {!loading || totalResults > 0 ? (
        <div className="search-results">
          {(typeFilter === 'all' || typeFilter === 'movies') && movies.length > 0 && <MediaRow title="Movies" items={movies} layout="poster" disableArtOverride={false} cinematicExpand={false} />}
          {(typeFilter === 'all' || typeFilter === 'series') && series.length > 0 && <MediaRow title="Series" items={series} layout="poster" disableArtOverride={false} cinematicExpand={false} />}
          {(typeFilter === 'all' || typeFilter === 'anime') && animeMovies.length > 0 && <MediaRow title="Anime Movies" items={animeMovies} layout="poster" disableArtOverride={false} cinematicExpand={false} />}
          {(typeFilter === 'all' || typeFilter === 'anime') && animeSeries.length > 0 && <MediaRow title="Anime Series" items={animeSeries} layout="poster" disableArtOverride={false} cinematicExpand={false} />}
          {(typeFilter === 'all' || typeFilter === 'people') && people.length > 0 && (
            <PeopleResults people={typeFilter === 'people' ? people : people.slice(0, 10)} />
          )}
        </div>
      ) : null}

      {noResults && (
        <div className="search-empty mx-5 sm:mx-8">
          <EmptyState
            icon={<SearchIcon />}
            title="No strong matches found"
            description="Try a full actor name, an original title, or fewer words."
          />
        </div>
      )}

      {!searched && !loading && (
        <section className={`search-start mx-5 sm:mx-8 ${searchHistory.length > 0 ? 'search-start--history' : ''}`}>
          {searchHistory.length > 0 ? (
            <>
              <div className="search-section-heading">
                <h2>Recent searches</h2>
                <button
                  type="button"
                  onClick={() => {
                    saveSearchHistory([])
                    setSearchHistory([])
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="search-history">
                {searchHistory.map((historyQuery) => (
                  <div key={historyQuery} className="search-history__item">
                    <button type="button" onClick={() => navigate(`/search?q=${encodeURIComponent(historyQuery)}`)}>
                      <HistoryIcon />
                      <span>{historyQuery}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        removeFromSearchHistory(historyQuery)
                        setSearchHistory(loadSearchHistory())
                      }}
                      aria-label={`Remove ${historyQuery} from search history`}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="search-start__empty">
              <SearchIcon />
              <h2>Movies, shows, and the people behind them</h2>
              <p>Start typing above. You can search an actor, director, creator, or title.</p>
              <div className="search-start__examples">
                <span>Try &ldquo;Florence Pugh&rdquo;</span>
                <span>Try &ldquo;Dune&rdquo;</span>
                <span>Try &ldquo;Hayao Miyazaki&rdquo;</span>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function PeopleResults({ people }: { people: TmdbPersonSearchResult[] }) {
  const navigate = useNavigate()
  return (
    <section className="people-results" aria-labelledby="people-results-title">
      <div className="people-results__heading">
        <div>
          <p className="search-eyebrow">Cast &amp; crew</p>
          <h2 id="people-results-title">People</h2>
        </div>
        <span>{people.length} shown</span>
      </div>
      <div className="people-results__grid">
        {people.map((person) => (
          <button
            key={person.id}
            type="button"
            onClick={() => navigate(`/person/${person.id}`)}
            className="person-search-card focus-ring"
          >
            <div className="person-search-card__photo">
              {person.profile ? (
                <img src={person.profile} alt="" loading="lazy" />
              ) : (
                <span>{person.name.slice(0, 1)}</span>
              )}
            </div>
            <div className="person-search-card__body">
              <h3>{person.name}</h3>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function PeopleSkeleton() {
  return (
    <div className="people-results people-results--loading" aria-hidden="true">
      <div className="h-6 w-28 rounded bg-white/[0.06] animate-pulse" />
      <div className="people-results__grid mt-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="person-search-card h-28 animate-pulse" />)}
      </div>
    </div>
  )
}

function SearchIcon() {
  return <svg fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" strokeLinecap="round" /></svg>
}

function HistoryIcon() {
  return <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 3v5h5M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function CloseIcon() {
  return <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" strokeLinecap="round" /></svg>
}
