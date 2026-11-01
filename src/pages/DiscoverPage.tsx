import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, RotateCcw, Search, Shuffle, X } from 'lucide-react'
import type { DiscoverConfig, SearchResult, WatchProgress } from '../types'
import { discoverTmdbWithCache, getTmdbPerson, tmdbProvider } from '../services/tmdb'
import MediaRow from '../components/MediaRow'
import { applySearchResultArt, resolveArtFromProviders } from '../services/artwork'
import { useAppStore } from '../stores/appStore'
import { useCatalogStore } from '../stores/catalogStore'
import { useDiscoverStore, type DiscoverTab } from '../stores/discoverStore'
import WatchlistButton from '../components/WatchlistButton'
import CatalogKeyNotice from '../components/CatalogKeyNotice'
import { applyRecommendationFeedback, buildTasteProfile, generateDiscoverySections, rankCandidates } from '../services/discovery/recommendationEngine'
import { loadRecommendationFeedback, resetTasteFeedback, saveRecommendationFeedback } from '../services/discovery/feedbackStore'
import type { DiscoveryMode, RecommendationCandidate, RecommendationFeedback } from '../services/discovery/types'
import { getWatchedMovies as getTraktWatchedMovies, getWatchedShows as getTraktWatchedShows, getRatings as getTraktRatings } from '../services/trakt/sync'
import { getSimklWatchedMovies, getSimklWatchedEpisodes } from '../services/simkl/history'
import { getSimklWatchlist } from '../services/simkl/lists'
import { getStremioAuth, getStremioWatchHistory, type StremioLibraryEntry } from '../services/stremio'
import type { AniListFullEntry } from '../services/anilist'
import { useDiscoverPrefsStore, getDiscoverPrefs, excludeGenreIds, onlyGenreIds, candidatePassesPrefs, prefsSignature, prefsWeights } from '../stores/discoverPrefsStore'
import { loadRecommendationImpressions, recordRecommendationImpressions } from '../services/discovery/impressionStore'
import { getTrailerSource, type TrailerSource } from '../services/trailers'
import TrailerPreview from '../components/TrailerPreview'
import { discoveryViewState } from '../services/discovery/viewState'
import { collectCandidateSources } from '../services/discovery/candidatePipeline'
import { catalogContentFingerprint } from '../services/cache/homeStartupSnapshot'
import { providerCacheScope } from '../services/cache/homeRowCacheKeys'
import { berlinDaySeed, getBerlinDateKey, getNextBerlinMidnight } from '../services/discovery/berlinDate'
import { DISCOVERY_ALGORITHM_VERSION, latestSnapshotForScope, makeDailySnapshotKey } from '../services/discovery/dailySnapshot'
import { getActiveProfileId } from '../services/profiles'
import { getServerCatalogItems, listServerCatalogs } from '../services/serverIntegrations'
import { dedupeMediaItems, mediaIdentity } from '../services/mediaPresentation'
import { getLocalWatchlist, subscribeLocalWatchlist } from '../services/localWatchlist'

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
// Impressions recorded this session — once per day/tab/mode, so revisiting Discover
// doesn't re-penalize the shown titles and reshuffle the recommendations every time
const IMPRESSIONS_RECORDED = new Set<string>()
const MAX_DISCOVER_SESSION_KEYS = 500
// Keep anime out of the Movies/Series tabs — it lives in the Anime tab only
const ANIME_EXCLUDE_KEYWORDS = [{ id: 210024, name: 'anime' }]

const DISCOVERY_SECTION_TITLES: Record<string, string> = {
  'made-for-you': 'Recommended',
  'hidden-gems': 'Hidden Gems',
  new: 'Recently Released',
  critics: 'Critically Acclaimed',
}

function readDiscoveryPicks(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 3) : []
  } catch {
    return []
  }
}

function DiscoveryPicker({ item, onClose, onSpin, onOpen, isSpinning }: {
  item: SearchResult
  onClose: () => void
  onSpin: () => void
  onOpen: () => void
  isSpinning: boolean
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = Array.from(document.querySelectorAll<HTMLElement>('.discover-picker button'))
      if (!controls.length) return
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    window.addEventListener('keydown', onKeyDown)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); returnFocusTo?.focus() }
  }, [onClose])

  const poster = item.poster || item.backdrop
  const genre = item.genres?.slice(0, 2).join(' · ') || (item.isAnime ? 'Anime' : item.type === 'series' ? 'Series' : 'Movie')
  return <div className="discover-picker-backdrop" role="presentation" onClick={onClose}>
    <section className="discover-picker" role="dialog" aria-modal="true" aria-labelledby="discover-picker-title" onClick={(event) => event.stopPropagation()}>
      <div className="discover-picker__grabber" aria-hidden="true" />
      <button ref={closeButtonRef} className="discover-picker__close" type="button" aria-label="Close picker" onClick={onClose}><X size={19} /></button>
      <div key={item.id} className={`discover-picker__reveal${isSpinning ? ' is-spinning' : ''}`}>
        {poster ? <img className="discover-picker__poster" src={poster} alt={`${item.title} poster`} /> : <div className="discover-picker__poster discover-picker__poster--empty" aria-hidden="true">A</div>}
      </div>
      <p className="discover-picker__eyebrow">Tonight, try</p>
      <h2 key={`title-${item.id}`} id="discover-picker-title" className={isSpinning ? 'is-spinning' : ''} aria-live="polite">{item.title}</h2>
      <p className="discover-picker__meta">{genre}{item.year ? ` · ${item.year}` : ''}{item.rating != null ? ` · ★ ${Number(item.rating).toFixed(1)}` : ''}</p>
      {isSpinning && <p className="discover-picker__status" role="status">Finding tonight’s pick…</p>}
      <div className="discover-picker__actions">
        <button className="discover-picker__open" type="button" onClick={onOpen} disabled={isSpinning}>Open</button>
        <button className="discover-picker__spin" type="button" onClick={onSpin} disabled={isSpinning}><Shuffle size={17} /> <span>Another option</span></button>
      </div>
    </section>
  </div>
}

// Anime = explicitly flagged, or Japanese-language animation. Plain genre-16 animation
// (Pixar, DreamWorks, ...) is NOT anime.
function isAnimeLike(entry: SearchResult): boolean {
  return Boolean(entry.isAnime || (entry.genreIds?.includes(16) && ['ja', 'zh', 'ko'].includes(entry.originalLanguage || '')))
}

function matchesDiscoverTab(entry: SearchResult, tab: DiscoverTab): boolean {
  if (tab === 'anime') return isAnimeLike(entry)
  if (tab === 'movies') return entry.type === 'movie' && !isAnimeLike(entry)
  return entry.type === 'series' && !isAnimeLike(entry)
}
const FORCED_DISCOVERY_REFRESHES = new Set<string>()

