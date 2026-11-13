import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, RefreshCw, RotateCcw, Search, Settings, Shuffle, ThumbsDown, X } from 'lucide-react'
import type { DiscoverConfig, DiscoveryCatalogContinuation, SearchResult, WatchProgress } from '../types'
import { discoverTmdbPageWithCache, discoverTmdbWithCache, getTmdbCertification, getTmdbPerson, getTrendingTmdb, tmdbProvider } from '../services/tmdb'
import MediaRow from '../components/MediaRow'
import MediaCard from '../components/MediaCard'
import { applySearchResultArt, getSearchResultCustomArt, resolveArtFromProviders, resolveSearchResultCustomArt } from '../services/artwork'
import { loadAmbientColor } from '../services/ambientColor'
import { getTmdbCleanPoster } from '../services/tmdb'
import { classifyPosterColor, POSTER_COLOR_GROUPS, selectPosterColorItems, type PosterColorGroup } from '../services/discovery/posterColor'
import { useAppStore } from '../stores/appStore'
import { useWatchedCacheStore } from '../stores/watchedCacheStore'
import { useVisibilityOnce } from '../hooks/useVisibilityOnce'
import { getProviderWatchedEpisodeSummary, isWatchedFromProviders, searchResultToLookup, type ProviderWatchedEpisodeSummary, type WatchedSource } from '../services/watchedStatus'
import { isInLocalWatchlist } from '../services/localWatchlist'
import { ensurePosterProgress, getPosterProgressSnapshot, getPosterTimeLeftSnapshot, subscribePosterProgress } from '../services/posterProgress'
import { getPosterArtworkCandidate, getPosterEpisodeSegmentCount, getPosterFadeAppearance, getPosterVisibleDetails, POSTER_RATING_CAPTION_CLASS, POSTER_RATING_CAPTION_STAR_CLASS } from '../services/posterLayout'
import { PosterBottomStack } from '../components/media/PosterBottomStack'
import { PosterFooterCaption } from '../components/media/PosterFooterCaption'
import { getJellyfinPosterEpisodeSummaryForMedia, type PosterEpisodeSummary } from '../services/posterEpisodeSummary'
import { useCatalogStore } from '../stores/catalogStore'
import { toggleDiscoverContentType, useDiscoverStore, type DiscoverContentType } from '../stores/discoverStore'
import CatalogKeyNotice from '../components/CatalogKeyNotice'
import DiscoverPrefsPanel from '../components/DiscoverPrefsPanel'
import DiscoveryCalendarRow from '../components/discovery/DiscoveryCalendarRow'
import { applyRecommendationFeedback, buildPopularTopTen, buildTastePickerPool, buildTasteProfile, chooseSurpriseAnimationFrame, chooseSurpriseRecommendation, generateDiscoverySections, interleaveLiveTrendSources, orderRecommendationsBySource, orderRuntimeCandidates, orderSpotlightCandidates, prioritizeLiveTrends, prioritizeLiveTrendsWithin, rankCandidates, reconcileTrendingSignals, selectEditorialReason, sortRecommendationsByPopularity, trendingScopeFingerprint } from '../services/discovery/recommendationEngine'
import { loadRecommendationFeedback, resetTasteFeedback, saveRecommendationFeedback } from '../services/discovery/feedbackStore'
import type { DiscoveryMode, RecommendationCandidate, RecommendationFeedback } from '../services/discovery/types'
import { getWatchedMovies as getTraktWatchedMovies, getWatchedShows as getTraktWatchedShows, getRatings as getTraktRatings } from '../services/trakt/sync'
import { getSimklWatchedMovies, getSimklWatchedEpisodes } from '../services/simkl/history'
import { getSimklWatchlist } from '../services/simkl/lists'
import { getStremioAuth, getStremioWatchHistory, type StremioLibraryEntry } from '../services/stremio'
import type { AniListFullEntry } from '../services/anilist'
import { useDiscoverPrefsStore, getDiscoverPrefs, excludeGenreIds, onlyGenreIds, candidatePassesPrefs, prefsSignature, prefsWeights } from '../stores/discoverPrefsStore'
import { loadRecommendationImpressions, recordRecommendationImpressions } from '../services/discovery/impressionStore'
import { discoveryViewState } from '../services/discovery/viewState'
import { collectCandidateSources } from '../services/discovery/candidatePipeline'
import { catalogContentFingerprint } from '../services/cache/homeStartupSnapshot'
import { providerCacheScope } from '../services/cache/homeRowCacheKeys'
import { getBerlinDateKey, getNextBerlinMidnight } from '../services/discovery/berlinDate'
import { DISCOVERY_ALGORITHM_VERSION, discoverySourcesSettled, latestSnapshotForScope, makeDailySnapshotKey } from '../services/discovery/dailySnapshot'
import { getActiveProfile, getActiveProfileId } from '../services/profiles'
import { cardArtworkUrl, mediaIdentity } from '../services/mediaPresentation'
import { editorialAccolade } from '../services/accolades'
import { getLocalWatchlist, subscribeLocalWatchlist, type LocalWatchlistItem } from '../services/localWatchlist'
import { parseLibraryAddedAt, type DatedLibraryItem } from '../services/discovery/libraryItems'
import { preferredScrollBehavior } from '../services/motion'

function DiscoverPosterRatingBelow({ rating }: { rating?: string }) {
  const settings = useAppStore((state) => state.posterOverlay)
  if (!settings.enabled || !settings.showRatingBelow || !rating) return null
  return <span className={`${POSTER_RATING_CAPTION_CLASS} discover-poster-rating-below justify-center`} aria-label={`Rating ${rating} out of 10`}><svg className={POSTER_RATING_CAPTION_STAR_CLASS} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{rating}</span>
}

/** Keep watch state visible on Discover's editorial poster tiles too. */
function DiscoverPosterWatchMark({ item, rating, logo }: { item: SearchResult; rating?: string; logo?: ReactNode }) {
  const posterSettings = useAppStore((state) => state.posterOverlay)
  const showWatched = posterSettings.enabled && posterSettings.showWatched
  const showFavorite = posterSettings.enabled && posterSettings.showFavorite
  const showAsCheckmark = posterSettings.showAsCheckmark
  const contentAlignment = posterSettings.contentAlignment
  const showGenre = posterSettings.enabled && posterSettings.showGenre
  const showCertification = posterSettings.enabled && posterSettings.showCertification
  const showEpisodes = posterSettings.enabled && posterSettings.showEpisodes && item.type === 'series'
  const showEpisodesWatched = posterSettings.enabled && posterSettings.showEpisodesWatched && item.type === 'series'
  const showNextEpisode = posterSettings.enabled && posterSettings.showNextEpisode && item.type === 'series'
  const showProgress = posterSettings.enabled && posterSettings.showProgress && posterSettings.progressPlacement !== 'off'
  const needsEpisodeSummary = showEpisodes || showEpisodesWatched || showNextEpisode
    || showProgress && posterSettings.splitEpisodeProgress && item.type === 'series'
  const showTimeLeft = posterSettings.enabled && posterSettings.showTimeLeft
  const showRating = posterSettings.enabled && posterSettings.showRating
  const style = useAppStore((state) => state.posterOverlay.style)
  const primaryProgressProvider = useAppStore((state) => state.primaryProgressProvider)
  const connectedSourceFlags = useAppStore((state) => [state.traktConnected, state.simklConnected, Boolean(state.pmdbApiKey), Boolean(state.mdblistApiKey || localStorage.getItem('mdblist_oauth_tokens')), state.anilistConnected].map(Number).join(''))
  const sources = useMemo(() => {
    const connected: WatchedSource[] = [
      'local',
      ...(connectedSourceFlags[0] === '1' ? ['trakt' as const] : []),
      ...(connectedSourceFlags[1] === '1' ? ['simkl' as const] : []),
      ...(connectedSourceFlags[2] === '1' ? ['pmdb' as const] : []),
      ...(connectedSourceFlags[3] === '1' ? ['mdblist' as const] : []),
      ...(connectedSourceFlags[4] === '1' ? ['anilist' as const] : []),
    ]
    return primaryProgressProvider === 'all' ? connected : [primaryProgressProvider as WatchedSource]
  }, [connectedSourceFlags, primaryProgressProvider])
  const localWatchDataEnabled = sources.includes('local')
  const ids = {
    id: item.id,
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    malId: item.malId,
    anilistId: item.anilistId,
  }
  const isCachedWatched = useWatchedCacheStore((state) => state.isWatched(ids, localWatchDataEnabled))
  const watchProgress = useAppStore((state) => state.watchProgress)
  const localWatchedEpisodes = useMemo(() => {
    if (!localWatchDataEnabled || item.type !== 'series') return 0
    const aliases = new Set([item.id, item.imdbId, item.tmdbId, item.tvdbId, item.sourceItemId,
      item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined].filter((value) => value != null).map(String))
    const title = item.title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const watched = new Set<string>()
    for (const [key, entry] of watchProgress) {
      if (!entry.completed || entry.season == null || entry.episode == null
        || (entry.mediaType === 'movie' ? 'movie' : 'series') !== 'series') continue
      const entryTitle = entry.title?.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      const entryAliases = [key, entry.id, entry.mediaId, entry.imdbId, entry.tmdbId,
        entry.tmdbId != null ? `tmdb-${entry.tmdbId}` : undefined].filter((value) => value != null).map(String)
      const matches = entryAliases.some((alias) => aliases.has(alias) || [...aliases].some((id) => alias.startsWith(`${id}:`)))
        || Boolean(title && entryTitle === title)
      if (matches) watched.add(`${entry.season}:${entry.episode}`)
    }
    return watched.size
  }, [item.id, item.imdbId, item.sourceItemId, item.tmdbId, item.title, item.tvdbId, item.type, localWatchDataEnabled, watchProgress])
  const serviceProgress = useSyncExternalStore(subscribePosterProgress, getPosterProgressSnapshot, getPosterProgressSnapshot)
  const serviceTimeLeft = useSyncExternalStore(subscribePosterProgress, getPosterTimeLeftSnapshot, getPosterTimeLeftSnapshot)
  const favorite = useSyncExternalStore(
    subscribeLocalWatchlist,
    () => isInLocalWatchlist(item),
    () => false,
  )
  const markerRef = useRef<HTMLSpanElement>(null)
  const visible = useVisibilityOnce(markerRef, { rootMargin: '240px' })
  const [watched, setWatched] = useState(false)
  const [watchedResolved, setWatchedResolved] = useState(false)
  const [progressResolved, setProgressResolved] = useState(false)
  const [episodeSummaryResolved, setEpisodeSummaryResolved] = useState(false)
  const [posterDetailsFallbackReady, setPosterDetailsFallbackReady] = useState(false)
  const [episodeSummary, setEpisodeSummary] = useState<PosterEpisodeSummary | ProviderWatchedEpisodeSummary | undefined>()
  const certificationKey = `${item.type}:${item.tmdbId || item.id}`
  const [resolvedCertification, setResolvedCertification] = useState<{ key: string; value?: string }>()
  useEffect(() => {
    setPosterDetailsFallbackReady(false)
    if (!visible) return
    // A connected service can stall indefinitely. Keep the poster itself from
    // disappearing forever; unresolved status fields stay absent until they
    // have real data, while the artwork and available details can render.
    const timer = window.setTimeout(() => {
      const poster = markerRef.current?.closest<HTMLElement>('.discover-poster-fade')
      if (poster) {
        poster.dataset.posterDetailsFallbackReady = 'true'
        poster.dataset.posterStatusReady = 'true'
      }
      setPosterDetailsFallbackReady(true)
      window.dispatchEvent(new Event('aurales:discover-poster-status-ready'))
    }, 4_000)
    return () => window.clearTimeout(timer)
  }, [item.id, visible])
  const needsCertificationResolution = showCertification && !item.certification && visible
    && resolvedCertification?.key !== certificationKey
  useEffect(() => {
    if (!showCertification || item.certification || !visible || resolvedCertification?.key === certificationKey) return
    let cancelled = false
    ;(async () => {
      const { resolveTmdbIdFromExternalIds } = await import('../services/metadataEnrich')
      const tmdbId = await resolveTmdbIdFromExternalIds(item, item.type)
      const value = tmdbId ? await getTmdbCertification(item.type, tmdbId) : undefined
      if (!cancelled) setResolvedCertification({ key: certificationKey, value })
    })().catch(() => { if (!cancelled) setResolvedCertification({ key: certificationKey }) })
    return () => { cancelled = true }
  }, [certificationKey, item, item.anilistId, item.certification, item.id, item.imdbId, item.malId, item.tmdbId, item.tvdbId, item.type, resolvedCertification?.key, showCertification, visible])
  useLayoutEffect(() => {
    if (!visible) return
    const needsProgressResolution = showProgress || showTimeLeft
    const poster = markerRef.current?.closest<HTMLElement>('.discover-poster-fade')
    if (!showWatched && !needsProgressResolution && !needsEpisodeSummary && !needsCertificationResolution) {
      setWatchedResolved(true)
      setProgressResolved(true)
      setEpisodeSummaryResolved(true)
      if (poster) {
        poster.dataset.posterStatusReady = 'true'
        window.dispatchEvent(new Event('aurales:discover-poster-status-ready'))
      }
      return
    }
    if (showWatched) setWatchedResolved(false)
    if (needsProgressResolution) setProgressResolved(false)
    if (needsEpisodeSummary) setEpisodeSummaryResolved(false)
    if (!poster) return
    delete poster.dataset.posterStatusReady
    delete poster.dataset.posterDetailsFallbackReady
    const artwork = poster.querySelector<HTMLImageElement>('img[data-discover-media-key]')
    const currentArtworkUrl = artwork && (artwork.currentSrc || artwork.src)
    const sameArtworkAlreadyLoaded = artwork?.dataset.artworkLoaded === 'true'
      && artwork.dataset.artworkLoadedUrl === currentArtworkUrl
    if (artwork && !sameArtworkAlreadyLoaded) {
      delete artwork.dataset.artworkLoaded
      delete artwork.dataset.artworkLoadedUrl
      artwork.dataset.artworkLoadedPending = 'true'
    }
  }, [visible, item.id, item.type, primaryProgressProvider, isCachedWatched, sources,
    showWatched, showProgress, showTimeLeft, needsEpisodeSummary, needsCertificationResolution])
  useEffect(() => {
    if ((!showProgress && !showTimeLeft) || !visible) {
      setProgressResolved(true)
      return
    }
    let cancelled = false
    setProgressResolved(false)
    void ensurePosterProgress().finally(() => { if (!cancelled) setProgressResolved(true) })
    return () => { cancelled = true }
  }, [showProgress, showTimeLeft, visible])
  useEffect(() => {
    if (!showWatched || !visible) {
      setWatched(false)
      setWatchedResolved(true)
      return
    }
    // The local cache contains Jellyfin watched state as well as playback
    // history. Honor it for both the combined source and an explicitly local
    // selection, matching the ordinary Home poster cards.
    if (localWatchDataEnabled && isCachedWatched) {
      setWatched(true)
      setWatchedResolved(true)
      return
    }
    let cancelled = false
    setWatched(false)
    setWatchedResolved(false)
    void isWatchedFromProviders(searchResultToLookup(item), sources, watchProgress)
      .then((result) => { if (!cancelled) setWatched(result) })
      .catch(() => { if (!cancelled) setWatched(false) })
      .finally(() => { if (!cancelled) setWatchedResolved(true) })
    return () => { cancelled = true }
  }, [isCachedWatched, item, localWatchDataEnabled, primaryProgressProvider, showWatched, sources, visible, watchProgress])
  useEffect(() => {
    if (!needsEpisodeSummary || !visible) {
      setEpisodeSummary(undefined)
      setEpisodeSummaryResolved(true)
      return
    }
    let cancelled = false
    setEpisodeSummary(undefined)
    setEpisodeSummaryResolved(false)
    const refreshEpisodeSummary = () => {
      const serverSummary = localWatchDataEnabled
        ? getJellyfinPosterEpisodeSummaryForMedia(item)
        : Promise.resolve(undefined)
      const providerSummary = sources.some((source) => source !== 'local')
        ? getProviderWatchedEpisodeSummary(searchResultToLookup(item), sources)
        : Promise.resolve(undefined)
      void Promise.all([serverSummary, providerSummary]).then(([server, provider]) => {
        if (cancelled) return
        const preferred = primaryProgressProvider === 'local' ? server : provider || server
        const watched = Math.max(server?.watched || 0, provider?.watched || 0, localWatchedEpisodes)
        const nextEpisode = server && (server.watched || 0) > (provider?.watched || 0)
          ? server.nextEpisode || provider?.nextEpisode
          : provider?.nextEpisode || server?.nextEpisode
        setEpisodeSummary(preferred ? { ...preferred, watched, ...(nextEpisode ? { nextEpisode } : {}) } : undefined)
      }).catch(() => { if (!cancelled) setEpisodeSummary(undefined) })
        .finally(() => { if (!cancelled) setEpisodeSummaryResolved(true) })
    }
    refreshEpisodeSummary()
    window.addEventListener('aurales:server-catalogs-changed', refreshEpisodeSummary)
    return () => {
      cancelled = true
      window.removeEventListener('aurales:server-catalogs-changed', refreshEpisodeSummary)
    }
  }, [item, localWatchedEpisodes, localWatchDataEnabled, needsEpisodeSummary, primaryProgressProvider, sources, visible])

  const posterDetailsReady = posterDetailsFallbackReady || watchedResolved && progressResolved && episodeSummaryResolved
    && (!showCertification || Boolean(item.certification) || !visible || resolvedCertification?.key === certificationKey)
  useEffect(() => {
    if (!visible || !posterDetailsReady) return
    const poster = markerRef.current?.closest<HTMLElement>('.discover-poster-fade')
    if (!poster) return
    poster.dataset.posterStatusReady = 'true'
    window.dispatchEvent(new Event('aurales:discover-poster-status-ready'))
  }, [posterDetailsReady, visible])

  const watchedCheckmark = <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m8 12 2.5 2.5L16.5 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  const watchedMarker = !showWatched ? null
    : style === 'line' && !showAsCheckmark
      ? <span className={`discover-poster-watch-mark discover-poster-watch-mark--line${watched ? '' : ' is-pending'}`} aria-label={watched ? 'Watched' : undefined} title={watched ? 'Watched' : undefined} />
      : style === 'symbol'
        ? <span className={`discover-poster-watch-mark discover-poster-watch-mark--symbol${watched ? '' : ' is-pending'}`} aria-label={watched ? 'Watched' : undefined} title={watched ? 'Watched' : undefined}><svg viewBox="0 0 24 24" aria-hidden="true">{showAsCheckmark ? <><circle cx="12" cy="12" r="10" fill="white" /><path d="m7.5 12.2 3 3L17 8.8" fill="none" stroke="#111" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></> : <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />}</svg></span>
        : <span className={`discover-poster-watch-mark${style === 'tag' ? ' discover-poster-watch-mark--tag' : style === 'badge' ? ' discover-poster-watch-mark--badge' : ''}${watched ? '' : ' is-pending'}`} aria-label={watched ? 'Watched' : undefined} title={watched ? 'Watched' : undefined}>{showAsCheckmark && watchedCheckmark}<span className={showAsCheckmark ? 'hidden sm:inline' : ''}>Watched</span></span>
  const episodeWatched = episodeSummary?.total != null
    ? Math.min(episodeSummary.total, episodeSummary.watched)
    : episodeSummary?.watched || 0
  const episodesLeft = episodeSummary?.total != null
    ? Math.max(0, episodeSummary.total - episodeWatched)
    : undefined
  const progressIds = [item.id, item.imdbId, item.tmdbId, item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined,
    item.tvdbId, item.malId, item.malId != null ? `mal-${item.malId}` : undefined,
    item.anilistId, item.anilistId != null ? `anilist-${item.anilistId}` : undefined].filter((value) => value != null).map(String)
  const normalizedTitle = item.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  let progressPct: number | undefined
  let localRemainingSeconds: number | undefined
  if (localWatchDataEnabled) {
    for (const [key, entry] of watchProgress) {
      if (entry.completed || entry.durationSeconds <= 0 || (entry.mediaType === 'movie' ? 'movie' : 'series') !== item.type) continue
      const aliases = [key, entry.id, entry.mediaId, entry.imdbId, entry.tmdbId,
        entry.tmdbId != null ? `tmdb-${entry.tmdbId}` : undefined].filter((value) => value != null).map(String)
      const entryTitle = entry.title?.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      const matches = aliases.some((alias) => progressIds.includes(alias) || progressIds.some((id) => alias.startsWith(`${id}:`)))
        || Boolean(normalizedTitle && normalizedTitle === entryTitle)
      if (!matches) continue
      const pct = Math.max(0, Math.min(100, entry.progressSeconds / entry.durationSeconds * 100))
      if (pct > (progressPct ?? 0)) {
        progressPct = pct
        localRemainingSeconds = Math.max(0, entry.durationSeconds - entry.progressSeconds)
      }
    }
  }
  const titleKey = normalizedTitle ? `title:${item.type}:${normalizedTitle}` : undefined
  const serviceKeys = progressIds.map((id) => `${item.type}:${id}`)
  if (titleKey) serviceKeys.push(titleKey)
  for (const key of serviceKeys) {
    const pct = serviceProgress.get(key)
    if (pct != null && pct > (progressPct ?? 0)) progressPct = pct
  }
  let serviceRemainingSeconds: number | undefined
  for (const key of serviceKeys) {
    const candidate = serviceTimeLeft.get(key)
    if (candidate && (!serviceRemainingSeconds || candidate.pct >= (progressPct ?? 0))) serviceRemainingSeconds = candidate.remainingSeconds
  }
  const posterProgressPct = posterSettings.splitEpisodeProgress && item.type === 'series'
    && episodeSummary?.total ? Math.min(100, episodeWatched / episodeSummary.total * 100) : progressPct
  const displayedProgress = !watched && showProgress && posterProgressPct != null && posterProgressPct > 2
    ? posterProgressPct : undefined
  const remainingSeconds = localRemainingSeconds ?? serviceRemainingSeconds
  const formatTimeLeft = (seconds: number) => {
    const minutes = Math.max(0, Math.ceil(seconds / 60))
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }
  const genre = item.genres?.[0]
    || (item.genreIds?.[0] != null
      ? (item.isAnime ? GENRE_MAP_ANIME[item.genreIds[0]] : item.type === 'series' ? GENRE_MAP_TV[item.genreIds[0]] : GENRE_MAP_MOVIE[item.genreIds[0]])
      : undefined)
  const ageRating = showCertification ? item.certification || (resolvedCertification?.key === certificationKey ? resolvedCertification.value : undefined) : undefined
  const visibleDetails = getPosterVisibleDetails({ genre: showGenre && Boolean(genre), rating: showRating && Boolean(rating), ageRating: Boolean(ageRating) })
  const captionGenre = visibleDetails.genre ? genre : undefined
  const captionRating = visibleDetails.rating ? rating : undefined
  const details = [
    visibleDetails.ageRating ? ageRating : undefined,
    showEpisodes && episodesLeft != null ? `${episodesLeft} episodes left` : undefined,
    showEpisodesWatched && episodeSummary && (episodeSummary.total != null || episodeWatched > 0)
      ? episodeSummary.total != null ? `${episodeWatched}/${episodeSummary.total} watched` : `${episodeWatched} watched`
      : undefined,
    showNextEpisode && episodeSummary?.nextEpisode ? `Next ${episodeSummary.nextEpisode}` : undefined,
    showTimeLeft && remainingSeconds != null ? `${formatTimeLeft(remainingSeconds)} left` : undefined,
  ].filter(Boolean)
  const progressSegments = item.type === 'series' && posterSettings.splitEpisodeProgress
    ? getPosterEpisodeSegmentCount(episodeSummary?.total)
    : 0
  const segmentFill = progressSegments > 0 && episodeSummary?.total
    ? Math.max(0, Math.min(progressSegments, episodeWatched / episodeSummary.total * progressSegments))
    : 0
  const progressPlacement = posterSettings.progressPlacement
  const progressBar = displayedProgress == null ? null : progressSegments > 0
    ? <span className={`discover-poster-segment-progress discover-poster-segment-progress--${progressPlacement}`} role="progressbar" aria-label="Episodes watched" aria-valuemin={0} aria-valuemax={episodeSummary?.total} aria-valuenow={episodeWatched}>{Array.from({ length: progressSegments }, (_, index) => <span key={index} style={{ background: segmentFill >= index + 1 ? '#fff' : segmentFill > index ? `linear-gradient(to right,#fff ${(segmentFill - index) * 100}%,rgba(255,255,255,.42) ${(segmentFill - index) * 100}%)` : 'rgba(255,255,255,.42)' }} />)}</span>
    : <span className={`discover-poster-progress discover-poster-progress--${progressPlacement}`} role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(displayedProgress)}><span style={{ width: `${displayedProgress}%` }} /></span>
  const progressRing = posterSettings.progressPlacement === 'around-status' && displayedProgress != null
    ? <span className="discover-poster-progress-ring"><span className="discover-poster-progress-ring__status">{watched
      ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="white" /><path d="m7.5 12.2 3 3L17 8.8" fill="none" stroke="#111" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}</span><svg className="discover-poster-progress-ring__outline" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.42)" strokeWidth="2.5" /><circle cx="18" cy="18" r="15" fill="none" stroke="#fff" strokeWidth="2.5" strokeDasharray={`${displayedProgress * .9425} 94.25`} strokeLinecap="round" /></svg></span>
    : null
  const lineMarker = style === 'line' && !showAsCheckmark ? watchedMarker : null
  const footerMarker = lineMarker ? null : watchedMarker
  const hasCaption = Boolean(progressRing || footerMarker || showFavorite && favorite || captionGenre || captionRating)
  const footer = hasCaption ? <PosterFooterCaption
    alignment={contentAlignment}
    className="discover-poster-caption-row"
    status={progressRing || footerMarker}
    favorite={showFavorite && favorite ? <span className="text-sm" aria-label="In favorites" title="In favorites">♥</span> : undefined}
    genre={captionGenre}
    showSeparator={!progressRing && !footerMarker}
    rating={captionRating ? <><svg className="h-3 w-3 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{captionRating}</> : undefined}
  /> : undefined
  return <>
    <span ref={markerRef} className={`discover-poster-probe${watchedMarker ? '' : ' is-pending'}`} aria-hidden="true" />
    {lineMarker}
    {(details.length > 0 || showProgress && posterSettings.progressPlacement === 'under-details' && progressBar) && <span className={`discover-poster-details discover-poster-details--${contentAlignment}`}>{details.map((detail) => <span key={detail}>{detail}</span>)}{showProgress && posterSettings.progressPlacement === 'under-details' && progressBar}</span>}
    <PosterBottomStack
      className={`poster-bottom-stack--${contentAlignment}`}
      logo={logo}
      footer={footer}
      bottomProgress={showProgress && posterSettings.progressPlacement === 'along-bottom' ? progressBar : undefined}
    />
  </>
}


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

