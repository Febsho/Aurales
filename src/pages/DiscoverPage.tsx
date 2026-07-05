import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DiscoverConfig, SearchResult } from '../types'
import { discoverTmdbWithCache, getTvdbIdFromTmdb } from '../services/tmdb'
import { getTvdbBanner } from '../services/tvdb'
import { MOCK_POPULAR_SHOWS, MOCK_TRENDING } from '../data/mock'
import MediaRow from '../components/MediaRow'
import HeroSection from '../components/HeroSection'
import ServiceCard from '../components/ServiceCard'
import { SERVICES } from '../data/services'
import { applySearchResultArt } from '../services/artwork'
import { useAppStore } from '../stores/appStore'
import { useDiscoverStore, type DiscoverTab } from '../stores/discoverStore'

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

const GENRE_MAP_ANIME: Record<number, string> = {
  10759: 'Action & Adventure', 35: 'Comedy', 80: 'Crime',
  18: 'Drama', 10751: 'Family', 10762: 'Kids',
  9648: 'Mystery', 10765: 'Sci-Fi & Fantasy', 10768: 'War & Politics',
}

export const SERVICE_PROVIDER_MAP: Record<string, { ids: number[]; name: string }> = {
  "Netflix": { ids: [8], name: "Netflix" },
  "Disney+": { ids: [337], name: "Disney+" },
  "Apple TV": { ids: [350], name: "Apple TV Plus" },
  "Prime Video": { ids: [9, 119], name: "Amazon Prime Video" },
  "HBO Max": { ids: [384, 1899], name: "HBO Max / Max" },
  "Paramount+": { ids: [531], name: "Paramount+" },
  "Hulu": { ids: [15], name: "Hulu" },
  "Peacock": { ids: [386, 387], name: "Peacock" },
  "STARZ": { ids: [43], name: "STARZ" },
  "MUBI": { ids: [11], name: "MUBI" },
  "Crunchyroll": { ids: [283], name: "Crunchyroll" },
  "The Criterion Channel": { ids: [258], name: "The Criterion Channel" },
  "Shudder": { ids: [97], name: "Shudder" },
  "AMC+": { ids: [528], name: "AMC+" },
  "britbox": { ids: [196], name: "BritBox" },
  "Discovery+": { ids: [445], name: "Discovery+" },
  "Curiosity Stream": { ids: [190], name: "Curiosity Stream" },
  "MagellanTV": { ids: [551], name: "Magellan TV" },
  "Netflix Kids": { ids: [8], name: "Netflix Kids" }
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

const ANIME_MOODS = [
  { title: 'Action Packed', genres: [10759, 10765] },
  { title: 'Slice of Life & Comedy', genres: [35, 10751] },
  { title: 'Thrills & Mystery', genres: [9648, 80] },
  { title: 'Emotional Journeys', genres: [18] },
  { title: 'Sci-Fi & Fantasy', genres: [10765] },
  { title: 'Lighthearted Fun', genres: [35, 10762] },
]

const HENTAI_EXCLUDE_KEYWORDS = [{ id: 293054, name: 'hentai' }, { id: 6126, name: 'ecchi' }]
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
  const setCachedRow = useDiscoverStore((s) => s.setCachedRow)

  // Read cache snapshot once — avoid putting cachedRows in deps to prevent feedback loops
  const items = useDiscoverStore((s) => s.cachedRows[rowId]?.items) ?? []
  const cacheTimestamp = useDiscoverStore((s) => s.cachedRows[rowId]?.timestamp) ?? 0

  useEffect(() => {
    const ttl = 15 * 60 * 1000 // 15 minutes
    if (cacheTimestamp > 0 && Date.now() - cacheTimestamp < ttl) return

    let cancelled = false
    discoverTmdbWithCache(config, rowId)
      .then(async (results) => {
        const rawItems = results.length > 0 ? results : fallback
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(rawItems)
        const finalItems = enriched.map(applySearchResultArt)
        if (!cancelled) setCachedRow(rowId, finalItems)
      })
      .catch(async () => {
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(fallback)
        const finalItems = enriched.map(applySearchResultArt)
        if (!cancelled) setCachedRow(rowId, finalItems)
      })
    return () => { cancelled = true }
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
  const navigate = useNavigate()
  const tab = useDiscoverStore((s) => s.tab)
  const setTab = useDiscoverStore((s) => s.setTab)
  const selectedGenre = useDiscoverStore((s) => s.selectedGenre)
  const setSelectedGenre = useDiscoverStore((s) => s.setSelectedGenre)
  const genreResults = useDiscoverStore((s) => s.genreResults)
  const setGenreResults = useDiscoverStore((s) => s.setGenreResults)
  const genreLoading = useDiscoverStore((s) => s.genreLoading)
  const setGenreLoading = useDiscoverStore((s) => s.setGenreLoading)

  const region = useAppStore((s) => s.discoveryRegion)
  const minRating = useAppStore((s) => s.discoveryMinRating)
  const includeAdult = useAppStore((s) => s.discoveryIncludeAdult)
  const recentlyViewed = useAppStore((s) => s.recentlyWatched)

  const genreMap = tab === 'movies' ? GENRE_MAP_MOVIE : tab === 'series' ? GENRE_MAP_TV : GENRE_MAP_ANIME
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
    const pool = tab === 'movies' ? MOVIE_MOODS : tab === 'series' ? SERIES_MOODS : ANIME_MOODS
    return pool[DISCOVERY_DAY % pool.length]
  }, [tab])

  const animeOverrides = tab === 'anime' ? {
    originalLanguage: 'ja',
    includeGenres: ['16'],
    excludeKeywords: HENTAI_EXCLUDE_KEYWORDS,
  } : {}

  const trending = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, animeOverrides),
    `discover-trending-${tab}-${preferenceKey}`,
    fallback,
  )
  const topRated = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, {
      voteCountMin: tab === 'anime' ? 150 : 500,
      ...animeOverrides
    }),
    `discover-toprated-${tab}-${preferenceKey}`,
    fallback,
  )
  const moodItems = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: tab === 'anime' ? ['16', ...mood.genres.map(String)] : mood.genres.map(String),
      genreMatchMode: tab === 'anime' ? 'AND' : 'OR',
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 80 : 250,
      ...(tab === 'anime' ? { originalLanguage: 'ja', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS } : {})
    }),
    `discover-mood-${tab}-${mood.title}-${preferenceKey}`,
    fallbackVariants.mood,
  )
  const hiddenGems = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, {
      voteAverageMin: Math.max(7.2, minRating),
      voteCountMin: tab === 'anime' ? 80 : 120,
      ...animeOverrides
    }),
    `discover-gems-${tab}-${preferenceKey}`,
    fallbackVariants.gems,
  )
  const quickWatches = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      runtimeMax: contentType === 'movie' ? 100 : tab === 'anime' ? 25 : 35,
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 80 : 200,
      ...animeOverrides
    }),
    `discover-quick-${tab}-${preferenceKey}`,
    fallbackVariants.quick,
  )
  const forYou = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: tab === 'anime'
        ? ['16', ...(tasteGenre ? [String(tasteGenre)] : [])]
        : (tasteGenre ? [String(tasteGenre)] : []),
      genreMatchMode: tab === 'anime' ? 'AND' : 'OR',
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 50 : 150,
      ...(tab === 'anime' ? { originalLanguage: 'ja', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS } : {})
    }),
    `discover-for-you-${tab}-${tasteGenre || 'starter'}-${preferenceKey}`,
    fallbackVariants.taste,
  )

  const rawHeroItems = useMemo(() => trending.slice(0, 5), [trending])
  const [heroItems, setHeroItems] = useState<SearchResult[]>([])

  useEffect(() => {
    setHeroItems(rawHeroItems)
    if (rawHeroItems.length === 0) return
    let cancelled = false
    const enhance = async () => {
      const enhanced = await Promise.all(
        rawHeroItems.map(async (item) => {
          if (item.type !== 'series') return item
          const tmdbId = item.tmdbId || item.id?.replace('tmdb-', '')
          if (!tmdbId) return item
          const tvdbId = await getTvdbIdFromTmdb(tmdbId)
          if (!tvdbId) return item
          const banner = await getTvdbBanner(tvdbId)
          return banner ? { ...item, backdrop: banner } : item
        })
      )
      if (!cancelled) setHeroItems(enhanced)
    }
    enhance()
    return () => { cancelled = true }
  }, [rawHeroItems])

  const handleGenreClick = useCallback((genreId: number) => {
    if (selectedGenre === genreId) {
      setSelectedGenre(null)
      setGenreResults([])
      return
    }
    setSelectedGenre(genreId)
    setGenreLoading(true)
    discoverTmdbWithCache(
      makeConfig(contentType, 'popularity.desc', preferences, {
        includeGenres: tab === 'anime' ? ['16', String(genreId)] : [String(genreId)],
        genreMatchMode: tab === 'anime' ? 'AND' : 'OR',
        ...(tab === 'anime' ? { originalLanguage: 'ja', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS } : {})
      }),
      `discover-genre-${tab}-${genreId}-${preferenceKey}`,
    )
      .then((results) => setGenreResults(results.map(applySearchResultArt)))
      .catch(() => setGenreResults([]))
      .finally(() => setGenreLoading(false))
  }, [selectedGenre, contentType, preferences, preferenceKey, tab, setSelectedGenre, setGenreResults, setGenreLoading])

  const handleTabChange = (nextTab: DiscoverTab) => {
    setTab(nextTab)
    setSelectedGenre(null)
    setGenreResults([])
  }

  return (
    <div className="pb-12">
      <div className="px-6 pt-8 pb-6">
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
          {(['movies', 'series', 'anime'] as DiscoverTab[]).map((item) => (
            <button
              key={item}
              onClick={() => handleTabChange(item)}
              className={`px-5 py-2 rounded-xl text-sm font-semibold transition-all cursor-pointer border ${
                tab === item
                  ? 'bg-accent/15 text-accent border-accent/25'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/[0.06] border-transparent'
              }`}
            >
              {item === 'movies' ? 'Movies' : item === 'series' ? 'Series' : 'Anime'}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 mb-6 flex flex-wrap gap-2">
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
          <div className="flex items-center gap-3 px-6 py-6">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-white/40">Loading {genreMap[selectedGenre]}...</span>
          </div>
        ) : genreResults.length > 0 ? (
          <MediaRow title={genreMap[selectedGenre]} items={genreResults} layout="poster" disableArtOverride={false} />
        ) : (
          <p className="px-6 py-4 text-sm text-white/30">No results for {genreMap[selectedGenre]}</p>
        )
      ) : (
        <>
          {heroItems.length > 0 && (
            <div className="px-6 mb-8">
              <HeroSection items={heroItems} isSmall={true} />
            </div>
          )}

          {/* Platforms Row */}
          {tab !== 'anime' && (
            <div className="px-6 mb-8 select-none">
              <div className="flex items-center justify-between mb-3.5">
                <h2 className="text-lg font-bold text-white/90 tracking-tight">Platforms</h2>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-3 scrollbar-none scroll-gpu">
                {SERVICES.map((service) => (
                  <ServiceCard
                    key={service.id}
                    title={service.title}
                    videoURL={service.videoURL}
                    backgroundURL={service.backgroundURL}
                    isActive={false}
                    onClick={() => navigate(`/catalog/discover-provider-${service.title}-${contentType}?title=${encodeURIComponent(service.title + (contentType === 'movie' ? ' Movies' : ' Series'))}`)}
                  />
                ))}
              </div>
            </div>
          )}

          <MediaRow
            title={tasteGenre ? `For You · More ${genreMap[tasteGenre] || 'Like This'}` : 'For You · Start Exploring'}
            items={forYou}
            layout="landscape"
            disableArtOverride={false}
          />
          <div className="row-contain">
            <MediaRow title={`Tonight's Mood · ${mood.title}`} items={moodItems} layout="poster" disableArtOverride={false} />
          </div>
          <div className="row-contain">
            <MediaRow title={`Trending ${tab === 'movies' ? 'Movies' : tab === 'series' ? 'Series' : 'Anime'}`} items={trending} layout="landscape" disableArtOverride={false} />
          </div>
          <div className="row-contain">
            <MediaRow title="Highly Rated, Quietly Loved" items={hiddenGems} layout="poster" disableArtOverride={false} />
          </div>
          <div className="row-contain">
            <MediaRow title={contentType === 'movie' ? 'Quick Watches · Under 100 Minutes' : tab === 'anime' ? 'Quick Episodes · Around 25 Minutes' : 'Quick Episodes · Around 35 Minutes'} items={quickWatches} layout="poster" disableArtOverride={false} />
          </div>
          <div className="row-contain">
            <MediaRow title="Critically Loved" items={topRated} layout="poster" disableArtOverride={false} />
          </div>
        </>
      )}
    </div>
  )
}

