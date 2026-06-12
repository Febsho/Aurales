import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DiscoverConfig, SearchResult } from '../types'
import { discoverTmdbWithCache } from '../services/tmdb'
import { MOCK_POPULAR_SHOWS, MOCK_TRENDING } from '../data/mock'
import MediaRow from '../components/MediaRow'
import { applySearchResultArt } from '../services/artwork'
import { useAppStore } from '../stores/appStore'

type DiscoverTab = 'movies' | 'series'

const GENRE_MAP_MOVIE: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western',
}

const GENRE_MAP_TV: Record<number, string> = {
  10759: 'Action & Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 10762: 'Kids',
  9648: 'Mystery', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10768: 'War & Politics', 37: 'Western',
}

const MOVIE_MOODS = [
  { title: 'Mind Benders', genres: [878, 9648, 53] },
  { title: 'Comfort Watch', genres: [35, 10751, 16] },
  { title: 'After Dark', genres: [27, 53] },
  { title: 'Heists & Cons', genres: [80, 53] },
  { title: 'Epic Adventures', genres: [12, 28, 14] },
  { title: 'Date Night', genres: [10749, 35] },
]

const SERIES_MOODS = [
  { title: 'Prestige Drama', genres: [18] },
  { title: 'Mystery Box', genres: [9648, 10765] },
  { title: 'Laugh Out Loud', genres: [35] },
  { title: 'Crime Stories', genres: [80, 18] },
  { title: 'Big Adventures', genres: [10759, 10765] },
  { title: 'Reality Escape', genres: [10764] },
]

const DISCOVERY_DAY = Math.floor(Date.now() / 86_400_000)

function makeConfig(
  contentType: 'movie' | 'series',
  sortBy: string,
  preferences: { region: string; minRating: number; includeAdult: boolean },
  overrides: Partial<DiscoverConfig> = {},
): DiscoverConfig {
  return {
    source: 'TMDB',
    contentType,
    sortBy,
    cacheTtl: 43200,
    releasedOnly: true,
    includeAdult: preferences.includeAdult,
    includeGenres: [],
    excludeGenres: [],
    genreMatchMode: 'OR',
    originalLanguage: '',
    releaseRegion: preferences.region,
    people: [],
    peopleMatchMode: 'OR',
    includeCompanies: [],
    excludeCompanies: [],
    companyMatchMode: 'OR',
    includeKeywords: [],
    excludeKeywords: [],
    keywordMatchMode: 'OR',
    watchRegion: preferences.region,
    providerMatchMode: 'OR',
    selectedProviders: [],
    voteAverageMin: preferences.minRating,
    voteAverageMax: 10,
    voteCountMin: 50,
    ...overrides,
  }
}