const DISCOVERY_RUNTIME_BUCKETS = [
  { id: 'under-90', label: 'Under 90 Minutes', min: 1, max: 89 },
  { id: 'about-2-hours', label: 'About 2 Hours', min: 90, max: 129 },
  { id: 'long-night', label: 'Long Night', min: 130, max: 240 },
] as const

const DISCOVERY_MOODS = [
  { id: 'feel-good', label: 'Feel-Good', genres: [35, 10751, 10749, 10402, 10762, 10766] },
  { id: 'edge-of-seat', label: 'Edge of Your Seat', genres: [28, 53, 80, 27, 9648, 10759, 10768] },
  { id: 'mind-bending', label: 'Mind-Bending', genres: [878, 9648, 14, 53, 10765] },
] as const
type DiscoveryContinuationKey = 'movies' | 'shows' | 'anime-movies' | 'anime-shows'

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

function formatWatchDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return hours ? `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ''}` : `${remainingMinutes}m`
}

function formatDiscoveryRating(value: number | undefined): string | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? value.toFixed(1) : undefined
}

const HENTAI_EXCLUDE_KEYWORDS = [{ id: 293054, name: 'hentai' }, { id: 6126, name: 'ecchi' }]
// Impressions recorded this session — once per day/tab/mode, so revisiting Discover
// doesn't re-penalize the shown titles and reshuffle the recommendations every time
const IMPRESSIONS_RECORDED = new Set<string>()
const MAX_DISCOVER_SESSION_KEYS = 500
// Keep anime out of the Movies/Series tabs — it lives in the Anime tab only
const ANIME_EXCLUDE_KEYWORDS = [{ id: 210024, name: 'anime' }]

function readDiscoveryPicks(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 3) : []
  } catch {
    return []
  }
}

function DiscoveryReveal({ children }: { children: import('react').ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealed(true)
      return
    }
    const element = ref.current
    if (!element) return
    const scrollRoot = element.closest<HTMLElement>('.app-scroll-root')
    // Keep the observer animation, with geometry fallbacks for both the app's
    // nested scroller and the window. Mobile Safari can dispatch programmatic
    // scrolls through either target while its visual viewport is settling.
    let didReveal = false
    const reveal = () => {
      if (didReveal) return
      didReveal = true
      setRevealed(true)
      observer.disconnect()
      scrollRoot?.removeEventListener('scroll', revealIfVisible)
      window.removeEventListener('scroll', revealIfVisible)
      window.removeEventListener('resize', revealIfVisible)
    }
    const revealIfVisible = () => {
      const bounds = element.getBoundingClientRect()
      const viewport = scrollRoot?.getBoundingClientRect()
      const viewportTop = viewport?.top ?? 0
      const viewportBottom = viewport?.bottom ?? window.innerHeight
      if (bounds.bottom >= viewportTop - 80 && bounds.top <= viewportBottom + 80) reveal()
    }
    const handleIntersection = ([entry]: IntersectionObserverEntry[]) => {
      if (entry?.isIntersecting) reveal()
    }
    const observer = new IntersectionObserver(handleIntersection, { root: scrollRoot, rootMargin: '0px 0px -32px 0px', threshold: 0.01 })
    observer.observe(element)
    scrollRoot?.addEventListener('scroll', revealIfVisible, { passive: true })
    window.addEventListener('scroll', revealIfVisible, { passive: true })
    window.addEventListener('resize', revealIfVisible, { passive: true })
    const frame = window.requestAnimationFrame(revealIfVisible)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      scrollRoot?.removeEventListener('scroll', revealIfVisible)
      window.removeEventListener('scroll', revealIfVisible)
      window.removeEventListener('resize', revealIfVisible)
    }
  }, [])

  return <div ref={ref} className="discover-reveal" data-revealed={revealed}>{children}</div>
}

function revealDiscoveryArtwork(event: import('react').SyntheticEvent<HTMLImageElement>): void {
  const image = event.currentTarget
  image.dataset.artworkLoaded = 'true'
  image.dataset.artworkLoadedUrl = image.currentSrc || image.src
}

// Anime = explicitly flagged, or Japanese-language animation. Plain genre-16 animation
// (Pixar, DreamWorks, ...) is NOT anime.
function isAnimeLike(entry: SearchResult): boolean {
  return Boolean(entry.isAnime || (entry.genreIds?.includes(16) && ['ja', 'zh', 'ko'].includes(entry.originalLanguage || '')))
}