function rememberDiscoverSessionKey(set: Set<string>, key: string): void {
  set.delete(key)
  set.add(key)
  while (set.size > MAX_DISCOVER_SESSION_KEYS) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

function makeConfig(
  contentType: 'movie' | 'series',
  sortBy: string,
  preferences: { region: string; minRating: number; includeAdult: boolean },
  overrides: Partial<DiscoverConfig> = {},
): DiscoverConfig {
  const config: DiscoverConfig = {
    source: 'TMDB',
    contentType,
    sortBy,
    cacheTtl: 24 * 60 * 60,
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

  // Fold the user's Discover preferences into every row query so exclusions and
  // thresholds are enforced at fetch time (candidatePassesPrefs is the safety net)
  const prefs = getDiscoverPrefs()

  // Audience mode adjustments
  if (prefs.audienceMode === 'grown-up') {
    // Exclude Kids (10762) and Family (10751)
    config.excludeGenres = [...new Set([...config.excludeGenres, '10762', '10751'])]
  } else if (prefs.audienceMode === 'kid-safe') {
    // Exclude Horror (27), Thriller (53), Crime (80)
    config.excludeGenres = [...new Set([...config.excludeGenres, '27', '53', '80'])]
  }

  const excludeIds = excludeGenreIds(prefs)
  if (excludeIds.length) config.excludeGenres = [...new Set([...config.excludeGenres, ...excludeIds.map(String)])]

  const onlyIds = onlyGenreIds(prefs)
  if (onlyIds.length) config.includeGenres = [...new Set([...config.includeGenres, ...onlyIds.map(String)])]

  if (prefs.onlyLanguages?.length) {
    config.originalLanguage = prefs.onlyLanguages.join('|')
  }

  if (prefs.minVoteAverage != null) config.voteAverageMin = Math.max(config.voteAverageMin, prefs.minVoteAverage)
  if (prefs.minVoteCount != null) config.voteCountMin = Math.max(config.voteCountMin ?? 0, prefs.minVoteCount)
  if (prefs.yearFrom != null) config.releaseDateFrom = `${prefs.yearFrom}-01-01`
  if (prefs.yearTo != null) config.releaseDateTo = `${prefs.yearTo}-12-31`

  if (prefs.runtimeMin != null) config.runtimeMin = prefs.runtimeMin
  if (prefs.runtimeMax != null) config.runtimeMax = prefs.runtimeMax

  if (prefs.mustIncludeKeywords?.length) {
    config.includeKeywords = [...config.includeKeywords, ...prefs.mustIncludeKeywords]
  }
  if (prefs.excludeKeywords?.length) {
    config.excludeKeywords = [...config.excludeKeywords, ...prefs.excludeKeywords]
  }
  if (prefs.includeCompanies?.length) {
    config.includeCompanies = [...config.includeCompanies, ...prefs.includeCompanies]
  }

  if (prefs.selectedProviders?.length) {
    const PROVIDER_TMDB_MAP: Record<string, { ids: number[]; name: string }> = {
      "Netflix": { ids: [8], name: "Netflix" },
      "Amazon Prime": { ids: [9, 119], name: "Amazon Prime Video" },
      "Disney+": { ids: [337], name: "Disney+" },
      "Max": { ids: [1899, 384], name: "Max" },
      "Apple TV+": { ids: [350], name: "Apple TV+" },
      "Hulu": { ids: [15], name: "Hulu" },
      "Paramount+": { ids: [531], name: "Paramount+" },
      "Peacock": { ids: [386, 387], name: "Peacock" },
      "Crunchyroll": { ids: [283], name: "Crunchyroll" },
      "AMC+": { ids: [528], name: "AMC+" },
      "Apple iTunes": { ids: [2], name: "Apple iTunes" },
      "Google Play": { ids: [3], name: "Google Play Movies" },
      "YouTube": { ids: [192], name: "YouTube" },
      "MUBI": { ids: [11], name: "MUBI" },
      "Curiosity Stream": { ids: [190], name: "Curiosity Stream" },
      "GuideDoc": { ids: [222], name: "GuideDoc" },
      "Criterion Channel": { ids: [258], name: "The Criterion Channel" },
      "Kanopy": { ids: [191], name: "Kanopy" },
      "Tubi": { ids: [73], name: "Tubi TV" },
      "Pluto TV": { ids: [300], name: "Pluto TV" },
    }
    const providers = prefs.selectedProviders.flatMap((name) => {
      const p = PROVIDER_TMDB_MAP[name]
      if (!p) return []
      return p.ids.map((id) => ({ id, name: p.name }))
    })
    config.selectedProviders = [...config.selectedProviders, ...providers]
  }

  if (prefs.contentRating) {
    config.certificationCountry = preferences.region || 'US'
    config.certificationLte = prefs.contentRating
  }

  return config
}

function useDiscoverRow(config: DiscoverConfig, rowId: string, fallback: SearchResult[] = [], enabled = true, refreshNonce = 0) {
  const setCachedRow = useDiscoverStore((s) => s.setCachedRow)

  // Read cache snapshot once — avoid putting cachedRows in deps to prevent feedback loops
  const items = useDiscoverStore((s) => s.cachedRows[rowId]?.items) ?? []
  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let staleRefreshStarted = false
    const forceKey = `${rowId}:${refreshNonce}`
    const forceRefresh = refreshNonce > 0 && !FORCED_DISCOVERY_REFRESHES.has(forceKey)
    if (forceRefresh) rememberDiscoverSessionKey(FORCED_DISCOVERY_REFRESHES, forceKey)
    discoverTmdbWithCache(config, rowId, forceRefresh, (fresh) => {
      if (cancelled) return
      staleRefreshStarted = true
      import('../services/metadata/metadataResolver')
        .then(({ enrichSearchResultsWithAppMetadata }) => enrichSearchResultsWithAppMetadata(fresh))
        .then((enriched) => { if (!cancelled) setCachedRow(rowId, enriched.map(applySearchResultArt)) })
        .catch(() => { if (!cancelled) setCachedRow(rowId, fresh.map(applySearchResultArt)) })
    })
      .then(async (results) => {
        if (cancelled) return
        if (results.length === 0 && items.length > 0) return
        const rawItems = results.length > 0 ? results : fallback
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(rawItems)
        const finalItems = enriched.map(applySearchResultArt)
        if (!cancelled && !staleRefreshStarted && (finalItems.length > 0 || items.length === 0)) setCachedRow(rowId, finalItems)
      })
      .catch(async () => {
        if (cancelled || items.length > 0) return
        const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
        const enriched = await enrichSearchResultsWithAppMetadata(fallback)
        const finalItems = enriched.map(applySearchResultArt)
        if (!cancelled) setCachedRow(rowId, finalItems)
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, enabled, refreshNonce])

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

function opaqueScope(value: string | null): string {
  if (!value) return 'none'
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(36)
}

function recommendationCandidate(item: SearchResult, source: RecommendationCandidate['source'], overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return { item, source, voteCount:item.voteCount, popularity:item.popularity, runtimeMinutes:item.runtime, releaseDate:item.releaseDate, ...overrides }
}

function discoveryProgressSignature(progress: Map<string, WatchProgress>, rankingNow: number): string {
  const tasteProgress: unknown[][] = []
  const tasteItems: unknown[][] = []
  const watchedSeeds: unknown[][] = []
  for (const item of progress.values()) {
    tasteProgress.push([item.id, item.mediaId, item.tmdbId, item.imdbId, item.completed])
    if (item.tmdbId != null && (item.completed || item.progressSeconds > 120)) {
      watchedSeeds.push([item.mediaId || `tmdb-${item.tmdbId}`, item.title || '', item.mediaType === 'movie' ? 'movie' : 'series', item.tmdbId, item.imdbId, item.poster, item.backdrop, item.malId, item.anilistId])
    }
    const abandoned = Boolean(item.updatedAt && Date.parse(item.updatedAt) < rankingNow - 14 * 86400_000 && item.durationSeconds > 0 && item.progressSeconds / item.durationSeconds >= .08)
    if (item.completed || abandoned) {
      tasteItems.push([item.completed ? 1 : 0, abandoned ? 1 : 0, item.mediaType === 'movie' ? 'movie' : 'series', item.mediaId, item.tmdbId, item.imdbId, item.title || ''])
    }
  }
  // Zustand's watchProgress map is replaced immutably while preserving its
  // insertion order. Sorting here made each progress update pay O(n log n)
  // plus repeated JSON serialization in the comparator.
  return JSON.stringify([tasteProgress, tasteItems, watchedSeeds])
}

export default function DiscoverPage() {
  const navigate = useNavigate()
  const tab = useDiscoverStore((s) => s.tab)
  const setTab = useDiscoverStore((s) => s.setTab)
  const persistedRankings = useDiscoverStore((s) => s.rankedSnapshots)
  const dailySnapshotMeta = useDiscoverStore((s) => s.dailySnapshotMeta)
  const catalogSetCache = useCatalogStore((s) => s.setCache)

  const region = useAppStore((s) => s.discoveryRegion)
  const minRating = useAppStore((s) => s.discoveryMinRating)
  const includeAdult = useAppStore((s) => s.discoveryIncludeAdult)
  const recentlyViewed = useAppStore((s) => s.recentlyWatched)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const simklConnected = useAppStore((s) => s.simklConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const stremioAuthKey = useMemo(() => getStremioAuth()?.authKey ?? null, [])
  const accountScope = useMemo(() => [
    traktConnected ? `trakt:${providerCacheScope('trakt')}` : '',
    simklConnected ? `simkl:${providerCacheScope('simkl')}` : '',
    anilistConnected ? `anilist:${providerCacheScope('anilist')}` : '',
    stremioAuthKey ? `stremio:${opaqueScope(stremioAuthKey)}` : '',
  ].filter(Boolean).join('|') || 'local', [traktConnected, simklConnected, anilistConnected, stremioAuthKey])
  const [mode, setMode] = useState<DiscoveryMode>(() => (localStorage.getItem('aurales_discovery_mode') as DiscoveryMode) || 'for-you')
  const prefs = useDiscoverPrefsStore((s) => s.prefs)

  const [feedback, setFeedback] = useState<RecommendationFeedback[]>(() => loadRecommendationFeedback())
  const [similarCandidates, setSimilarCandidates] = useState<RecommendationCandidate[]>([])
  const [watchedTasteMetadata, setWatchedTasteMetadata] = useState<NonNullable<import('../services/discovery/types').DiscoveryActivity['tasteMetadata']>>([])
  const [connectedActivity, setConnectedActivity] = useState<{ items: SearchResult[]; progress: import('../types').WatchProgress[]; ratings: Array<{item:SearchResult;rating:number}>; watchlist:SearchResult[]; rewatches:SearchResult[]; bingeItems:SearchResult[] }>({ items:[], progress:[], ratings:[], watchlist:[], rewatches:[], bingeItems:[] })
  const [localWatchlist, setLocalWatchlist] = useState<SearchResult[]>(() => getLocalWatchlist())
  useEffect(() => subscribeLocalWatchlist(() => setLocalWatchlist(getLocalWatchlist())), [])
  const [impressions] = useState(() => loadRecommendationImpressions())
  const [heroTrailer, setHeroTrailer] = useState<TrailerSource | null>(null)
  const [trailerOpen, setTrailerOpen] = useState(false)
  const [initialWaitComplete, setInitialWaitComplete] = useState(false)
  const [serverDiscoverItems, setServerDiscoverItems] = useState<SearchResult[]>([])
  const [moodIndex, setMoodIndex] = useState(0)
  const [tasteQuery, setTasteQuery] = useState('')
  const [bingeIndex, setBingeIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const catalogs = await listServerCatalogs()
        const relevant = catalogs.filter((catalog) => {
          if (catalog.kind !== 'library') return false
          if (tab === 'movies') return catalog.contentType === 'movie' || catalog.catalogId === 'movies'
          if (tab === 'anime') return catalog.contentType === 'anime' || catalog.catalogId === 'anime'
          return catalog.contentType === 'series' || catalog.catalogId === 'series'
        })
        const settled = await Promise.allSettled(relevant.map((catalog) => (
          getServerCatalogItems(catalog.connectionId, catalog.catalogId, 40)
        )))
        if (cancelled) return
        const merged = dedupeMediaItems(settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
          .filter((item) => tab === 'anime' ? item.isAnime : tab === 'movies' ? item.type === 'movie' && !item.isAnime : item.type === 'series' && !item.isAnime)
          .slice(0, 40)
        setServerDiscoverItems(merged)
      } catch {
        if (!cancelled) setServerDiscoverItems([])
      }
    }
    void load()
    window.addEventListener('aurales:server-catalogs-changed', load)
    return () => { cancelled = true; window.removeEventListener('aurales:server-catalogs-changed', load) }
  }, [tab])
  // Rank against the start of the day, not the exact mount time, so recency scoring
  // is identical on every visit within a day (a source of visit-to-visit reshuffling)
  const [berlinDateKey, setBerlinDateKey] = useState(() => getBerlinDateKey())
  const rankingNow = Date.parse(`${berlinDateKey}T00:00:00.000Z`)
  const watchProgress = useAppStore((state) => state.watchProgress)
  const progressSignature = useMemo(
    () => discoveryProgressSignature(watchProgress, rankingNow),
    [watchProgress, rankingNow],
  )
  const progressSignals = useMemo(() => {
    const [tasteProgress, tasteItems, watchedSeeds] = JSON.parse(progressSignature) as [string, string, string]
    return { tasteProgress, tasteItems, watchedSeeds }
  }, [progressSignature])
  const watchProgressRef = useRef(watchProgress)
  watchProgressRef.current = watchProgress
  const [starterGenres]=useState<number[]>(()=>{try{const saved=JSON.parse(localStorage.getItem('aurales_discovery_starter_genres')||'[]');return Array.isArray(saved)?saved.filter((value):value is number=>Number.isFinite(value)):[]}catch{return[]}})
  const [heroIndex,setHeroIndex]=useState(0)
  const [heroLogoError,setHeroLogoError]=useState(false)
  const [heroArt,setHeroArt]=useState<Record<string,{poster?:string;backdrop?:string;logo?:string}>>({})
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickOffset, setPickOffset] = useState(0)
  const pickStorageKey = `aurales_discovery_picks:${getActiveProfileId()}:${tab}`
  const [pickedIds, setPickedIds] = useState<string[]>(() => readDiscoveryPicks(pickStorageKey))

  useEffect(() => { setPickedIds(readDiscoveryPicks(pickStorageKey)); setPickOffset(0) }, [pickStorageKey])

  useEffect(() => {
    const refreshDate = () => setBerlinDateKey((current) => {
      const next = getBerlinDateKey()
      return next === current ? current : next
    })
    const delay = Math.max(1_000, getNextBerlinMidnight().getTime() - Date.now() + 250)
    const timer = window.setTimeout(refreshDate, delay)
    window.addEventListener('focus', refreshDate)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refreshDate)
    }
  }, [berlinDateKey])

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
  // Advanced preferences change the TMDB request itself. Include a compact
  // signature in every row key so a provider/language/genre change cannot
  // silently reuse results fetched for the previous query.
  const discoveryPrefsKey = opaqueScope(prefsSignature(prefs))
  const discoveryQueryKey = `${preferenceKey}-${discoveryPrefsKey}`
  // Snapshots are durable per person and Berlin date.  Switching away and
  // back therefore restores that profile's frozen daily Discover ranking.
  const dailySnapshotScope = `${getActiveProfileId()}:${tab}:${mode}:${discoveryQueryKey}:${accountScope}`
  const dailySnapshotKey = makeDailySnapshotKey(berlinDateKey, dailySnapshotScope)
  const dailySnapshot = persistedRankings[dailySnapshotKey]
  const hasDailySnapshot = Boolean(dailySnapshot?.length)
  const refreshNonce = 0
  useEffect(() => { const reset=window.setTimeout(()=>setInitialWaitComplete(false),0); const timer=window.setTimeout(()=>setInitialWaitComplete(true),4000); return()=>{window.clearTimeout(reset);window.clearTimeout(timer)} },[tab,discoveryQueryKey,mode])
  const tasteGenre = useMemo(() => getTopGenre(recentlyViewed, contentType), [recentlyViewed, contentType])
  const moodOptions = useMemo(() => tab === 'movies' ? MOVIE_MOODS : tab === 'series' ? SERIES_MOODS : ANIME_MOODS, [tab])
  const mood = moodOptions[moodIndex % moodOptions.length]!

  useEffect(() => { setMoodIndex(berlinDaySeed(new Date(`${berlinDateKey}T12:00:00.000Z`)) % 3) }, [tab, berlinDateKey])

  const animeOverrides = tab === 'anime' ? {
    originalLanguage: 'ja',
    includeGenres: ['16'],
    excludeKeywords: HENTAI_EXCLUDE_KEYWORDS,
  } : {
    excludeKeywords: ANIME_EXCLUDE_KEYWORDS,
  }

  const trending = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, animeOverrides),
    `discover-trending-${tab}-${discoveryQueryKey}`,
    fallback,
    !hasDailySnapshot,
    refreshNonce,
  )
  const topRated = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, {
      voteCountMin: tab === 'anime' ? 150 : 500,
      ...animeOverrides
    }),
    `discover-toprated-${tab}-${discoveryQueryKey}`,
    fallback,
    !hasDailySnapshot,
    refreshNonce,
  )
  const moodItems = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: tab === 'anime' ? ['16', ...mood.genres.map(String)] : mood.genres.map(String),
      genreMatchMode: tab === 'anime' ? 'AND' : 'OR',
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 80 : 250,
      ...(tab === 'anime' ? { originalLanguage: 'ja', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS } : { excludeKeywords: ANIME_EXCLUDE_KEYWORDS })
    }),
    `discover-mood-${tab}-${mood.title}-${discoveryQueryKey}`,
    fallbackVariants.mood,
    !hasDailySnapshot,
    refreshNonce,
  )
  const hiddenGems = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, {
      voteAverageMin: Math.max(7.2, minRating),
      voteCountMin: tab === 'anime' ? 80 : 120,
      ...animeOverrides
    }),
    `discover-gems-${tab}-${discoveryQueryKey}`,
    fallbackVariants.gems,
    !hasDailySnapshot,
    refreshNonce,
  )
  const quickWatches = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      runtimeMax: contentType === 'movie' ? 100 : tab === 'anime' ? 25 : 35,
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 80 : 200,
      ...animeOverrides
    }),
    `discover-quick-${tab}-${discoveryQueryKey}`,
    fallbackVariants.quick,
    !hasDailySnapshot,
    refreshNonce,
  )
  // Anime movies — the anime tab's discover rows are series-only, so without these
  // rows anime films would never surface in the anime category
  const animeMovieOverrides = { originalLanguage: 'ja', includeGenres: ['16'], genreMatchMode: 'AND' as const, excludeKeywords: HENTAI_EXCLUDE_KEYWORDS }
  const animeMovies = useDiscoverRow(
    makeConfig('movie', 'popularity.desc', preferences, { ...animeMovieOverrides, voteCountMin: 100 }),
    `discover-anime-movies-${discoveryQueryKey}`,
    fallback,
    tab === 'anime' && !hasDailySnapshot,
    refreshNonce,
  )
  const animeMoviesTop = useDiscoverRow(
    makeConfig('movie', 'vote_average.desc', preferences, { ...animeMovieOverrides, voteCountMin: 150, voteAverageMin: Math.max(7, minRating) }),
    `discover-anime-movies-top-${discoveryQueryKey}`,
    fallback,
    tab === 'anime' && !hasDailySnapshot,
    refreshNonce,
  )
  const forYou = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: tab === 'anime'
        ? ['16', ...(tasteGenre ? [String(tasteGenre)] : [])]
        : (tasteGenre ? [String(tasteGenre)] : []),
      genreMatchMode: tab === 'anime' ? 'AND' : 'OR',
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 50 : 150,
      ...(tab === 'anime' ? { originalLanguage: 'ja', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS } : { excludeKeywords: ANIME_EXCLUDE_KEYWORDS })
    }),
    `discover-for-you-${tab}-${tasteGenre || 'starter'}-${discoveryQueryKey}`,
    fallbackVariants.taste,
    !hasDailySnapshot,
    refreshNonce,
  )

  // Titles the user actually watched — local playback progress + connected watch
  // history. "Because You Watched" must seed from these, NOT from merely-opened items.
  const watchedForSeeds = useMemo<SearchResult[]>(() => {
    const fromProgress: SearchResult[] = Array.from(watchProgressRef.current.values())
      .filter((p) => p.tmdbId != null && (p.completed || p.progressSeconds > 120))
      .map((p): SearchResult => ({ id: p.mediaId || `tmdb-${p.tmdbId}`, title: p.title || '', type: p.mediaType === 'movie' ? 'movie' : 'series', provider: 'progress', tmdbId: p.tmdbId, imdbId: p.imdbId, poster: p.poster, backdrop: p.backdrop, malId: p.malId, anilistId: p.anilistId }))
    return [...fromProgress, ...connectedActivity.items]
    // This signature intentionally gates ref reads: seconds-only checkpoints
    // keep the same seed identities and must not restart metadata requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressSignals.watchedSeeds, connectedActivity.items])

  useEffect(() => {
    if (hasDailySnapshot) return
    // Clear previous tab's candidates and metadata before collecting new seeds.
    setSimilarCandidates([])
    setWatchedTasteMetadata([])
    // Seeds and candidates must match the active tab: movies seed movies, series seed
    // non-anime series, and the anime tab only seeds/keeps anime titles (movies included).
    const matchesTab = (entry: SearchResult) => tab === 'anime'
      ? isAnimeLike(entry)
      : entry.type === contentType && !isAnimeLike(entry)
    const seeds = watchedForSeeds.filter((item) => item.tmdbId != null && matchesTab(item)).slice(0, 3)
    if (!seeds.length) return
    let cancelled = false
    const metadata: NonNullable<import('../services/discovery/types').DiscoveryActivity['tasteMetadata']> = []
    collectCandidateSources(seeds.map((seed)=>({id:`similar:${seed.type}:${seed.tmdbId}`,load:async()=>{
      const id=`tmdb-${seed.tmdbId}`;const details=seed.type==='movie'?await tmdbProvider.getMovie(id):await tmdbProvider.getShow(id);metadata.push({item:seed,runtimeMinutes:'runtime' in details ? details.runtime : undefined,cast:details.cast.slice(0,5).map((person)=>person.name),directors:details.crew.filter((person)=>person.job==='Director'||person.job==='Creator').slice(0,3).map((person)=>person.name)});const candidates=details.recommendations.map((item)=>recommendationCandidate(item,'tmdb-similar',{seedTitle:seed.title}));const director=details.crew.find((person)=>person.job==='Director'||person.job==='Creator');const people=[details.cast[0]?{id:details.cast[0].id,name:details.cast[0].name,source:'tmdb-cast' as const}:null,director?{id:director.id,name:director.name,source:'tmdb-director' as const}:null].filter((person):person is NonNullable<typeof person>=>Boolean(person));const credits=await Promise.allSettled(people.map(async(person)=>({person,details:await getTmdbPerson(person.id)})));for(const result of credits)if(result.status==='fulfilled')candidates.push(...result.value.details.credits.slice(0,12).map((item)=>recommendationCandidate(item,result.value.person.source,{seedTitle:result.value.person.name,...(result.value.person.source === 'tmdb-cast' ? {cast:[result.value.person.name]} : {directors:[result.value.person.name]})})));return candidates
    }}))).then((result) => {
      if (cancelled) return
      setSimilarCandidates(result.items.filter((candidate) => matchesTab(candidate.item)).slice(0, 50))
      setWatchedTasteMetadata(metadata)
    })
    return () => { cancelled = true }
  }, [watchedForSeeds, tab, contentType, hasDailySnapshot])

  useEffect(() => {
    if (hasDailySnapshot) return
    if (!traktConnected && !simklConnected && !stremioAuthKey && !anilistConnected) { const timer=window.setTimeout(()=>setConnectedActivity({items:[],progress:[],ratings:[],watchlist:[],rewatches:[],bingeItems:[]}),0); return()=>window.clearTimeout(timer) }
    let cancelled = false
    Promise.allSettled([
      traktConnected ? Promise.all([getTraktWatchedMovies(),getTraktWatchedShows(),getTraktRatings('movies'),getTraktRatings('shows'),import('../services/trakt/sync').then((m)=>m.getWatchlist('movies')),import('../services/trakt/sync').then((m)=>m.getWatchlist('shows'))]) : Promise.resolve([[],[],[],[],[],[]] as const),
      simklConnected ? Promise.all([getSimklWatchedMovies(),getSimklWatchedEpisodes(),getSimklWatchlist()]) : Promise.resolve([[],[],[]] as const),
      stremioAuthKey ? getStremioWatchHistory(stremioAuthKey) : Promise.resolve([] as StremioLibraryEntry[]),
      anilistConnected ? import('../services/anilist').then((m)=>m.getAniListFullList()) : Promise.resolve([] as AniListFullEntry[]),
    ]).then(async ([traktResult,simklResult,stremioResult,anilistResult]) => {
      const items: SearchResult[] = []
      const rawRatings: Array<{item:SearchResult;rating:number}> = []
      const rewatches:SearchResult[]=[]; const bingeItems:SearchResult[]=[]; const watchlist:SearchResult[]=[]
      if (traktResult.status === 'fulfilled') for (const entry of [...traktResult.value[0],...traktResult.value[1]]) { const media=entry.movie||entry.show; if(media) { const mapped={id:`tmdb-${media.ids.tmdb}`,title:media.title,type:entry.movie?'movie' as const:'series' as const,year:media.year,provider:'trakt',tmdbId:media.ids.tmdb,imdbId:media.ids.imdb}; items.push(mapped); if(entry.plays>1)rewatches.push(mapped); if(entry.seasons?.some((season)=>season.episodes.filter((episode)=>episode.plays>0).length>=3))bingeItems.push(mapped) } }
      if (traktResult.status === 'fulfilled') for (const raw of [...traktResult.value[2],...traktResult.value[3]]) { if(!raw||typeof raw!=='object')continue; const record=raw as Record<string,unknown>; const media=(record.movie||record.show) as {title?:string;year?:number;ids?:{tmdb?:number;imdb?:string}}|undefined; const rating=Number(record.rating); if(media?.title&&Number.isFinite(rating)) rawRatings.push({rating,item:{id:media.ids?.tmdb?`tmdb-${media.ids.tmdb}`:media.ids?.imdb||media.title,title:media.title,type:record.movie?'movie':'series',year:media.year,provider:'trakt',tmdbId:media.ids?.tmdb,imdbId:media.ids?.imdb}}) }
      if(traktResult.status==='fulfilled')for(const raw of [...traktResult.value[4],...traktResult.value[5]]){if(!raw||typeof raw!=='object')continue;const record=raw as Record<string,unknown>;const media=(record.movie||record.show) as {title?:string;year?:number;ids?:{tmdb?:number;imdb?:string}}|undefined;if(media?.title)watchlist.push({id:media.ids?.tmdb?`tmdb-${media.ids.tmdb}`:media.ids?.imdb||media.title,title:media.title,type:record.movie?'movie':'series',year:media.year,provider:'trakt',tmdbId:media.ids?.tmdb,imdbId:media.ids?.imdb})}
      if (simklResult.status === 'fulfilled') for (const entry of [...simklResult.value[0],...simklResult.value[1]]) items.push({id:entry.tmdbId?`tmdb-${entry.tmdbId}`:entry.id,title:entry.title,type:entry.type==='movie'?'movie':'series',year:entry.year,provider:'simkl',tmdbId:entry.tmdbId,imdbId:entry.imdbId,simklId:entry.simklId,isAnime:entry.type==='anime',poster:entry.poster,backdrop:entry.backdrop})
      if(simklResult.status==='fulfilled')for(const entry of simklResult.value[2])watchlist.push({id:entry.tmdbId?`tmdb-${entry.tmdbId}`:entry.id,title:entry.title,type:entry.type==='movie'?'movie':'series',year:entry.year,provider:'simkl',tmdbId:entry.tmdbId,imdbId:entry.imdbId,simklId:entry.simklId,isAnime:entry.type==='anime',poster:entry.poster,backdrop:entry.backdrop})
      if(stremioResult.status==='fulfilled')for(const entry of stremioResult.value){const mapped={id:entry.imdbId||entry.id,title:entry.title,type:entry.type,year:entry.year,provider:'stremio',imdbId:entry.imdbId,poster:entry.poster};items.push(mapped)}
      // AniList watched anime → taste/Discovery. Include anything the user engaged
      // with (progress > 0 or completed); enrichment resolves tmdb ids downstream.
      if(anilistResult.status==='fulfilled')for(const entry of anilistResult.value){if(entry.status==='PLANNING'||(entry.progress<=0&&entry.status!=='COMPLETED'))continue;const mapped={id:`anilist-${entry.mediaId}`,title:entry.title,type:'series' as const,year:entry.seasonYear,provider:'anilist',malId:entry.idMal,anilistId:entry.mediaId,isAnime:true,poster:entry.poster,backdrop:entry.backdrop};items.push(mapped);if((entry.repeat||0)>0)rewatches.push(mapped)}
      const unique=[...new Map(items.map((item)=>[mediaIdentity(item),item])).values()].slice(0,150)
      const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
      const enriched=await enrichSearchResultsWithAppMetadata(unique)
      if(cancelled)return
      setConnectedActivity({items:enriched,ratings:rawRatings,watchlist,rewatches,bingeItems,progress:enriched.map((item,index)=>({id:`connected:${index}`,mediaType:item.type,mediaId:item.id,progressSeconds:1,durationSeconds:1,completed:true,title:item.title,poster:item.poster,backdrop:item.backdrop,tmdbId:item.tmdbId,imdbId:item.imdbId}))})
    }).catch(()=>undefined)
    return()=>{cancelled=true}
  },[traktConnected,simklConnected,stremioAuthKey,anilistConnected,hasDailySnapshot])

  const starterTasteItems=useMemo<SearchResult[]>(()=>starterGenres.map((genreId)=>({id:`taste-genre-${genreId}`,title:genreMap[genreId]||`Genre ${genreId}`,type:contentType,provider:'preference',genreIds:[genreId]})),[starterGenres,genreMap,contentType])
  // The signature gates this ref read so time-only updates keep the same ranking input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tasteProgress = useMemo(() => Array.from(watchProgressRef.current.values()), [progressSignals.tasteProgress])
  const progressTaste = useMemo(() => {
    const completed = new Map<string, SearchResult>()
    const abandoned = new Map<string, SearchResult>()
    for (const progress of watchProgressRef.current.values()) {
      const type = progress.mediaType === 'movie' ? 'movie' : 'series'
      const match = recentlyViewed.find((item) => item.type === type && (item.id === progress.mediaId || (progress.tmdbId != null && String(item.tmdbId) === String(progress.tmdbId)) || (progress.imdbId && item.imdbId === progress.imdbId)))
      const item: SearchResult = match || { id: progress.mediaId, title: progress.title || '', type, provider: 'progress', tmdbId: progress.tmdbId, imdbId: progress.imdbId }
      const key = mediaIdentity({ id: progress.mediaId, type, provider: 'progress', tmdbId: progress.tmdbId, imdbId: progress.imdbId })
      if (progress.completed) completed.set(key, item)
      else if (progress.updatedAt && Date.parse(progress.updatedAt) < rankingNow - 14 * 86400_000 && progress.durationSeconds > 0 && progress.progressSeconds / progress.durationSeconds >= .08) abandoned.set(key, item)
    }
    for (const key of completed.keys()) abandoned.delete(key)
    return { completedItems: [...completed.values()], abandonedItems: [...abandoned.values()] }
    // The signature contains the completion/abandonment projection used below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressSignals.tasteItems, recentlyViewed])
  const activity = useMemo(() => ({ progress: [...tasteProgress,...connectedActivity.progress], recent: [...starterTasteItems,...progressTaste.completedItems,...connectedActivity.items], ratings:connectedActivity.ratings,completedItems:[...progressTaste.completedItems,...connectedActivity.items,...feedback.filter((entry)=>entry.kind==='already-seen').map((entry):SearchResult=>({...entry.item,provider:'taste-feedback'}))],abandonedItems:progressTaste.abandonedItems,watchlist:[...localWatchlist,...connectedActivity.watchlist],rewatches:connectedActivity.rewatches,bingeItems:connectedActivity.bingeItems,tasteMetadata:[...watchedTasteMetadata,...localWatchlist.filter((item)=>item.runtime).map((item)=>({item,runtimeMinutes:item.runtime}))] }), [tasteProgress, connectedActivity,starterTasteItems,localWatchlist,watchedTasteMetadata,progressTaste,feedback])
  const tasteProfile = useMemo(() => buildTasteProfile(activity), [activity])
  const candidates = useMemo<RecommendationCandidate[]>(() => [
    ...forYou.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...trending.map((item) => recommendationCandidate(item,'tmdb-trending')),
    ...topRated.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...moodItems.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...hiddenGems.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...quickWatches.map((item) => recommendationCandidate(item,'tmdb-discover',{runtimeMinutes:item.runtime||(contentType==='movie'?95:30)})),
    ...(tab === 'anime' ? [...animeMovies, ...animeMoviesTop].map((item) => recommendationCandidate(item,'tmdb-discover')) : []),
    ...similarCandidates,
  ], [forYou, trending, topRated, moodItems, hiddenGems, quickWatches, animeMovies, animeMoviesTop, similarCandidates, contentType, tab])
  const filteredCandidates = useMemo(() => {
    return candidates.filter((c) => matchesDiscoverTab(c.item, tab) && candidatePassesPrefs(c.item, prefs))
  }, [candidates, prefs, tab])

  const liveRanked = useMemo(() => {
    const weights = prefsWeights(prefs)
    const ranked = rankCandidates(filteredCandidates, tasteProfile, activity, feedback, mode, rankingNow, impressions, weights)

    if (prefs.sortOrder === 'popularity.desc') {
      return [...ranked].sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    } else if (prefs.sortOrder === 'vote_average.desc') {
      return [...ranked].sort((a, b) => (b.item.rating || 0) - (a.item.rating || 0))
    } else if (prefs.sortOrder === 'release_date.desc') {
      return [...ranked].sort((a, b) => {
        const dateA = a.item.releaseDate ? new Date(a.item.releaseDate).getTime() : 0
        const dateB = b.item.releaseDate ? new Date(b.item.releaseDate).getTime() : 0
        return dateB - dateA
      })
    }
    return ranked
  }, [filteredCandidates, tasteProfile, activity, feedback, mode, rankingNow, impressions, prefs])

  // Keep the last complete ranking across restarts/day changes. A settled refresh
  // replaces it only when the material catalog content actually changed.
  const setRankedSnapshot = useDiscoverStore((s) => s.setRankedSnapshot)
  const fallbackRankedSnapshot = useMemo(
    () => latestSnapshotForScope(persistedRankings, dailySnapshotScope),
    [persistedRankings, dailySnapshotScope],
  )
  const validRankedSnapshot = useMemo(
    () => dailySnapshot?.filter((entry) => matchesDiscoverTab(entry.item, tab)),
    [dailySnapshot, tab],
  )
  const snapshotIsValid = Boolean(dailySnapshot && validRankedSnapshot?.length === dailySnapshot.length && dailySnapshot.length > 0)
  const ranked = snapshotIsValid
    ? applyRecommendationFeedback(validRankedSnapshot!, feedback.filter((entry) => entry.createdAt > (dailySnapshotMeta[dailySnapshotKey]?.generatedAt ?? 0)))
    : fallbackRankedSnapshot?.filter((entry) => matchesDiscoverTab(entry.item, tab))?.length
      ? applyRecommendationFeedback(fallbackRankedSnapshot.filter((entry) => matchesDiscoverTab(entry.item, tab)), feedback)
      : liveRanked
  const genreTiles = useMemo(() => moodOptions.map((option, index) => ({
    option,
    item: ranked.find((entry) => option.genres.some((genreId) => entry.item.genreIds?.includes(genreId)))?.item || ranked[index]?.item,
  })), [moodOptions, ranked])
  useEffect(() => {
    // Today's snapshot is immutable once committed. History, feedback and
    // provider refreshes influence tomorrow instead of reshuffling the page.
    if (!initialWaitComplete || snapshotIsValid || liveRanked.length === 0) return
    const profileFingerprint = catalogContentFingerprint(activity.recent)
    setRankedSnapshot(dailySnapshotKey, liveRanked, {
      dateKey: berlinDateKey,
      generatedAt: Date.now(),
      profileFingerprint,
      algorithmVersion: DISCOVERY_ALGORITHM_VERSION,
    })
  }, [activity.recent, berlinDateKey, dailySnapshotKey, initialWaitComplete, liveRanked, setRankedSnapshot, snapshotIsValid])
  const personalizedSections = useMemo(() => generateDiscoverySections(ranked.slice(1), tasteProfile, mode), [ranked, tasteProfile, mode])
  const bingeRecommendations = useMemo(() => {
    const matchesTab = (item: SearchResult) => tab === 'anime'
      ? Boolean(item.isAnime)
      : tab === 'series' ? item.type === 'series' && !item.isAnime : false
    const seen = new Set<string>()
    return [...connectedActivity.bingeItems, ...ranked.map((entry) => entry.item)]
      .filter((item) => matchesTab(item) && Boolean(item.poster))
      .filter((item) => {
        const key = mediaIdentity(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 5)
  }, [connectedActivity.bingeItems, ranked, tab])
  const activeBingeItem = bingeRecommendations.length ? bingeRecommendations[bingeIndex % bingeRecommendations.length] : undefined
  const heroPool = useMemo(() => ranked.slice(0, 6), [ranked])
  const activeHeroIndex = heroPool.length ? heroIndex % heroPool.length : 0
  const heroRecommendation = heroPool[activeHeroIndex]
  const heroItem = heroRecommendation?.item
  const pickerPool = useMemo(() => {
    const seen = new Set<string>()
    return ranked.filter((entry) => {
      const key = mediaIdentity(entry.item)
      if (!entry.item.poster || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [ranked])
  const tastePickCandidates = useMemo(() => {
    if (!ranked.length) return []
    const query = tasteQuery.trim().toLocaleLowerCase()
    const pool = ranked.filter((entry) => entry.item.poster && !pickedIds.includes(mediaIdentity(entry.item)) && (!query || `${entry.item.title} ${entry.item.genres?.join(' ') || ''} ${entry.item.year || ''}`.toLocaleLowerCase().includes(query)))
    if (!pool.length) return []
    const start = pickOffset % pool.length
    return Array.from({ length: Math.min(10, pool.length) }, (_, index) => pool[(start + index) % pool.length]!.item)
  }, [ranked, pickedIds, pickOffset, tasteQuery])

  useEffect(() => { setHeroIndex(0) }, [tab, mode, discoveryQueryKey])
  useEffect(() => { setHeroLogoError(false) }, [activeHeroIndex])

  // Auto-advance the hero like the Home hero; pause while the trailer is open
  useEffect(() => {
    if (heroPool.length <= 1 || trailerOpen) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') setHeroIndex((current) => (current + 1) % heroPool.length)
    }, 8000)
    return () => window.clearInterval(id)
  }, [heroPool.length, trailerOpen])

  // Resolve logos/backdrops for the hero pool so the banner can show title logos
  useEffect(() => {
    let cancelled = false
    const visibleHeroIndexes = new Set([
      activeHeroIndex,
      (activeHeroIndex - 1 + heroPool.length) % heroPool.length,
      (activeHeroIndex + 1) % heroPool.length,
    ])
    heroPool.forEach((entry, index) => {
      if (!visibleHeroIndexes.has(index)) return
      const key = String(entry.item.id)
      resolveArtFromProviders(entry.item.type === 'series' ? 'series' : 'movie', { tmdbId: entry.item.tmdbId, tvdbId: entry.item.tvdbId, imdbId: entry.item.imdbId }, entry.item.isAnime)
        .then((art) => { if (!cancelled) setHeroArt((prev) => prev[key] ? prev : { ...prev, [key]: art }) })
        .catch(() => undefined)
    })
    return () => { cancelled = true }
  }, [heroPool, activeHeroIndex])

  // Seed the catalog cache so "Show all" opens a full-screen view of a section like on Home
  useEffect(() => {
    personalizedSections.forEach((section) => catalogSetCache(`discover-section-${tab}-${section.id}`, { items: section.items.map((entry) => entry.item), page: 0, hasMore: false, scrollTop: 0 }))
  }, [personalizedSections, tab, catalogSetCache])
  const viewState = discoveryViewState(ranked.length,initialWaitComplete)

  useEffect(() => {
    const reset=window.setTimeout(()=>{setHeroTrailer(null);setTrailerOpen(false)},0)
    if(!heroItem)return
    let cancelled=false
    getTrailerSource({type:heroItem.type,tmdbId:heroItem.tmdbId,imdbId:heroItem.imdbId,title:heroItem.title,year:heroItem.year}).then((trailer)=>{if(!cancelled)setHeroTrailer(trailer)}).catch(()=>undefined)
    return()=>{cancelled=true;window.clearTimeout(reset)}
  },[heroItem])

  useEffect(() => {
    const key = `${berlinDateKey}:${tab}:${mode}`
    if (!ranked.length || IMPRESSIONS_RECORDED.has(key)) return
    rememberDiscoverSessionKey(IMPRESSIONS_RECORDED, key)
    recordRecommendationImpressions(ranked.slice(0,40).map((entry)=>entry.item))
  }, [ranked, tab, mode, berlinDateKey])

  const changeMode = (next: DiscoveryMode) => { try { localStorage.setItem('aurales_discovery_mode', next) } catch { /* keep live mode */ } setMode(next) }
  const submitFeedback = (item: SearchResult, kind: Parameters<typeof saveRecommendationFeedback>[1]) => {
    setFeedback(saveRecommendationFeedback(item, kind))
  }

  const [randomPickerItem, setRandomPickerItem] = useState<SearchResult | null>(null)
  const [pickerSpinning, setPickerSpinning] = useState(false)
  const pickerSpinRunRef = useRef(0)
  const spinPicker = (currentId = randomPickerItem?.id) => {
    if (!pickerPool.length) return
    const runId = pickerSpinRunRef.current + 1
    pickerSpinRunRef.current = runId
    const alternatives = pickerPool.filter((entry) => entry.item.id !== currentId)
    const choices = alternatives.length ? alternatives : pickerPool
    const winner = choices[Math.floor(Math.random() * choices.length)]
    if (!winner) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRandomPickerItem(winner.item)
      setPickerSpinning(false)
      return
    }

    const delays = [65, 75, 90, 115, 150, 200, 270, 360]
    setPickerSpinning(true)
    const first = choices[Math.floor(Math.random() * choices.length)]
    if (first) setRandomPickerItem(first.item)
    void (async () => {
      for (const delay of delays) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
        if (pickerSpinRunRef.current !== runId) return
        const interimChoices = pickerPool.filter((entry) => entry.item.id !== winner.item.id)
        const reel = interimChoices.length ? interimChoices : choices
        const next = reel[Math.floor(Math.random() * reel.length)]
        if (next) setRandomPickerItem(next.item)
      }
      if (pickerSpinRunRef.current !== runId) return
      setRandomPickerItem(winner.item)
      setPickerSpinning(false)
    })()
  }
  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setPickerSpinning(false)
    pickerSpinRunRef.current += 1
  }, [])
  const selectTastePick = (item: SearchResult) => {
    const id = mediaIdentity(item)
    if (pickedIds.includes(id) || pickedIds.length >= 3) return
    const next = [...pickedIds, id]
    setPickedIds(next)
    try { localStorage.setItem(pickStorageKey, JSON.stringify(next)) } catch { /* use this session's selection */ }
    submitFeedback(item, 'more-like-this')
  }
  const resetTastePicks = () => {
    const selected = ranked.map((entry) => entry.item).filter((item) => pickedIds.includes(mediaIdentity(item)))
    setFeedback(resetTasteFeedback(selected))
    setPickedIds([])
    setPickOffset(0)
    try { localStorage.removeItem(pickStorageKey) } catch { /* use this session's selection */ }
  }

  const handleTabChange = (nextTab: DiscoverTab) => {
    setTab(nextTab)
  }

  const openItemDetail = (item: SearchResult, autoPlay = false) => navigate(item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`, { state: { ...item, autoPlay } })
  const openHeroDetail = (autoPlay = false) => { if (heroRecommendation) openItemDetail(heroRecommendation.item, autoPlay) }
  const heroLogo = heroRecommendation ? (heroArt[String(heroRecommendation.item.id)]?.logo || heroRecommendation.item.logo) : undefined
  const heroPoster = heroRecommendation ? (heroRecommendation.item.poster || heroArt[String(heroRecommendation.item.id)]?.poster || heroRecommendation.item.backdrop || heroArt[String(heroRecommendation.item.id)]?.backdrop) : undefined
  const heroGlassButton = 'focus-ring cursor-pointer rounded-full border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white/90 transition-colors hover:border-white/25 hover:bg-white/20 hover:text-white active:scale-[0.97]'

  return (
    <div className="discover-page pb-12">
      <div className="discover-page__notice pt-8"><CatalogKeyNotice /></div>
      <div className="discover-page__heading px-6 pt-10 pb-7 md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-2xl">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[.2em] text-accent">Picked around your taste</p>
            <h1 className="text-4xl font-semibold tracking-[-.04em] text-white md:text-5xl">Discover</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-white/55">Find something worth watching tonight.</p>
          </div>
          <span className="rounded-full border border-white/[0.09] bg-white/[0.035] px-4 py-2 text-xs font-medium text-white/50">Daily picks <span className="mx-1.5 text-white/20">·</span> {region} <span className="mx-1.5 text-white/20">·</span> {minRating > 0 ? `${minRating}+ rating` : 'All ratings'}</span>
        </div>

        <div className="discover-page__tabs mt-8 inline-flex max-w-full gap-1 overflow-x-auto rounded-2xl border border-white/[.08] bg-white/[.035] p-1.5">
          {(['movies', 'series', 'anime'] as DiscoverTab[]).map((item) => (
            <button
              key={item}
              onClick={() => handleTabChange(item)}
              className={`whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-semibold transition-all cursor-pointer ${
                tab === item
                  ? 'bg-white text-black shadow-lg shadow-black/20'
                  : 'text-white/55 hover:bg-white/[.06] hover:text-white'
              }`}
            >
              {item === 'movies' ? 'Movies' : item === 'series' ? 'Series' : 'Anime'}
            </button>
          ))}
        </div>
        <button className="discover-surprise-trigger" type="button" onClick={() => { setPickerOpen(true); spinPicker() }} disabled={!pickerPool.length}>
          <Shuffle size={16} aria-hidden="true" /> Surprise Me
        </button>
      </div>

      <>

          <div className="discover-page__modes mb-7 flex gap-2 overflow-x-auto px-6 pb-1 md:px-10" aria-label="Browse recommendations">
            {([['for-you','Recommended'],['new','Something New'],['hidden-gems','Hidden Gems'],['critically-acclaimed','Critically Acclaimed'],['recently-released','Recently Released'],['quick-watch','Quick Watch']] as const).map(([value,label]) => <button key={value} onClick={() => changeMode(value)} className={`focus-ring flex-none whitespace-nowrap rounded-full border px-4 py-2 text-xs font-semibold transition-colors ${mode === value ? 'border-white bg-white text-black' : 'border-white/10 bg-transparent text-white/55 hover:border-white/25 hover:text-white'}`}>{label}</button>)}
          </div>
          {viewState==='content'&&heroRecommendation ? <section className="discover-spotlight">
            <div className="discover-spotlight__ambient" aria-hidden="true">{heroRecommendation.item.backdrop && <img src={heroRecommendation.item.backdrop} alt="" draggable={false} decoding="async" />}</div>
            <div className="discover-spotlight__copy">
              <p className="discover-spotlight__eyebrow">Your Weekend Plan · Tonight <span>·</span> {heroRecommendation.reasons[0]?.label.replace(/\btaste\b/gi, 'preferences') || 'Picked for you'}</p>
              {heroLogo && !heroLogoError
                ? <img src={heroLogo} alt={heroRecommendation.item.title} draggable={false} onError={()=>setHeroLogoError(true)} className="discover-spotlight__logo" />
                : <h2>{heroRecommendation.item.title}</h2>}
              <div className="discover-spotlight__meta">
                {heroRecommendation.item.year && <span>{heroRecommendation.item.year}</span>}
                <span>{heroRecommendation.runtimeMinutes ? `${heroRecommendation.runtimeMinutes} min` : heroRecommendation.item.type === 'series' ? 'Series' : 'Movie'}</span>
                {heroRecommendation.item.rating != null && <span>★ {Number(heroRecommendation.item.rating).toFixed(1)}</span>}
                {heroRecommendation.item.genres?.slice(0, 2).map((genre) => <span key={genre}>{genre}</span>)}
              </div>
              {heroRecommendation.item.overview && <p className="discover-spotlight__overview">{heroRecommendation.item.overview}</p>}
              <div className="discover-spotlight__actions">
                <button onClick={() => openHeroDetail(true)} className="discover-spotlight__play">▶ <span>Play</span></button>
                <button onClick={() => openHeroDetail(false)} className={heroGlassButton}>Details</button>
                <WatchlistButton className="discover-spotlight__watchlist" item={heroRecommendation.item} mediaRef={{localId:heroRecommendation.item.id,title:heroRecommendation.item.title,year:heroRecommendation.item.year,type:heroRecommendation.item.isAnime?'anime':heroRecommendation.item.type==='series'?'show':'movie',imdbId:heroRecommendation.item.imdbId,tmdbId:heroRecommendation.item.tmdbId?Number(heroRecommendation.item.tmdbId):undefined}} mediaType={heroRecommendation.item.type} isAnime={tab==='anime'||Boolean(heroRecommendation.item.isAnime)} anilistId={heroRecommendation.item.anilistId} malId={heroRecommendation.item.malId} tvdbId={heroRecommendation.item.tvdbId}/>
                {heroPool.length > 1 && <button onClick={() => setHeroIndex((activeHeroIndex + 1) % heroPool.length)} className={heroGlassButton}>Another option</button>}
                {heroTrailer && <button onClick={() => setTrailerOpen(true)} className={`${heroGlassButton} discover-spotlight__trailer`}>Trailer</button>}
                <button onClick={() => submitFeedback(heroRecommendation.item,'not-interested')} className={`${heroGlassButton} discover-spotlight__feedback`}>Not for me</button>
              </div>
            </div>
            {heroPoster && <div className="discover-spotlight__poster"><img src={heroPoster} alt={`${heroRecommendation.item.title} poster`} draggable={false} loading="eager" decoding="async" /></div>}
          </section> : viewState==='error' ? <div className="mx-6 mb-8 grid min-h-72 place-items-center rounded-3xl border border-white/10 bg-white/[.03] p-8 text-center"><div><h2 className="text-xl font-black">Recommendations are unavailable</h2><p className="mt-2 max-w-md text-sm text-white/60">Cached discovery data was not available and recommendation sources could not be loaded. Check your network or TMDB settings.</p><button onClick={()=>window.location.reload()} className="mt-5 rounded-full bg-white px-5 py-2 font-bold text-black">Retry</button></div></div> : <div className="discover-loading mx-6 mb-8 animate-pulse"><div className="h-56 rounded-[1.5rem] bg-white/[.06] sm:h-72"/><div className="mt-5 flex gap-3 overflow-hidden">{Array.from({length:7}).map((_,index)=><div key={index} className="h-[10.5rem] w-28 flex-shrink-0 rounded-2xl bg-white/[.05]"/>)}</div></div>}
          {ranked.length > 0 && <section className="discover-refine row-contain" aria-labelledby="discover-refine-title">
            <p className="discover-section-eyebrow">Refine your taste</p>
            <div className="discover-refine__heading">
              <h2 id="discover-refine-title">Pick Three You Like</h2>
              <div className="discover-refine__progress" aria-label={`${pickedIds.length} of 3 titles selected`}>
                {[0, 1, 2].map((index) => <span key={index} className={index < pickedIds.length ? 'is-complete' : ''} />)}
                <span className="discover-refine__count">{pickedIds.length < 3 ? `${3 - pickedIds.length} more to go` : 'Taste tuned'}</span>
              </div>
            </div>
            <div className="discover-refine__tools">
              <label className="discover-refine__search"><Search size={16} aria-hidden="true"/><input type="search" value={tasteQuery} onChange={(event) => { setTasteQuery(event.target.value); setPickOffset(0) }} placeholder="Search titles" aria-label="Search titles to refine recommendations" /></label>
              {tastePickCandidates.length > 0 && pickedIds.length < 3 && <button className="discover-refine__more" type="button" onClick={() => setPickOffset((current) => current + 10)}><RefreshCw size={16} aria-hidden="true" /> <span>More choices</span></button>}
              {pickedIds.length > 0 && <button className="discover-refine__reset" type="button" onClick={resetTastePicks}><RotateCcw size={16} aria-hidden="true" /> <span>Start over</span></button>}
            </div>
            <div className="discover-taste-picks">
              {tastePickCandidates.map((item) => {
                const id = mediaIdentity(item)
                return <button key={id} type="button" className="discover-taste-pick" onClick={() => selectTastePick(item)} disabled={pickedIds.length >= 3} aria-label={`Choose ${item.title}`}>
                  <span className="discover-taste-pick__poster">{item.poster && <img src={item.poster} alt="" loading="lazy" decoding="async"/>}{item.rating != null && <span className="discover-taste-pick__rating">★ {Number(item.rating).toFixed(1)}</span>}</span>
                  <span className="discover-taste-pick__title">{item.title}</span>
                  <span className="discover-taste-pick__year">{item.year || (item.isAnime ? 'Anime' : item.type === 'series' ? 'Series' : 'Movie')}</span>
                </button>
              })}
              {tastePickCandidates.length === 0 && <p className="discover-taste-picks__empty">No matching titles. Try another search.</p>}
            </div>
          </section>}
          {bingeRecommendations.length > 0 && <section className="discover-binge row-contain" aria-labelledby="discover-binge-title">
            <div className="discover-binge__heading"><div><p className="discover-section-eyebrow">For your next long watch</p><h2 id="discover-binge-title">Your Next Binge</h2></div><span>Based on your taste and watch history</span></div>
            <div className="discover-binge__feature">
              <div className="discover-binge__art">{activeBingeItem?.backdrop && <img src={activeBingeItem.backdrop} alt="" loading="lazy" decoding="async"/>}{activeBingeItem?.poster && <img className="discover-binge__poster" src={activeBingeItem.poster} alt={`${activeBingeItem.title} poster`} loading="lazy" decoding="async"/>}</div>
              <div className="discover-binge__copy"><p className="discover-section-eyebrow">{activeBingeItem?.isAnime ? 'Anime series' : 'Series pick'}</p><h3>{activeBingeItem?.title}</h3><p>{activeBingeItem?.overview || 'A series recommendation picked from your current discovery results.'}</p><div><button type="button" onClick={() => activeBingeItem && openItemDetail(activeBingeItem, true)}>▶ Play</button><button type="button" onClick={() => activeBingeItem && openItemDetail(activeBingeItem)}>Details</button><button type="button" onClick={() => setBingeIndex((current) => (current + 1) % bingeRecommendations.length)} disabled={bingeRecommendations.length < 2}>Another option</button></div></div>
            </div>
            {bingeRecommendations.length > 1 && <div className="discover-binge__rail"><MediaRow title="More series to binge" items={bingeRecommendations.slice(1)} layout="poster" /></div>}
          </section>}
          <section className="discover-moods row-contain" aria-label="Choose a genre">
            <div className="discover-moods__heading"><div><p className="discover-section-eyebrow">Picked from this discovery mix</p><h2>Your Genres</h2></div></div>
            <div className="discover-genres__grid" role="group" aria-label="Genres">
              {genreTiles.map(({ option, item }, index) => <button type="button" key={option.title} aria-pressed={moodIndex === index} className={moodIndex === index ? 'is-active' : ''} onClick={() => setMoodIndex(index)} style={item?.backdrop || item?.poster ? { backgroundImage: `linear-gradient(90deg, rgba(9,9,12,.88), rgba(9,9,12,.3)), url("${item.backdrop || item.poster}")` } : undefined}><span>{option.title}</span><small>{item?.title || 'Explore this genre'}</small></button>)}
            </div>
            {moodItems.length > 0 && <MediaRow title={`${mood.title} Picks`} items={moodItems} layout="poster" />}
          </section>
          {pickerOpen && randomPickerItem && <DiscoveryPicker item={randomPickerItem} onClose={closePicker} onSpin={() => spinPicker()} onOpen={() => openItemDetail(randomPickerItem)} isSpinning={pickerSpinning} />}
          {personalizedSections.map((section) => {
            const title = DISCOVERY_SECTION_TITLES[section.id] ?? section.title.replace(/\s+for you$/i, '')
            return <div key={section.id} className="row-contain discover-shelf"><MediaRow title={title} items={section.items.map((entry)=>entry.item)} layout="poster" showAllPath={`/catalog/discover-section-${tab}-${section.id}?title=${encodeURIComponent(title)}`} /></div>
          })}
          {serverDiscoverItems.length > 0 && <div className="row-contain"><MediaRow title="From Your Servers" items={serverDiscoverItems} layout="poster" showAllPath={`/catalog/discover-servers-${tab}?title=${encodeURIComponent('From Your Servers')}`} /></div>}
          {trailerOpen&&heroTrailer&&<div role="dialog" aria-modal="true" aria-label="Trailer" className="fixed inset-0 z-[10000] grid place-items-center bg-black/80 p-6" onClick={()=>setTrailerOpen(false)}><div className="aspect-video w-[min(70rem,92vw)] overflow-hidden rounded-3xl border border-white/15 bg-black" onClick={(event)=>event.stopPropagation()}><TrailerPreview trailer={heroTrailer} title={heroRecommendation?.item.title||'Trailer'} muted={false} eager/></div></div>}
      </>
    </div>
  )
}