function useDiscoverRow(config: DiscoverConfig, rowId: string, fallback: SearchResult[] = []) {
  const [items, setItems] = useState<SearchResult[]>([])

  useEffect(() => {
    let cancelled = false
    discoverTmdbWithCache(config, rowId)
      .then(async (results) => {
        const rawItems = results.length > 0 ? results : fallback
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(rawItems)
        if (!cancelled) setItems(enriched.map(applySearchResultArt))
      })
      .catch(async () => {
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(fallback)
        if (!cancelled) setItems(enriched.map(applySearchResultArt))
      })
    return () => { cancelled = true }
    // Config values are encoded into rowId so preference changes always refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId])

  return items
}

function getTopGenre(items: SearchResult[], type: 'movie' | 'series'): number | null {
  const counts = new Map<number, number>()
  items.filter((item) => item.type === type).forEach((item, index) => {
    const weight = Math.max(1, 8 - index)
    item.genreIds?.forEach((genre) => counts.set(genre, (counts.get(genre) || 0) + weight))
  })
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function rotateItems(items: SearchResult[], offset: number): SearchResult[] {
  if (items.length === 0) return items
  const start = offset % items.length
  return [...items.slice(start), ...items.slice(0, start)]
}

export default function DiscoverPage() {
  const [tab, setTab] = useState<DiscoverTab>('movies')
  const [selectedGenre, setSelectedGenre] = useState<number | null>(null)
  const [genreResults, setGenreResults] = useState<SearchResult[]>([])
  const [genreLoading, setGenreLoading] = useState(false)
  const region = useAppStore((s) => s.discoveryRegion)
  const minRating = useAppStore((s) => s.discoveryMinRating)
  const includeAdult = useAppStore((s) => s.discoveryIncludeAdult)
  const recentlyViewed = useAppStore((s) => s.recentlyWatched)

  const genreMap = tab === 'movies' ? GENRE_MAP_MOVIE : GENRE_MAP_TV
  const contentType = tab === 'movies' ? 'movie' : 'series'
  const fallback = tab === 'movies' ? MOCK_TRENDING : MOCK_POPULAR_SHOWS
  const fallbackVariants = useMemo(() => ({
    taste: rotateItems(fallback, 1),
    mood: rotateItems(fallback, 3),
    gems: rotateItems(fallback, 5),
    quick: rotateItems(fallback, 7),
  }), [fallback])
  const preferences = useMemo(() => ({ region, minRating, includeAdult }), [region, minRating, includeAdult])
  const preferenceKey = `${region}-${minRating}-${includeAdult}`
  const tasteGenre = useMemo(() => getTopGenre(recentlyViewed, contentType), [recentlyViewed, contentType])
  const mood = useMemo(() => {
    const pool = tab === 'movies' ? MOVIE_MOODS : SERIES_MOODS
    return pool[DISCOVERY_DAY % pool.length]
  }, [tab])

  const trending = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences),
    `discover-trending-${contentType}-${preferenceKey}`,
    fallback,
  )
  const topRated = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, { voteCountMin: 500 }),
    `discover-toprated-${contentType}-${preferenceKey}`,
    fallback,
  )
  const moodItems = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: mood.genres.map(String),
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: 250,
    }),
    `discover-mood-${contentType}-${mood.title}-${preferenceKey}`,
    fallbackVariants.mood,
  )
  const hiddenGems = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, {
      voteAverageMin: Math.max(7.2, minRating),
      voteCountMin: 120,
    }),
    `discover-gems-${contentType}-${preferenceKey}`,
    fallbackVariants.gems,
  )
  const quickWatches = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      runtimeMax: contentType === 'movie' ? 100 : 35,
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: 200,
    }),
    `discover-quick-${contentType}-${preferenceKey}`,
    fallbackVariants.quick,
  )
  const forYou = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: tasteGenre ? [String(tasteGenre)] : [],
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: 150,
    }),
    `discover-for-you-${contentType}-${tasteGenre || 'starter'}-${preferenceKey}`,
    fallbackVariants.taste,
  )

  const handleGenreClick = useCallback((genreId: number) => {
    if (selectedGenre === genreId) {
      setSelectedGenre(null)
      setGenreResults([])
      return
    }
    setSelectedGenre(genreId)
    setGenreLoading(true)
    discoverTmdbWithCache(
      makeConfig(contentType, 'popularity.desc', preferences, { includeGenres: [String(genreId)] }),
      `discover-genre-${contentType}-${genreId}-${preferenceKey}`,
    )
      .then((results) => setGenreResults(results.map(applySearchResultArt)))
      .catch(() => setGenreResults([]))
      .finally(() => setGenreLoading(false))
  }, [selectedGenre, contentType, preferences, preferenceKey])

  const handleTabChange = (nextTab: DiscoverTab) => {
    setTab(nextTab)
    setSelectedGenre(null)
    setGenreResults([])
  }

  return (
    <div className="pb-12">
      <div className="px-8 pt-8 pb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Discover</h1>
            <p className="text-sm text-white/35">Daily moods, quality picks, and recommendations shaped by what you open</p>
          </div>
          <span className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-xs text-white/45">
            Region {region} · {minRating > 0 ? `${minRating}+ rating` : 'all ratings'}
          </span>
        </div>

        <div className="flex items-center gap-2 mt-5">
          {(['movies', 'series'] as DiscoverTab[]).map((item) => (
            <button
              key={item}
              onClick={() => handleTabChange(item)}
              className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all cursor-pointer border ${
                tab === item
                  ? 'bg-accent/15 text-accent border-accent/25'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/[0.06] border-transparent'
              }`}
            >
              {item === 'movies' ? 'Movies' : 'Series'}
            </button>
          ))}
        </div>
      </div>

      <div className="px-8 mb-6 flex flex-wrap gap-2">
        {Object.entries(genreMap).map(([id, name]) => (
          <button
            key={id}
            onClick={() => handleGenreClick(Number(id))}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
              selectedGenre === Number(id)
                ? 'bg-accent/15 text-accent border-accent/30'
                : 'text-white/45 hover:text-white/70 bg-white/[0.03] hover:bg-white/[0.06] border-white/[0.06]'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {selectedGenre ? (
        genreLoading ? (
          <div className="flex items-center gap-3 px-8 py-6">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/40">Loading {genreMap[selectedGenre]}...</span>
          </div>
        ) : genreResults.length > 0 ? (
          <MediaRow title={genreMap[selectedGenre]} items={genreResults} layout="poster" disableArtOverride={false} />
        ) : (
          <p className="px-8 py-4 text-sm text-white/30">No results for {genreMap[selectedGenre]}</p>
        )
      ) : (
        <>
          <MediaRow
            title={tasteGenre ? `For You · More ${genreMap[tasteGenre] || 'Like This'}` : 'For You · Start Exploring'}
            items={forYou}
            layout="landscape"
            disableArtOverride={false}
          />
          <MediaRow title={`Tonight's Mood · ${mood.title}`} items={moodItems} layout="poster" disableArtOverride={false} />
          <MediaRow title={`Trending ${tab === 'movies' ? 'Movies' : 'Series'}`} items={trending} layout="landscape" disableArtOverride={false} />
          <MediaRow title="Highly Rated, Quietly Loved" items={hiddenGems} layout="poster" disableArtOverride={false} />
          <MediaRow title={contentType === 'movie' ? 'Quick Watches · Under 100 Minutes' : 'Quick Episodes · Around 35 Minutes'} items={quickWatches} layout="poster" disableArtOverride={false} />
          <MediaRow title="Critically Loved" items={topRated} layout="poster" disableArtOverride={false} />
        </>
      )}
    </div>
  )
}