function matchesDiscoverContent(entry: SearchResult, contentTypes: DiscoverContentType[]): boolean {
  if (isAnimeLike(entry)) return contentTypes.includes('anime')
  if (entry.type === 'movie') return contentTypes.includes('movies')
  return contentTypes.includes('shows')
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

function makeContentTypeConfigs(
  contentTypes: DiscoverContentType[],
  sortBy: string,
  preferences: { region: string; minRating: number; includeAdult: boolean },
  overrides: Partial<DiscoverConfig> = {},
): DiscoverConfig[] {
  const configs: DiscoverConfig[] = []
  if (contentTypes.includes('movies')) {
    configs.push(makeConfig('movie', sortBy, preferences, { ...overrides, excludeKeywords: overrides.excludeKeywords ?? ANIME_EXCLUDE_KEYWORDS }))
  }
  if (contentTypes.includes('shows')) {
    configs.push(makeConfig('series', sortBy, preferences, { ...overrides, excludeKeywords: overrides.excludeKeywords ?? ANIME_EXCLUDE_KEYWORDS }))
  }
  if (contentTypes.includes('anime')) {
    const animeOverrides: Partial<DiscoverConfig> = {
      ...overrides,
      // Use the API query only to constrain the anime source. Additional
      // genre/mood filters are applied to results by the continuation matcher
      // so an OR mood list does not accidentally require every genre.
      includeGenres: ['16'],
      genreMatchMode: 'AND',
      originalLanguage: overrides.originalLanguage || 'ja',
      excludeKeywords: overrides.excludeKeywords ?? HENTAI_EXCLUDE_KEYWORDS,
    }
    configs.push(makeConfig('movie', sortBy, preferences, animeOverrides), makeConfig('series', sortBy, preferences, animeOverrides))
  }
  return configs
}

function useDiscoverRow(config: DiscoverConfig, rowId: string, enabled = true, refreshNonce = 0, onLoadingChange?: (rowId: string, loading: boolean) => void, enrichResults = true) {
  const setCachedRow = useDiscoverStore((s) => s.setCachedRow)

  // Read cache snapshot once — avoid putting cachedRows in deps to prevent feedback loops
  const items = useDiscoverStore((s) => s.cachedRows[rowId]?.items) ?? []
  useEffect(() => {
    if (!enabled) {
      onLoadingChange?.(rowId, false)
      return
    }

    let cancelled = false
    let staleRefreshStarted = false
    onLoadingChange?.(rowId, items.length === 0)
    const forceKey = `${rowId}:${refreshNonce}`
    const forceRefresh = refreshNonce > 0 && !FORCED_DISCOVERY_REFRESHES.has(forceKey)
    if (forceRefresh) rememberDiscoverSessionKey(FORCED_DISCOVERY_REFRESHES, forceKey)
    discoverTmdbWithCache(config, rowId, forceRefresh, (fresh) => {
      if (cancelled) return
      staleRefreshStarted = true
      if (!enrichResults) {
        setCachedRow(rowId, fresh.map(applySearchResultArt))
        return
      }
      import('../services/metadata/metadataResolver')
        .then(({ enrichSearchResultsWithAppMetadata }) => enrichSearchResultsWithAppMetadata(fresh))
        .then((enriched) => { if (!cancelled) setCachedRow(rowId, enriched.map(applySearchResultArt)) })
        .catch(() => { if (!cancelled) setCachedRow(rowId, fresh.map(applySearchResultArt)) })
    })
      .then(async (results) => {
        if (cancelled) return
        if (results.length === 0 && items.length > 0) return
        const enriched = enrichResults
          ? await import('../services/metadata/metadataResolver').then(({ enrichSearchResultsWithAppMetadata }) => enrichSearchResultsWithAppMetadata(results))
          : results
        const finalItems = enriched.map(applySearchResultArt)
        if (!cancelled && !staleRefreshStarted && (finalItems.length > 0 || items.length === 0)) setCachedRow(rowId, finalItems)
      })
      .catch(() => {
        if (!cancelled && items.length === 0) setCachedRow(rowId, [])
      })
      .finally(() => { if (!cancelled) onLoadingChange?.(rowId, false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, enabled, refreshNonce, onLoadingChange, enrichResults])

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

function opaqueScope(value: string | null): string {
  if (!value) return 'none'
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(36)
}

function recommendationCandidate(item: SearchResult, source: RecommendationCandidate['source'], overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return { item, source, voteCount:item.voteCount, popularity:item.popularity, trendSignal:source === 'tmdb-trending', runtimeMinutes:item.runtime, releaseDate:item.releaseDate, ...overrides }
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
  const activeProfile = getActiveProfile()
  const tab = useDiscoverStore((s) => s.tab)
  const setTab = useDiscoverStore((s) => s.setTab)
  const contentTypes = useDiscoverStore((s) => s.contentTypes)
  const setContentTypes = useDiscoverStore((s) => s.setContentTypes)
  const contentTypeKey = [...contentTypes].sort().join('+')
  const continuationTabs: NonNullable<DiscoveryCatalogContinuation['tabs']> = contentTypes.map((type) => type === 'shows' ? 'series' : type)
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
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey)
  const stremioAuthKey = useMemo(() => getStremioAuth()?.authKey ?? null, [])
  const accountScope = useMemo(() => [
    traktConnected ? `trakt:${providerCacheScope('trakt')}` : '',
    simklConnected ? `simkl:${providerCacheScope('simkl')}` : '',
    anilistConnected ? `anilist:${providerCacheScope('anilist')}` : '',
    stremioAuthKey ? `stremio:${opaqueScope(stremioAuthKey)}` : '',
  ].filter(Boolean).join('|') || 'local', [traktConnected, simklConnected, anilistConnected, stremioAuthKey])
  // Discovery is one blended stream; the old top-level Browse selector split
  // titles into modes even though the page already presents every shelf.
  const mode: DiscoveryMode = 'for-you'
  const prefs = useDiscoverPrefsStore((s) => s.prefs)

  const [feedback, setFeedback] = useState<RecommendationFeedback[]>(() => loadRecommendationFeedback())
  const [trendingSnapshot, setTrendingSnapshot] = useState<{ scope: string; items: SearchResult[] }>({ scope: '', items: [] })
  const [similarCandidates, setSimilarCandidates] = useState<RecommendationCandidate[]>([])
  const [watchedTasteMetadata, setWatchedTasteMetadata] = useState<NonNullable<import('../services/discovery/types').DiscoveryActivity['tasteMetadata']>>([])
  const [connectedActivity, setConnectedActivity] = useState<{ items: SearchResult[]; progress: import('../types').WatchProgress[]; ratings: Array<{item:SearchResult;rating:number}>; watchlist:DatedLibraryItem[]; rewatches:SearchResult[]; bingeItems:SearchResult[] }>({ items:[], progress:[], ratings:[], watchlist:[], rewatches:[], bingeItems:[] })
  const [localWatchlist, setLocalWatchlist] = useState<LocalWatchlistItem[]>(() => getLocalWatchlist())
  useEffect(() => subscribeLocalWatchlist(() => setLocalWatchlist(getLocalWatchlist())), [])
  const [impressions] = useState(() => loadRecommendationImpressions())
  const [discoverySettledScope, setDiscoverySettledScope] = useState('')
  const [genreLoading, setGenreLoading] = useState(false)
  const [discoveryRowLoads, setDiscoveryRowLoads] = useState<Record<string, boolean>>({})
  const reportDiscoveryRowLoading = useCallback((rowId: string, loading: boolean) => {
    setDiscoveryRowLoads((current) => current[rowId] === loading ? current : { ...current, [rowId]: loading })
  }, [])
  const reportGenreLoading = useCallback((_rowId: string, loading: boolean) => setGenreLoading(loading), [])
  const [trendingReadyScope, setTrendingReadyScope] = useState('')
  const [similarReadyScope, setSimilarReadyScope] = useState('')
  const [connectedReadyScope, setConnectedReadyScope] = useState('')
  const [selectedGenreId, setSelectedGenreId] = useState<number | null>(null)
  const [selectedSimilaritySectionId, setSelectedSimilaritySectionId] = useState<string | null>(null)
  const [tasteQuery, setTasteQuery] = useState('')
  const [bingeIndex, setBingeIndex] = useState(0)
  const [weekendPlanIndex, setWeekendPlanIndex] = useState(0)
  const [selectedRuntimeBucketId, setSelectedRuntimeBucketId] = useState<(typeof DISCOVERY_RUNTIME_BUCKETS)[number]['id']>('long-night')
  const [selectedDiscoveryMoodId, setSelectedDiscoveryMoodId] = useState<(typeof DISCOVERY_MOODS)[number]['id']>('mind-bending')
  const [selectedPosterColor, setSelectedPosterColor] = useState<PosterColorGroup | 'all'>('all')
  const [posterColors, setPosterColors] = useState<Record<string, PosterColorGroup>>({})
  const posterColorCacheRef = useRef<Record<string, PosterColorGroup>>({})
  const unavailablePosterColorsRef = useRef(new Set<string>())
  const [moreToDiscover, setMoreToDiscover] = useState<SearchResult[]>([])
  const [moreToDiscoverStatus, setMoreToDiscoverStatus] = useState<'idle' | 'loading' | 'error' | 'paused' | 'done'>('idle')
  const moreToDiscoverSentinelRef = useRef<HTMLDivElement>(null)
  const moreToDiscoverScopeRef = useRef('')
  const moreToDiscoverItemsRef = useRef<SearchResult[]>([])
  const moreToDiscoverStatusRef = useRef<'idle' | 'loading' | 'error' | 'paused' | 'done'>('idle')
  const moreToDiscoverLoadingRef = useRef(false)
  const moreToDiscoverPagesRef = useRef<Record<DiscoveryContinuationKey, number>>({ movies: 3, shows: 3, 'anime-movies': 3, 'anime-shows': 3 })
  const moreToDiscoverExhaustedRef = useRef<Record<DiscoveryContinuationKey, boolean>>({ movies: false, shows: false, 'anime-movies': false, 'anime-shows': false })
  const loadMoreDiscoveryRef = useRef<() => Promise<void>>(async () => undefined)
  const genrePicksRef = useRef<HTMLDivElement>(null)
  const surpriseButtonRef = useRef<HTMLButtonElement>(null)
  const pickerDialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (selectedGenreId == null) return
    const frame = window.requestAnimationFrame(() => {
      genrePicksRef.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedGenreId])

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
  const [pickerSelectionKey, setPickerSelectionKey] = useState<string | null>(null)
  const [spotlightSelectionKey, setSpotlightSelectionKey] = useState<string | null>(null)
  const spotlightTransitionRef = useRef<HTMLElement | null>(null)
  const previousSpotlightKeyRef = useRef<string | null>(null)
  const [pickerLogoError,setPickerLogoError]=useState(false)
  const [heroLogoError,setHeroLogoError]=useState(false)
  const preferencesWereOpenRef = useRef(false)
  const [heroArt,setHeroArt]=useState<Record<string,{poster?:string;backdrop?:string;logo?:string}>>({})
  const [resolvedPosterLogoLookups, setResolvedPosterLogoLookups] = useState<Record<string, boolean>>({})
  const [failedPosterLogos, setFailedPosterLogos] = useState<Record<string, boolean>>({})
  const [posterLogoLoadRevision, setPosterLogoLoadRevision] = useState(0)
  const [posterDetailsLoadRevision, setPosterDetailsLoadRevision] = useState(0)
  const [loadedHeroBackdrop,setLoadedHeroBackdrop]=useState<string | null>(null)
  const [loadedWeekendBackdrop,setLoadedWeekendBackdrop]=useState<string | null>(null)
  const [surpriseSpinning, setSurpriseSpinning] = useState(false)
  const [pickerRollDurationMs, setPickerRollDurationMs] = useState(520)
  const surpriseSpinningRef = useRef(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerClosing, setPickerClosing] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const preferencesButtonRef = useRef<HTMLButtonElement>(null)
  const setDiscoverPrefs = useDiscoverPrefsStore((s) => s.setPrefs)
  const resetDiscoverPrefs = useDiscoverPrefsStore((s) => s.resetPrefs)
  const pickerClosingRef = useRef(false)
  const pickerCloseTimerRef = useRef<number | null>(null)
  const surpriseRunRef = useRef(0)
  const updateSurpriseSpinning = useCallback((spinning: boolean) => {
    surpriseSpinningRef.current = spinning
    setPickerRollDurationMs(spinning ? 180 : 520)
    setSurpriseSpinning(spinning)
  }, [])
  const [pickOffset, setPickOffset] = useState(0)
  const pickStorageKey = `aurales_discovery_picks:${getActiveProfileId()}:${tab}`
  const [pickedIds, setPickedIds] = useState<string[]>(() => readDiscoveryPicks(pickStorageKey))

  useEffect(() => { setPickedIds(readDiscoveryPicks(pickStorageKey)); setPickOffset(0) }, [pickStorageKey])
  useEffect(() => () => {
    surpriseRunRef.current += 1
    if (pickerCloseTimerRef.current != null) window.clearTimeout(pickerCloseTimerRef.current)
  }, [])

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

  const genreMap = useMemo(() => {
    const combined: Record<number, string> = {}
    if (contentTypes.includes('movies')) Object.assign(combined, GENRE_MAP_MOVIE)
    if (contentTypes.includes('shows')) Object.assign(combined, GENRE_MAP_TV)
    if (contentTypes.includes('anime')) Object.assign(combined, GENRE_MAP_ANIME)
    return combined
  }, [contentTypes])
  const genreOptions = useMemo(() => Object.entries(genreMap).map(([id, title]) => ({ id: Number(id), title })), [genreMap])
  const contentType = tab === 'movies' ? 'movie' : 'series'
  const preferences = useMemo(() => ({ region, minRating, includeAdult }), [region, minRating, includeAdult])
  const preferenceKey = `${region}-${minRating}-${includeAdult}`
  // Advanced preferences change the TMDB request itself. Include a compact
  // signature in every row key so a provider/language/genre change cannot
  // silently reuse results fetched for the previous query.
  const discoveryPrefsKey = opaqueScope(prefsSignature(prefs))
  const discoveryQueryKey = `${preferenceKey}-${discoveryPrefsKey}-${contentTypeKey}`
  useEffect(() => { setSelectedPosterColor('all') }, [tab, discoveryQueryKey])
  const continuationScope = `${contentTypeKey}:${discoveryQueryKey}`
  useEffect(() => {
    moreToDiscoverScopeRef.current = continuationScope
    moreToDiscoverItemsRef.current = []
    moreToDiscoverStatusRef.current = 'idle'
    moreToDiscoverLoadingRef.current = false
    moreToDiscoverPagesRef.current = { movies: 3, shows: 3, 'anime-movies': 3, 'anime-shows': 3 }
    moreToDiscoverExhaustedRef.current = {
      movies: !contentTypes.includes('movies'),
      shows: !contentTypes.includes('shows'),
      'anime-movies': !contentTypes.includes('anime'),
      'anime-shows': !contentTypes.includes('anime'),
    }
    setMoreToDiscover([])
    setMoreToDiscoverStatus('idle')
  }, [continuationScope, contentTypes])
  const trendingScope = `${contentTypeKey}:${discoveryQueryKey}:week`
  const currentTrending = useMemo(() => trendingSnapshot.scope === trendingScope ? trendingSnapshot.items : [], [trendingSnapshot, trendingScope])
  // A daily snapshot is stable for an unchanged taste profile, but connected
  // watchlists and playback history can hydrate after the first render. Include
  // their identity fingerprint so those newly available seeds replace a stale
  // anonymous snapshot on the same day.
  const personalizationScope = opaqueScope(JSON.stringify({
    favorites: [...localWatchlist, ...connectedActivity.watchlist].map(mediaIdentity).sort(),
    watched: [...recentlyViewed, ...connectedActivity.items].map(mediaIdentity).sort(),
    progress: progressSignals.watchedSeeds,
    // A live feed can retain its titles while their weekly popularity/order
    // changes. Include those signals so a frozen daily snapshot cannot mask
    // the current public trend ranking across the Hero and recommendation rows.
    trending: trendingScopeFingerprint(currentTrending),
  }))
  // Snapshots are durable per person and Berlin date.  Switching away and
  // back therefore restores that profile's frozen daily Discover ranking,
  // updated when its local or connected taste signals have changed.
  const dailySnapshotScope = `${getActiveProfileId()}:${contentTypeKey}:${mode}:${discoveryQueryKey}:${accountScope}:${personalizationScope}`
  const dailySnapshotKey = makeDailySnapshotKey(berlinDateKey, dailySnapshotScope)
  const dailySnapshot = persistedRankings[dailySnapshotKey]
  const hasDailySnapshot = Boolean(dailySnapshot?.length && dailySnapshotMeta[dailySnapshotKey]?.algorithmVersion === DISCOVERY_ALGORITHM_VERSION)
  const refreshNonce = 0
  const tasteGenre = useMemo(() => getTopGenre(recentlyViewed, contentType), [recentlyViewed, contentType])
  const animeOverrides = tab === 'anime' ? {
    originalLanguage: 'ja',
    includeGenres: ['16'],
    excludeKeywords: HENTAI_EXCLUDE_KEYWORDS,
  } : {
    excludeKeywords: ANIME_EXCLUDE_KEYWORDS,
  }
  const recommendationRowIds = [
    `discover-trending-${tab}-${discoveryQueryKey}`,
    `discover-toprated-${tab}-${discoveryQueryKey}`,
    `discover-gems-${tab}-${discoveryQueryKey}`,
    `discover-quick-${tab}-${discoveryQueryKey}`,
    `discover-for-you-${tab}-${tasteGenre || 'starter'}-${discoveryQueryKey}`,
    ...(contentTypes.includes('movies') ? [`discover-mix-movies-${discoveryQueryKey}`] : []),
    ...(contentTypes.includes('shows') ? [`discover-mix-shows-${discoveryQueryKey}`] : []),
    ...(contentTypes.includes('anime') ? [`discover-mix-anime-shows-${discoveryQueryKey}`, `discover-mix-anime-movies-${discoveryQueryKey}`] : []),
    ...(tab === 'anime' ? [`discover-anime-movies-${discoveryQueryKey}`, `discover-anime-movies-top-${discoveryQueryKey}`] : []),
  ]

  const trending = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, animeOverrides),
    `discover-trending-${tab}-${discoveryQueryKey}`,
    !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  useEffect(() => {
    let cancelled = false
    const sourceTypes = [
      ...(contentTypes.includes('movies') || contentTypes.includes('anime') ? ['movie' as const] : []),
      ...(contentTypes.includes('shows') || contentTypes.includes('anime') ? ['series' as const] : []),
    ]
    Promise.all(sourceTypes.map((type) => getTrendingTmdb(type, 'week')))
      .then((sources) => {
        if (cancelled) return
        const unique = new Map<string, SearchResult>()
        for (const item of interleaveLiveTrendSources(sources)) {
          if (!matchesDiscoverContent(item, contentTypes)) continue
          const key = mediaIdentity(item)
          if (!unique.has(key)) unique.set(key, item)
        }
        setTrendingSnapshot({ scope: trendingScope, items: [...unique.values()].map(applySearchResultArt) })
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setTrendingReadyScope(trendingScope) })
    return () => { cancelled = true }
  }, [contentTypes, trendingScope])
  const topRated = useDiscoverRow(
    makeConfig(contentType, 'vote_average.desc', preferences, {
      voteCountMin: tab === 'anime' ? 150 : 500,
      ...animeOverrides
    }),
    `discover-toprated-${tab}-${discoveryQueryKey}`,
    !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  const genreItems = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      includeGenres: [...new Set([...(tab === 'anime' ? ['16'] : []), ...(selectedGenreId == null ? [] : [String(selectedGenreId)])])],
      genreMatchMode: 'AND',
      voteAverageMin: Math.max(6, minRating),
      voteCountMin: tab === 'anime' ? 50 : 100,
      ...(tab === 'anime' ? { originalLanguage: 'ja', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS } : { excludeKeywords: ANIME_EXCLUDE_KEYWORDS }),
    }),
    `discover-genre-${tab}-${selectedGenreId ?? 'none'}-${discoveryQueryKey}`,
    selectedGenreId != null,
    refreshNonce,
    reportGenreLoading,
  )
  const hiddenGemsConfig = makeConfig(contentType, 'vote_average.desc', preferences, {
    voteAverageMin: Math.max(7.2, minRating),
    voteCountMin: tab === 'anime' ? 80 : 120,
    ...animeOverrides,
  })
  const hiddenGems = useDiscoverRow(
    hiddenGemsConfig,
    `discover-gems-${tab}-${discoveryQueryKey}`,
    !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  const quickWatches = useDiscoverRow(
    makeConfig(contentType, 'popularity.desc', preferences, {
      runtimeMax: contentType === 'movie' ? 100 : tab === 'anime' ? 25 : 35,
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: tab === 'anime' ? 80 : 200,
      ...animeOverrides
    }),
    `discover-quick-${tab}-${discoveryQueryKey}`,
    !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  const selectedRuntimeBucket = DISCOVERY_RUNTIME_BUCKETS.find((bucket) => bucket.id === selectedRuntimeBucketId) ?? DISCOVERY_RUNTIME_BUCKETS[2]
  const genreRowId = `discover-genre-${tab}-${selectedGenreId ?? 'all'}-${discoveryQueryKey}`
  // Anime movies — the anime tab's discover rows are series-only, so without these
  // rows anime films would never surface in the anime category
  const animeMovieOverrides = { originalLanguage: 'ja', includeGenres: ['16'], genreMatchMode: 'AND' as const, excludeKeywords: HENTAI_EXCLUDE_KEYWORDS }
  const animeMovies = useDiscoverRow(
    makeConfig('movie', 'popularity.desc', preferences, { ...animeMovieOverrides, voteCountMin: 100 }),
    `discover-anime-movies-${discoveryQueryKey}`,
    tab === 'anime' && !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  const animeMoviesTop = useDiscoverRow(
    makeConfig('movie', 'vote_average.desc', preferences, { ...animeMovieOverrides, voteCountMin: 150, voteAverageMin: Math.max(7, minRating) }),
    `discover-anime-movies-top-${discoveryQueryKey}`,
    tab === 'anime' && !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  const mixedMovies = useDiscoverRow(
    makeConfig('movie', 'popularity.desc', preferences, { voteAverageMin: Math.max(6, minRating), voteCountMin: 100, excludeKeywords: ANIME_EXCLUDE_KEYWORDS }),
    `discover-mix-movies-${discoveryQueryKey}`,
    contentTypes.includes('movies'), refreshNonce, reportDiscoveryRowLoading,
  )
  const mixedShows = useDiscoverRow(
    makeConfig('series', 'popularity.desc', preferences, { voteAverageMin: Math.max(6, minRating), voteCountMin: 100, excludeKeywords: ANIME_EXCLUDE_KEYWORDS }),
    `discover-mix-shows-${discoveryQueryKey}`,
    contentTypes.includes('shows'), refreshNonce, reportDiscoveryRowLoading,
  )
  const mixedAnimeShows = useDiscoverRow(
    makeConfig('series', 'popularity.desc', preferences, { includeGenres: ['16'], genreMatchMode: 'AND', originalLanguage: 'ja', voteCountMin: 50, excludeKeywords: HENTAI_EXCLUDE_KEYWORDS }),
    `discover-mix-anime-shows-${discoveryQueryKey}`,
    contentTypes.includes('anime'), refreshNonce, reportDiscoveryRowLoading,
  )
  const mixedAnimeMovies = useDiscoverRow(
    makeConfig('movie', 'popularity.desc', preferences, { includeGenres: ['16'], genreMatchMode: 'AND', originalLanguage: 'ja', voteCountMin: 50, excludeKeywords: HENTAI_EXCLUDE_KEYWORDS }),
    `discover-mix-anime-movies-${discoveryQueryKey}`,
    contentTypes.includes('anime'), refreshNonce, reportDiscoveryRowLoading,
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
    !hasDailySnapshot,
    refreshNonce,
    reportDiscoveryRowLoading,
  )
  // The binge feature is about long-form series, even when the visitor is
  // browsing movies. Fetch a popular TV shelf independently instead of trying
  // to derive series from the movie-only ranking pool.
  const bingeSeries = useDiscoverRow(
    makeConfig('series', 'popularity.desc', preferences, {
      voteAverageMin: Math.max(6.5, minRating),
      voteCountMin: 150,
      excludeKeywords: ANIME_EXCLUDE_KEYWORDS,
    }),
    `discover-binge-series-${discoveryQueryKey}`,
    contentTypes.includes('shows') || contentTypes.includes('anime'),
    refreshNonce,
    reportDiscoveryRowLoading,
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

  const similaritySeeds = useMemo(() => {
    const matchesTab = (item: SearchResult) => tab === 'anime'
      ? isAnimeLike(item)
      : item.type === contentType && !isAnimeLike(item)
    const unique = (items: SearchResult[]) => [...new Map(items
      .filter((item) => item.tmdbId != null && item.title?.trim() && matchesTab(item))
      .map((item) => [mediaIdentity(item), item])).values()].slice(0, 3)
    const favorites = unique([...localWatchlist, ...connectedActivity.watchlist])
    const seeds = favorites.length ? favorites.map((item) => ({ item, kind: 'favorited' as const }))
      : unique(watchedForSeeds).map((item) => ({ item, kind: 'watched' as const }))
    return seeds
  }, [localWatchlist, connectedActivity.watchlist, watchedForSeeds, tab, contentType])
  const similarScope = opaqueScope(JSON.stringify([tab, similaritySeeds.map(({ item, kind }) => [mediaIdentity(item), kind])]))

  useEffect(() => {
    if (hasDailySnapshot) return
    // Clear previous tab's candidates and metadata before collecting new seeds.
    setSimilarCandidates([])
    setWatchedTasteMetadata([])
    if (!similaritySeeds.length) {
      setSimilarReadyScope(similarScope)
      return
    }
    let cancelled = false
    const metadata: NonNullable<import('../services/discovery/types').DiscoveryActivity['tasteMetadata']> = []
    collectCandidateSources(similaritySeeds.map(({ item: seed, kind }) => ({ id: `similar:${kind}:${seed.type}:${seed.tmdbId}`, load: async () => {
      const id = `tmdb-${seed.tmdbId}`
      const details = seed.type === 'movie' ? await tmdbProvider.getMovie(id) : await tmdbProvider.getShow(id)
      metadata.push({ item: seed, runtimeMinutes: 'runtime' in details ? details.runtime : undefined, cast: details.cast.slice(0, 5).map((person) => person.name), directors: details.crew.filter((person) => person.job === 'Director' || person.job === 'Creator').slice(0, 3).map((person) => person.name) })
      const candidates = details.recommendations.map((item) => recommendationCandidate(item, 'tmdb-similar', { seedTitle: seed.title, seedKind: kind, seedYear: seed.year }))
      const director = details.crew.find((person) => person.job === 'Director' || person.job === 'Creator')
      const people = [details.cast[0] ? { id: details.cast[0].id, name: details.cast[0].name, source: 'tmdb-cast' as const } : null, director ? { id: director.id, name: director.name, source: 'tmdb-director' as const } : null].filter((person): person is NonNullable<typeof person> => Boolean(person))
      const credits = await Promise.allSettled(people.map(async (person) => ({ person, details: await getTmdbPerson(person.id) })))
      for (const result of credits) if (result.status === 'fulfilled') candidates.push(...result.value.details.credits.slice(0, 12).map((item) => recommendationCandidate(item, result.value.person.source, { seedTitle: result.value.person.name, ...(result.value.person.source === 'tmdb-cast' ? { cast: [result.value.person.name] } : { directors: [result.value.person.name] }) })))
      return candidates
    } }))).then((result) => {
      if (cancelled) return
      const matchesTab = (candidate: RecommendationCandidate) => tab === 'anime'
        ? isAnimeLike(candidate.item)
        : candidate.item.type === contentType && !isAnimeLike(candidate.item)
      setSimilarCandidates(result.items.filter(matchesTab).slice(0, 50))
      setWatchedTasteMetadata(metadata)
    })
      .finally(() => { if (!cancelled) setSimilarReadyScope(similarScope) })
    return () => { cancelled = true }
  }, [similaritySeeds, similarScope, tab, contentType, hasDailySnapshot])

  useEffect(() => {
    if (hasDailySnapshot) return
    if (!traktConnected && !simklConnected && !stremioAuthKey && !anilistConnected) { const timer=window.setTimeout(()=>{setConnectedActivity({items:[],progress:[],ratings:[],watchlist:[],rewatches:[],bingeItems:[]});setConnectedReadyScope(accountScope)},0); return()=>window.clearTimeout(timer) }
    let cancelled = false
    Promise.allSettled([
      traktConnected ? Promise.all([getTraktWatchedMovies(),getTraktWatchedShows(),getTraktRatings('movies'),getTraktRatings('shows'),import('../services/trakt/sync').then((m)=>m.getWatchlist('movies')),import('../services/trakt/sync').then((m)=>m.getWatchlist('shows'))]) : Promise.resolve([[],[],[],[],[],[]] as const),
      simklConnected ? Promise.all([getSimklWatchedMovies(),getSimklWatchedEpisodes(),getSimklWatchlist()]) : Promise.resolve([[],[],[]] as const),
      stremioAuthKey ? getStremioWatchHistory(stremioAuthKey) : Promise.resolve([] as StremioLibraryEntry[]),
      anilistConnected ? import('../services/anilist').then((m)=>m.getAniListFullList()) : Promise.resolve([] as AniListFullEntry[]),
    ]).then(async ([traktResult,simklResult,stremioResult,anilistResult]) => {
      const items: SearchResult[] = []
      const rawRatings: Array<{item:SearchResult;rating:number}> = []
      const rewatches:SearchResult[]=[]; const bingeItems:SearchResult[]=[]; const watchlist:DatedLibraryItem[]=[]
      if (traktResult.status === 'fulfilled') for (const entry of [...traktResult.value[0],...traktResult.value[1]]) { const media=entry.movie||entry.show; if(media) { const mapped={id:`tmdb-${media.ids.tmdb}`,title:media.title,type:entry.movie?'movie' as const:'series' as const,year:media.year,provider:'trakt',tmdbId:media.ids.tmdb,imdbId:media.ids.imdb}; items.push(mapped); if(entry.plays>1)rewatches.push(mapped); if(entry.seasons?.some((season)=>season.episodes.filter((episode)=>episode.plays>0).length>=3))bingeItems.push(mapped) } }
      if (traktResult.status === 'fulfilled') for (const raw of [...traktResult.value[2],...traktResult.value[3]]) { if(!raw||typeof raw!=='object')continue; const record=raw as Record<string,unknown>; const media=(record.movie||record.show) as {title?:string;year?:number;ids?:{tmdb?:number;imdb?:string}}|undefined; const rating=Number(record.rating); if(media?.title&&Number.isFinite(rating)) rawRatings.push({rating,item:{id:media.ids?.tmdb?`tmdb-${media.ids.tmdb}`:media.ids?.imdb||media.title,title:media.title,type:record.movie?'movie':'series',year:media.year,provider:'trakt',tmdbId:media.ids?.tmdb,imdbId:media.ids?.imdb}}) }
      if(traktResult.status==='fulfilled')for(const raw of [...traktResult.value[4],...traktResult.value[5]]){if(!raw||typeof raw!=='object')continue;const record=raw as Record<string,unknown>;const media=(record.movie||record.show) as {title?:string;year?:number;ids?:{tmdb?:number;imdb?:string}}|undefined;const libraryAddedAt=parseLibraryAddedAt(record.listed_at);if(media?.title&&libraryAddedAt)watchlist.push({id:media.ids?.tmdb?`tmdb-${media.ids.tmdb}`:media.ids?.imdb||media.title,title:media.title,type:record.movie?'movie':'series',year:media.year,provider:'trakt',tmdbId:media.ids?.tmdb,imdbId:media.ids?.imdb,libraryAddedAt})}
      if (simklResult.status === 'fulfilled') for (const entry of [...simklResult.value[0],...simklResult.value[1]]) items.push({id:entry.tmdbId?`tmdb-${entry.tmdbId}`:entry.id,title:entry.title,type:entry.type==='movie'?'movie':'series',year:entry.year,provider:'simkl',tmdbId:entry.tmdbId,imdbId:entry.imdbId,simklId:entry.simklId,isAnime:entry.type==='anime',poster:entry.poster,backdrop:entry.backdrop})
      if(simklResult.status==='fulfilled')for(const entry of simklResult.value[2]){const libraryAddedAt=parseLibraryAddedAt(entry.addedAt);if(libraryAddedAt)watchlist.push({id:entry.tmdbId?`tmdb-${entry.tmdbId}`:entry.id,title:entry.title,type:entry.type==='movie'?'movie':'series',year:entry.year,provider:'simkl',tmdbId:entry.tmdbId,imdbId:entry.imdbId,simklId:entry.simklId,isAnime:entry.type==='anime',poster:entry.poster,backdrop:entry.backdrop,libraryAddedAt})}
      if(stremioResult.status==='fulfilled')for(const entry of stremioResult.value){const mapped={id:entry.imdbId||entry.id,title:entry.title,type:entry.type,year:entry.year,provider:'stremio',imdbId:entry.imdbId,poster:entry.poster};items.push(mapped)}
      // AniList watched anime → taste/Discovery. Include anything the user engaged
      // with (progress > 0 or completed); enrichment resolves tmdb ids downstream.
      if(anilistResult.status==='fulfilled')for(const entry of anilistResult.value){if(entry.status==='PLANNING'||(entry.progress<=0&&entry.status!=='COMPLETED'))continue;const mapped={id:`anilist-${entry.mediaId}`,title:entry.title,type:'series' as const,year:entry.seasonYear,provider:'anilist',malId:entry.idMal,anilistId:entry.mediaId,isAnime:true,poster:entry.poster,backdrop:entry.backdrop};items.push(mapped);if((entry.repeat||0)>0)rewatches.push(mapped)}
      const unique=[...new Map(items.map((item)=>[mediaIdentity(item),item])).values()].slice(0,150)
      const { enrichSearchResultsWithAppMetadata } = await import('../services/metadata/metadataResolver')
      const enriched=await enrichSearchResultsWithAppMetadata(unique)
      // Trakt's watchlist endpoint supplies stable TMDB IDs and listed_at but no art.
      // Resolve a bounded recent subset through the existing metadata provider so
      // connected entries can participate in the library shelf without fake dates.
      const recentWatchlist = watchlist.sort((a,b)=>b.libraryAddedAt-a.libraryAddedAt).slice(0,40)
      const artworkResolved: DatedLibraryItem[] = []
      for (let offset = 0; offset < recentWatchlist.length; offset += 4) {
        const batch = await Promise.all(recentWatchlist.slice(offset, offset + 4).map(async (item) => {
          if (item.poster || !item.tmdbId) return item
          try {
            const details = item.type === 'movie'
              ? await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`)
              : await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)
            return { ...item, poster: details.poster, backdrop: item.backdrop || details.backdrop }
          } catch { return item }
        }))
        artworkResolved.push(...batch)
      }
      if(cancelled)return
      setConnectedActivity({items:enriched,ratings:rawRatings,watchlist:artworkResolved,rewatches,bingeItems,progress:enriched.map((item,index)=>({id:`connected:${index}`,mediaType:item.type,mediaId:item.id,progressSeconds:1,durationSeconds:1,completed:true,title:item.title,poster:item.poster,backdrop:item.backdrop,tmdbId:item.tmdbId,imdbId:item.imdbId}))})
    }).catch(()=>undefined).finally(()=>{if(!cancelled)setConnectedReadyScope(accountScope)})
    return()=>{cancelled=true}
  },[traktConnected,simklConnected,stremioAuthKey,anilistConnected,accountScope,hasDailySnapshot])

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
    ...trending.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...currentTrending.map((item) => recommendationCandidate(item,'tmdb-trending')),
    ...topRated.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...hiddenGems.map((item) => recommendationCandidate(item,'tmdb-discover')),
    ...quickWatches.map((item) => recommendationCandidate(item,'tmdb-discover',{runtimeMinutes:item.runtime||(contentType==='movie'?95:30)})),
    ...(tab === 'anime' ? [...animeMovies, ...animeMoviesTop].map((item) => recommendationCandidate(item,'tmdb-discover')) : []),
    ...mixedMovies.map((item) => recommendationCandidate(item, 'tmdb-discover')),
    ...mixedShows.map((item) => recommendationCandidate(item, 'tmdb-discover')),
    ...mixedAnimeShows.map((item) => recommendationCandidate({ ...item, isAnime: true }, 'tmdb-discover')),
    ...mixedAnimeMovies.map((item) => recommendationCandidate({ ...item, isAnime: true }, 'tmdb-discover')),
    ...similarCandidates,
  ], [forYou, trending, currentTrending, topRated, hiddenGems, quickWatches, animeMovies, animeMoviesTop, mixedMovies, mixedShows, mixedAnimeShows, mixedAnimeMovies, similarCandidates, contentType, tab])
  const filteredCandidates = useMemo(() => {
    return candidates.filter((c) => matchesDiscoverContent(c.item, contentTypes) && candidatePassesPrefs(c.item, prefs))
  }, [candidates, contentTypes, prefs])

  const liveRanked = useMemo(() => {
    const weights = prefsWeights(prefs)
    const ranked = rankCandidates(filteredCandidates, tasteProfile, activity, feedback, mode, rankingNow, impressions, weights)

    if (prefs.sortOrder === 'popularity.desc') {
      return sortRecommendationsByPopularity(ranked)
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
    () => latestSnapshotForScope(persistedRankings, dailySnapshotMeta, dailySnapshotScope, DISCOVERY_ALGORITHM_VERSION),
    [persistedRankings, dailySnapshotMeta, dailySnapshotScope],
  )
  const validRankedSnapshot = useMemo(
    () => dailySnapshot?.filter((entry) => matchesDiscoverContent(entry.item, contentTypes)),
    [dailySnapshot, contentTypes],
  )
  const snapshotIsValid = Boolean(dailySnapshot && dailySnapshotMeta[dailySnapshotKey]?.algorithmVersion === DISCOVERY_ALGORITHM_VERSION && validRankedSnapshot?.length === dailySnapshot.length && dailySnapshot.length > 0)
  const recommendationSourcesReady = discoverySourcesSettled(recommendationRowIds, discoveryRowLoads, [
    trendingReadyScope === trendingScope,
    similarReadyScope === similarScope,
    connectedReadyScope === accountScope,
  ])
  const discoveryWaitScope = `${contentTypeKey}:${discoveryQueryKey}:${mode}`
  useLayoutEffect(() => {
    // Wait for the real source state instead of replacing skeletons with an
    // error after an arbitrary four seconds. Keep a hard bound for stalled
    // providers, and key it to the active query so tab changes cannot reuse
    // the previous tab's timeout.
    setDiscoverySettledScope('')
    const timer = window.setTimeout(() => setDiscoverySettledScope(discoveryWaitScope), 12_000)
    return () => window.clearTimeout(timer)
  }, [discoveryWaitScope])
  useEffect(() => {
    if (recommendationSourcesReady) setDiscoverySettledScope(discoveryWaitScope)
  }, [recommendationSourcesReady, discoveryWaitScope])
  const initialWaitComplete = discoverySettledScope === discoveryWaitScope
  const ranked = useMemo(() => snapshotIsValid
    ? applyRecommendationFeedback(validRankedSnapshot!, feedback.filter((entry) => entry.createdAt > (dailySnapshotMeta[dailySnapshotKey]?.generatedAt ?? 0)))
    : fallbackRankedSnapshot?.filter((entry) => matchesDiscoverContent(entry.item, contentTypes))?.length
      ? applyRecommendationFeedback(fallbackRankedSnapshot.filter((entry) => matchesDiscoverContent(entry.item, contentTypes)), feedback)
      : liveRanked,
  [snapshotIsValid, validRankedSnapshot, feedback, dailySnapshotMeta, dailySnapshotKey, fallbackRankedSnapshot, contentTypes, liveRanked])
  // A persisted provider snapshot can briefly outlive a content-tab switch
  // while its replacement loads. Keep every Discovery surface scoped to the
  // active tab so another media type never flashes into the recommendations.
  const snapshotTabRanked = useMemo(() => ranked.filter((entry) => matchesDiscoverContent(entry.item, contentTypes)), [ranked, contentTypes])
  const currentTrendingRanked = useMemo(() => {
    const sourceItems = currentTrending.filter((item) => item.poster && matchesDiscoverContent(item, contentTypes) && candidatePassesPrefs(item, prefs))
    return orderRecommendationsBySource(rankCandidates(
      sourceItems.map((item) => recommendationCandidate(item, 'tmdb-trending')),
      tasteProfile,
      activity,
      feedback,
      mode,
      rankingNow,
      impressions,
      prefsWeights(prefs),
    ), sourceItems)
  },
  // Preserve the public weekly chart's actual feed order for the Spotlight,
  // OR TRY, Top 10 boosts and the randomizer. The popularity field is a noisy
  // per-title signal and must not reorder a rank supplied by the live source.
  [activity, currentTrending, contentTypes, feedback, impressions, mode, prefs, rankingNow, tasteProfile])
  const tabRanked = useMemo(() => reconcileTrendingSignals(
    snapshotTabRanked,
    currentTrendingRanked,
    tasteProfile,
    activity,
    feedback,
    mode,
    rankingNow,
    impressions,
    prefsWeights(prefs),
  ), [activity, currentTrendingRanked, feedback, impressions, mode, prefs, rankingNow, snapshotTabRanked, tasteProfile])
  // Wait for either personalized results or current trends before making an
  // additional runtime request, so a browser-only session can use whichever
  // source is available without blocking the main Discovery feed.
  const hasDiscoveryItems = tabRanked.length > 0 || currentTrendingRanked.length > 0
  const timeTonightConfig = makeConfig(contentType, 'popularity.desc', preferences, {
    runtimeMin: selectedRuntimeBucket.min,
    runtimeMax: selectedRuntimeBucket.max,
    voteAverageMin: Math.max(6, minRating),
    voteCountMin: tab === 'anime' ? 50 : 100,
    ...animeOverrides,
  })
  const timeTonightAnimeMovieConfig = makeConfig('movie', 'popularity.desc', preferences, {
    runtimeMin: selectedRuntimeBucket.min,
    runtimeMax: selectedRuntimeBucket.max,
    voteAverageMin: Math.max(6, minRating),
    voteCountMin: 50,
    ...animeOverrides,
  })
  const timeTonight = useDiscoverRow(
    timeTonightConfig,
    `discover-time-${tab}-${selectedRuntimeBucket.id}-${discoveryQueryKey}`,
    hasDiscoveryItems,
    refreshNonce,
    reportDiscoveryRowLoading,
    false,
  )
  const timeTonightAnimeMovies = useDiscoverRow(
    timeTonightAnimeMovieConfig,
    `discover-time-anime-movies-${selectedRuntimeBucket.id}-${discoveryQueryKey}`,
    tab === 'anime' && hasDiscoveryItems,
    refreshNonce,
    reportDiscoveryRowLoading,
    false,
  )
  // Keep the editorial extra out of adjacent shelves so it reads as its own
  // recommendation instead of a repeated catalog card. Live weekly trends
  // lead, and alternatives follow the popularity-first fallback ordering.
  const spotlightCandidates = useMemo(() => {
    return orderSpotlightCandidates(currentTrendingRanked, tabRanked)
  }, [currentTrendingRanked, tabRanked])
  const heroRecommendation = spotlightCandidates.find((entry) => mediaIdentity(entry.item) === spotlightSelectionKey) ?? spotlightCandidates[0]
  // Lock the first available editorial pick for this Discovery scope. Catalog
  // sources settle at different times across browsers. Wait for the live weekly
  // feed before pinning the first card, so a stale daily snapshot cannot outrank
  // the current top trend or replace the hero again after it has settled.
  useEffect(() => {
    if (spotlightSelectionKey || trendingReadyScope !== trendingScope || !spotlightCandidates.length) return
    setSpotlightSelectionKey(mediaIdentity(spotlightCandidates[0]!.item))
  }, [spotlightCandidates, spotlightSelectionKey, trendingReadyScope, trendingScope])
  const heroItem = heroRecommendation?.item
  const heroMediaKey = heroItem ? mediaIdentity(heroItem) : null
  const heroEditorialLabel = heroItem ? editorialAccolade({
    type: heroItem.type,
    year: heroItem.year,
    releaseDate: heroItem.releaseDate,
    rating: heroItem.rating,
    voteCount: heroItem.voteCount,
  }) : null
  const heroReason = selectEditorialReason(heroRecommendation?.reasons ?? [])
  useEffect(() => {
    const previousKey = previousSpotlightKeyRef.current
    previousSpotlightKeyRef.current = heroMediaKey
    if (!previousKey || !heroMediaKey || previousKey === heroMediaKey || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const surfaces = spotlightTransitionRef.current?.querySelectorAll<HTMLElement>('.discover-spotlight__copy, .discover-spotlight__poster')
    if (!surfaces?.length) return
    const animations = Array.from(surfaces, (surface, index) => surface.animate([
      { opacity: .58, transform: 'translateY(6px) scale(.99)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: 300, delay: index * 35, easing: 'cubic-bezier(.2,.75,.25,1)' }))
    return () => animations.forEach((animation) => animation.cancel())
  }, [heroMediaKey])
  const shelfRanked = useMemo(() => heroMediaKey ? tabRanked.filter((entry) => mediaIdentity(entry.item) !== heroMediaKey) : tabRanked, [heroMediaKey, tabRanked])
  // A successful public weekly feed is useful Discovery content even if every
  // broad catalog request failed. Do not hide that available content behind a
  // full-page error state.
  const viewState = discoveryViewState(tabRanked.length, initialWaitComplete, currentTrendingRanked.length)
  const loadMoreDiscovery = useCallback(async () => {
    if (moreToDiscoverLoadingRef.current || moreToDiscoverStatusRef.current === 'done' || moreToDiscoverStatusRef.current === 'error' || moreToDiscoverStatusRef.current === 'paused') return
    const requestScope = `${contentTypeKey}:${discoveryQueryKey}`
    if (moreToDiscoverScopeRef.current !== requestScope) return

    const sources: Array<{ key: DiscoveryContinuationKey; type: 'movie' | 'series'; config: DiscoverConfig }> = [
      ...(contentTypes.includes('movies') ? [{ key: 'movies' as const, type: 'movie' as const, config: makeConfig('movie', 'popularity.desc', preferences, { excludeKeywords: ANIME_EXCLUDE_KEYWORDS }) }] : []),
      ...(contentTypes.includes('shows') ? [{ key: 'shows' as const, type: 'series' as const, config: makeConfig('series', 'popularity.desc', preferences, { excludeKeywords: ANIME_EXCLUDE_KEYWORDS }) }] : []),
      ...(contentTypes.includes('anime') ? [
        { key: 'anime-shows' as const, type: 'series' as const, config: makeConfig('series', 'popularity.desc', preferences, { originalLanguage: 'ja', includeGenres: ['16'], genreMatchMode: 'AND', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS }) },
        { key: 'anime-movies' as const, type: 'movie' as const, config: makeConfig('movie', 'popularity.desc', preferences, { originalLanguage: 'ja', includeGenres: ['16'], genreMatchMode: 'AND', excludeKeywords: HENTAI_EXCLUDE_KEYWORDS }) },
      ] : []),
    ]
    const activeSources = sources.filter(({ key }) => !moreToDiscoverExhaustedRef.current[key])
    if (!activeSources.length) {
      moreToDiscoverStatusRef.current = 'done'
      setMoreToDiscoverStatus('done')
      return
    }

    moreToDiscoverLoadingRef.current = true
    moreToDiscoverStatusRef.current = 'loading'
    setMoreToDiscoverStatus('loading')
    try {
      const pageResults = await Promise.allSettled(activeSources.map(({ key, type, config }) => {
        const page = Math.min(500, moreToDiscoverPagesRef.current[key] + 1)
        return discoverTmdbPageWithCache(config, `discover-infinite-${key}-${discoveryQueryKey}`, page)
          .then((result) => ({ key, type, requestedPage: page, result }))
      }))
      if (moreToDiscoverScopeRef.current !== requestScope) return
      const pages = pageResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      const hadPageErrors = pages.length !== activeSources.length
      if (pages.length === 0) {
        const firstError = pageResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        throw firstError?.reason ?? new Error('No Discovery continuation page could be loaded')
      }

      // Continuation pages are public popularity catalogs, so keep titles that
      // already lead the editorial feed out of the long tail as well. The live
      // weekly feed can contain titles missing from an older daily snapshot.
      const featuredIds = new Set([
        ...currentTrendingRanked.map((entry) => mediaIdentity(entry.item)),
        ...tabRanked.map((entry) => mediaIdentity(entry.item)),
      ])
      const existingIds = new Set([
        ...featuredIds,
        ...moreToDiscoverItemsRef.current.map(mediaIdentity),
      ])
      const appendedCandidates: SearchResult[] = []
      for (const { key, requestedPage, result } of pages) {
        moreToDiscoverPagesRef.current[key] = requestedPage
        if (requestedPage >= result.totalPages || result.items.length === 0) moreToDiscoverExhaustedRef.current[key] = true
        for (const item of result.items) {
          if (!matchesDiscoverContent(item, contentTypes) || !candidatePassesPrefs(item, prefs)) continue
          const key = mediaIdentity(item)
          if (!item.poster || key === heroMediaKey || existingIds.has(key)) continue
          existingIds.add(key)
          appendedCandidates.push(applySearchResultArt(item))
        }
      }

      const appended = sortRecommendationsByPopularity(rankCandidates(
        appendedCandidates.map((item) => recommendationCandidate(item, 'tmdb-discover')),
        tasteProfile,
        activity,
        feedback,
        mode,
        rankingNow,
        impressions,
        prefsWeights(prefs),
      )).map((entry) => entry.item)

      if (appended.length) {
        moreToDiscoverItemsRef.current = [...moreToDiscoverItemsRef.current, ...appended]
        setMoreToDiscover(moreToDiscoverItemsRef.current)
      }
      const hasActiveSources = sources.some(({ key }) => !moreToDiscoverExhaustedRef.current[key])
      // Keep the endless catalog moving when a provider page contains only
      // duplicates or entries excluded by the active tab/preferences. Returning
      // to idle recreates the sentinel observer, which immediately requests the
      // next page while it remains near the viewport. The provider's page limit
      // still ends the sequence, and actual request failures remain retryable.
      moreToDiscoverStatusRef.current = hadPageErrors ? 'error' : hasActiveSources ? 'idle' : 'done'
      setMoreToDiscoverStatus(moreToDiscoverStatusRef.current)
    } catch {
      if (moreToDiscoverScopeRef.current === requestScope) {
        moreToDiscoverStatusRef.current = 'error'
        setMoreToDiscoverStatus('error')
      }
    } finally {
      if (moreToDiscoverScopeRef.current === requestScope) moreToDiscoverLoadingRef.current = false
    }
  }, [activity, contentTypeKey, contentTypes, currentTrendingRanked, discoveryQueryKey, feedback, heroMediaKey, impressions, mode, prefs, preferences, tabRanked, rankingNow, tasteProfile])

  useEffect(() => { loadMoreDiscoveryRef.current = loadMoreDiscovery }, [loadMoreDiscovery])
  useEffect(() => {
    const sentinel = moreToDiscoverSentinelRef.current
    if (!sentinel || viewState !== 'content') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || moreToDiscoverStatusRef.current !== 'idle') return
      void loadMoreDiscoveryRef.current()
    }, { rootMargin: '500px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [continuationScope, moreToDiscoverStatus, viewState])
  const genreTileCandidates = useMemo(
    () => prioritizeLiveTrends(currentTrendingRanked, tabRanked)
      .filter((entry) => mediaIdentity(entry.item) !== heroMediaKey),
    [currentTrendingRanked, heroMediaKey, tabRanked],
  )
  const genreTiles = useMemo(() => genreOptions.map((genre) => ({
    option: { title: genre.title, genres: [genre.id] },
    items: genreTileCandidates
      .filter((entry) => entry.item.genreIds?.includes(genre.id) && Boolean(entry.item.poster))
      .slice(0, 3)
      .map((entry) => entry.item),
  })), [genreOptions, genreTileCandidates])
  const selectedGenreTileItems = useMemo(
    () => genreTiles.find(({ option }) => option.genres[0] === selectedGenreId)?.items ?? [],
    [genreTiles, selectedGenreId],
  )
  const genreSelectionItems = useMemo(() => {
    if (selectedGenreId == null) return []
    const seen = new Set<string>()
    // genreItems came from a provider query that already includes this genre.
    // Some addon/local metadata omits genreIds on returned records, so checking
    // that field again incorrectly turns a successful genre query into an empty row.
    return [...selectedGenreTileItems, ...genreItems, ...tabRanked.filter((entry) => entry.item.genreIds?.includes(selectedGenreId)).map((entry) => entry.item)]
      .filter((item) => {
        const key = mediaIdentity(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 20)
  }, [genreItems, selectedGenreId, selectedGenreTileItems, tabRanked])
  useEffect(() => {
    // Today's snapshot is immutable once committed. History, feedback and
    // provider refreshes influence tomorrow instead of reshuffling the page.
    if (!initialWaitComplete || !recommendationSourcesReady || snapshotIsValid || liveRanked.length === 0) return
    const profileFingerprint = catalogContentFingerprint(activity.recent)
    setRankedSnapshot(dailySnapshotKey, liveRanked, {
      dateKey: berlinDateKey,
      generatedAt: Date.now(),
      profileFingerprint,
      algorithmVersion: DISCOVERY_ALGORITHM_VERSION,
    })
  }, [activity.recent, berlinDateKey, dailySnapshotKey, initialWaitComplete, liveRanked, recommendationSourcesReady, setRankedSnapshot, snapshotIsValid])
  const personalizedSections = useMemo(() => {
    const sections = generateDiscoverySections(shelfRanked, tasteProfile, mode, 5, rankingNow)
    if (mode !== 'for-you') return sections

    const topTen = sections.find((section) => section.id === 'made-for-you')
    if (!topTen) return sections

    // Daily personalized snapshots should not make Top 10 stale while the
    // current weekly feed has already refreshed. Promote three fresh trends into
    // the editorial Top 10, then let the separate OR TRY shelf continue with
    // the remaining titles. Keep the Spotlight out of both shelves.
    const freshTrendPicks = currentTrendingRanked
      .filter((entry) => mediaIdentity(entry.item) !== heroMediaKey)
      .slice(0, 3)
    if (!freshTrendPicks.length) return sections
    const promotedKeys = new Set(freshTrendPicks.map((entry) => mediaIdentity(entry.item)))
    const mergeTopTen = (items: typeof topTen.items) => buildPopularTopTen(freshTrendPicks, items)

    return sections
      .map((section) => {
        if (section.id === 'made-for-you') {
          return { ...section, items: mergeTopTen(section.items), catalogItems: mergeTopTen(section.catalogItems ?? section.items) }
        }
        if (section.id === 'trending-this-week') return section
        const items = section.items.filter((entry) => !promotedKeys.has(mediaIdentity(entry.item)))
        const catalogItems = section.catalogItems?.filter((entry) => !promotedKeys.has(mediaIdentity(entry.item)))
        return { ...section, items, catalogItems }
      })
      .filter((section) => section.id === 'made-for-you' || section.id === 'trending-this-week' || section.items.length >= 5)
  }, [currentTrendingRanked, heroMediaKey, mode, rankingNow, shelfRanked, tasteProfile])
  const similaritySections = useMemo(
    () => personalizedSections.filter((section) => section.id.startsWith('because-favorited') || section.id.startsWith('because-watched')),
    [personalizedSections],
  )
  const activeSimilaritySection = similaritySections.find((section) => section.id === selectedSimilaritySectionId) || similaritySections[0]
  const activeSimilarityTitle = activeSimilaritySection?.title
    .replace(/^Because You (?:Favorited|Watched) /i, '')
    .replace(/\s+\(\d{4}\)$/, '')
  const visiblePersonalizedSections = useMemo(
    // Keep only the video-led editorial shelves: Top 10 plus the strongest
    // taste-genre row. Library-based similarity is presented as one compact,
    // selectable seed rail immediately below instead of several old rows.
    () => personalizedSections.filter((section) => section.id === 'made-for-you' || section.id.startsWith('because-genre-')),
    [personalizedSections],
  )
  // The public weekly trend feed powers the reference's OR TRY shelf. It is
  // independent of the user's library and follows the Tonight spotlight.
  const trendingSection = useMemo(() => {
    const heroKey = heroItem ? mediaIdentity(heroItem) : undefined
    const alreadyFeatured = new Set(visiblePersonalizedSections
      .filter((section) => section.id !== 'trending-this-week')
      .flatMap((section) => section.items.map((entry) => mediaIdentity(entry.item))))
    const current = currentTrendingRanked.filter((entry) => {
      const key = mediaIdentity(entry.item)
      return key !== heroKey && !alreadyFeatured.has(key)
    })
    const currentKeys = new Set(current.map((entry) => mediaIdentity(entry.item)))
    // Fall back to the strongest current popularity signals when the public
    // weekly feed is unavailable or too small to fill a useful shelf.
    const popular = tabRanked
      .filter((entry) => {
        const key = mediaIdentity(entry.item)
        return entry.item.poster && key !== heroKey && !alreadyFeatured.has(key) && !currentKeys.has(key)
      })
      .sort((left, right) => (right.popularity || 0) - (left.popularity || 0) || right.score.total - left.score.total)
    const catalogItems = [...current, ...popular]
    if (catalogItems.length < 5) return undefined
    return { id: 'trending-this-week', title: 'OR TRY', items: catalogItems.slice(0, 10), catalogItems }
  }, [currentTrendingRanked, heroItem, tabRanked, visiblePersonalizedSections])
  // The video reference features a distinct Weekend Plan editorial card. Keep
  // its rotating suggestion separate from both the hero spotlight and the
  // Surprise Me roulette, while drawing from the same live, trend-first pool.
  const weekendPlanCandidates = useMemo(() => {
    const featuredKeys = new Set([
      ...(heroMediaKey ? [heroMediaKey] : []),
      ...visiblePersonalizedSections.flatMap((section) => section.items.map((entry) => mediaIdentity(entry.item))),
      ...(trendingSection?.items.map((entry) => mediaIdentity(entry.item)) ?? []),
      ...(activeSimilaritySection?.items.map((entry) => mediaIdentity(entry.item)) ?? []),
    ])
    const seen = new Set<string>()
    const candidates = prioritizeLiveTrends(currentTrendingRanked, tabRanked).map((entry) => entry.item).filter((item) => {
      const key = mediaIdentity(item)
      if (!item.poster || !matchesDiscoverContent(item, contentTypes) || seen.has(key)) return false
      seen.add(key)
      return true
    })
    const distinctCandidates = candidates.filter((item) => !featuredKeys.has(mediaIdentity(item)))
    // Lead with unseen titles, then retain featured alternatives so the
    // weekend card can still rotate when the available catalog is small.
    const unseenKeys = new Set(distinctCandidates.map(mediaIdentity))
    return [
      ...distinctCandidates,
      ...candidates.filter((item) => mediaIdentity(item) !== heroMediaKey && !unseenKeys.has(mediaIdentity(item))),
    ]
  }, [activeSimilaritySection, contentTypes, currentTrendingRanked, heroMediaKey, tabRanked, trendingSection, visiblePersonalizedSections])
  const activeWeekendPlanItem = weekendPlanCandidates.length
    ? weekendPlanCandidates[weekendPlanIndex % weekendPlanCandidates.length]
    : undefined
  const hiddenGemsSection = personalizedSections.find((section) => section.id === 'hidden-gems')
  const hiddenGemCatalogItems = useMemo(
    () => (hiddenGemsSection?.catalogItems ?? hiddenGemsSection?.items ?? []).map((entry) => entry.item).filter((item) => Boolean(item.poster)),
    [hiddenGemsSection],
  )
  const hiddenGemItems = useMemo(() => hiddenGemCatalogItems.slice(0, 10), [hiddenGemCatalogItems])
  const timeTonightCatalogItems = useMemo(() => {
    const seen = new Set<string>()
    const selectedRuntimeItems = tabRanked
      .filter((entry) => entry.runtimeMinutes != null && entry.runtimeMinutes >= selectedRuntimeBucket.min && entry.runtimeMinutes <= selectedRuntimeBucket.max)
      .map((entry) => entry.item)
    const runtimeItems = [...timeTonight, ...timeTonightAnimeMovies, ...selectedRuntimeItems]
    const eligibleItems = runtimeItems.filter((item) => {
      const key = mediaIdentity(item)
      if (!item.poster || seen.has(key) || !matchesDiscoverContent(item, contentTypes)) return false
      seen.add(key)
      return true
    })
    return orderRuntimeCandidates(eligibleItems, currentTrendingRanked.map((entry) => entry.item))
  }, [contentTypes, currentTrendingRanked, selectedRuntimeBucket.max, selectedRuntimeBucket.min, tabRanked, timeTonight, timeTonightAnimeMovies])
  const timeTonightItems = useMemo(() => timeTonightCatalogItems.slice(0, 10), [timeTonightCatalogItems])
  const timeTonightLoading = discoveryRowLoads[`discover-time-${tab}-${selectedRuntimeBucket.id}-${discoveryQueryKey}`]
    || (tab === 'anime' && discoveryRowLoads[`discover-time-anime-movies-${selectedRuntimeBucket.id}-${discoveryQueryKey}`])
  const bigScreenCatalogItems = useMemo(() => {
    const featured = new Set([
      ...(heroItem ? [mediaIdentity(heroItem)] : []),
      ...visiblePersonalizedSections.flatMap((section) => section.items.slice(0, 10).map((entry) => mediaIdentity(entry.item))),
      ...(trendingSection ? trendingSection.items.map((entry) => mediaIdentity(entry.item)) : []),
    ])
    const seen = new Set<string>()
    return prioritizeLiveTrends(currentTrendingRanked, tabRanked).map((entry) => entry.item).filter((item) => {
      const key = mediaIdentity(item)
      if (!item.poster || featured.has(key) || seen.has(key) || !matchesDiscoverContent(item, contentTypes)) return false
      seen.add(key)
      return true
    })
  }, [contentTypes, currentTrendingRanked, heroItem, tabRanked, trendingSection, visiblePersonalizedSections])
  const bigScreenItems = useMemo(() => bigScreenCatalogItems.slice(0, 10), [bigScreenCatalogItems])
  const activeDiscoveryMood = DISCOVERY_MOODS.find((mood) => mood.id === selectedDiscoveryMoodId) ?? DISCOVERY_MOODS[2]
  const moodCatalogItems = useMemo(() => {
    const seen = new Set<string>()
    return prioritizeLiveTrends(currentTrendingRanked, tabRanked).map((entry) => entry.item).filter((item) => {
      const key = mediaIdentity(item)
      if (!item.poster || !matchesDiscoverContent(item, contentTypes) || seen.has(key) || !item.genreIds?.some((genreId) => activeDiscoveryMood.genres.some((id) => id === genreId))) return false
      seen.add(key)
      return true
    })
  }, [activeDiscoveryMood, contentTypes, currentTrendingRanked, tabRanked])
  const moodItems = useMemo(() => moodCatalogItems.slice(0, 10), [moodCatalogItems])
  const bingeRecommendations = useMemo(() => {
    if (!contentTypes.includes('shows') && !contentTypes.includes('anime')) return []
    const allSeries = [...currentTrending, ...bingeSeries, ...tabRanked.map((entry) => entry.item)]
    const unique = new Map<string, SearchResult>()
    for (const item of allSeries) {
      if (item.type !== 'series' || !matchesDiscoverContent(item, contentTypes) || !item.poster || !candidatePassesPrefs(item, prefs)) continue
      const key = mediaIdentity(item)
      if (!unique.has(key)) unique.set(key, item)
    }
    const bingeRanked = rankCandidates(
      [...unique.values()].map((item) => recommendationCandidate(item, currentTrending.some((trend) => mediaIdentity(trend) === mediaIdentity(item)) ? 'tmdb-trending' : 'tmdb-discover')),
      tasteProfile, activity, feedback, mode, rankingNow, impressions, prefsWeights(prefs),
    )
    const seen = new Set<string>()
    // Keep this editorial series rail on the same public momentum rules as
    // Spotlight and Surprise Me: current weekly TV trends lead, then popular
    // catalog picks. Personal taste still filters the pool and affects ranking
    // metadata, but an old high-affinity title should not bury what's hot now.
    return prioritizeLiveTrends(
      currentTrendingRanked.filter((entry) => entry.item.type === 'series'),
      bingeRanked,
    ).map((entry) => entry.item)
      .filter((item) => item.type === 'series' && matchesDiscoverContent(item, contentTypes) && Boolean(item.poster))
      .filter((item) => {
        const key = mediaIdentity(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [activity, bingeSeries, contentTypes, currentTrending, currentTrendingRanked, feedback, impressions, mode, prefs, rankingNow, tabRanked, tasteProfile])
  const activeBingeItem = bingeRecommendations.length ? bingeRecommendations[bingeIndex % bingeRecommendations.length] : undefined
  const bingeGalleryItems = useMemo(() => {
    if (!activeBingeItem || bingeRecommendations.length < 2) return []
    return Array.from({ length: Math.min(4, bingeRecommendations.length - 1) }, (_, index) =>
      bingeRecommendations[(bingeIndex + index + 1) % bingeRecommendations.length]!,
    )
  }, [activeBingeItem, bingeIndex, bingeRecommendations])
  const bingeArtworkItems = useMemo(() => activeBingeItem ? [activeBingeItem, ...bingeGalleryItems] : [], [activeBingeItem, bingeGalleryItems])
  const [bingeArtwork, setBingeArtwork] = useState<Record<string, { poster?: string; backdrop?: string; logo?: string }>>({})
  const posterSize = useAppStore((state) => state.posterSize)
  const posterArtworkSetting = useAppStore((state) => state.posterOverlay.artwork)
  const posterFade = useAppStore((state) => state.posterOverlay.fade)
  const posterColorMode = useAppStore((state) => state.posterOverlay.colorMode)
  const posterContentAlignment = useAppStore((state) => state.posterOverlay.contentAlignment)
  const [cleanDiscoverPosters, setCleanDiscoverPosters] = useState<Record<string, string | null>>({})
  const [discoverPosterColors, setDiscoverPosterColors] = useState<Record<string, { r: number; g: number; b: number } | null>>({})
  const [loadedDiscoverArtwork, setLoadedDiscoverArtwork] = useState<Record<string, boolean>>({})
  const posterFadeStyleFor = (artworkUrl?: string) => {
    const fadeAppearance = getPosterFadeAppearance(posterFade, posterColorMode, artworkUrl ? discoverPosterColors[artworkUrl] : undefined)
    return {
      '--discover-poster-fade-height': fadeAppearance.height,
      '--discover-poster-fade': fadeAppearance.background,
      '--discover-poster-content-alignment': posterContentAlignment,
      '--discover-poster-object-position': posterContentAlignment === 'left' ? 'left center' : posterContentAlignment === 'right' ? 'right center' : 'center',
    } as import('react').CSSProperties
  }
  const requestedDiscoverPosterColors = useRef(new Set<string>())
  const revealDiscoverPosterWhenReady = (event: import('react').SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    const artworkUrl = image.currentSrc || image.src
    const mediaKey = image.dataset.discoverMediaKey
    const cleanArtworkReady = posterArtworkSetting !== 'poster' || !mediaKey || mediaKey in cleanDiscoverPosters
    const logoLookupKey = image.dataset.logoLookupKey
    const logoLookupReady = !logoLookupKey || resolvedPosterLogoLookups[logoLookupKey] === true
    const posterContainer = image.closest<HTMLElement>('.discover-poster-fade')
    const posterStatusReady = posterContainer?.dataset.posterStatusReady === 'true'
    const titleLogo = image.parentElement?.querySelector<HTMLImageElement>('.discover-poster-title-logo')
    const titleLogoReady = !titleLogo || titleLogo.dataset.titleLogoLoaded === 'true' || titleLogo.dataset.titleLogoFailed === 'true'
    if ((posterColorMode !== 'artwork' || artworkUrl in discoverPosterColors) && cleanArtworkReady && logoLookupReady && posterStatusReady && titleLogoReady) {
      revealDiscoveryArtwork(event)
      setLoadedDiscoverArtwork((current) => current[artworkUrl] ? current : { ...current, [artworkUrl]: true })
      return
    }
    image.dataset.artworkLoadedPending = 'true'
  }
  const markDiscoverTitleLogoLoaded = (event: React.SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.dataset.titleLogoLoaded = 'true'
    setPosterLogoLoadRevision((revision) => revision + 1)
  }
  const markDiscoverTitleLogoFailed = (event: React.SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.dataset.titleLogoFailed = 'true'
    const poster = event.currentTarget.closest<HTMLElement>('.discover-poster-fade')
      ?.querySelector<HTMLImageElement>('img[data-logo-lookup-key]')
    const lookupKey = poster?.dataset.logoLookupKey
    if (lookupKey) setFailedPosterLogos((current) => current[lookupKey] ? current : { ...current, [lookupKey]: true })
    setPosterLogoLoadRevision((revision) => revision + 1)
  }
  const selectDiscoverPosterArtwork = useCallback((poster?: string, backdrop?: string, cleanPoster?: string) => {
    const selected = getPosterArtworkCandidate(posterArtworkSetting, poster, cleanPoster, backdrop)
    if (!selected) return undefined
    const usesBackdrop = posterArtworkSetting === 'backdrop' && Boolean(backdrop)
    return cardArtworkUrl(selected, usesBackdrop ? 'landscape' : 'poster', posterSize)
  }, [posterArtworkSetting, posterSize])
  const artworkSettingsKey = useAppStore((state) => JSON.stringify([state.artProviders, state.customArtUrls, state.appManagedMetadata, state.fanartApiKey]))
  const artworkCacheKey = useCallback((item: SearchResult) => `${artworkSettingsKey}:${mediaIdentity(item)}`, [artworkSettingsKey])
  useEffect(() => {
    let cancelled = false
    const resolvePosters = async () => {
      const resolved = await Promise.all(bingeArtworkItems.map(async (item) => {
        const key = artworkCacheKey(item)
        const displayItem = applySearchResultArt(item)
        const customArt = await resolveSearchResultCustomArt(item)
        try {
          const providerArt = await resolveArtFromProviders(
            displayItem.type,
            { tmdbId: displayItem.tmdbId, tvdbId: displayItem.tvdbId, imdbId: displayItem.imdbId },
            Boolean(displayItem.isAnime),
            'all',
            true,
          )
          const poster = customArt.poster || providerArt.poster || displayItem.poster || item.poster
          const backdrop = customArt.backdrop || providerArt.backdrop || displayItem.backdrop || item.backdrop
          const logo = customArt.logo || providerArt.logo || displayItem.logo || item.logo
          return poster || backdrop || logo ? [key, {
            poster: cardArtworkUrl(poster, 'poster', posterSize),
            backdrop: cardArtworkUrl(backdrop, 'landscape', posterSize),
            logo,
          }] as const : null
        } catch {
          const poster = customArt.poster || displayItem.poster || item.poster
          const backdrop = customArt.backdrop || displayItem.backdrop || item.backdrop
          const logo = customArt.logo || displayItem.logo || item.logo
          return poster || backdrop || logo ? [key, {
            poster: cardArtworkUrl(poster, 'poster', posterSize),
            backdrop: cardArtworkUrl(backdrop, 'landscape', posterSize),
            logo,
          }] as const : null
        }
      }))
      if (!cancelled) {
        const updates = Object.fromEntries(resolved.filter((entry): entry is readonly [string, { poster: string | undefined; backdrop: string | undefined; logo: string | undefined }] => entry !== null))
        setBingeArtwork((current) => {
          const changed = Object.entries(updates).some(([key, art]) =>
            current[key]?.poster !== art.poster || current[key]?.backdrop !== art.backdrop || current[key]?.logo !== art.logo,
          )
          return changed ? { ...current, ...updates } : current
        })
        setResolvedPosterLogoLookups((current) => {
          const keys = bingeArtworkItems.map((item) => artworkCacheKey(item))
          if (keys.every((key) => current[key])) return current
          return { ...current, ...Object.fromEntries(keys.map((key) => [key, true])) }
        })
      }
    }
    void resolvePosters()
    return () => { cancelled = true }
  }, [artworkCacheKey, artworkSettingsKey, bingeArtworkItems, posterSize])
  const bingePoster = useCallback((item: SearchResult) => selectDiscoverPosterArtwork(
    bingeArtwork[artworkCacheKey(item)]?.poster || cardArtworkUrl(applySearchResultArt(item).poster || item.poster, 'poster', posterSize),
    bingeArtwork[artworkCacheKey(item)]?.backdrop || cardArtworkUrl(applySearchResultArt(item).backdrop || item.backdrop, 'landscape', posterSize),
    cleanDiscoverPosters[mediaIdentity(item)] || undefined,
  ), [artworkCacheKey, bingeArtwork, cleanDiscoverPosters, posterSize, selectDiscoverPosterArtwork])
  const bingeLogo = (item: SearchResult) => bingeArtwork[artworkCacheKey(item)]?.logo || applySearchResultArt(item).logo || item.logo
  const bingeBackdrop = (item: SearchResult) => bingeArtwork[artworkCacheKey(item)]?.backdrop || cardArtworkUrl(applySearchResultArt(item).backdrop || item.backdrop, 'landscape', posterSize)
  const activeBingeRating = formatDiscoveryRating(activeBingeItem?.rating)
  const activeBingeLogo = activeBingeItem ? bingeLogo(activeBingeItem) : undefined
  const pickerPool = useMemo(() => {
    const seen = new Set<string>()
    // Live weekly trends lead the randomizer too; a still-valid daily snapshot
    // must not hide newly popular choices until the next Berlin day boundary.
    return [...currentTrendingRanked, ...tabRanked].filter((entry) => {
      const key = mediaIdentity(entry.item)
      // The spotlight is an extra editorial recommendation, not one of the
      // randomizer's choices. Keep its title and the randomizer pool distinct.
      if (!entry.item.poster || key === heroMediaKey || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [currentTrendingRanked, heroMediaKey, tabRanked])
  const colorCandidateItems = useMemo(() => {
    const seen = new Set<string>()
    return [...currentTrendingRanked, ...tabRanked]
      .map((entry) => entry.item)
      .filter((item) => {
        const key = mediaIdentity(item)
        if (!item.poster || key === heroMediaKey || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 24)
  }, [currentTrendingRanked, heroMediaKey, tabRanked])
  useEffect(() => {
    const controller = new AbortController()
    const pending = [...new Set(colorCandidateItems.flatMap((item) => item.poster ? [item.poster] : []))]
      .filter((poster) => !posterColorCacheRef.current[poster] && !unavailablePosterColorsRef.current.has(poster))
    if (!pending.length) {
      setPosterColors(posterColorCacheRef.current)
      return () => controller.abort()
    }
    let cursor = 0
    const classifyNext = async () => {
      while (!controller.signal.aborted && cursor < pending.length) {
        const poster = pending[cursor++]!
        try {
          const color = await loadAmbientColor(poster, controller.signal)
          if (controller.signal.aborted) return
          if (color) posterColorCacheRef.current[poster] = classifyPosterColor(color)
          else unavailablePosterColorsRef.current.add(poster)
        } catch { /* Colour browsing is optional when remote artwork blocks CORS. */ }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => classifyNext())).then(() => {
      if (!controller.signal.aborted) setPosterColors({ ...posterColorCacheRef.current })
    })
    return () => controller.abort()
  }, [colorCandidateItems])
  const colorSamples = useMemo(() => colorCandidateItems.flatMap((item) => {
    const color = item.poster ? posterColors[item.poster] : undefined
    return color ? [{ item, color }] : []
  }), [colorCandidateItems, posterColors])
  const colorSelectionItems = useMemo(
    () => selectPosterColorItems(colorSamples, selectedPosterColor),
    [colorSamples, selectedPosterColor],
  )
  const colorCatalogTitle = selectedPosterColor === 'all'
    ? 'Popular Posters'
    : `${POSTER_COLOR_GROUPS.find((group) => group.id === selectedPosterColor)?.label || 'Colour'} Posters`
  const colorPreviewItems = useMemo(() => colorSelectionItems.slice(0, 10), [colorSelectionItems])
  const availablePosterColors = useMemo(() => new Set(colorSamples.map((sample) => sample.color)), [colorSamples])
  const colorRowId = `discover-color-${tab}-${selectedPosterColor}`
  const pickerRecommendation = (pickerSelectionKey ? pickerPool.find((entry) => mediaIdentity(entry.item) === pickerSelectionKey) : undefined) || pickerPool[0]
  const pickerItem = pickerRecommendation?.item
  const pickerFrameId = pickerItem ? mediaIdentity(pickerItem) : null
  const pickerFrameAnimationAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (!surpriseSpinning) {
      pickerFrameAnimationAtRef.current = null
      return
    }
    if (!pickerFrameId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const now = performance.now()
    const previousFrameAt = pickerFrameAnimationAtRef.current
    pickerFrameAnimationAtRef.current = now
    // Follow the roulette's decelerating frame cadence. Short early intervals
    // get a quick crossfade; the chosen title gets a longer, settled entrance.
    const frameDuration = previousFrameAt == null
      ? 150
      : Math.max(48, Math.min(360, (now - previousFrameAt) * 0.82))
    const surfaces = pickerDialogRef.current?.querySelectorAll<HTMLElement>(
      '.discover-picker__poster > img, .discover-picker__ambient > img, .discover-picker__copy h2:not(.sr-only), .discover-picker__logo',
    )
    if (!surfaces?.length) return
    surfaces.forEach((surface) => {
      surface.getAnimations().forEach((animation) => animation.cancel())
      surface.animate([
        { opacity: 0.28, transform: 'translateY(5px) scale(.985)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ], { duration: frameDuration, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both' })
    })
  }, [pickerFrameId, surpriseSpinning])
  const tastePickPool = useMemo(() => {
    if (!tabRanked.length && !currentTrendingRanked.length) return []
    const query = tasteQuery.trim().toLocaleLowerCase()
    const seen = new Set<string>()
    return buildTastePickerPool(currentTrendingRanked, tabRanked)
      .filter((entry) => {
        const key = mediaIdentity(entry.item)
        if (!entry.item.poster || key === heroMediaKey || pickedIds.includes(key) || seen.has(key)) return false
        seen.add(key)
        return !query || `${entry.item.title} ${entry.item.genres?.join(' ') || ''} ${entry.item.year || ''}`.toLocaleLowerCase().includes(query)
      })
      .map((entry) => entry.item)
  }, [currentTrendingRanked, heroMediaKey, pickedIds, tabRanked, tasteQuery])
  const tastePickCandidates = useMemo(() => tastePickPool.slice(0, 10 + pickOffset), [tastePickPool, pickOffset])
  const discoveryArtworkItems = useMemo(() => {
    const unique = new Map<string, SearchResult>()
    for (const item of [activeWeekendPlanItem, ...tastePickCandidates, ...genreTiles.flatMap(({ items }) => items)]) {
      if (!item) continue
      unique.set(mediaIdentity(item), item)
    }
    return Array.from(unique.values())
  }, [activeWeekendPlanItem, genreTiles, tastePickCandidates])
  const [discoveryArtwork, setDiscoveryArtwork] = useState<Record<string, { poster?: string; backdrop?: string; logo?: string }>>({})
  useEffect(() => {
    let cancelled = false
    const resolve = async () => {
      const results: Array<[string, { poster?: string; backdrop?: string; logo?: string }]> = []
      // Bound provider lookups so artwork enrichment does not starve catalogs.
      for (let index = 0; index < discoveryArtworkItems.length; index += 4) {
        const batch = discoveryArtworkItems.slice(index, index + 4)
        const resolved = await Promise.all(batch.map(async (item): Promise<[string, { poster?: string; backdrop?: string; logo?: string }]> => {
          const custom = await resolveSearchResultCustomArt(item)
          const base = applySearchResultArt(item)
          try {
            const provider = await resolveArtFromProviders(
              item.type === 'series' ? 'series' : 'movie',
              { tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId },
              Boolean(item.isAnime),
              'all',
              true,
            )
            return [mediaIdentity(item), {
              poster: cardArtworkUrl(custom.poster || provider.poster || base.poster || item.poster, 'poster', posterSize),
              backdrop: cardArtworkUrl(custom.backdrop || provider.backdrop || base.backdrop || item.backdrop, 'landscape', posterSize),
              logo: custom.logo || provider.logo || base.logo || item.logo,
            }]
          } catch {
            return [mediaIdentity(item), {
              poster: cardArtworkUrl(custom.poster || base.poster || item.poster, 'poster', posterSize),
              backdrop: cardArtworkUrl(custom.backdrop || base.backdrop || item.backdrop, 'landscape', posterSize),
              logo: custom.logo || base.logo || item.logo,
            }]
          }
        }))
        results.push(...resolved)
        if (cancelled) return
      }
      if (!cancelled) {
        const updates = Object.fromEntries(results)
        setDiscoveryArtwork((current) => {
          const changed = Object.entries(updates).some(([key, art]) =>
            current[key]?.poster !== art.poster || current[key]?.backdrop !== art.backdrop || current[key]?.logo !== art.logo,
          )
          return changed ? { ...current, ...updates } : current
        })
        setResolvedPosterLogoLookups((current) => {
          const keys = discoveryArtworkItems.map((item) => artworkCacheKey(item))
          if (keys.every((key) => current[key])) return current
          return { ...current, ...Object.fromEntries(keys.map((key) => [key, true])) }
        })
      }
    }
    void resolve()
    return () => { cancelled = true }
  }, [artworkCacheKey, artworkSettingsKey, discoveryArtworkItems, posterSize])
  const discoveryPoster = useCallback((item: SearchResult) => discoveryArtwork[mediaIdentity(item)]?.poster
    || cleanDiscoverPosters[mediaIdentity(item)]
    || cardArtworkUrl(applySearchResultArt(item).poster || item.poster, 'poster', posterSize), [cleanDiscoverPosters, discoveryArtwork, posterSize])
  const discoveryBackdrop = useCallback((item: SearchResult) => discoveryArtwork[mediaIdentity(item)]?.backdrop
    || cardArtworkUrl(applySearchResultArt(item).backdrop || item.backdrop, 'landscape', posterSize), [discoveryArtwork, posterSize])
  const discoveryLogo = (item: SearchResult) => discoveryArtwork[mediaIdentity(item)]?.logo || applySearchResultArt(item).logo || item.logo
  const discoverPosterTitleFallback = (item: SearchResult, posterUrl?: string, logo?: string, failed = false) => {
    const lookupKey = artworkCacheKey(item)
    if (!posterUrl || !loadedDiscoverArtwork[posterUrl] || !resolvedPosterLogoLookups[lookupKey] || (logo && !failed && !failedPosterLogos[lookupKey])) return null
    return <span className="discover-poster-title-fallback">{item.title}</span>
  }
  useEffect(() => { setPickerSelectionKey(null); setPickerLogoError(false); setHeroLogoError(false) }, [tab, mode, discoveryQueryKey])
  useEffect(() => { setSpotlightSelectionKey(null) }, [tab, mode, discoveryQueryKey])
  useEffect(() => { setHeroLogoError(false) }, [heroItem?.id])
  useEffect(() => { setPickerLogoError(false) }, [pickerItem?.id])

  // Resolve editorial artwork independently from the Surprise Me roulette.
  useEffect(() => {
    let cancelled = false
    const featuredItems = [heroItem, activeWeekendPlanItem].filter((item): item is SearchResult => Boolean(item))
    void Promise.all(featuredItems.map(async (item) => {
      const key = artworkCacheKey(item)
      if (heroArt[key] || resolvedPosterLogoLookups[key]) return
      try {
        const [custom, art] = await Promise.all([
          resolveSearchResultCustomArt(item),
          resolveArtFromProviders(item.type === 'series' ? 'series' : 'movie', { tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId }, item.isAnime, 'all', true),
        ])
        if (!cancelled) setHeroArt((prev) => prev[key] ? prev : { ...prev, [key]: { ...art, ...custom } })
      } catch { /* provider artwork is optional */ }
      finally {
        if (!cancelled) setResolvedPosterLogoLookups((current) => current[key] ? current : { ...current, [key]: true })
      }
    }))
    return () => { cancelled = true }
  }, [activeWeekendPlanItem, artworkCacheKey, heroItem, heroArt, resolvedPosterLogoLookups])

  useEffect(() => {
    let cancelled = false
    if (!pickerOpen || !pickerItem || surpriseSpinning) return
    const key = artworkCacheKey(pickerItem)
    if (heroArt[key] || resolvedPosterLogoLookups[key]) return
    Promise.all([
      resolveSearchResultCustomArt(pickerItem),
      resolveArtFromProviders(pickerItem.type === 'series' ? 'series' : 'movie', { tmdbId: pickerItem.tmdbId, tvdbId: pickerItem.tvdbId, imdbId: pickerItem.imdbId }, pickerItem.isAnime, 'all', true),
    ])
      .then(([custom, art]) => { if (!cancelled) setHeroArt((prev) => prev[key] ? prev : { ...prev, [key]: { ...art, ...custom } }) })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setResolvedPosterLogoLookups((current) => current[key] ? current : { ...current, [key]: true }) })
    return () => { cancelled = true }
  }, [artworkCacheKey, heroArt, pickerItem, pickerOpen, resolvedPosterLogoLookups, surpriseSpinning])

  // Seed the catalog cache so "Show all" opens a full-screen view of a section like on Home
  useEffect(() => {
    visiblePersonalizedSections.forEach((section) => {
      if (section.id === 'trending-this-week') return
      // Top 10 is a curated editorial list, not a doorway into the entire
      // recommendation pool. Keep the catalog cache contract aligned with the
      // ten cards rendered in the Discovery shelf.
      const catalogEntries = section.id === 'made-for-you'
        ? section.items.slice(0, 10)
        : section.catalogItems ?? section.items
      catalogSetCache(`discover-section-${tab}-${section.id}`, { items: catalogEntries.map((entry) => entry.item), page: 0, hasMore: false, scrollTop: 0 })
    })
  }, [visiblePersonalizedSections, tab, catalogSetCache])
  useEffect(() => {
    if (!trendingSection) return
    catalogSetCache(`discover-section-${tab}-trending-this-week`, { items: trendingSection.catalogItems?.map((entry) => entry.item) ?? trendingSection.items.map((entry) => entry.item), page: 0, hasMore: false, scrollTop: 0 })
  }, [catalogSetCache, tab, trendingSection])
  useEffect(() => {
    catalogSetCache(genreRowId, { items: genreSelectionItems, page: 0, hasMore: false, scrollTop: 0 })
  }, [catalogSetCache, genreRowId, genreSelectionItems])
  useEffect(() => {
    catalogSetCache(`discover-time-${tab}-${selectedRuntimeBucket.id}-${discoveryQueryKey}`, { items: timeTonightCatalogItems, page: 0, hasMore: false, scrollTop: 0 })
    if (tab === 'anime') catalogSetCache(`discover-time-anime-movies-${selectedRuntimeBucket.id}-${discoveryQueryKey}`, { items: timeTonightAnimeMovies, page: 0, hasMore: false, scrollTop: 0 })
    catalogSetCache(`discover-big-screen-${tab}-${discoveryQueryKey}`, { items: bigScreenCatalogItems, page: 0, hasMore: false, scrollTop: 0 })
    catalogSetCache(`discover-mood-${tab}-${activeDiscoveryMood.id}-${discoveryQueryKey}`, { items: moodCatalogItems, page: 0, hasMore: false, scrollTop: 0 })
    if (hiddenGemCatalogItems.length) catalogSetCache(`discover-hidden-gems-${tab}-${discoveryQueryKey}`, { items: hiddenGemCatalogItems, page: 0, hasMore: false, scrollTop: 0 })
  }, [activeDiscoveryMood.id, bigScreenCatalogItems, catalogSetCache, discoveryQueryKey, hiddenGemCatalogItems, moodCatalogItems, selectedRuntimeBucket.id, tab, timeTonightAnimeMovies, timeTonightCatalogItems])
  useEffect(() => {
    const key = `${berlinDateKey}:${tab}:${mode}`
    if (!tabRanked.length || IMPRESSIONS_RECORDED.has(key)) return
    rememberDiscoverSessionKey(IMPRESSIONS_RECORDED, key)
    recordRecommendationImpressions(tabRanked.slice(0,40).map((entry)=>entry.item))
  }, [tabRanked, tab, mode, berlinDateKey])

  const submitFeedback = (item: SearchResult, kind: Parameters<typeof saveRecommendationFeedback>[1]) => {
    setFeedback(saveRecommendationFeedback(item, kind))
  }

  useEffect(() => {
    surpriseRunRef.current += 1
    if (pickerCloseTimerRef.current != null) window.clearTimeout(pickerCloseTimerRef.current)
    pickerCloseTimerRef.current = null
    pickerClosingRef.current = false
    updateSurpriseSpinning(false)
    setPickerClosing(false)
    setPickerOpen(false)
  }, [tab, mode, discoveryQueryKey, updateSurpriseSpinning])
  const spinPicker = (currentId: string | number | undefined, onSelect: (item: SearchResult) => void) => {
    if (!pickerPool.length || surpriseSpinningRef.current) return
    const runId = surpriseRunRef.current + 1
    surpriseRunRef.current = runId
    const winner = chooseSurpriseRecommendation(pickerPool, currentId)
    if (!winner) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onSelect(winner.item)
      updateSurpriseSpinning(false)
      return
    }

    const delays = [65, 75, 90, 115, 150, 200, 270, 360]
    updateSurpriseSpinning(true)
    // A throttled background tab or a slow embedded WebKit timer must never
    // leave the roulette busy indefinitely. The normal sequence settles in
    // about two seconds; this only releases the already-selected winner when
    // the browser stalls the scheduled frames.
    const finishTimer = window.setTimeout(() => {
      if (surpriseRunRef.current !== runId) return
      onSelect(winner.item)
      surpriseRunRef.current += 1
      updateSurpriseSpinning(false)
    }, 2_800)
    // Keep the winner out of the rolling frames and exclude the previously
    // displayed title on each tick so the roulette visibly advances.
    let previousId = currentId
    const first = chooseSurpriseAnimationFrame(pickerPool, winner.item.id, previousId)
    if (first) {
      onSelect(first.item)
      previousId = first.item.id
    }
    void (async () => {
      try {
        for (const delay of delays) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
          if (surpriseRunRef.current !== runId) return
          // Tie the 3D turn to the planned frame cadence so slow browsers
          // still show a deliberate, progressive deceleration.
          setPickerRollDurationMs(Math.max(180, delay * 2.1))
          const next = chooseSurpriseAnimationFrame(pickerPool, winner.item.id, previousId)
          if (next) {
            onSelect(next.item)
            previousId = next.item.id
          }
        }
        if (surpriseRunRef.current !== runId) return
        // Give the final rolling frame the same decelerated pause it earned
        // before revealing the selected winner.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 320))
        if (surpriseRunRef.current !== runId) return
        onSelect(winner.item)
        // Let the final title/poster entry animation finish while the rolling
        // state is still active. Without this handoff React batches the winner
        // and `false` state together, so the selected title appears to jump.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 320))
      } finally {
        window.clearTimeout(finishTimer)
        if (surpriseRunRef.current === runId) updateSurpriseSpinning(false)
      }
    })()
  }
  const closePicker = useCallback(() => {
    if (pickerClosingRef.current) return
    surpriseRunRef.current += 1
    updateSurpriseSpinning(false)
    const finishClose = () => {
      pickerCloseTimerRef.current = null
      pickerClosingRef.current = false
      setPickerOpen(false)
      setPickerClosing(false)
      window.requestAnimationFrame(() => surpriseButtonRef.current?.focus())
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishClose()
      return
    }
    pickerClosingRef.current = true
    setPickerClosing(true)
    pickerCloseTimerRef.current = window.setTimeout(finishClose, 190)
  }, [updateSurpriseSpinning])
  const closePreferences = useCallback(() => {
    setPreferencesOpen(false)
    // The dialog is conditionally removed. In WebKit/Firefox the passive
    // keyboard listener can finish before the state commit, so schedule a
    // post-commit focus restore as well as the layout-effect fallback below.
    window.requestAnimationFrame(() => {
      const trigger = preferencesButtonRef.current
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    })
  }, [])
  useLayoutEffect(() => {
    if (preferencesWereOpenRef.current && !preferencesOpen) {
      const trigger = preferencesButtonRef.current
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
    preferencesWereOpenRef.current = preferencesOpen
  }, [preferencesOpen])
  useEffect(() => {
    if (!pickerOpen) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closePicker() }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [pickerOpen, closePicker])
  useEffect(() => {
    if (!preferencesOpen) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closePreferences() }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [preferencesOpen, closePreferences])
  const triggerSurprise = () => {
    setPickerOpen(true)
    spinPicker(pickerItem?.id, (item) => setPickerSelectionKey(mediaIdentity(item)))
  }
  const chooseAnotherSpotlight = () => {
    if (spotlightCandidates.length < 2) return
    const currentIndex = spotlightCandidates.findIndex((entry) => mediaIdentity(entry.item) === spotlightSelectionKey)
    const fallbackIndex = spotlightCandidates.findIndex((entry) => mediaIdentity(entry.item) !== heroMediaKey)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % spotlightCandidates.length : fallbackIndex
    const next = spotlightCandidates[nextIndex]
    if (next) setSpotlightSelectionKey(mediaIdentity(next.item))
  }
  const selectTastePick = (item: SearchResult) => {
    const id = mediaIdentity(item)
    if (pickedIds.includes(id) || pickedIds.length >= 3) return
    const next = [...pickedIds, id]
    setPickedIds(next)
    try { localStorage.setItem(pickStorageKey, JSON.stringify(next)) } catch { /* use this session's selection */ }
    submitFeedback(item, 'more-like-this')
  }
  const resetTastePicks = () => {
    const selected = tabRanked.map((entry) => entry.item).filter((item) => pickedIds.includes(mediaIdentity(item)))
    const selectedFeedback = feedback.filter((entry) => entry.kind === 'more-like-this' && (pickedIds.includes(entry.mediaKey) || pickedIds.includes(mediaIdentity({ ...entry.item, provider: entry.item.provider || 'unknown' }))))
    setFeedback(resetTasteFeedback([...selected, ...selectedFeedback.map((entry) => entry.item)], selectedFeedback.map((entry) => entry.mediaKey)))
    setPickedIds([])
    setPickOffset(0)
    try { localStorage.removeItem(pickStorageKey) } catch { /* use this session's selection */ }
  }

  const toggleContentType = (type: DiscoverContentType) => {
    const next = toggleDiscoverContentType(contentTypes, type)
    if (next === contentTypes) return
    setContentTypes(next)
    setTab(next.includes('movies') ? 'movies' : next.includes('shows') ? 'series' : 'anime')
    setSelectedGenreId(null)
  }

  const openItemDetail = (item: SearchResult, autoPlay = false) => navigate(item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`, { state: { ...item, autoPlay } })
  const openHeroDetail = (autoPlay = false) => { if (heroRecommendation) openItemDetail(heroRecommendation.item, autoPlay) }
  const heroCustomArt = heroRecommendation ? getSearchResultCustomArt(heroRecommendation.item) : undefined
  const heroPoster = heroRecommendation ? selectDiscoverPosterArtwork(
    heroCustomArt?.poster || heroArt[artworkCacheKey(heroRecommendation.item)]?.poster || heroRecommendation.item.poster,
    heroCustomArt?.backdrop || heroArt[artworkCacheKey(heroRecommendation.item)]?.backdrop || heroRecommendation.item.backdrop,
    cleanDiscoverPosters[mediaIdentity(heroRecommendation.item)] || undefined,
  ) : undefined
  const heroLogo = heroRecommendation ? (heroArt[artworkCacheKey(heroRecommendation.item)]?.logo || heroRecommendation.item.logo) : undefined
  const heroBackdrop = heroRecommendation ? cardArtworkUrl(heroCustomArt?.backdrop || heroArt[artworkCacheKey(heroRecommendation.item)]?.backdrop || heroRecommendation.item.backdrop || heroArt[artworkCacheKey(heroRecommendation.item)]?.poster || heroRecommendation.item.poster, 'landscape', posterSize) : undefined
  const heroRating = formatDiscoveryRating(heroRecommendation?.item.rating)
  const weekendPlanCustomArt = activeWeekendPlanItem ? getSearchResultCustomArt(activeWeekendPlanItem) : undefined
  const weekendPlanPoster = activeWeekendPlanItem ? selectDiscoverPosterArtwork(
    weekendPlanCustomArt?.poster || heroArt[artworkCacheKey(activeWeekendPlanItem)]?.poster || activeWeekendPlanItem.poster,
    weekendPlanCustomArt?.backdrop || heroArt[artworkCacheKey(activeWeekendPlanItem)]?.backdrop || activeWeekendPlanItem.backdrop,
    cleanDiscoverPosters[mediaIdentity(activeWeekendPlanItem)] || undefined,
  ) : undefined
  const weekendPlanLogo = activeWeekendPlanItem ? heroArt[artworkCacheKey(activeWeekendPlanItem)]?.logo || activeWeekendPlanItem.logo : undefined
  const weekendPlanBackdrop = activeWeekendPlanItem ? cardArtworkUrl(
    weekendPlanCustomArt?.backdrop || heroArt[artworkCacheKey(activeWeekendPlanItem)]?.backdrop || activeWeekendPlanItem.backdrop || activeWeekendPlanItem.poster,
    'landscape',
    posterSize,
  ) : undefined
  const weekendPlanRating = formatDiscoveryRating(activeWeekendPlanItem?.rating)
  const weekendPlanAccolade = activeWeekendPlanItem ? editorialAccolade({
    type: activeWeekendPlanItem.type,
    year: activeWeekendPlanItem.year,
    releaseDate: activeWeekendPlanItem.releaseDate,
    rating: activeWeekendPlanItem.rating,
    voteCount: activeWeekendPlanItem.voteCount,
  }) : null
  const weekendPlanRuntime = activeWeekendPlanItem
    ? tabRanked.find((entry) => mediaIdentity(entry.item) === mediaIdentity(activeWeekendPlanItem))?.runtimeMinutes
      || currentTrendingRanked.find((entry) => mediaIdentity(entry.item) === mediaIdentity(activeWeekendPlanItem))?.runtimeMinutes
      || activeWeekendPlanItem.runtime
    : undefined
  const pickerCustomArt = pickerRecommendation ? getSearchResultCustomArt(pickerRecommendation.item) : undefined
  const pickerLogo = pickerRecommendation ? (heroArt[artworkCacheKey(pickerRecommendation.item)]?.logo || pickerRecommendation.item.logo) : undefined
  const pickerRating = formatDiscoveryRating(pickerRecommendation?.item.rating)
  const pickerPoster = pickerRecommendation ? selectDiscoverPosterArtwork(
    pickerCustomArt?.poster || heroArt[artworkCacheKey(pickerRecommendation.item)]?.poster || pickerRecommendation.item.poster,
    pickerCustomArt?.backdrop || heroArt[artworkCacheKey(pickerRecommendation.item)]?.backdrop || pickerRecommendation.item.backdrop,
    cleanDiscoverPosters[mediaIdentity(pickerRecommendation.item)] || undefined,
  ) : undefined
  const pickerBackdrop = pickerRecommendation ? cardArtworkUrl(pickerCustomArt?.backdrop || heroArt[artworkCacheKey(pickerRecommendation.item)]?.backdrop || pickerRecommendation.item.backdrop || heroArt[artworkCacheKey(pickerRecommendation.item)]?.poster || pickerRecommendation.item.poster, 'landscape', posterSize) : undefined
  const directPosterItems = useMemo(() => {
    const unique = new Map<string, SearchResult>()
    for (const item of [heroRecommendation?.item, activeWeekendPlanItem, pickerRecommendation?.item, ...bingeArtworkItems, ...tastePickCandidates]) {
      if (item) unique.set(mediaIdentity(item), item)
    }
    return [...unique.values()]
  }, [activeWeekendPlanItem, bingeArtworkItems, heroRecommendation?.item, pickerRecommendation?.item, tastePickCandidates])
  useEffect(() => {
    let cancelled = false
    const pending = directPosterItems.filter((item) => !(mediaIdentity(item) in cleanDiscoverPosters))
    if (!pending.length) return
    void Promise.all(pending.map(async (item) => {
      try {
        const { resolveTmdbIdFromExternalIds } = await import('../services/metadataEnrich')
        const tmdbId = await resolveTmdbIdFromExternalIds(item, item.type)
        if (!tmdbId) return [mediaIdentity(item), null] as const
        return [mediaIdentity(item), await getTmdbCleanPoster(item.type, tmdbId, item.poster) || null] as const
      } catch {
        return [mediaIdentity(item), null] as const
      }
    })).then((entries) => {
      if (!cancelled) setCleanDiscoverPosters((current) => ({ ...current, ...Object.fromEntries(entries) }))
    })
    return () => { cancelled = true }
  }, [cleanDiscoverPosters, directPosterItems])
  const discoverFadeArtwork = useMemo(() => [...new Set([
    heroPoster,
    pickerPoster,
    ...bingeArtworkItems.map((item) => bingePoster(item)),
    ...tastePickCandidates.map((item) => selectDiscoverPosterArtwork(discoveryPoster(item), discoveryBackdrop(item))),
  ].filter((url): url is string => Boolean(url)))], [bingeArtworkItems, bingePoster, discoveryBackdrop, discoveryPoster, heroPoster, pickerPoster, selectDiscoverPosterArtwork, tastePickCandidates])
  useEffect(() => {
    if (posterColorMode !== 'artwork' || !discoverFadeArtwork.length) return
    const missing = discoverFadeArtwork.filter((url) => !(url in discoverPosterColors) && !requestedDiscoverPosterColors.current.has(url))
    if (!missing.length) return
    // The artwork list changes as clean posters and provider art arrive. Do
    // not abort an in-flight color sample on each list update: that left the
    // poster reveal gate waiting forever on the same artwork URL.
    missing.forEach((url) => requestedDiscoverPosterColors.current.add(url))
    void Promise.all(missing.map(async (url) => [url, await loadAmbientColor(url, undefined, 'poster-bottom')] as const)).then((entries) => {
      setDiscoverPosterColors((current) => ({ ...current, ...Object.fromEntries(entries) }))
    })
  }, [discoverFadeArtwork, discoverPosterColors, posterColorMode])
  useEffect(() => {
    const markPosterDetailsReady = () => setPosterDetailsLoadRevision((revision) => revision + 1)
    window.addEventListener('aurales:discover-poster-status-ready', markPosterDetailsReady)
    return () => window.removeEventListener('aurales:discover-poster-status-ready', markPosterDetailsReady)
  }, [])
  useEffect(() => {
    const pendingImages = document.querySelectorAll<HTMLImageElement>('.discover-poster-fade img[data-artwork-loaded-pending="true"]')
    pendingImages.forEach((image) => {
      const artworkUrl = image.currentSrc || image.src
      const posterContainer = image.closest<HTMLElement>('.discover-poster-fade')
      const allowDetailsFallback = posterContainer?.dataset.posterDetailsFallbackReady === 'true'
      if (!allowDetailsFallback && posterColorMode === 'artwork' && !(artworkUrl in discoverPosterColors)) return
      const mediaKey = image.dataset.discoverMediaKey
      if (!allowDetailsFallback && posterArtworkSetting === 'poster' && mediaKey && !(mediaKey in cleanDiscoverPosters)) return
      const logoLookupKey = image.dataset.logoLookupKey
      if (!allowDetailsFallback && logoLookupKey && !resolvedPosterLogoLookups[logoLookupKey]) return
      if (posterContainer?.dataset.posterStatusReady !== 'true') return
      const titleLogo = image.parentElement?.querySelector<HTMLImageElement>('.discover-poster-title-logo')
      if (!allowDetailsFallback && titleLogo && titleLogo.dataset.titleLogoLoaded !== 'true' && titleLogo.dataset.titleLogoFailed !== 'true') return
      delete image.dataset.artworkLoadedPending
      image.dataset.artworkLoaded = 'true'
      image.dataset.artworkLoadedUrl = artworkUrl
      setLoadedDiscoverArtwork((current) => current[artworkUrl] ? current : { ...current, [artworkUrl]: true })
    })
  }, [cleanDiscoverPosters, discoverPosterColors, posterArtworkSetting, posterColorMode, posterDetailsLoadRevision, posterLogoLoadRevision, resolvedPosterLogoLookups])
  return (
    <div className="discover-page pb-12">
      <div className="discover-page__notice pt-8"><CatalogKeyNotice /></div>
      <div className="discover-page__heading px-6 pt-10 pb-7 md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-[-.04em] text-white md:text-5xl">Settle in, {activeProfile.name}.</h1>
          </div>
        </div>

        <div className="discover-page__controls">
          <details className="discover-page__tabs discover-content-menu mt-8">
            <summary className="discover-content-menu__summary" aria-label={`Content types: ${contentTypes.map((item) => item === 'movies' ? 'Movies' : item === 'shows' ? 'Shows' : 'Anime').join(' & ')}`}>
              <span>{contentTypes.map((item) => item === 'movies' ? 'Movies' : item === 'shows' ? 'Shows' : 'Anime').join(' & ')}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
            </summary>
            <div className="discover-content-menu__options" role="group" aria-label="Include content types">
              {(['movies', 'shows', 'anime'] as DiscoverContentType[]).map((item) => (
                <button key={item} type="button" role="checkbox" aria-checked={contentTypes.includes(item)} onClick={() => toggleContentType(item)}>
                  <span className="discover-content-menu__check" aria-hidden="true">{contentTypes.includes(item) ? '✓' : ''}</span>
                  {item === 'movies' ? 'Movies' : item === 'shows' ? 'Shows' : 'Anime'}
                </button>
              ))}
            </div>
          </details>
          <div className="discover-page__modes" aria-label="Discovery controls">
            <button ref={surpriseButtonRef} className="discover-surprise-trigger" type="button" onClick={triggerSurprise} disabled={pickerPool.length < 2 || surpriseSpinning} aria-busy={surpriseSpinning}><Shuffle size={16} aria-hidden="true" /> <span>{surpriseSpinning ? 'Choosing…' : 'Surprise Me'}</span></button>
            <button ref={preferencesButtonRef} className="discover-preferences-trigger" type="button" onClick={() => setPreferencesOpen(true)} aria-label="Discovery settings"><Settings size={18} aria-hidden="true" /></button>
          </div>
        </div>
      </div>

      <>
          <DiscoveryReveal><DiscoveryCalendarRow watchProgress={watchProgress} traktConnected={traktConnected} simklConnected={simklConnected} anilistConnected={anilistConnected} mdblistApiKey={mdblistApiKey} /></DiscoveryReveal>
          {viewState === 'content' && heroRecommendation && <DiscoveryReveal>
            <>
              <header className="discover-spotlight-heading row-contain">
                <div className="discover-spotlight-heading__copy"><h2 id="discover-next-title">Your Next Obsession</h2></div>
              </header>
              <section ref={spotlightTransitionRef} className="discover-spotlight discover-next-hero" aria-labelledby="discover-next-title" data-title={heroRecommendation.item.title}>
                {heroBackdrop && <div key={heroBackdrop} className="discover-spotlight__ambient" aria-hidden="true"><img className={loadedHeroBackdrop === heroBackdrop ? 'is-loaded' : undefined} src={heroBackdrop} alt="" draggable={false} decoding="async" fetchPriority="high" onLoad={() => setLoadedHeroBackdrop(heroBackdrop)} /></div>}
                <div className="discover-spotlight__copy" data-title={heroRecommendation.item.title}>
                  <div className="discover-spotlight__top">
                    <p className="discover-spotlight__eyebrow">{heroRecommendation.item.type === 'movie' ? 'A movie for tonight' : heroRecommendation.item.isAnime ? 'An anime for tonight' : 'A series for tonight'}</p>
                    <p className="discover-spotlight__duration">Usually {formatWatchDuration(heroRecommendation.runtimeMinutes || tasteProfile.preferredRuntimeMinutes || (tab === 'movies' ? 105 : 45))}</p>
                  </div>
                  <div className={`discover-spotlight__bottom${heroRecommendation.reasons[0] ? ' has-editorial-reason' : ''}`}>
                    {heroLogo && !heroLogoError ? <img key={heroRecommendation.item.id} src={heroLogo} alt={heroRecommendation.item.title} draggable={false} onError={() => setHeroLogoError(true)} className="discover-spotlight__logo" /> : <h2 key={heroRecommendation.item.id}>{heroRecommendation.item.title}</h2>}
                    <div className="discover-spotlight__meta">
                      {heroRecommendation.item.year && <span>{heroRecommendation.item.year}</span>}
                      <span>{isAnimeLike(heroRecommendation.item) ? 'Anime' : heroRecommendation.item.type === 'series' ? 'Series' : 'Movie'}</span>
                      {heroRecommendation.item.genres?.slice(0, 1).map((genre) => <span key={genre}>{genre}</span>)}
                      {heroRating && <span>★ {heroRating}</span>}
                    </div>
                    {heroReason && <p className="discover-spotlight__reason">{heroReason.label.replace(/\btaste\b/gi, 'preferences')}</p>}
                    {heroRecommendation.item.overview && <p className="discover-spotlight__overview">{heroRecommendation.item.overview}</p>}
                    <div className="discover-spotlight__actions">
                      <button type="button" className="discover-spotlight__play" onClick={() => openHeroDetail(true)}>▶ <span>Play</span></button>
                      <button type="button" className="discover-spotlight__another discover-spotlight__secondary" onClick={() => openHeroDetail(false)} aria-label="Details"><Info size={17} aria-hidden="true"/><span>Details</span></button>
                      <button type="button" className="discover-spotlight__another discover-spotlight__feedback" aria-label="Not for me" onClick={() => submitFeedback(heroRecommendation.item, 'not-interested')}><ThumbsDown size={17} aria-hidden="true"/><span>Not for me</span></button>
                      <button type="button" className="discover-spotlight__another discover-spotlight__change" onClick={chooseAnotherSpotlight} disabled={spotlightCandidates.length < 2}><Shuffle size={15} aria-hidden="true"/><span>Another option</span></button>
                    </div>
                  </div>
                </div>
                {heroPoster && <figure className="discover-spotlight__poster-wrap"><div className="discover-spotlight__poster discover-poster-fade" style={posterFadeStyleFor(heroPoster)}><img key={heroPoster} data-discover-media-key={mediaIdentity(heroRecommendation.item)} data-logo-lookup-key={artworkCacheKey(heroRecommendation.item)} className="discover-artwork-enter" src={heroPoster} alt={`${heroRecommendation.item.title} poster`} draggable={false} loading="eager" decoding="async" onLoad={revealDiscoverPosterWhenReady} />{heroEditorialLabel && <span className="discover-spotlight__accolade">{heroEditorialLabel}</span>}<DiscoverPosterWatchMark item={heroRecommendation.item} rating={heroRating} logo={heroLogo && !heroLogoError ? <img className="discover-poster-title-logo" src={heroLogo} alt="" aria-hidden="true" draggable={false} onLoad={markDiscoverTitleLogoLoaded} onError={(event) => { markDiscoverTitleLogoFailed(event); setHeroLogoError(true) }} /> : discoverPosterTitleFallback(heroRecommendation.item, heroPoster, heroLogo, heroLogoError)} /></div><DiscoverPosterRatingBelow rating={heroRating} /></figure>}
              </section>
            </>
          </DiscoveryReveal>}
          {viewState === 'error' && <div className="mx-6 mb-8 grid min-h-72 place-items-center rounded-3xl border border-white/10 bg-white/[.03] p-8 text-center"><div><h2 className="text-xl font-black">Recommendations are unavailable</h2><p className="mt-2 max-w-md text-sm text-white/60">Cached discovery data was not available and recommendation sources could not be loaded. Check your network or TMDB settings.</p><button onClick={() => window.location.reload()} className="mt-5 rounded-full bg-white px-5 py-2 font-bold text-black">Retry</button></div></div>}
          {viewState === 'content' && trendingSection && <DiscoveryReveal><div className="row-contain discover-shelf discover-shelf--trending"><MediaRow title="OR TRY" items={trendingSection.items.map((entry) => entry.item)} showAllItems={trendingSection.catalogItems?.map((entry) => entry.item)} showAllContinuation={{ configs: makeContentTypeConfigs(contentTypes, 'popularity.desc', preferences), tab, tabs: continuationTabs, excludeIds: [...(heroMediaKey ? [heroMediaKey] : []), ...visiblePersonalizedSections.flatMap((section) => section.items.map((entry) => mediaIdentity(entry.item)))] }} forceShowAll layout="poster" disableCinematic showAllPath={`/catalog/discover-section-${tab}-trending-this-week?title=${encodeURIComponent('OR TRY')}`} /></div></DiscoveryReveal>}
          {visiblePersonalizedSections.filter((section) => section.id !== 'trending-this-week').map((section) => {
            const isTopTen = section.id === 'made-for-you'
            const isPersonalGenre = section.id.startsWith('because-genre-')
            const genreTitle = isPersonalGenre ? section.title.replace(/^Because You Love /i, '') : ''
            const title = isTopTen ? (mode === 'for-you' ? 'Top 10 For You' : section.title) : isPersonalGenre ? `${genreTitle} Picks` : section.title.replace(/\s+for you$/i, '')
            const items = (isTopTen ? section.items : isPersonalGenre ? prioritizeLiveTrendsWithin(currentTrendingRanked, section.items) : section.items).map((entry) => entry.item).slice(0, isTopTen || isPersonalGenre ? 10 : undefined)
            // A Top 10 catalog must stay a ten-title collection even when the
            // recommendation engine exposes a larger backing catalog.
            const sourceCatalogItems = isPersonalGenre ? prioritizeLiveTrendsWithin(currentTrendingRanked, section.catalogItems ?? section.items) : section.catalogItems ?? section.items
            const catalogItems = sourceCatalogItems.map((entry) => entry.item).slice(0, isTopTen ? 10 : undefined)
            const personalGenreId = isPersonalGenre ? Number(section.id.slice('because-genre-'.length)) : undefined
            const continuation: DiscoveryCatalogContinuation | undefined = isTopTen ? undefined : isPersonalGenre && Number.isFinite(personalGenreId)
              ? { configs: makeContentTypeConfigs(contentTypes, 'popularity.desc', preferences, { includeGenres: [String(personalGenreId)], genreMatchMode: 'OR', voteAverageMin: Math.max(6.5, minRating), voteCountMin: 100 }), tab, tabs: continuationTabs, genreIds: [personalGenreId!] }
              : undefined
            const eyebrow = isPersonalGenre ? `Because you love ${genreTitle.toLocaleLowerCase()}` : undefined
            return <DiscoveryReveal key={section.id}><div className={`row-contain discover-shelf${isPersonalGenre ? ' discover-shelf--personal-genre' : ''}`}><MediaRow title={title} headerEyebrow={eyebrow} items={items} showAllItems={catalogItems} showAllContinuation={continuation} layout={isTopTen ? 'ranked' : 'poster'} previewLimit={isTopTen ? 10 : undefined} renderAllPreviewItems={isTopTen} disableCinematic forceShowAll showAllPath={`/catalog/discover-section-${tab}-${section.id}?title=${encodeURIComponent(title)}`} /></div></DiscoveryReveal>
          })}
          {viewState === 'content' && activeSimilaritySection && activeSimilarityTitle && <DiscoveryReveal><div className="row-contain discover-shelf discover-shelf--personal-seed">
            <MediaRow
              title={activeSimilarityTitle}
              headerEyebrow={activeSimilaritySection.id.startsWith('because-favorited') ? 'Because you favorited' : 'Because you watched'}
              headerBottomControls={<div className="discover-seed-tabs" role="group" aria-label="Recommendation seeds">{similaritySections.map((section) => {
                const seedTitle = section.title.replace(/^Because You (?:Favorited|Watched) /i, '').replace(/\s+\(\d{4}\)$/, '')
                return <button key={section.id} type="button" aria-pressed={section.id === activeSimilaritySection.id} onClick={() => setSelectedSimilaritySectionId(section.id)}>{seedTitle}</button>
              })}</div>}
              items={prioritizeLiveTrendsWithin(currentTrendingRanked, activeSimilaritySection.items).map((entry) => entry.item)}
              showAllItems={prioritizeLiveTrendsWithin(currentTrendingRanked, activeSimilaritySection.catalogItems ?? activeSimilaritySection.items).map((entry) => entry.item)}
              layout="poster"
              disableCinematic
              forceShowAll
              showAllPath={`/catalog/discover-section-${tab}-${activeSimilaritySection.id}?title=${encodeURIComponent(`Because you ${activeSimilaritySection.id.startsWith('because-favorited') ? 'favorited' : 'watched'} ${activeSimilarityTitle}`)}`}
            />
          </div></DiscoveryReveal>}
          {viewState === 'content' && activeWeekendPlanItem && <DiscoveryReveal>
            <>
              <header className="discover-spotlight-heading row-contain"><div className="discover-spotlight-heading__copy"><h2 id="discover-weekend-title">Your Weekend Plan</h2></div></header>
              <section className="discover-spotlight discover-weekend-plan" aria-labelledby="discover-weekend-title" data-title={activeWeekendPlanItem.title}>
                {weekendPlanBackdrop && <div key={weekendPlanBackdrop} className="discover-spotlight__ambient" aria-hidden="true"><img className={loadedWeekendBackdrop === weekendPlanBackdrop ? 'is-loaded' : undefined} src={weekendPlanBackdrop} alt="" draggable={false} decoding="async" fetchPriority="high" onLoad={() => setLoadedWeekendBackdrop(weekendPlanBackdrop)} /></div>}
                <div key={mediaIdentity(activeWeekendPlanItem)} className="discover-spotlight__copy" data-title={activeWeekendPlanItem.title} aria-live="polite">
                  <div className="discover-spotlight__top"><p className="discover-spotlight__eyebrow">{activeWeekendPlanItem.isAnime ? 'An anime' : activeWeekendPlanItem.type === 'movie' ? 'A movie' : 'A series'} for tonight</p>{weekendPlanRuntime != null && <p className="discover-spotlight__duration">Usually {formatWatchDuration(weekendPlanRuntime)}</p>}</div>
                  <div className="discover-spotlight__bottom">
                    {weekendPlanLogo ? <img src={weekendPlanLogo} alt={activeWeekendPlanItem.title} draggable={false} className="discover-spotlight__logo" /> : <h2>{activeWeekendPlanItem.title}</h2>}
                    <div className="discover-spotlight__meta">{activeWeekendPlanItem.year && <span>{activeWeekendPlanItem.year}</span>}<span>{isAnimeLike(activeWeekendPlanItem) ? 'Anime' : activeWeekendPlanItem.type === 'series' ? 'Series' : 'Movie'}</span>{activeWeekendPlanItem.genres?.slice(0, 1).map((genre) => <span key={genre}>{genre}</span>)}{weekendPlanRating && <span>★ {weekendPlanRating}</span>}</div>
                    {activeWeekendPlanItem.overview && <p className="discover-spotlight__overview">{activeWeekendPlanItem.overview}</p>}
                    <div className="discover-spotlight__actions">
                      <button type="button" className="discover-spotlight__play" onClick={() => openItemDetail(activeWeekendPlanItem, true)}>▶ <span>Play</span></button>
                      <button type="button" className="discover-spotlight__another discover-spotlight__secondary" onClick={() => openItemDetail(activeWeekendPlanItem)} aria-label="Details"><Info size={17} aria-hidden="true"/><span>Details</span></button>
                      <button type="button" className="discover-spotlight__another discover-spotlight__change" onClick={() => setWeekendPlanIndex((index) => (index + 1) % weekendPlanCandidates.length)} disabled={weekendPlanCandidates.length < 2}><Shuffle size={15} aria-hidden="true"/><span>Another option</span></button>
                    </div>
                  </div>
                </div>
                {weekendPlanPoster && <figure className="discover-spotlight__poster-wrap"><div key={mediaIdentity(activeWeekendPlanItem)} className="discover-spotlight__poster discover-poster-fade" style={posterFadeStyleFor(weekendPlanPoster)}><img data-discover-media-key={mediaIdentity(activeWeekendPlanItem)} data-logo-lookup-key={artworkCacheKey(activeWeekendPlanItem)} className="discover-artwork-enter" src={weekendPlanPoster} alt={`${activeWeekendPlanItem.title} poster`} draggable={false} loading="lazy" decoding="async" onLoad={revealDiscoverPosterWhenReady} />{weekendPlanAccolade && <span className="discover-spotlight__accolade">{weekendPlanAccolade}</span>}<DiscoverPosterWatchMark item={activeWeekendPlanItem} rating={weekendPlanRating} logo={weekendPlanLogo ? <img className="discover-poster-title-logo" src={weekendPlanLogo} alt="" aria-hidden="true" draggable={false} onLoad={markDiscoverTitleLogoLoaded} onError={markDiscoverTitleLogoFailed} /> : discoverPosterTitleFallback(activeWeekendPlanItem, weekendPlanPoster, weekendPlanLogo)} /></div><DiscoverPosterRatingBelow rating={weekendPlanRating} /></figure>}
              </section>
            </>
          </DiscoveryReveal>}
          {(tabRanked.length > 0 || currentTrendingRanked.length > 0) && <DiscoveryReveal><section className="discover-refine row-contain" aria-labelledby="discover-refine-title">
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
              {tastePickCandidates.length < tastePickPool.length && pickedIds.length < 3 && <button className="discover-refine__more" type="button" onClick={() => setPickOffset((current) => current + 10)}><RefreshCw size={16} aria-hidden="true"/> <span>More choices</span></button>}
              {pickedIds.length > 0 && <button className="discover-refine__reset" type="button" onClick={resetTastePicks}><RotateCcw size={16} aria-hidden="true"/> <span>Start over</span></button>}
            </div>
            <div className="discover-taste-picks">
              {tastePickCandidates.map((item) => {
                const id = mediaIdentity(item)
                const poster = selectDiscoverPosterArtwork(discoveryPoster(item), discoveryBackdrop(item), cleanDiscoverPosters[id] || undefined)
                const logo = discoveryLogo(item)
                const rating = formatDiscoveryRating(item.rating)
                return <button key={id} type="button" className="discover-taste-pick" onClick={() => selectTastePick(item)} disabled={pickedIds.length >= 3} aria-label={`Choose ${item.title}`}>
                  <span className="discover-taste-pick__poster discover-poster-fade" style={posterFadeStyleFor(poster)}>{poster && <img key={poster} data-discover-media-key={id} data-logo-lookup-key={artworkCacheKey(item)} className="discover-artwork-enter" src={poster} alt="" loading="lazy" decoding="async" onLoad={revealDiscoverPosterWhenReady} />}<DiscoverPosterWatchMark item={item} rating={rating} logo={logo ? <img className="discover-poster-title-logo" src={logo} alt="" aria-hidden="true" loading="lazy" decoding="async" onLoad={markDiscoverTitleLogoLoaded} onError={markDiscoverTitleLogoFailed} /> : discoverPosterTitleFallback(item, poster, logo)} /></span>
                  <DiscoverPosterRatingBelow rating={rating} />
                  <span className="discover-taste-pick__title">{item.title}</span>
                  <span className="discover-taste-pick__year">{item.year || (item.isAnime ? 'Anime' : item.type === 'series' ? 'Series' : 'Movie')}</span>
                </button>
              })}
              {tastePickCandidates.length === 0 && <p className="discover-taste-picks__empty">No matching titles. Try another search.</p>}
            </div>
          </section></DiscoveryReveal>}
          {viewState === 'content' && colorSamples.length >= 3 && <DiscoveryReveal><section className="discover-colors row-contain" aria-labelledby="discover-colors-title">
            <div className="discover-colors__heading"><div><p className="discover-section-eyebrow">Browse by poster colour</p><h2 id="discover-colors-title">Pick by Colour</h2></div><span>Popular titles, grouped by their artwork</span></div>
            <div className="discover-colors__filters" role="group" aria-label="Poster colour">
              <button type="button" className={selectedPosterColor === 'all' ? 'is-active' : ''} aria-pressed={selectedPosterColor === 'all'} onClick={() => setSelectedPosterColor('all')}>All</button>
              {POSTER_COLOR_GROUPS.filter((group) => availablePosterColors.has(group.id)).map((group) => <button key={group.id} type="button" className={selectedPosterColor === group.id ? 'is-active' : ''} aria-pressed={selectedPosterColor === group.id} onClick={() => setSelectedPosterColor(group.id)}><span aria-hidden="true" style={{ backgroundColor: group.color }} />{group.label}</button>)}
            </div>
            {colorPreviewItems.length > 0
              ? <div className="discover-colors__row"><MediaRow title={colorCatalogTitle} items={colorPreviewItems} showAllItems={colorSelectionItems} layout="poster" disableCinematic showAllPath={`/catalog/${colorRowId}?title=${encodeURIComponent(colorCatalogTitle)}`} /></div>
              : <p className="discover-colors__empty" role="status">No titles found in this colour yet. Choose another colour.</p>}
          </section></DiscoveryReveal>}
          {viewState === 'content' && <DiscoveryReveal><div className="discover-time discover-shelf--time">
            {timeTonightItems.length > 0
              ? <MediaRow
                title="How Much Time Tonight?"
                headerEyebrow="Picked to fit"
                headerBottomControls={<div className="discover-editorial-tabs" role="group" aria-label="Choose a watch duration">
                  {DISCOVERY_RUNTIME_BUCKETS.map((bucket) => <button key={bucket.id} type="button" aria-pressed={selectedRuntimeBucket.id === bucket.id} onClick={() => setSelectedRuntimeBucketId(bucket.id)}>{bucket.label}</button>)}
                </div>}
                items={timeTonightItems}
                showAllItems={timeTonightCatalogItems}
                showAllContinuation={{ configs: makeContentTypeConfigs(contentTypes, 'popularity.desc', preferences, { runtimeMin: selectedRuntimeBucket.min, runtimeMax: selectedRuntimeBucket.max, voteAverageMin: Math.max(6, minRating), voteCountMin: 50 }), tab, tabs: continuationTabs }}
                layout="poster"
                disableCinematic
                showAllPath={`/catalog/discover-time-${tab}-${selectedRuntimeBucket.id}-${discoveryQueryKey}?title=${encodeURIComponent('How Much Time Tonight?')}`}
              />
              : <section className="discover-time__empty row-contain" aria-labelledby="discover-time-title">
                <div className="discover-editorial-heading"><div><p className="discover-section-eyebrow">Picked to fit</p><h2 id="discover-time-title">How Much Time Tonight?</h2></div>
                  <div className="discover-editorial-tabs" role="group" aria-label="Choose a watch duration">
                    {DISCOVERY_RUNTIME_BUCKETS.map((bucket) => <button key={bucket.id} type="button" aria-pressed={selectedRuntimeBucket.id === bucket.id} onClick={() => setSelectedRuntimeBucketId(bucket.id)}>{bucket.label}</button>)}
                  </div>
                </div>
                <p className="discover-editorial-empty" role="status">{timeTonightLoading ? 'Finding popular titles that fit…' : 'No titles found for this time yet.'}</p>
              </section>}
          </div></DiscoveryReveal>}
          <DiscoveryReveal><section className="discover-genres row-contain" aria-labelledby="discover-genres-title">
            <div className="discover-genres__heading"><div><p className="discover-section-eyebrow">Browse by category</p><h2 id="discover-genres-title">Your Genres</h2></div></div>
            <div className="discover-genres__grid" role="group" aria-label="Genres">
              {genreTiles.map(({ option, items }) => {
                const featured = items[0]
                const artwork = featured ? selectDiscoverPosterArtwork(discoveryPoster(featured), discoveryBackdrop(featured)) : undefined
                return <button
                  type="button"
                  key={option.title}
                  aria-pressed={selectedGenreId === option.genres[0]}
                  aria-controls="discover-genre-picks"
                  className={selectedGenreId === option.genres[0] ? 'is-active' : ''}
                  onClick={() => setSelectedGenreId(option.genres[0]!)}
                  style={artwork ? { backgroundImage: `linear-gradient(90deg, rgba(9,9,12,.9), rgba(9,9,12,.58)), url("${artwork}")` } : undefined}
                >
                  <span className="discover-genres__tile-copy">
                    <span className="discover-genres__tile-title">{option.title}</span>
                    <small>{option.genres[0] === selectedGenreId && genreSelectionItems.length ? genreSelectionItems.length : filteredCandidates.filter((entry) => entry.item.genreIds?.includes(option.genres[0]!)).length} titles</small>
                  </span>
                  <span className="discover-genres__tile-art" aria-hidden="true">
                    {items.map((item) => <img key={mediaIdentity(item)} src={selectDiscoverPosterArtwork(discoveryPoster(item), discoveryBackdrop(item))} alt="" loading="lazy" decoding="async" />)}
                  </span>
                </button>
              })}
            </div>
            <div id="discover-genre-picks" ref={genrePicksRef} className="discover-genre-picks" aria-live="polite">
              {selectedGenreId != null && genreLoading && genreSelectionItems.length === 0 && <p className="discover-genre-picks__loading" role="status">Finding {genreMap[selectedGenreId] || 'genre'} titles…</p>}
              {selectedGenreId != null && genreSelectionItems.length > 0 && <MediaRow title={`${genreMap[selectedGenreId] || 'Genre'} Picks`} items={genreSelectionItems} showAllItems={genreSelectionItems} showAllContinuation={{ configs: makeContentTypeConfigs(contentTypes, 'popularity.desc', preferences, { includeGenres: [String(selectedGenreId)], genreMatchMode: 'OR', voteAverageMin: Math.max(6, minRating), voteCountMin: 100 }), tab, tabs: continuationTabs, genreIds: [selectedGenreId] }} forceShowAll layout="poster" disableCinematic showAllPath={`/catalog/${genreRowId}?title=${encodeURIComponent(`${genreMap[selectedGenreId] || 'Genre'} Picks`)}`} />}
              {selectedGenreId != null && genreSelectionItems.length === 0 && !genreLoading && <p className="discover-genre-picks__empty">No titles found for {genreMap[selectedGenreId] || 'this genre'} yet. Try another genre.</p>}
            </div>
          </section></DiscoveryReveal>
          {bingeRecommendations.length > 0 && <DiscoveryReveal><section className="discover-binge row-contain" aria-labelledby="discover-binge-title">
            <div className="discover-binge__heading"><div><p className="discover-section-eyebrow">{activeBingeItem?.isAnime ? 'Anime to get lost in' : 'Series to get lost in'}</p><h2 id="discover-binge-title">Your Next Binge</h2></div><span>Popular picks · {bingeIndex % bingeRecommendations.length + 1} of {bingeRecommendations.length}</span></div>
            <div className="discover-binge__feature" data-active-title={activeBingeItem?.title}>
              <div key={`art-${activeBingeItem ? mediaIdentity(activeBingeItem) : 'empty'}`} className="discover-binge__art" aria-hidden="true">{activeBingeItem && bingeBackdrop(activeBingeItem) && <img src={bingeBackdrop(activeBingeItem)} alt="" loading="lazy" decoding="async"/>}</div>
              <div key={`copy-${activeBingeItem ? mediaIdentity(activeBingeItem) : 'empty'}`} className="discover-binge__copy" aria-live="polite">
                <div><h3>{activeBingeItem?.title}</h3><p>{[activeBingeItem?.year, activeBingeItem?.genres?.[0], activeBingeItem?.isAnime ? 'Anime' : 'Series'].filter(Boolean).join(' · ')}</p></div>
                <div className="discover-binge__actions"><button type="button" onClick={() => activeBingeItem && openItemDetail(activeBingeItem, true)}>▶ Play</button><button type="button" onClick={() => activeBingeItem && openItemDetail(activeBingeItem)}>Details</button><button type="button" onClick={() => setBingeIndex((current) => (current + 1) % bingeRecommendations.length)} disabled={bingeRecommendations.length < 2}>Another option</button></div>
              </div>
              {activeBingeItem && <div key={`gallery-${mediaIdentity(activeBingeItem)}`} className="discover-binge__gallery" aria-label="Binge recommendations">
                <div className="discover-binge__poster-wrap">
                  <button className="discover-binge__main-poster discover-poster-fade" style={posterFadeStyleFor(bingePoster(activeBingeItem))} type="button" onClick={() => openItemDetail(activeBingeItem)} aria-label={`Details for ${activeBingeItem.title}`}>
                    <img key={bingePoster(activeBingeItem)} data-discover-media-key={mediaIdentity(activeBingeItem)} data-logo-lookup-key={artworkCacheKey(activeBingeItem)} className="discover-artwork-enter" src={bingePoster(activeBingeItem)} alt={`${activeBingeItem.title} poster`} loading="lazy" decoding="async" onLoad={revealDiscoverPosterWhenReady} />
                    <DiscoverPosterWatchMark item={activeBingeItem} rating={activeBingeRating} logo={activeBingeLogo ? <img className="discover-poster-title-logo" src={activeBingeLogo} alt="" aria-hidden="true" loading="lazy" decoding="async" onLoad={markDiscoverTitleLogoLoaded} onError={markDiscoverTitleLogoFailed} /> : discoverPosterTitleFallback(activeBingeItem, bingePoster(activeBingeItem), activeBingeLogo)} />
                  </button>
                  <DiscoverPosterRatingBelow rating={activeBingeRating} />
                </div>
                <div className="discover-binge__alternatives">
                  {bingeGalleryItems.map((item) => {
                    const logo = bingeLogo(item)
                    const rating = formatDiscoveryRating(item.rating)
                    return <div key={mediaIdentity(item)} className="discover-binge__poster-wrap">
                      <button className="discover-poster-fade" style={posterFadeStyleFor(bingePoster(item))} type="button" onClick={() => setBingeIndex(bingeRecommendations.findIndex((candidate) => mediaIdentity(candidate) === mediaIdentity(item)))} aria-label={`Show ${item.title} in Your Next Binge`}>
                        <img key={bingePoster(item)} data-discover-media-key={mediaIdentity(item)} data-logo-lookup-key={artworkCacheKey(item)} className="discover-artwork-enter" src={bingePoster(item)} alt={`${item.title} poster`} loading="lazy" decoding="async" onLoad={revealDiscoverPosterWhenReady} />
                        <DiscoverPosterWatchMark item={item} rating={rating} logo={logo ? <img className="discover-poster-title-logo" src={logo} alt="" aria-hidden="true" loading="lazy" decoding="async" onLoad={markDiscoverTitleLogoLoaded} onError={markDiscoverTitleLogoFailed} /> : discoverPosterTitleFallback(item, bingePoster(item), logo)} />
                      </button>
                      <DiscoverPosterRatingBelow rating={rating} />
                    </div>
                  })}
                </div>
              </div>}
            </div>
          </section></DiscoveryReveal>}
          {viewState === 'content' && <DiscoveryReveal><section className="row-contain discover-shelf discover-shelf--moods" aria-labelledby="discover-moods-title">
            <div className="discover-editorial-heading"><div><p className="discover-section-eyebrow">Tuned to your taste</p><h2 id="discover-moods-title">Sunday Night Moods</h2></div>
              <div className="discover-editorial-tabs" role="group" aria-label="Choose a mood">{DISCOVERY_MOODS.map((mood) => <button key={mood.id} type="button" aria-pressed={activeDiscoveryMood.id === mood.id} onClick={() => setSelectedDiscoveryMoodId(mood.id)}>{mood.label}</button>)}</div>
            </div>
            {moodItems.length > 0
              ? <MediaRow title={`${activeDiscoveryMood.label} Picks`} items={moodItems} showAllItems={moodCatalogItems} showAllContinuation={{ configs: makeContentTypeConfigs(contentTypes, 'popularity.desc', preferences, { includeGenres: activeDiscoveryMood.genres.map(String), genreMatchMode: 'OR' }), tab, tabs: continuationTabs, genreIds: [...activeDiscoveryMood.genres] }} layout="poster" disableCinematic forceShowAll showAllPath={`/catalog/discover-mood-${tab}-${activeDiscoveryMood.id}-${discoveryQueryKey}?title=${encodeURIComponent(`${activeDiscoveryMood.label} Picks`)}`} />
              : <p className="discover-editorial-empty" role="status">No titles found for this mood yet.</p>}
          </section></DiscoveryReveal>}
          {bigScreenItems.length > 0 && <DiscoveryReveal><div className="row-contain discover-shelf discover-shelf--big-screen"><MediaRow title="Made for the Big Screen" headerEyebrow="Best in widescreen" items={bigScreenItems} showAllItems={bigScreenCatalogItems} showAllContinuation={{ configs: makeContentTypeConfigs(contentTypes, 'popularity.desc', preferences), tab, tabs: continuationTabs, excludeIds: [...(heroMediaKey ? [heroMediaKey] : []), ...visiblePersonalizedSections.flatMap((section) => section.items.slice(0, 10).map((entry) => mediaIdentity(entry.item))), ...(trendingSection?.items.map((entry) => mediaIdentity(entry.item)) ?? [])] }} layout="poster" disableCinematic showAllPath={`/catalog/discover-big-screen-${tab}-${discoveryQueryKey}?title=${encodeURIComponent('Made for the Big Screen')}`} /></div></DiscoveryReveal>}
          {hiddenGemItems.length > 0 && <DiscoveryReveal><div className="row-contain discover-shelf discover-shelf--gems"><MediaRow title="Hidden Gems" headerEyebrow="Highly rated, waiting for you" items={hiddenGemItems} showAllItems={hiddenGemCatalogItems} showAllContinuation={{ configs: makeContentTypeConfigs(contentTypes, 'vote_average.desc', preferences, { voteAverageMin: Math.max(7.2, minRating), voteCountMin: 100 }), tab, tabs: continuationTabs, maxPopularity: 35, minRating: Math.max(7.2, minRating) }} layout="poster" disableCinematic showAllPath={`/catalog/discover-hidden-gems-${tab}-${discoveryQueryKey}?title=${encodeURIComponent('Hidden Gems')}`} /></div></DiscoveryReveal>}
          {viewState === 'content' && <DiscoveryReveal><section className="discover-more row-contain" aria-labelledby="discover-more-title">
            <div className="discover-more__heading"><div><p className="discover-section-eyebrow">More popular picks</p><h2 id="discover-more-title">Keep Exploring</h2></div><span>{moreToDiscover.length ? `${moreToDiscover.length} titles loaded` : 'Fresh titles load as you scroll'}</span></div>
            {moreToDiscover.length > 0 && <div className="media-grid discover-more__grid">
              {moreToDiscover.map((item, index) => <MediaCard key={mediaIdentity(item)} item={item} layout="poster" disableTrailerPreview style={{ '--discover-card-delay': `${(index % 10) * 32}ms` } as import('react').CSSProperties} />)}
            </div>}
            <div ref={moreToDiscoverSentinelRef} className="discover-more__sentinel" aria-live="polite" role="status">
              {moreToDiscoverStatus === 'loading' && <><span className="discover-more__spinner" aria-hidden="true" />Loading more popular titles…</>}
              {moreToDiscoverStatus === 'idle' && <span>Keep scrolling for more titles</span>}
              {moreToDiscoverStatus === 'paused' && <button type="button" onClick={() => { moreToDiscoverStatusRef.current = 'idle'; setMoreToDiscoverStatus('idle'); void loadMoreDiscovery() }}>Continue exploring</button>}
              {moreToDiscoverStatus === 'error' && <button type="button" onClick={() => { moreToDiscoverStatusRef.current = 'idle'; setMoreToDiscoverStatus('idle'); void loadMoreDiscovery() }}>Retry loading titles</button>}
              {moreToDiscoverStatus === 'done' && <span>You’re all caught up for now</span>}
            </div>
          </section></DiscoveryReveal>}
      </>
      {pickerOpen && pickerRecommendation && <div className={`discover-picker-backdrop${pickerClosing ? ' is-closing' : ''}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePicker() }}>
        <section ref={pickerDialogRef} className={`discover-picker${surpriseSpinning ? ' is-spinning' : ''}${pickerClosing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="discover-picker-title" aria-busy={surpriseSpinning} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'))
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (!first || !last) return
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }}>
          <div className="discover-picker__ambient" aria-hidden="true">{pickerBackdrop && <img src={pickerBackdrop} alt="" draggable={false} />}</div>
          <button type="button" autoFocus className="discover-picker__close" onClick={closePicker} aria-label="Close picker"><X size={19} aria-hidden="true" /></button>
          <div className="discover-picker__body">
            <div className="discover-picker__visual">
              <div className="discover-picker__poster discover-poster-fade" style={{ ...posterFadeStyleFor(pickerPoster), '--discover-picker-roll-duration': `${pickerRollDurationMs}ms` } as import('react').CSSProperties}>
                {pickerPoster && <img data-discover-media-key={mediaIdentity(pickerRecommendation.item)} data-logo-lookup-key={artworkCacheKey(pickerRecommendation.item)} className="discover-artwork-enter" src={pickerPoster} alt={`${pickerRecommendation.item.title} poster`} draggable={false} onLoad={revealDiscoverPosterWhenReady} />}
                <DiscoverPosterWatchMark item={pickerRecommendation.item} rating={pickerRating} logo={pickerLogo && !pickerLogoError ? <img className="discover-poster-title-logo" src={pickerLogo} alt="" aria-hidden="true" draggable={false} onLoad={markDiscoverTitleLogoLoaded} onError={(event) => { markDiscoverTitleLogoFailed(event); setPickerLogoError(true) }} /> : discoverPosterTitleFallback(pickerRecommendation.item, pickerPoster, pickerLogo, pickerLogoError)} />
              </div>
              <DiscoverPosterRatingBelow rating={pickerRating} />
              {surpriseSpinning && <p className="discover-picker__status" role="status" aria-live="polite"><Shuffle size={15} aria-hidden="true" />Finding something for you</p>}
            </div>
            <div className="discover-picker__copy" data-title={pickerRecommendation.item.title}>
              {!surpriseSpinning && <p className="discover-section-eyebrow">Tonight, try</p>}
              {pickerLogo && !pickerLogoError
                ? <img className="discover-picker__logo" src={pickerLogo} alt={pickerRecommendation.item.title} onError={() => setPickerLogoError(true)} />
                : <h2 id="discover-picker-title">{pickerRecommendation.item.title}</h2>}
              {pickerLogo && !pickerLogoError && <h2 id="discover-picker-title" className="sr-only">{pickerRecommendation.item.title}</h2>}
              <p className="discover-picker__meta">{[pickerRecommendation.item.genres?.[0], pickerRecommendation.item.year, pickerRecommendation.item.type === 'movie' ? 'Movie' : 'Series', pickerRating ? `★ ${pickerRating}` : undefined].filter(Boolean).join(' · ')}</p>
              {pickerRecommendation.reasons[0] && <p className="discover-picker__reason">{pickerRecommendation.reasons[0].label}</p>}
              <div className="discover-picker__actions">
                <button type="button" className="discover-picker__open" onClick={() => { const item = pickerRecommendation.item; closePicker(); openItemDetail(item) }}>Open</button>
                <button type="button" className="discover-picker__dismiss" onClick={() => { const item = pickerRecommendation.item; closePicker(); submitFeedback(item, 'not-interested') }}>Not for me</button>
                <button type="button" className="discover-picker__spin" onClick={() => spinPicker(pickerItem?.id, (item) => setPickerSelectionKey(mediaIdentity(item)))} disabled={surpriseSpinning || pickerPool.length < 2} aria-label={surpriseSpinning ? 'Picking a title' : 'Spin again'}><Shuffle size={16} aria-hidden="true" />{surpriseSpinning ? 'Picking…' : 'Spin Again'}</button>
              </div>
            </div>
          </div>
        </section>
      </div>}
      {preferencesOpen && <div className="discover-preferences-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreferences() }}>
        <section className="discover-preferences" role="dialog" aria-modal="true" aria-labelledby="discover-preferences-title" onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (!first || !last) return
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }}>
          <header className="discover-preferences__header">
            <div><p className="discover-section-eyebrow">Tune your recommendations</p><h2 id="discover-preferences-title">Discovery settings</h2></div>
            <button type="button" autoFocus onClick={closePreferences} aria-label="Close Discovery settings"><X size={19} aria-hidden="true" /></button>
          </header>
          <div className="discover-preferences__body"><DiscoverPrefsPanel localPrefs={prefs} onChange={setDiscoverPrefs} onReset={resetDiscoverPrefs} /></div>
        </section>
      </div>}
    </div>
  )
}
