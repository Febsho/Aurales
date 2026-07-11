import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DiscoverConfig, SearchResult } from '../types'
import { discoverTmdbWithCache, getTmdbPerson, tmdbProvider } from '../services/tmdb'
import MediaRow from '../components/MediaRow'
import { applySearchResultArt } from '../services/artwork'
import { useAppStore } from '../stores/appStore'
import { useDiscoverStore, type DiscoverTab } from '../stores/discoverStore'
import WatchlistButton from '../components/WatchlistButton'
import { buildTasteProfile, generateDiscoverySections, rankCandidates } from '../services/discovery/recommendationEngine'
import { loadRecommendationFeedback, saveRecommendationFeedback } from '../services/discovery/feedbackStore'
import type { DiscoveryMode, RecommendationCandidate, RecommendationFeedback } from '../services/discovery/types'
import { getWatchedMovies as getTraktWatchedMovies, getWatchedShows as getTraktWatchedShows, getRatings as getTraktRatings } from '../services/trakt/sync'
import { getSimklWatchedMovies, getSimklWatchedEpisodes } from '../services/simkl/history'
import { getSimklWatchlist } from '../services/simkl/lists'
import { loadRecommendationImpressions, recordRecommendationImpressions } from '../services/discovery/impressionStore'
import { getTrailerSource, type TrailerSource } from '../services/trailers'
import TrailerPreview from '../components/TrailerPreview'
import { discoveryViewState } from '../services/discovery/viewState'
import { cacheClearCategory } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { collectCandidateSources } from '../services/discovery/candidatePipeline'

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

// eslint-disable-next-line react-refresh/only-export-components
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
    discoverTmdbWithCache(config, rowId, false, (fresh) => {
      import('../services/metadata/metadataResolver').then(({ enrichSearchResultsWithAppMetadata }) => enrichSearchResultsWithAppMetadata(fresh)).then((enriched) => { if (!cancelled) setCachedRow(rowId, enriched.map(applySearchResultArt)) }).catch(() => undefined)
    })
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

function recommendationCandidate(item: SearchResult, source: RecommendationCandidate['source'], overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return { item, source, voteCount:item.voteCount, popularity:item.popularity, runtimeMinutes:item.runtime, releaseDate:item.releaseDate, ...overrides }
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
  const discoveryCachedRows = useDiscoverStore((s)=>s.cachedRows)

  const region = useAppStore((s) => s.discoveryRegion)
  const minRating = useAppStore((s) => s.discoveryMinRating)
  const includeAdult = useAppStore((s) => s.discoveryIncludeAdult)
  const recentlyViewed = useAppStore((s) => s.recentlyWatched)
  const watchProgress = useAppStore((s) => s.watchProgress)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const simklConnected = useAppStore((s) => s.simklConnected)
  const [mode, setMode] = useState<DiscoveryMode>(() => (localStorage.getItem('aurales_discovery_mode') as DiscoveryMode) || 'for-you')
  const [feedback, setFeedback] = useState<RecommendationFeedback[]>(() => loadRecommendationFeedback())
  const [whyOpen, setWhyOpen] = useState(false)
  const [similarCandidates, setSimilarCandidates] = useState<RecommendationCandidate[]>([])
  const [connectedActivity, setConnectedActivity] = useState<{ items: SearchResult[]; progress: import('../types').WatchProgress[]; ratings: Array<{item:SearchResult;rating:number}>; watchlist:SearchResult[]; rewatches:SearchResult[]; bingeItems:SearchResult[] }>({ items:[], progress:[], ratings:[], watchlist:[], rewatches:[], bingeItems:[] })
  const [impressions] = useState(() => loadRecommendationImpressions())
  const [heroTrailer, setHeroTrailer] = useState<TrailerSource | null>(null)
  const [trailerOpen, setTrailerOpen] = useState(false)
  const [initialWaitComplete, setInitialWaitComplete] = useState(false)
  const [rankingNow] = useState(() => Date.now())
  const [starterGenres,setStarterGenres]=useState<number[]>(()=>{try{return JSON.parse(localStorage.getItem('aurales_discovery_starter_genres')||'[]')}catch{return[]}})
  const [refreshing,setRefreshing]=useState(false)

  useEffect(() => {
    const refreshFeedback = () => setFeedback(loadRecommendationFeedback())
    window.addEventListener('aurales:discovery-feedback', refreshFeedback)
    return () => window.removeEventListener('aurales:discovery-feedback', refreshFeedback)
  }, [])

  const genreMap = tab === 'movies' ? GENRE_MAP_MOVIE : tab === 'series' ? GENRE_MAP_TV : GENRE_MAP_ANIME
  const contentType = tab === 'movies' ? 'movie' : 'series'
  const fallback = useMemo<SearchResult[]>(() => [], [])
  const fallbackVariants = useMemo(() => ({
    taste: rotateItems(fallback, 1),
    mood: rotateItems(fallback, 3),
    gems: rotateItems(fallback, 5),
    quick: rotateItems(fallback, 7),
  }), [fallback])
  const preferences = useMemo(() => ({ region, minRating, includeAdult }), [region, minRating, includeAdult])
  const preferenceKey = `${region}-${minRating}-${includeAdult}`
  useEffect(() => { const reset=window.setTimeout(()=>setInitialWaitComplete(false),0); const timer=window.setTimeout(()=>setInitialWaitComplete(true),4000); return()=>{window.clearTimeout(reset);window.clearTimeout(timer)} },[tab,preferenceKey])
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

  useEffect(() => {
    const seeds = recentlyViewed.filter((item) => item.tmdbId != null).slice(0, 3)
    if (!seeds.length) { const timer=window.setTimeout(()=>setSimilarCandidates([]),0); return()=>window.clearTimeout(timer) }
    let cancelled = false
    collectCandidateSources(seeds.map((seed)=>({id:`similar:${seed.type}:${seed.tmdbId}`,load:async()=>{
      const id=`tmdb-${seed.tmdbId}`;const details=seed.type==='movie'?await tmdbProvider.getMovie(id):await tmdbProvider.getShow(id);const candidates=details.recommendations.map((item)=>recommendationCandidate(item,'tmdb-similar',{seedTitle:seed.title}));const director=details.crew.find((person)=>person.job==='Director'||person.job==='Creator');const people=[details.cast[0]?{id:details.cast[0].id,name:details.cast[0].name,source:'tmdb-cast' as const}:null,director?{id:director.id,name:director.name,source:'tmdb-director' as const}:null].filter((person):person is NonNullable<typeof person>=>Boolean(person));const credits=await Promise.allSettled(people.map(async(person)=>({person,details:await getTmdbPerson(person.id)})));for(const result of credits)if(result.status==='fulfilled')candidates.push(...result.value.details.credits.slice(0,12).map((item)=>recommendationCandidate(item,result.value.person.source,{seedTitle:result.value.person.name})));return candidates
    }}))).then((result) => {
      if (cancelled) return
      setSimilarCandidates(result.items.slice(0, 50))
    })
    return () => { cancelled = true }
  }, [recentlyViewed])

  useEffect(() => {
    if (!traktConnected && !simklConnected) { const timer=window.setTimeout(()=>setConnectedActivity({items:[],progress:[],ratings:[],watchlist:[],rewatches:[],bingeItems:[]}),0); return()=>window.clearTimeout(timer) }
    let cancelled = false
    Promise.allSettled([
      traktConnected ? Promise.all([getTraktWatchedMovies(),getTraktWatchedShows(),getTraktRatings('movies'),getTraktRatings('shows'),import('../services/trakt/sync').then((m)=>m.getWatchlist('movies')),import('../services/trakt/sync').then((m)=>m.getWatchlist('shows'))]) : Promise.resolve([[],[],[],[],[],[]] as const),
      simklConnected ? Promise.all([getSimklWatchedMovies(),getSimklWatchedEpisodes(),getSimklWatchlist()]) : Promise.resolve([[],[],[]] as const),
    ]).then(async ([traktResult,simklResult]) => {
      const items: SearchResult[] = []
      const rawRatings: Array<{item:SearchResult;rating:number}> = []
      const rewatches:SearchResult[]=[]; const bingeItems:SearchResult[]=[]; const watchlist:SearchResult[]=[]
      if (traktResult.status === 'fulfilled') for (const entry of [...traktResult.value[0],...traktResult.value[1]]) { const media=entry.movie||entry.show; if(media) { const mapped={id:`tmdb-${media.ids.tmdb}`,title:media.title,type:entry.movie?'movie' as const:'series' as const,year:media.year,provider:'trakt',tmdbId:media.ids.tmdb,imdbId:media.ids.imdb}; items.push(mapped); if(entry.plays>1)rewatches.push(mapped); if(entry.seasons?.some((season)=>season.episodes.filter((episode)=>episode.plays>0).length>=3))bingeItems.push(mapped) } }
      if (traktResult.status === 'fulfilled') for (const raw of [...traktResult.value[2],...traktResult.value[3]]) { if(!raw||typeof raw!=='object')continue; const record=raw as Record<string,unknown>; const media=(record.movie||record.show) as {title?:string;year?:number;ids?:{tmdb?:number;imdb?:string}}|undefined; const rating=Number(record.rating); if(media?.title&&Number.isFinite(rating)) rawRatings.push({rating,item:{id:media.ids?.tmdb?`tmdb-${media.ids.tmdb}`:media.ids?.imdb||media.title,title:media.title,type:record.movie?'movie':'series',year:media.year,provider:'trakt',tmdbId:media.ids?.tmdb,imdbId:media.ids?.imdb}}) }
      if(traktResult.status==='fulfilled')for(const raw of [...traktResult.value[4],...traktResult.value[5]]){if(!raw||typeof raw!=='object')continue;const record=raw as Record<string,unknown>;const media=(record.movie||record.show) as {title?:string;year?:number;ids?:{tmdb?:number;imdb?:string}}|undefined;if(media?.title)watchlist.push({id:media.ids?.tmdb?`tmdb-${media.ids.tmdb}`:media.ids?.imdb||media.title,title:media.title,type:record.movie?'movie':'series',year:media.year,provider:'trakt',tmdbId:media.ids?.tmdb,imdbId:media.ids?.imdb})}
      if (simklResult.status === 'fulfilled') for (const entry of [...simklResult.value[0],...simklResult.value[1]]) items.push({id:entry.tmdbId?`tmdb-${entry.tmdbId}`:entry.id,title:entry.title,type:entry.type==='movie'?'movie':'series',year:entry.year,provider:'simkl',tmdbId:entry.tmdbId,imdbId:entry.imdbId,simklId:entry.simklId,isAnime:entry.type==='anime',poster:entry.poster,backdrop:entry.backdrop})
      if(simklResult.status==='fulfilled')for(const entry of simklResult.value[2])watchlist.push({id:entry.tmdbId?`tmdb-${entry.tmdbId}`:entry.id,title:entry.title,type:entry.type==='movie'?'movie':'series',year:entry.year,provider:'simkl',tmdbId:entry.tmdbId,imdbId:entry.imdbId,simklId:entry.simklId,isAnime:entry.type==='anime',poster:entry.poster,backdrop:entry.backdrop})
      const unique=[...new Map(items.map((item)=>[`${item.type}:${item.tmdbId||item.imdbId||item.id}`,item])).values()].slice(0,120)
      const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
      const enriched=await enrichSearchResultsWithAppMetadata(unique)
      if(cancelled)return
      setConnectedActivity({items:enriched,ratings:rawRatings,watchlist,rewatches,bingeItems,progress:enriched.map((item,index)=>({id:`connected:${index}`,mediaType:item.type,mediaId:item.id,progressSeconds:1,durationSeconds:1,completed:true,title:item.title,poster:item.poster,backdrop:item.backdrop,tmdbId:item.tmdbId,imdbId:item.imdbId}))})
    }).catch(()=>undefined)
    return()=>{cancelled=true}
  },[traktConnected,simklConnected])

  const starterTasteItems=useMemo<SearchResult[]>(()=>starterGenres.map((genreId)=>({id:`taste-genre-${genreId}`,title:genreMap[genreId]||`Genre ${genreId}`,type:contentType,provider:'preference',genreIds:[genreId]})),[starterGenres,genreMap,contentType])
  const activity = useMemo(() => ({ progress: [...Array.from(watchProgress.values()),...connectedActivity.progress], recent: [...starterTasteItems,...recentlyViewed,...connectedActivity.items], ratings:connectedActivity.ratings,watchlist:connectedActivity.watchlist,rewatches:connectedActivity.rewatches,bingeItems:connectedActivity.bingeItems }), [watchProgress, recentlyViewed, connectedActivity,starterTasteItems])
  const tasteProfile = useMemo(() => buildTasteProfile(activity), [activity])
  const candidates = useMemo<RecommendationCandidate[]>(() => [
    ...forYou.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...trending.map((item) => recommendationCandidate(item,'tmdb-trending')),
    ...topRated.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...moodItems.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...hiddenGems.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...quickWatches.map((item) => recommendationCandidate(item,'tmdb-discover',{runtimeMinutes:item.runtime||(contentType==='movie'?95:30)})),
    ...similarCandidates,
  ], [forYou, trending, topRated, moodItems, hiddenGems, quickWatches, similarCandidates, contentType])
  const ranked = useMemo(() => rankCandidates(candidates, tasteProfile, activity, feedback, mode, rankingNow, impressions), [candidates, tasteProfile, activity, feedback, mode, rankingNow, impressions])
  const personalizedSections = useMemo(() => generateDiscoverySections(ranked.slice(1), tasteProfile, mode), [ranked, tasteProfile, mode])
  const heroRecommendation = ranked[0]
  const heroItem = heroRecommendation?.item
  const viewState = discoveryViewState(ranked.length,initialWaitComplete)
  const newestCandidateCacheTimestamp=Object.values(discoveryCachedRows).reduce((latest,row)=>Math.max(latest,row.timestamp),0)

  useEffect(() => {
    const reset=window.setTimeout(()=>{setHeroTrailer(null);setTrailerOpen(false)},0)
    if(!heroItem)return
    let cancelled=false
    getTrailerSource({type:heroItem.type,tmdbId:heroItem.tmdbId,title:heroItem.title,year:heroItem.year}).then((trailer)=>{if(!cancelled)setHeroTrailer(trailer)}).catch(()=>undefined)
    return()=>{cancelled=true;window.clearTimeout(reset)}
  },[heroItem])

  useEffect(() => { if (ranked.length) recordRecommendationImpressions(ranked.slice(0,40).map((entry)=>entry.item)) }, [ranked])

  const changeMode = (next: DiscoveryMode) => { localStorage.setItem('aurales_discovery_mode', next); setMode(next) }
  const toggleStarterGenre=(genreId:number)=>setStarterGenres((current)=>{const next=current.includes(genreId)?current.filter((id)=>id!==genreId):[...current,genreId].slice(-8);localStorage.setItem('aurales_discovery_starter_genres',JSON.stringify(next));return next})
  const submitFeedback = (item: SearchResult, kind: Parameters<typeof saveRecommendationFeedback>[1]) => setFeedback(saveRecommendationFeedback(item, kind))
  const refreshDiscovery=async()=>{setRefreshing(true);await cacheClearCategory(CACHE_CATEGORIES.DISCOVER);useDiscoverStore.getState().clearCache();window.location.reload()}

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
          <div className="flex items-center gap-2"><button onClick={refreshDiscovery} disabled={refreshing} className="focus-ring rounded-full border border-white/10 bg-white/[.04] px-3 py-1.5 text-xs font-bold text-white/55 disabled:opacity-50">{refreshing?'Refreshing…':'Refresh'}</button><span className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-xs text-white/45">Region {region} · {minRating > 0 ? `${minRating}+ rating` : 'all ratings'}</span></div>
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
          <div className="px-6 mb-6 flex flex-wrap gap-2" aria-label="Discovery mode">
            {([['for-you','For You'],['new','Something New'],['hidden-gems','Hidden Gems'],['critically-acclaimed','Critically Acclaimed'],['recently-released','Recently Released'],['quick-watch','Quick Watch']] as const).map(([value,label]) => <button key={value} onClick={() => changeMode(value)} className={`focus-ring rounded-full border px-4 py-2 text-xs font-bold ${mode === value ? 'border-accent/40 bg-accent/15 text-accent' : 'border-white/10 bg-white/[.04] text-white/55'}`}>{label}</button>)}
          </div>
          {tasteProfile.confidence==='low'&&<section className="mx-6 mb-8 rounded-2xl border border-accent/20 bg-accent/[.05] p-5"><h2 className="font-black">Choose a few things you like</h2><p className="mb-4 mt-1 text-sm text-white/45">This gives Aurales a starting point while your watch history grows.</p><div className="flex flex-wrap gap-2">{Object.entries(genreMap).slice(0,12).map(([id,name])=><button key={id} onClick={()=>toggleStarterGenre(Number(id))} className={`rounded-full border px-3 py-1.5 text-sm ${starterGenres.includes(Number(id))?'border-accent/50 bg-accent/15 text-accent':'border-white/10 bg-white/[.04] text-white/60'}`}>{name}</button>)}</div></section>}
          {viewState==='content'&&heroRecommendation ? <section className="relative mx-6 mb-10 min-h-[430px] overflow-hidden rounded-[2rem] border border-white/10 bg-white/[.03]">
            {(heroRecommendation.item.backdrop || heroRecommendation.item.poster) && <img src={heroRecommendation.item.backdrop || heroRecommendation.item.poster} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-black/10" />
            <div className="relative z-10 flex min-h-[430px] max-w-2xl flex-col justify-end p-8 md:p-12">
              <h2 className="text-4xl font-black md:text-6xl">{heroRecommendation.item.title}</h2>
              <div className="my-3 flex flex-wrap items-center gap-2 text-sm font-bold"><span className="rounded-full bg-emerald-400/15 px-3 py-1 text-emerald-300">{heroRecommendation.matchPercent}% match for you</span>{heroRecommendation.item.year && <span>{heroRecommendation.item.year}</span>}<span>{heroRecommendation.runtimeMinutes?`${heroRecommendation.runtimeMinutes} min`:heroRecommendation.item.type==='series'?'Series':'Movie'}</span>{heroRecommendation.item.genres?.slice(0,3).map((genre)=><span key={genre}>{genre}</span>)}</div>
              <p className="mb-2 text-sm font-semibold text-accent">{heroRecommendation.reasons[0]?.label}</p>
              {heroRecommendation.item.overview && <p className="mb-5 line-clamp-3 text-white/65">{heroRecommendation.item.overview}</p>}
              <div className="flex flex-wrap gap-2"><button onClick={() => navigate(heroRecommendation.item.type === 'movie' ? `/movie/${heroRecommendation.item.id}` : `/series/${heroRecommendation.item.id}`, { state:{...heroRecommendation.item,autoPlay:true} })} className="focus-ring rounded-full bg-white px-6 py-2.5 font-black text-black">Watch</button>{heroTrailer&&<button onClick={()=>setTrailerOpen(true)} className="focus-ring rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold">Trailer</button>}<WatchlistButton mediaRef={{localId:heroRecommendation.item.id,title:heroRecommendation.item.title,year:heroRecommendation.item.year,type:heroRecommendation.item.isAnime?'anime':heroRecommendation.item.type==='series'?'show':'movie',imdbId:heroRecommendation.item.imdbId,tmdbId:heroRecommendation.item.tmdbId?Number(heroRecommendation.item.tmdbId):undefined}} mediaType={heroRecommendation.item.type}/><button onClick={() => submitFeedback(heroRecommendation.item,'not-interested')} className="focus-ring rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold">Not Interested</button><button onClick={() => setWhyOpen(true)} className="focus-ring rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold">Why This?</button></div>
            </div>
          </section> : viewState==='error' ? <div className="mx-6 mb-8 grid min-h-72 place-items-center rounded-3xl border border-white/10 bg-white/[.03] p-8 text-center"><div><h2 className="text-xl font-black">Recommendations are unavailable</h2><p className="mt-2 max-w-md text-sm text-white/45">Cached discovery data was not available and recommendation sources could not be loaded. Check your network or TMDB settings.</p><button onClick={()=>window.location.reload()} className="mt-5 rounded-full bg-white px-5 py-2 font-bold text-black">Retry</button></div></div> : <div className="mx-6 mb-8 animate-pulse"><div className="h-[430px] rounded-[2rem] bg-white/[.06]"/><div className="mt-5 flex gap-4 overflow-hidden">{Array.from({length:7}).map((_,index)=><div key={index} className="h-64 w-44 flex-shrink-0 rounded-2xl bg-white/[.05]"/>)}</div></div>}
          {tasteProfile.signals.length > 0 && <section className="mx-6 mb-9 rounded-2xl border border-white/10 bg-white/[.035] p-5"><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-black">Your Taste Map</h2><span className="text-xs text-white/35">{tasteProfile.confidence} confidence</span></div><div className="flex flex-wrap gap-2">{tasteProfile.signals.map((signal) => <button key={`${signal.kind}:${signal.value}`} onClick={() => { const genre=Object.entries(genreMap).find(([,name])=>name===signal.value); if(genre) handleGenreClick(Number(genre[0])) }} className="focus-ring rounded-full border border-white/10 bg-white/[.05] px-3 py-1.5 text-sm text-white/70">{signal.value}</button>)}</div></section>}
          {personalizedSections.map((section) => <div key={section.id} className="row-contain"><MediaRow title={section.title} items={section.items.map((entry)=>entry.item)} layout={section.id==='made-for-you'||section.id==='mode'?'landscape':'poster'} /></div>)}
          {whyOpen && heroRecommendation && <div role="dialog" aria-modal="true" className="fixed inset-0 z-[10000] grid place-items-center bg-black/65 p-6" onClick={()=>setWhyOpen(false)}><div className="max-w-lg rounded-3xl border border-white/15 bg-[#111] p-6" onClick={(event)=>event.stopPropagation()}><h2 className="text-xl font-black">Why {heroRecommendation.item.title}?</h2><p className="my-3 text-sm text-white/45">Based on your local Aurales activity and title metadata.</p>{heroRecommendation.reasons.map((reason)=><div key={reason.code} className="mb-2 rounded-xl bg-white/[.05] p-3 text-sm">{reason.label}</div>)}<div className="mt-4 flex flex-wrap gap-2"><button onClick={()=>submitFeedback(heroRecommendation.item,'more-like-this')} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold">More like this</button><button onClick={()=>submitFeedback(heroRecommendation.item,'less-like-this')} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold">Less like this</button><button onClick={()=>submitFeedback(heroRecommendation.item,'already-seen')} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold">I've seen this</button><button onClick={()=>submitFeedback(heroRecommendation.item,'hide')} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold">Hide title</button></div>{import.meta.env.DEV&&<pre className="mt-4 overflow-auto rounded-xl bg-black p-3 text-xs text-white/45">{JSON.stringify({source:heroRecommendation.source,cacheAgeSeconds:newestCandidateCacheTimestamp?Math.round((rankingNow-newestCandidateCacheTimestamp)/1000):null,reasons:heroRecommendation.reasons,score:heroRecommendation.score},null,2)}</pre>}<button onClick={()=>setWhyOpen(false)} className="mt-5 rounded-full bg-white px-5 py-2 font-bold text-black">Close</button></div></div>}
          {trailerOpen&&heroTrailer&&<div role="dialog" aria-modal="true" aria-label="Trailer" className="fixed inset-0 z-[10000] grid place-items-center bg-black/80 p-6" onClick={()=>setTrailerOpen(false)}><div className="aspect-video w-[min(70rem,92vw)] overflow-hidden rounded-3xl border border-white/15 bg-black" onClick={(event)=>event.stopPropagation()}><TrailerPreview trailer={heroTrailer} title={heroRecommendation?.item.title||'Trailer'} muted={false} eager/></div></div>}
        </>
      )}
    </div>
  )
}

