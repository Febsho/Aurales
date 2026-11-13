import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult, WatchProgress } from '../types'
import { applyInitialArtworkPreference, applySearchResultArt, getSearchResultCustomArt, resolveArtFromProviders } from '../services/artwork'
import { getTmdbCardMetadata, getTmdbCertification, getTmdbCleanPoster, getTmdbImageVariant, getTmdbLandscapeBackdrop } from '../services/tmdb'
import { getProviderWatchedEpisodeSummary, isWatchedFromProviders, searchResultToLookup, type ProviderWatchedEpisodeSummary } from '../services/watchedStatus'
import { getTrailerSource, type TrailerSource } from '../services/trailers'
import { cachedImage, retryImageFromSource, warmCachedImage, watchStalledImage } from '../services/imageCache'
import { useAppStore } from '../stores/appStore'
import { useWatchedCacheStore } from '../stores/watchedCacheStore'
import { useContextMenu } from '../hooks/useContextMenu'
import { useLongPressContextMenu } from '../hooks/useLongPressContextMenu'
import { cardArtworkUrl } from '../services/mediaPresentation'
import { nativeTrailerPlayerSupported } from '../services/player'
import { useVisibilityOnce } from '../hooks/useVisibilityOnce'
import { ensurePosterProgress, getPosterProgressSnapshot, getPosterTimeLeftSnapshot, subscribePosterProgress } from '../services/posterProgress'
import { isMobileWebViewport } from '../platform/mobileWeb'
import { getJellyfinPosterEpisodeSummaryForMedia, type PosterEpisodeSummary } from '../services/posterEpisodeSummary'
import { getPosterArtworkCandidate, getPosterEpisodeSegmentCount, getPosterFadeAppearance, getPosterVisibleDetails, POSTER_RATING_CAPTION_CLASS, POSTER_RATING_CAPTION_STAR_CLASS } from '../services/posterLayout'
import { loadAmbientColor, type AmbientColor } from '../services/ambientColor'
import { isInLocalWatchlist, subscribeLocalWatchlist } from '../services/localWatchlist'
import { PosterBottomStack } from './media/PosterBottomStack'
import { PosterFooterCaption } from './media/PosterFooterCaption'

const TrailerPreview = React.lazy(() => import('./TrailerPreview'))
const HeroMpvTrailer = React.lazy(() => import('./HeroMpvTrailer'))
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function getReducedMotionSnapshot(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(REDUCED_MOTION_QUERY).matches)
}

const TMDB_GENRES: Record<number, string> = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',
  18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',
  9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',
  10752:'War',37:'Western',10759:'Action & Adventure',10762:'Kids',10763:'News',
  10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics',
}

const localProgressIndexes = new WeakMap<Map<string, WatchProgress>, Map<string, number>>()
const posterAmbientColorCache = new Map<string, Promise<AmbientColor | null>>()

function getPosterAmbientColor(url: string): Promise<AmbientColor | null> {
  const cached = posterAmbientColorCache.get(url)
  if (cached) return cached
  // Match the fade to the image directly behind the captions. Sampling the
  // whole poster lets a bright title image at the top dictate the color at
  // the bottom (for example, orange fire over a blue lower scene).
  const request = loadAmbientColor(cachedImage(url), undefined, 'poster-bottom')
  posterAmbientColorCache.set(url, request)
  while (posterAmbientColorCache.size > 300) posterAmbientColorCache.delete(posterAmbientColorCache.keys().next().value!)
  return request
}

function useStalledArtwork(url?: string) {
  const cleanupRef = useRef<(() => void) | undefined>(undefined)
  return useCallback((image: HTMLImageElement | null) => {
    cleanupRef.current?.()
    // When a card resolves new artwork, keep the slot's existing surface as a
    // placeholder until that exact image has decoded instead of flashing the
    // unloaded image element into view. Ref callbacks change with `url`, so a
    // reused card resets this state whenever its artwork source changes.
    if (image?.classList.contains('media-card-artwork')) {
      image.dataset.artworkLoaded = String(image.complete && image.naturalWidth > 0)
    }
    cleanupRef.current = image ? watchStalledImage(image, url) : undefined
  }, [url])
}

function revealLoadedArtwork(event: React.SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.dataset.artworkLoaded = 'true'
}

function formatPosterTimeLeft(seconds: number): string {
  const minutes = Math.max(0, Math.ceil(seconds / 60))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function getLocalProgressIndex(entries: Map<string, WatchProgress>): Map<string, number> {
  const cached = localProgressIndexes.get(entries)
  if (cached) return cached
  const index = new Map<string, number>()
  for (const [key, progress] of entries) {
    if (progress.completed || progress.durationSeconds <= 0) continue
    const type = progress.mediaType === 'movie' ? 'movie' : 'series'
    const pct = (progress.progressSeconds / progress.durationSeconds) * 100
    const suffix = progress.season != null && progress.episode != null ? `:${progress.season}:${progress.episode}` : ''
    const identifiers = [key, progress.id, progress.mediaId, progress.imdbId, progress.tmdbId,
      progress.tmdbId != null ? `tmdb-${progress.tmdbId}` : undefined]
    for (const identifier of identifiers) {
      if (identifier == null) continue
      const value = String(identifier)
      for (const alias of suffix && value.endsWith(suffix) ? [value, value.slice(0, -suffix.length)] : [value]) {
        const indexedKey = `${type}:${alias}`
        index.set(indexedKey, Math.max(index.get(indexedKey) ?? 0, pct))
      }
    }
    if (progress.title) {
      const title = progress.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      if (title) {
        const titleKey = `title:${type}:${title}`
        index.set(titleKey, Math.max(index.get(titleKey) ?? 0, pct))
      }
    }
  }
  localProgressIndexes.set(entries, index)
  return index
}

function progressIdAliases(ids: Array<string | number | null | undefined>): string[] {
  const aliases = new Set<string>()
  for (const id of ids) {
    if (id == null) continue
    const value = String(id).trim()
    if (!value) continue
    aliases.add(value)
  }
  return [...aliases]
}

interface MediaCardProps {
  item: SearchResult
  cardIndex?: number
  layout?: 'poster' | 'ranked' | 'feature' | 'landscape'
  disableArtOverride?: boolean
  disableTrailerPreview?: boolean
  /** Keep non-library catalog cards from being recorded as a playback visit. */
  recordRecentlyWatched?: boolean
  /** Resolve poster artwork and enabled overlays before a mobile Home row is reached. */
  preloadComposition?: boolean
  rank?: number
  onFocusItem?: (item: SearchResult, cardIndex?: number) => void
  onUnfocusItem?: (item: SearchResult, cardIndex?: number) => void
  cinematicMode?: boolean
  cinematicFocused?: boolean
  /** Set false to keep cinematic cards at poster size (no landscape expansion on focus). */
  cinematicExpand?: boolean
  /** Fit special layouts into the fixed-home shelf rather than the page flow. */
  fixedHome?: boolean
  /** Optional entrance delay used by Discovery's staggered editorial grids. */
  style?: React.CSSProperties
}

function MediaCard({ item, cardIndex, layout = 'poster', disableArtOverride = false, disableTrailerPreview = false, recordRecentlyWatched = true, preloadComposition = false, rank, onFocusItem, onUnfocusItem, cinematicMode = false, cinematicFocused = false, cinematicExpand = true, fixedHome = false, style }: MediaCardProps) {
  const cardRef = useRef<HTMLButtonElement>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const hoverRequestRef = useRef(0)
  const mouseFollowFrameRef = useRef<number | null>(null)
  const mouseFollowPointerRef = useRef<{ card: HTMLButtonElement; x: number; y: number } | null>(null)
  // Warm Home poster composition alongside the deferred row preloader. A short
  // observer margin left cards black while scrolling because textless artwork,
  // separate logos, watch details, and browser image decoding all started too
  // close to the viewport on mobile.
  const isVisible = useVisibilityOnce(cardRef, { eager: preloadComposition, rootMargin: '1400px' })
  // Resolve the app's poster artwork before the card enters view. The regular
  // visibility gate remains tight so provider metadata avoids fanning out during scroll.
  const [hoverTrailer, setHoverTrailer] = useState<TrailerSource | null>(null)
  const [hoverPreviewOpen, setHoverPreviewOpen] = useState(false)
  const [nativeTrailerVisible, setNativeTrailerVisible] = useState(false)
  const [suppressPosterHover, setSuppressPosterHover] = useState(false)
  const [reducedMotion] = useState(getReducedMotionSnapshot)
  const [seriesCompleted, setSeriesCompleted] = useState(false)
  const [posterProviderWatched, setPosterProviderWatched] = useState(false)
  const [posterWatchedStatusResolved, setPosterWatchedStatusResolved] = useState(false)
  const [posterProgressResolved, setPosterProgressResolved] = useState(false)
  const [posterAmbientColor, setPosterAmbientColor] = useState<AmbientColor | null>(null)
  const [posterAmbientColorKey, setPosterAmbientColorKey] = useState<string>()

  const navigate = useNavigate()
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(new Set())
  const [resolvedBackdrop, setResolvedBackdrop] = useState<string | undefined>(undefined)
  const [resolvedPoster, setResolvedPoster] = useState<string | undefined>(undefined)
  const [resolvedLogo, setResolvedLogo] = useState<string | undefined>(undefined)
  const [cleanTmdbPoster, setCleanTmdbPoster] = useState<string | undefined>(undefined)
  const [cleanTmdbLogo, setCleanTmdbLogo] = useState<string | undefined>(undefined)
  const [resolvedCustomArt, setResolvedCustomArt] = useState<{ poster?: string; backdrop?: string; logo?: string }>({})
  const [serverEpisodeSummary, setServerEpisodeSummary] = useState<PosterEpisodeSummary | undefined>(undefined)
  const [serverEpisodeSummaryResolved, setServerEpisodeSummaryResolved] = useState(false)
  const [providerEpisodeSummary, setProviderEpisodeSummary] = useState<ProviderWatchedEpisodeSummary | undefined>(undefined)
  const [providerEpisodeSummaryResolved, setProviderEpisodeSummaryResolved] = useState(false)
  const [resolvedGenre, setResolvedGenre] = useState<string | undefined>(undefined)
  const [loadedPosterArtworkUrl, setLoadedPosterArtworkUrl] = useState('')
  const [loadedPosterLogoUrl, setLoadedPosterLogoUrl] = useState('')
  const [resolvedCleanPosterKey, setResolvedCleanPosterKey] = useState('')
  const [resolvedProviderArtworkKey, setResolvedProviderArtworkKey] = useState('')
  // Provider artwork is enrichment, not a prerequisite for a usable card.
  // This becomes true on deliberate focus/hover, so a shelf of already
  // artwork-rich catalog items does not fan out into dozens of requests.
  const [detailIntent, setDetailIntent] = useState(false)
  const posterSize = useAppStore((s) => s.posterSize)
  const homeCardAnimations = useAppStore((s) => s.homeCardAnimations) && !isMobileWebViewport()
  const compactSpecialLayouts = useAppStore((s) => s.interfaceTheme) === 'default'
  const showRatingsOnCards = useAppStore((s) => s.showRatingsOnCards)
  const showGenreOnCards = useAppStore((s) => s.showGenreOnCards)
  const posterTrailerPreviews = useAppStore((s) => s.posterTrailerPreviews)
  const posterTrailerHoverDelayMs = useAppStore((s) => s.posterTrailerHoverDelayMs)
  const posterTrailerSound = useAppStore((s) => s.posterTrailerSound)
  const preferredAudio = useAppStore((s) => s.preferredAudio)
  const preferredSubtitles = useAppStore((s) => s.preferredSubtitles)
  const artProviders = useAppStore((s) => s.artProviders)
  const fanartApiKey = useAppStore((s) => s.fanartApiKey)
  const customArtUrls = useAppStore((s) => s.customArtUrls)
  const posterOverlay = useAppStore((s) => s.posterOverlay)
  const primaryProgressProvider = useAppStore((s) => s.primaryProgressProvider)
  const posterWatchedSourceFlags = useAppStore((s) => [s.traktConnected, s.simklConnected, Boolean(s.pmdbApiKey), Boolean(s.mdblistApiKey || localStorage.getItem('mdblist_oauth_tokens')), s.anilistConnected].map(Number).join(''))
  const connectedPosterWatchedSources = useMemo(() => [
    'local',
    ...(posterWatchedSourceFlags[0] === '1' ? ['trakt'] : []),
    ...(posterWatchedSourceFlags[1] === '1' ? ['simkl'] : []),
    ...(posterWatchedSourceFlags[2] === '1' ? ['pmdb'] : []),
    ...(posterWatchedSourceFlags[3] === '1' ? ['mdblist'] : []),
    ...(posterWatchedSourceFlags[4] === '1' ? ['anilist'] : []),
  ] as import('../services/watchedStatus').WatchedSource[], [posterWatchedSourceFlags])
  const posterWatchedSources = useMemo(() => primaryProgressProvider === 'all'
    ? connectedPosterWatchedSources
    : [primaryProgressProvider] as import('../services/watchedStatus').WatchedSource[], [primaryProgressProvider, connectedPosterWatchedSources])
  const localWatchDataEnabled = posterWatchedSources.includes('local')
  const posterProgressConnections = `${primaryProgressProvider}:${posterWatchedSources.join('|')}`
  const allServiceProgress = useSyncExternalStore(subscribePosterProgress, getPosterProgressSnapshot, getPosterProgressSnapshot)
  const allServiceTimeLeft = useSyncExternalStore(subscribePosterProgress, getPosterTimeLeftSnapshot, getPosterTimeLeftSnapshot)
  const appManagedMetadata = useAppStore((s) => s.appManagedMetadata)
  const addRecentlyWatched = useAppStore((s) => s.addRecentlyWatched)
  const artProviderKey = useMemo(() => JSON.stringify(artProviders), [artProviders])
  const customArtKey = useMemo(() => JSON.stringify(customArtUrls), [customArtUrls])
  // Search-result artwork reads provider settings from the store. Keep its
  // derived object stable across ordinary card renders, but refresh it when
  // either the source item or artwork settings change.
  const displayItem = useMemo(
    () => disableArtOverride ? item : applySearchResultArt(item),
    // The helper reads artwork settings from the store, so its fingerprint is a deliberate dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disableArtOverride, item, customArtKey],
  )
  const isLocalFavorite = useSyncExternalStore(
    subscribeLocalWatchlist,
    () => isInLocalWatchlist(displayItem),
    () => false,
  )
  const initialArtItem = useMemo(
    () => disableArtOverride
      ? displayItem
      : applyInitialArtworkPreference(displayItem, displayItem.type, Boolean(displayItem.isAnime)),
    [disableArtOverride, displayItem],
  )
  const customArt = useMemo(
    () => disableArtOverride ? {} : getSearchResultCustomArt(item),
    // The helper reads these store settings directly; this fingerprint keeps the memo in sync with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disableArtOverride, item, customArtKey],
  )
  const customPosterNeedsImdbId = customArtUrls.posterUrl.includes('{imdb_id}')
  const posterAssetKey = useMemo(() => JSON.stringify([
    displayItem.id, displayItem.tmdbId, displayItem.imdbId, displayItem.type, displayItem.provider,
    displayItem.sourceConnectionId, displayItem.sourceItemId,
    layout, posterOverlay.enabled, posterOverlay.artwork, appManagedMetadata,
    artProviderKey, fanartApiKey, customArtKey,
    initialArtItem.poster, initialArtItem.backdrop, initialArtItem.logo,
  ]), [appManagedMetadata, artProviderKey, customArtKey, displayItem.id, displayItem.imdbId,
    displayItem.provider, displayItem.sourceConnectionId, displayItem.sourceItemId,
    displayItem.tmdbId, displayItem.type, fanartApiKey, initialArtItem.backdrop,
    initialArtItem.logo, initialArtItem.poster, layout, posterOverlay.artwork, posterOverlay.enabled])
  useEffect(() => {
    setFailedImageUrls(new Set())
  }, [posterAssetKey])
  const trailerLanguage = preferredAudio[0] || preferredSubtitles[0] || 'en'

  const announceFocus = () => {
    if (displayItem.type === 'movie') {
      void import('../pages/MovieDetailPage')
    } else {
      void import('../pages/SeriesDetailPage')
    }
    const focusedItem = {
      ...displayItem,
      poster: posterUrl || initialArtItem.poster,
      backdrop: backdropUrl || initialArtItem.backdrop,
      logo: logoUrl || initialArtItem.logo,
    }
    onFocusItem?.(focusedItem, cardIndex)
    window.dispatchEvent(new CustomEvent<SearchResult>('aurales:media-focus', { detail: focusedItem }))
  }

  useEffect(() => {
    const needsPosterProgress = posterOverlay.enabled && (posterOverlay.showProgress || posterOverlay.showTimeLeft)
    if (!needsPosterProgress || !isVisible) {
      setPosterProgressResolved(!needsPosterProgress)
      if (isVisible) ensurePosterProgress()
      return
    }
    let cancelled = false
    setPosterProgressResolved(false)
    void ensurePosterProgress().finally(() => {
      if (!cancelled) setPosterProgressResolved(true)
    })
    return () => { cancelled = true }
  }, [isVisible, posterProgressConnections, posterOverlay.enabled, posterOverlay.showProgress, posterOverlay.showTimeLeft])

  const mouseFollowEnabled = !homeCardAnimations && !reducedMotion
  const handleMouseFollow = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!mouseFollowEnabled) return
    mouseFollowPointerRef.current = { card: event.currentTarget, x: event.clientX, y: event.clientY }
    if (mouseFollowFrameRef.current) return
    mouseFollowFrameRef.current = window.requestAnimationFrame(() => {
      mouseFollowFrameRef.current = null
      const pointer = mouseFollowPointerRef.current
      if (!pointer) return
      const bounds = pointer.card.getBoundingClientRect()
      const horizontal = ((pointer.x - bounds.left) / bounds.width - 0.5) * 2
      const vertical = ((pointer.y - bounds.top) / bounds.height - 0.5) * 2
      pointer.card.style.setProperty('--mouse-card-tilt-x', `${(-vertical * 2).toFixed(2)}deg`)
      pointer.card.style.setProperty('--mouse-card-tilt-y', `${(horizontal * 2).toFixed(2)}deg`)
      pointer.card.style.setProperty('--mouse-card-shift-x', `${(horizontal * 1.5).toFixed(1)}px`)
      pointer.card.style.setProperty('--mouse-card-shift-y', `${(vertical * 1).toFixed(1)}px`)
    })
  }
  const resetMouseFollow = (card: HTMLButtonElement) => {
    mouseFollowPointerRef.current = null
    if (mouseFollowFrameRef.current) window.cancelAnimationFrame(mouseFollowFrameRef.current)
    mouseFollowFrameRef.current = null
    card.style.removeProperty('--mouse-card-tilt-x')
    card.style.removeProperty('--mouse-card-tilt-y')
    card.style.removeProperty('--mouse-card-shift-x')
    card.style.removeProperty('--mouse-card-shift-y')
  }

  const completedIds = useAppStore((s) => s.completedIds)
  const providerWatchedKeys = useWatchedCacheStore((s) => s.watchedKeys)
  const jellyfinWatchedKeys = useWatchedCacheStore((s) => s.jellyfinWatchedKeys)
  const isWatchedFromCache = useWatchedCacheStore((s) => s.isWatched)

  const localProgressPct = useAppStore((s) => {
    if (!localWatchDataEnabled) return null
    const index = getLocalProgressIndex(s.watchProgress)
    const type = item.type === 'movie' ? 'movie' : 'series'
    let pct: number | null = null
    for (const key of [item.id, item.imdbId, item.tmdbId, item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined]) {
      if (key == null) continue
      const match = index.get(`${type}:${key}`)
      if (match != null) pct = Math.max(pct ?? 0, match)
    }
    const title = item.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const titlePct = index.get(`title:${type}:${title}`)
    if (titlePct != null) pct = Math.max(pct ?? 0, titlePct)
    return pct
  })
  const posterWatchProgress = useAppStore((s) => s.watchProgress)
  const localPosterPlayback = useMemo(() => {
    if (!localWatchDataEnabled) return { remainingSeconds: undefined, watchedEpisodes: 0 }
    const normalizedTitle = item.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const ids = new Set([item.id, item.imdbId, item.tmdbId, item.tvdbId, item.sourceItemId,
      item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined].filter((value) => value != null).map(String))
    let playback: WatchProgress | undefined
    const watchedEpisodes = new Set<string>()
    for (const [key, entry] of posterWatchProgress) {
      if ((entry.mediaType === 'movie' ? 'movie' : 'series') !== item.type) continue
      const entryTitle = entry.title?.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      const aliases = [key, entry.id, entry.mediaId, entry.imdbId, entry.tmdbId, entry.tmdbId != null ? `tmdb-${entry.tmdbId}` : undefined].filter((value) => value != null).map(String)
      const matches = aliases.some((alias) => ids.has(alias) || [...ids].some((id) => alias.startsWith(`${id}:`)))
        || Boolean(normalizedTitle && entryTitle === normalizedTitle)
      if (!matches) continue
      if (entry.season != null && entry.episode != null && entry.completed) watchedEpisodes.add(`${entry.season}:${entry.episode}`)
      if (!entry.completed && entry.durationSeconds > 0 && (!playback || (entry.updatedAt || '') > (playback.updatedAt || ''))) playback = entry
    }
    return { remainingSeconds: playback ? Math.max(0, playback.durationSeconds - playback.progressSeconds) : undefined, watchedEpisodes: watchedEpisodes.size }
  }, [item.id, item.imdbId, item.tmdbId, item.tvdbId, item.sourceItemId, item.title, item.type, posterWatchProgress, localWatchDataEnabled])
  const serverRawItem = (item as SearchResult & { raw?: Record<string, unknown> }).raw
  const serverUserData = serverRawItem?.UserData && typeof serverRawItem.UserData === 'object'
    ? serverRawItem.UserData as Record<string, unknown>
    : undefined
  const isFavorite = isLocalFavorite || serverUserData?.IsFavorite === true
  const serverRuntimeTicks = Number(serverRawItem?.RunTimeTicks)
  const serverPositionTicks = Number(serverUserData?.PlaybackPositionTicks)
  const jellyfinProgressPct = localWatchDataEnabled && Number.isFinite(serverRuntimeTicks) && serverRuntimeTicks > 0 && Number.isFinite(serverPositionTicks) && serverPositionTicks > 0
    ? Math.min(100, serverPositionTicks / serverRuntimeTicks * 100)
    : null
  const jellyfinTimeLeftSeconds = jellyfinProgressPct != null ? Math.max(0, (serverRuntimeTicks - serverPositionTicks) / 10_000_000) : undefined
  const continueWatchingProgressPct = useAppStore((s) => {
    const progress = s.continueWatchingProgress
    const normalizedTitle = item.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const titleProgress = progress.get(`title:${item.type}:${normalizedTitle}`) ?? progress.get(`title:${normalizedTitle}`)
    if (titleProgress != null) return titleProgress
    for (const key of progressIdAliases([item.id, item.imdbId, item.tmdbId, item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined,
      item.malId != null ? `mal-${item.malId}` : undefined,
      item.anilistId != null ? `anilist-${item.anilistId}` : undefined])) {
      const pct = progress.get(`${item.type}:${key}`) ?? progress.get(key)
      if (pct != null) return pct
    }
    return null
  })

  const ratingStr = useMemo(() => {
    if (!displayItem.rating) return null
    const n = Number(displayItem.rating)
    if (isNaN(n)) return null
    const formatted = new Intl.NumberFormat(navigator.language, { minimumFractionDigits: n % 1 === 0 ? 0 : 1, maximumFractionDigits: 1 }).format(n)
    return formatted.replace(/\/10$/, '').trim()
  }, [displayItem.rating])
  const landscapeGenre = useMemo(() => {
    const rawGenre = displayItem.genres?.[0]
      || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : undefined)
      || resolvedGenre
    return typeof rawGenre === 'object' && rawGenre
      ? (rawGenre as { name?: string; title?: string }).name || (rawGenre as { title?: string }).title
      : rawGenre
  }, [displayItem.genreIds, displayItem.genres, resolvedGenre])

  const getDisplayProvider = (item: SearchResult) => {
    let provider: string | undefined
    if (item.provider === 'addon') {
      const genres = item.genres?.map((g) => g.toLowerCase()) || []
      const isAnime = item.isAnime ||
                      /^(mal|anilist)[-:]/i.test(item.id) ||
                      genres.includes('anime') ||
                      ((item.genreIds?.includes(16) || genres.includes('animation')) && ['ja', 'zh', 'ko'].includes(item.originalLanguage || ''))
      if (isAnime) {
        provider = useAppStore.getState().animeMetadataSource ?? 'tvdb'
      } else if (item.type === 'movie') {
        provider = useAppStore.getState().movieMetadataSource ?? 'tmdb'
      } else {
        provider = useAppStore.getState().seriesMetadataSource ?? 'tmdb'
      }
    } else {
      provider = item.provider
    }

    // TMDB and TVDB are metadata backends, not viewer-facing catalog labels.
    // Keep them visible during development for diagnostics, but omit them from
    // release cards without changing the underlying source/ID resolution.
    return import.meta.env.PROD && /^(tmdb|tvdb)$/i.test(provider || '') ? null : provider
  }

  const widthClass = useMemo(() => {
    if (layout === 'feature') {
      if (fixedHome) return 'w-[calc(var(--fixed-cinematic-card-height)*0.8)]'
      if (compactSpecialLayouts) {
        switch (posterSize) {
          case 'compact': return 'w-[200px]'
          case 'large': return 'w-[280px]'
          case 'huge': return 'w-[330px]'
          default: return 'w-[240px]'
        }
      }
      switch (posterSize) {
        case 'compact': return 'w-[260px]'
        case 'large': return 'w-[360px]'
        case 'huge': return 'w-[420px]'
        case 'default':
        default:
          return 'w-[320px]'
      }
    }
    if (layout === 'ranked') {
      if (fixedHome) return 'w-[calc(var(--fixed-cinematic-card-height)*0.97)]'
      if (compactSpecialLayouts) {
        switch (posterSize) {
          case 'compact': return 'w-[227px]'
          case 'large': return 'w-[319px]'
          case 'huge': return 'w-[362px]'
          default: return 'w-[271px]'
        }
      }
      switch (posterSize) {
        case 'compact': return 'w-[255px]'
        case 'large': return 'w-[380px]'
        case 'huge': return 'w-[435px]'
        case 'default':
        default:
          return 'w-[320px]'
      }
    }
    if (layout === 'landscape') {
      switch (posterSize) {
        case 'compact': return 'w-[240px]'
        case 'large': return 'w-[320px]'
        case 'huge': return 'w-[384px]'
        case 'default':
        default:
          return 'w-[288px]'
      }
    } else {
      switch (posterSize) {
        case 'compact': return 'w-[112px]'
        case 'large': return 'w-[176px]'
        case 'huge': return 'w-[208px]'
        case 'default':
        default:
          return 'w-[144px]'
      }
    }
  }, [compactSpecialLayouts, fixedHome, layout, posterSize])

  const expandedPosterWidthClass = useMemo(() => {
    switch (posterSize) {
      case 'compact': return 'w-[299px]'
      case 'large': return 'w-[469px]'
      case 'huge': return 'w-[555px]'
      case 'default':
      default:
        return 'w-[384px]'
    }
  }, [posterSize])

  const expandedPosterHeightClass = useMemo(() => {
    switch (posterSize) {
      case 'compact': return 'h-[168px]'
      case 'large': return 'h-[264px]'
      case 'huge': return 'h-[312px]'
      case 'default':
      default:
        return 'h-[216px]'
    }
  }, [posterSize])

  const posterSlotHeightClass = useMemo(() => {
    switch (posterSize) {
      case 'compact': return 'h-[214px]'
      case 'large': return 'h-[310px]'
      case 'huge': return 'h-[358px]'
      case 'default':
      default:
        return 'h-[262px]'
    }
  }, [posterSize])

  const expandedTrailerSlotHeightClass = useMemo(() => {
    switch (posterSize) {
      case 'compact': return 'h-[292px]'
      case 'large': return 'h-[390px]'
      case 'huge': return 'h-[438px]'
      case 'default':
      default:
        return 'h-[342px]'
    }
  }, [posterSize])

  const isSeriesCard = displayItem.type === 'series' && displayItem.season == null
  const isCompleted = isSeriesCard ? seriesCompleted : posterProviderWatched
  const allServiceProgressPct = progressIdAliases([item.id, item.imdbId, item.tmdbId, item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined,
    item.anilistId != null ? `anilist-${item.anilistId}` : undefined,
    item.malId != null ? `mal-${item.malId}` : undefined])
    .reduce<number | null>((pct, id) => {
      if (id == null) return pct
      const match = allServiceProgress.get(`${item.type}:${id}`)
      return match == null ? pct : Math.max(pct ?? 0, match)
    }, null)
  const normalizedTitle = item.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const allServiceTitleProgressPct = allServiceProgress.get(`title:${item.type}:${normalizedTitle}`)
    ?? null
  const allServiceTimeLeftSeconds = (() => {
    let match = allServiceTimeLeft.get(`title:${item.type}:${normalizedTitle}`)
    for (const id of progressIdAliases([item.id, item.imdbId, item.tmdbId, item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined,
      item.anilistId != null ? `anilist-${item.anilistId}` : undefined,
      item.malId != null ? `mal-${item.malId}` : undefined])) {
      const candidate = allServiceTimeLeft.get(`${item.type}:${id}`)
      if (candidate && (!match || candidate.pct > match.pct)) match = candidate
    }
    return match?.remainingSeconds
  })()
  const posterTimeLeftSeconds = localPosterPlayback.remainingSeconds
    ?? (localWatchDataEnabled ? jellyfinTimeLeftSeconds : undefined)
    ?? allServiceTimeLeftSeconds
  // posterProgress is scoped to primaryProgressProvider, so it is the selected
  // source's data for both the single-provider and combined modes.
  const progressPct = [localProgressPct, continueWatchingProgressPct, allServiceProgressPct, allServiceTitleProgressPct, jellyfinProgressPct]
    .reduce<number | null>((pct, value) => value == null ? pct : Math.max(pct ?? 0, value), null)
  const catalogEpisodeTotal = Array.isArray(displayItem.addonMeta?.videos)
    ? (displayItem.addonMeta?.videos as unknown[]).length
    : (typeof displayItem.addonMeta?.totalEpisodesCount === 'number' ? displayItem.addonMeta.totalEpisodesCount : undefined)
  const rawPosterEpisodeWatched = Math.max(
    localWatchDataEnabled ? serverEpisodeSummary?.watched || 0 : 0,
    localWatchDataEnabled ? localPosterPlayback.watchedEpisodes : 0,
    providerEpisodeSummary?.watched || 0,
  )
  const jellyfinEpisodeTotal = localWatchDataEnabled && displayItem.provider === 'jellyfin'
    && Number(serverEpisodeSummary?.total) > 0 ? serverEpisodeSummary?.total : undefined
  const providerEpisodeTotal = Number(providerEpisodeSummary?.total) > 0 ? providerEpisodeSummary?.total : undefined
  const serverEpisodeTotal = localWatchDataEnabled && Number(serverEpisodeSummary?.total) > 0
    ? serverEpisodeSummary?.total : undefined
  // Keep watched count and total aligned to a single authoritative catalog.
  // Jellyfin cards use the library's own total; other cards prefer the
  // selected watch provider, then fall back to server/catalog metadata.
  const posterEpisodeTotal = jellyfinEpisodeTotal ?? providerEpisodeTotal ?? serverEpisodeTotal ?? catalogEpisodeTotal
  const posterEpisodeWatched = posterEpisodeTotal != null
    ? Math.min(rawPosterEpisodeWatched, posterEpisodeTotal)
    : rawPosterEpisodeWatched
  const posterNextEpisode = providerEpisodeSummary
    && providerEpisodeSummary.watched > (serverEpisodeSummary?.watched ?? -1)
    ? providerEpisodeSummary.nextEpisode || serverEpisodeSummary?.nextEpisode
    : serverEpisodeSummary?.nextEpisode || providerEpisodeSummary?.nextEpisode
  const posterProgressPct = posterOverlay.enabled && posterOverlay.showProgress && posterOverlay.splitEpisodeProgress && displayItem.type === 'series' && posterEpisodeTotal
    ? Math.round(Math.min(100, posterEpisodeWatched / posterEpisodeTotal * 100))
    : progressPct
  const posterEpisodeSegmentCount = getPosterEpisodeSegmentCount(posterEpisodeTotal)
  const posterEpisodeSegmentFill = posterEpisodeTotal && posterEpisodeSegmentCount > 0
    ? Math.max(0, Math.min(posterEpisodeSegmentCount, posterEpisodeWatched / posterEpisodeTotal * posterEpisodeSegmentCount))
    : 0
  const showEpisodeProgress = posterOverlay.enabled && posterOverlay.showProgress && posterOverlay.splitEpisodeProgress
    && displayItem.type === 'series' && posterEpisodeTotal != null && posterEpisodeTotal > 0 && posterEpisodeWatched > 0
  const posterCertificationKey = `${displayItem.type}:${displayItem.tmdbId || displayItem.id}`
  const [resolvedPosterCertification, setResolvedPosterCertification] = useState<{ key: string; value?: string }>()
  const serverCertification = displayItem.certification || (typeof serverRawItem?.OfficialRating === 'string' ? serverRawItem.OfficialRating : undefined)
  useEffect(() => {
    if (!posterOverlay.enabled || !posterOverlay.showCertification || serverCertification || !isVisible) return
    let cancelled = false
    ;(async () => {
      const { resolveTmdbIdFromExternalIds } = await import('../services/metadataEnrich')
      const tmdbId = await resolveTmdbIdFromExternalIds(displayItem, displayItem.type)
      if (!tmdbId || cancelled) {
        if (!cancelled) setResolvedPosterCertification({ key: posterCertificationKey })
        return
      }
      const certification = await getTmdbCertification(displayItem.type, tmdbId)
      if (!cancelled) setResolvedPosterCertification({ key: posterCertificationKey, value: certification })
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [displayItem.id, displayItem.imdbId, displayItem.tmdbId, displayItem.tvdbId, displayItem.anilistId, displayItem.malId, displayItem.type, isVisible, posterOverlay.enabled, posterOverlay.showCertification, posterCertificationKey, serverCertification])
  const posterCertification = serverCertification || (resolvedPosterCertification?.key === posterCertificationKey ? resolvedPosterCertification.value : undefined)
  // Resume progress is independent of the watched-checkmark preference. A
  // disabled checkmark overlay must not hide Continue Watching on Home rows.
  const showPosterProgress = progressPct != null && progressPct > 2
    && (!posterOverlay.enabled || posterOverlay.showProgress)
  const showOverlayProgress = showPosterProgress || showEpisodeProgress
  const posterIsWatched = posterOverlay.enabled && posterOverlay.showWatched && isCompleted && !showPosterProgress
  const posterWatchBadge = posterIsWatched && (posterOverlay.style !== 'line' || posterOverlay.showAsCheckmark) ? (
    <span className={`inline-flex shrink-0 items-center justify-center gap-1 text-white drop-shadow-md ${posterOverlay.style === 'tag' ? 'text-[10px] font-semibold' : posterOverlay.style === 'badge' ? 'rounded-full border border-white/80 px-1.5 py-0.5 text-[10px] font-semibold' : ''}`} aria-label="Watched" title="Watched">
      {posterOverlay.showAsCheckmark && (posterOverlay.style === 'symbol'
        ? <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="white" /><path d="m7.5 12.2 3 3L17 8.8" fill="none" stroke="#111" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="m8 12 2.5 2.5L16.5 9" strokeLinecap="round" strokeLinejoin="round" /></svg>)}
      {!posterOverlay.showAsCheckmark && posterOverlay.style === 'symbol' && <svg className="h-3.5 w-3.5 sm:h-4 sm:w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /></svg>}
      {posterOverlay.style !== 'symbol' && <span className={`${posterOverlay.showAsCheckmark ? 'hidden sm:inline' : ''} ${posterOverlay.progressPlacement === 'around-status' && showOverlayProgress ? 'hidden' : ''}`}>Watched</span>}
    </span>
  ) : null
  const posterWatchedLine = posterIsWatched && posterOverlay.style === 'line'
    && !(posterOverlay.showProgress && posterOverlay.progressPlacement === 'along-bottom' && showOverlayProgress)
    ? <span className="pointer-events-none absolute inset-x-0 bottom-0 z-40 h-[3px] bg-white" aria-label="Watched" title="Watched" />
    : null
  const rawPosterGenre = displayItem.genres?.[0]
    || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : undefined)
    || resolvedGenre
  const posterFooterGenre = typeof rawPosterGenre === 'object' && rawPosterGenre
    ? (rawPosterGenre as { name?: string; title?: string }).name || (rawPosterGenre as { title?: string }).title
    : rawPosterGenre
  const posterVisibleDetails = getPosterVisibleDetails({
    genre: posterOverlay.showGenre && Boolean(posterFooterGenre),
    rating: posterOverlay.showRating && Boolean(ratingStr),
    ageRating: posterOverlay.showCertification && Boolean(posterCertification),
  })
  const posterFooterVisible = posterOverlay.enabled && (
    Boolean(posterVisibleDetails.rating && ratingStr)
    || Boolean(posterVisibleDetails.genre && posterFooterGenre)
    || Boolean(posterVisibleDetails.ageRating && posterCertification)
    || Boolean(posterWatchBadge)
    || Boolean(posterOverlay.progressPlacement === 'around-status' && posterOverlay.showProgress && showOverlayProgress)
    || Boolean(posterOverlay.showFavorite && isFavorite)
  )
  const posterFooterStatus = posterOverlay.progressPlacement === 'around-status' && posterOverlay.showProgress && showOverlayProgress
    ? <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center sm:h-7 sm:w-7">
      {posterWatchBadge || <svg className="h-3 w-3 text-white drop-shadow sm:h-4 sm:w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="In progress"><circle cx="12" cy="12" r="9.5" /><path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none" /></svg>}
      <svg className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="2.5" /><circle cx="18" cy="18" r="15" fill="none" stroke="#fff" strokeWidth="2.5" strokeDasharray={`${94.25 * Math.min(posterProgressPct || 0, 100) / 100} 94.25`} strokeLinecap="round" /></svg>
    </span>
    : posterWatchBadge
  const posterProgressRing = posterOverlay.enabled && posterOverlay.showProgress && posterOverlay.progressPlacement === 'around-status' && showOverlayProgress && !posterFooterStatus
    ? <svg className="absolute right-1 top-1 z-20 h-9 w-9 -rotate-90 drop-shadow" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.45)" strokeWidth="2.5" /><circle cx="18" cy="18" r="15" fill="none" stroke="#fff" strokeWidth="2.5" strokeDasharray={`${94.25 * Math.min(posterProgressPct || 0, 100) / 100} 94.25`} strokeLinecap="round" /></svg>
    : null
  const posterProgressUnderDetails = posterOverlay.enabled && posterOverlay.showProgress && posterOverlay.progressPlacement === 'under-details' && showOverlayProgress
    ? <div className="relative h-[3px] w-8 overflow-hidden rounded-full bg-white/40" role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(posterProgressPct || 0, 100))}><div className="h-full bg-white" style={{ width: `${Math.min(posterProgressPct || 0, 100)}%` }} /></div>
    : null
  const posterFooter = posterFooterVisible ? (
    <PosterFooterCaption
      alignment={posterOverlay.contentAlignment}
      className="relative text-[11px] font-semibold sm:text-[13px]"
      status={posterFooterStatus}
      favorite={posterOverlay.showFavorite && isFavorite ? <span className="text-sm" aria-label="Favorite" title="Favorite">♥</span> : undefined}
      genre={posterVisibleDetails.genre ? posterFooterGenre : undefined}
      ageRating={posterVisibleDetails.ageRating && posterCertification ? <span className="shrink-0 text-[10px] font-semibold leading-none text-white [text-shadow:0_1px_0_rgba(0,0,0,.85)] sm:text-meta">{posterCertification}</span> : undefined}
      showSeparator={!posterWatchBadge && !posterFooterStatus}
      rating={posterVisibleDetails.rating && ratingStr ? <><svg className="h-3 w-3 shrink-0 fill-current sm:h-3.5 sm:w-3.5" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</> : undefined}
    />
  ) : null
  const posterDetailsVisible = posterOverlay.enabled && (
    (posterOverlay.showTimeLeft && posterTimeLeftSeconds != null)
    || (posterOverlay.showEpisodes && displayItem.type === 'series' && (posterEpisodeTotal != null || posterEpisodeWatched > 0))
    || (posterOverlay.showEpisodesWatched && displayItem.type === 'series' && (posterEpisodeTotal != null || posterEpisodeWatched > 0))
    || (posterOverlay.showNextEpisode && Boolean(posterNextEpisode))
  )
  const posterDetailsBadges = posterDetailsVisible ? (
    <div className={`absolute inset-x-2 top-2 z-20 flex flex-wrap gap-1 ${posterOverlay.contentAlignment === 'left' ? 'justify-start' : posterOverlay.contentAlignment === 'right' ? 'justify-end' : 'justify-center'}`}>
      {posterOverlay.showTimeLeft && posterTimeLeftSeconds != null && <span className="whitespace-nowrap rounded-md bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow backdrop-blur">{formatPosterTimeLeft(posterTimeLeftSeconds)} left</span>}
      {posterOverlay.showEpisodes && displayItem.type === 'series' && (posterEpisodeTotal != null || posterEpisodeWatched > 0) && <span className="whitespace-nowrap rounded-md bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow backdrop-blur">{posterEpisodeTotal != null ? `${Math.max(0, posterEpisodeTotal - posterEpisodeWatched)} episodes left` : `${posterEpisodeWatched} watched`}</span>}
      {posterOverlay.showEpisodesWatched && displayItem.type === 'series' && (posterEpisodeTotal != null || posterEpisodeWatched > 0) && <span className="whitespace-nowrap rounded-md bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow backdrop-blur">{posterEpisodeTotal != null ? `${posterEpisodeWatched}/${posterEpisodeTotal} watched` : `${posterEpisodeWatched} watched`}</span>}
      {posterOverlay.showNextEpisode && posterNextEpisode && <span className="whitespace-nowrap rounded-md bg-black/75 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow backdrop-blur">Next {posterNextEpisode}</span>}
    </div>
  ) : null

  useEffect(() => {
    const needsWatchedStatus = posterOverlay.enabled && posterOverlay.showWatched
    if (!needsWatchedStatus || !isVisible) {
      setSeriesCompleted(false)
      setPosterProviderWatched(false)
      setPosterWatchedStatusResolved(!needsWatchedStatus)
      return
    }
    let cancelled = false
    setPosterWatchedStatusResolved(false)
    // The local source includes Jellyfin's watched cache as well as playback
    // history. Honor it for both the combined source and an explicitly local
    // selection, including cards whose metadata came from TMDB rather than the
    // Jellyfin catalog itself.
    const cachedWatched = localWatchDataEnabled && isWatchedFromCache({
      id: displayItem.id,
      imdbId: displayItem.imdbId,
      tmdbId: displayItem.tmdbId,
      tvdbId: displayItem.tvdbId,
      malId: displayItem.malId,
      anilistId: displayItem.anilistId,
    }, true)
    if ((localWatchDataEnabled && serverUserData?.Played === true) || cachedWatched) {
      setPosterProviderWatched(true)
      setSeriesCompleted(isSeriesCard)
      setPosterWatchedStatusResolved(true)
      return () => { cancelled = true }
    }
    void isWatchedFromProviders(searchResultToLookup(displayItem), posterWatchedSources, useAppStore.getState().watchProgress)
      .then((completed) => {
        if (cancelled) return
        setPosterProviderWatched(completed)
        setSeriesCompleted(isSeriesCard && completed)
      })
      .catch(() => { if (!cancelled) { setPosterProviderWatched(false); setSeriesCompleted(false) } })
      .finally(() => { if (!cancelled) setPosterWatchedStatusResolved(true) })
    return () => { cancelled = true }
  }, [
    isSeriesCard, isVisible, posterOverlay.enabled, posterOverlay.showWatched, posterWatchedSources, completedIds,
    providerWatchedKeys, jellyfinWatchedKeys, isWatchedFromCache,
    displayItem, serverUserData?.Played, localWatchDataEnabled, primaryProgressProvider,
  ])

  useEffect(() => {
    const needsEpisodeSummary = posterOverlay.enabled
      && (posterOverlay.showEpisodes || posterOverlay.showEpisodesWatched || posterOverlay.showNextEpisode || (posterOverlay.showProgress && posterOverlay.splitEpisodeProgress))
    const needsJellyfinSummary = localWatchDataEnabled && isVisible && needsEpisodeSummary && displayItem.type === 'series'
    if (!needsJellyfinSummary) {
      setServerEpisodeSummary(undefined)
      setServerEpisodeSummaryResolved(!needsEpisodeSummary || !isVisible || !localWatchDataEnabled || displayItem.type !== 'series')
      return
    }
    let cancelled = false
    setServerEpisodeSummaryResolved(false)
    const refreshSummary = () => {
      void getJellyfinPosterEpisodeSummaryForMedia(displayItem).then((summary) => {
        if (!cancelled) setServerEpisodeSummary(summary)
      }).catch(() => {
        if (!cancelled) setServerEpisodeSummary(undefined)
      }).finally(() => {
        if (!cancelled) setServerEpisodeSummaryResolved(true)
      })
    }
    refreshSummary()
    window.addEventListener('aurales:server-catalogs-changed', refreshSummary)
    return () => {
      cancelled = true
      window.removeEventListener('aurales:server-catalogs-changed', refreshSummary)
    }
  }, [isVisible, displayItem,
    posterOverlay.enabled, posterOverlay.showEpisodes, posterOverlay.showEpisodesWatched, posterOverlay.showNextEpisode, posterOverlay.showProgress,
    posterOverlay.splitEpisodeProgress, localWatchDataEnabled])

  useEffect(() => {
    const needsEpisodeSummary = posterOverlay.enabled
      && (posterOverlay.showEpisodes || posterOverlay.showEpisodesWatched || posterOverlay.showNextEpisode || (posterOverlay.showProgress && posterOverlay.splitEpisodeProgress))
    const shouldResolveProviderSummary = isVisible && displayItem.type === 'series' && needsEpisodeSummary
      && posterWatchedSources.some((source) => source !== 'local')
    if (!shouldResolveProviderSummary) {
      setProviderEpisodeSummary(undefined)
      setProviderEpisodeSummaryResolved(!needsEpisodeSummary || !isVisible || displayItem.type !== 'series' || !posterWatchedSources.some((source) => source !== 'local'))
      return
    }
    let cancelled = false
    setProviderEpisodeSummaryResolved(false)
    setProviderEpisodeSummary(undefined)
    void getProviderWatchedEpisodeSummary(searchResultToLookup(displayItem), posterWatchedSources).then((summary) => {
      if (!cancelled) setProviderEpisodeSummary(summary)
    }).finally(() => {
      if (!cancelled) setProviderEpisodeSummaryResolved(true)
    })
    return () => { cancelled = true }
  }, [isVisible, displayItem, displayItem.provider,
    posterOverlay.enabled, posterOverlay.showEpisodes, posterOverlay.showEpisodesWatched, posterOverlay.showNextEpisode, posterOverlay.showProgress,
    posterOverlay.splitEpisodeProgress, posterWatchedSources, providerWatchedKeys, jellyfinWatchedKeys])

  useEffect(() => {
    const needsTextlessPoster = posterOverlay.artwork === 'poster'
    if (!isVisible) return
    if (layout !== 'feature' && !needsTextlessPoster) {
      setResolvedCleanPosterKey(posterAssetKey)
      return
    }
    if (resolvedCleanPosterKey === posterAssetKey) return
    // Wait for the provider-art pass so the resolved primary poster can be
    // excluded; a catalog's poster_path may differ from TMDB's actual choice.
    if (resolvedProviderArtworkKey !== posterAssetKey) return
    let cancelled = false
    setCleanTmdbPoster(undefined)
    setCleanTmdbLogo(undefined)
    ;(async () => {
      try {
        const { resolveTmdbIdFromExternalIds } = await import('../services/metadataEnrich')
        const tmdbId = await resolveTmdbIdFromExternalIds(displayItem, displayItem.type)
        if (!tmdbId) return
        const metadata = await getTmdbCardMetadata(displayItem.type, tmdbId, displayItem.imdbId)
        // Exclude TMDB's authoritative primary poster (which can differ from
        // the catalog's poster_path) before selecting the separate artwork.
        const poster = await getTmdbCleanPoster(
          displayItem.type,
          tmdbId,
          metadata.poster || resolvedPoster || displayItem.poster || initialArtItem.poster,
        )
        if (!cancelled) {
          if (poster) setCleanTmdbPoster(poster)
          if (metadata.englishLogo || metadata.logo) setCleanTmdbLogo(metadata.englishLogo || metadata.logo)
        }
      } catch (_) { /* keep the catalog poster as a last-resort fallback */ }
      finally {
        if (!cancelled) setResolvedCleanPosterKey(posterAssetKey)
      }
    })()
    return () => { cancelled = true }
  }, [isVisible, layout, posterOverlay.enabled, posterOverlay.artwork, displayItem.id, displayItem.tmdbId, displayItem.imdbId, displayItem.tvdbId, displayItem.anilistId, displayItem.malId, displayItem.type, displayItem.poster, initialArtItem.poster, posterAssetKey, resolvedCleanPosterKey, resolvedPoster, resolvedProviderArtworkKey])

  useEffect(() => {
    if (!isVisible) return
    if (resolvedProviderArtworkKey === posterAssetKey
      && ![initialArtItem.poster, initialArtItem.backdrop].some((url) => url && failedImageUrls.has(url))) return
    let cancelled = false
    setResolvedPoster(undefined)
    setResolvedBackdrop(undefined)
    setResolvedCustomArt({})
    // Preserve the addon's art without starting TMDB/TVDB/Fanart bridge and
    // artwork requests for every card when managed metadata is disabled.
    // Poster art is still required when the overlay is disabled. Home cards
    // can already have a separate logo but arrive without the actual poster;
    // skipping enrichment in that case left a blank/placeholder card forever.
    const needsSeparateArtwork = posterOverlay.enabled
      || posterOverlay.artwork === 'backdrop'
      || !displayItem.logo
      || !displayItem.poster
      || Boolean(displayItem.poster && failedImageUrls.has(displayItem.poster))
      || Boolean(displayItem.backdrop && failedImageUrls.has(displayItem.backdrop))
    if (!appManagedMetadata && !needsSeparateArtwork) {
      setResolvedProviderArtworkKey(posterAssetKey)
      return
    }
    const tmdbId = displayItem.tmdbId || (/^tmdb[-:]/i.test(String(displayItem.id)) ? String(displayItem.id).replace(/^tmdb[-:]/i, '') : undefined)
    const imdbId = displayItem.imdbId || (String(displayItem.id).startsWith('tt') ? displayItem.id : undefined)

    const wantsPosterArtwork = posterOverlay.artwork === 'poster'
    const wantsBackdropArtwork = layout === 'landscape' || posterOverlay.artwork === 'backdrop'
    const needsPoster = wantsPosterArtwork && layout !== 'landscape'
      && (!displayItem.poster || Boolean(initialArtItem.poster && failedImageUrls.has(initialArtItem.poster)))
    const needsBackdrop = wantsBackdropArtwork
      && (!displayItem.backdrop || Boolean(initialArtItem.backdrop && failedImageUrls.has(initialArtItem.backdrop)))
    const needsLogo = !displayItem.logo
    const needsGenre = showGenreOnCards && !displayItem.genres?.length && !displayItem.genreIds?.length
    const initialArtwork = wantsBackdropArtwork ? initialArtItem.backdrop : initialArtItem.poster
    const hasInitialArtwork = Boolean(initialArtwork && !failedImageUrls.has(initialArtwork))
    const hasInitialLogo = !needsLogo || Boolean(initialArtItem.logo)
    const wantsProviderArt = !disableArtOverride && (!hasInitialArtwork || !hasInitialLogo || detailIntent)
    // A usable catalog poster must not short-circuit custom poster resolution.
    // {imdb_id} custom templates may still need us to
    // bridge a TMDB/TVDB ID to IMDb. Previously that work only started after
    // hover set detailIntent, making posters appear to update on hover.
    const needsCustomPosterId = !disableArtOverride
      && customPosterNeedsImdbId
      && !imdbId
      && Boolean(tmdbId || displayItem.tvdbId)

    if (!needsPoster && !needsBackdrop && !needsLogo && !needsGenre && !wantsProviderArt && !needsCustomPosterId) {
      if (layout === 'landscape' && !displayItem.backdrop && tmdbId) {
        getTmdbLandscapeBackdrop(displayItem.type, tmdbId)
          .then((backdrop) => { if (!cancelled && backdrop) setResolvedBackdrop(backdrop) })
          .catch(() => undefined)
      }
      // Composition still has a readiness gate when poster details are off;
      // mark the resolved artwork phase complete even when there was no
      // metadata lookup to run, or the gate leaves a permanent black cover.
      setResolvedProviderArtworkKey(posterAssetKey)
      return () => { cancelled = true }
    }

    ;(async () => {
      let finalServerPoster: string | undefined
      let finalServerBackdrop: string | undefined
      let finalServerLogo: string | undefined
      try {
        let resolvedTmdbId = tmdbId
        let resolvedImdbId = imdbId
        // Some Jellyfin catalogs carry a source item before their cached
        // presentation has image URLs attached. Resolve that exact item while
        // the Home card is being composed, then keep its artwork separate so
        // the poster logo and the app's watch details can be layered on top.
        if (displayItem.sourceConnectionId && displayItem.sourceItemId
          && (needsPoster || needsBackdrop)) {
          try {
            const { getServerItem } = await import('../services/serverIntegrations')
            const sourceItem = await getServerItem(displayItem.sourceConnectionId, displayItem.sourceItemId)
            if (sourceItem) {
              resolvedTmdbId ||= sourceItem.tmdbId ? String(sourceItem.tmdbId) : undefined
              resolvedImdbId ||= sourceItem.imdbId
              if (sourceItem.poster) finalServerPoster = sourceItem.poster
              if (sourceItem.backdrop) finalServerBackdrop = sourceItem.backdrop
              if (sourceItem.logo) finalServerLogo = sourceItem.logo
            }
          } catch (_) { /* continue with catalog and metadata-provider artwork */ }
        }
        if (!resolvedTmdbId && imdbId) {
          const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
          const found = await tmdbFindByExternalId(imdbId, 'imdb_id')
          if (found.tmdbId) resolvedTmdbId = String(found.tmdbId)
        }
        // Some connected catalogs contain useful titles and artwork IDs are
        // missing from their provider payload. Only do a title lookup when a
        // required poster/backdrop has already failed or is absent, then let
        // the normal TMDB metadata pipeline supply its clean art and logo.
        if (!resolvedTmdbId && !resolvedImdbId && !displayItem.tvdbId
          && !displayItem.anilistId && !displayItem.malId
          && (needsPoster || needsBackdrop)) {
          const { resolveTmdbIdByTitle } = await import('../services/metadata/externalIdResolver')
          const foundTmdbId = await resolveTmdbIdByTitle(
            displayItem.title,
            displayItem.year,
            displayItem.type === 'movie' ? 'movie' : 'show',
          )
          if (foundTmdbId) resolvedTmdbId = String(foundTmdbId)
        }
        if (!resolvedImdbId && (resolvedTmdbId || displayItem.tvdbId) && customPosterNeedsImdbId) {
          const { resolveImdbId } = await import('../services/metadataEnrich')
          resolvedImdbId = await resolveImdbId(
            {
              tmdbId: resolvedTmdbId || tmdbId,
              tvdbId: displayItem.tvdbId as string | number | undefined,
              anilistId: displayItem.anilistId,
              malId: displayItem.malId,
            },
            displayItem.type === 'movie' ? 'movie' : 'series',
          )
          if (!cancelled && resolvedImdbId) {
            setResolvedCustomArt(getSearchResultCustomArt({ ...displayItem, imdbId: resolvedImdbId }))
          }
        }

        // Collect all art results first, then do a single batch state update
        // to avoid intermediate renders that cause poster flickering.
        let finalPoster: string | undefined = finalServerPoster
        let finalBackdrop: string | undefined = finalServerBackdrop
        let finalLogo: string | undefined = finalServerLogo
        let finalGenre: string | undefined

        if (resolvedTmdbId && (needsPoster || needsBackdrop || needsLogo || needsGenre)) {
          const meta = await getTmdbCardMetadata(displayItem.type, resolvedTmdbId, resolvedImdbId)
          if (meta.poster) finalPoster = meta.poster
          if (meta.backdrop) finalBackdrop = meta.backdrop
          if (meta.englishLogo || meta.logo) finalLogo = meta.englishLogo || meta.logo
          if (meta.genre) finalGenre = meta.genre
        }

        if (wantsProviderArt) {
          const providerArt = await resolveArtFromProviders(
            displayItem.type,
            { tmdbId: resolvedTmdbId || tmdbId, tvdbId: displayItem.tvdbId as string | number | undefined, imdbId: resolvedImdbId },
            displayItem.isAnime,
            posterOverlay.enabled ? 'all' : wantsBackdropArtwork ? 'all' : 'poster',
          )
          // Provider art takes priority over TMDB metadata art
          if (providerArt.poster) finalPoster = providerArt.poster
          if (providerArt.backdrop) finalBackdrop = providerArt.backdrop
          if (providerArt.logo) finalLogo = providerArt.logo
        }

        if (cancelled) return

        if (!cancelled) {
          if (finalPoster) setResolvedPoster(finalPoster)
          if (finalBackdrop) setResolvedBackdrop(finalBackdrop)
          if (finalLogo) setResolvedLogo(finalLogo)
          if (finalGenre) setResolvedGenre(finalGenre)
        }
      } catch (_) { /* ignore */ }
      finally {
        if (!cancelled) setResolvedProviderArtworkKey(posterAssetKey)
      }
    })()
    return () => { cancelled = true }
  }, [isVisible, layout, disableArtOverride, displayItem, posterOverlay.enabled, posterOverlay.artwork, showGenreOnCards, artProviderKey, fanartApiKey, customArtKey, customPosterNeedsImdbId, appManagedMetadata, detailIntent, failedImageUrls, initialArtItem.poster, initialArtItem.backdrop, initialArtItem.logo, posterAssetKey, resolvedProviderArtworkKey])

  const pickWorkingUrl = (...urls: Array<string | undefined>) =>
    urls.find((url) => url && !failedImageUrls.has(url))
  const posterUrl = cardArtworkUrl(
    pickWorkingUrl(customArt.poster, resolvedCustomArt.poster, resolvedPoster, initialArtItem.poster),
    'poster',
    posterSize,
  )
  const backdropUrl = cardArtworkUrl(
    pickWorkingUrl(customArt.backdrop, resolvedCustomArt.backdrop, resolvedBackdrop, initialArtItem.backdrop),
    'landscape',
    posterSize,
  )
  const activeCleanTmdbPoster = cleanTmdbPoster && !failedImageUrls.has(cleanTmdbPoster) ? cleanTmdbPoster : undefined
  const posterArtworkUrl = getPosterArtworkCandidate(posterOverlay.artwork, posterUrl, activeCleanTmdbPoster, backdropUrl)
  const handlePosterArtworkLoad = (event: React.SyntheticEvent<HTMLImageElement>, url = event.currentTarget.currentSrc || event.currentTarget.src) => {
    revealLoadedArtwork(event)
    setLoadedPosterArtworkUrl(url)
  }
  const handlePosterLogoLoad = (event: React.SyntheticEvent<HTMLImageElement>, url = event.currentTarget.currentSrc || event.currentTarget.src) => {
    setLoadedPosterLogoUrl(url)
  }
  const posterBackgroundClass = 'bg-black'
  const logoUrl = pickWorkingUrl(customArt.logo, resolvedCustomArt.logo, resolvedLogo, cleanTmdbLogo, initialArtItem.logo)
  const posterFadeVisible = posterOverlay.enabled || Boolean(logoUrl)
  useEffect(() => {
    if (!posterFadeVisible || posterOverlay.colorMode !== 'artwork' || !posterArtworkUrl || !isVisible) {
      setPosterAmbientColor(null)
      setPosterAmbientColorKey(undefined)
      return
    }
    let cancelled = false
    setPosterAmbientColor(null)
    setPosterAmbientColorKey(undefined)
    void getPosterAmbientColor(posterArtworkUrl).then((color) => {
      if (cancelled) return
      setPosterAmbientColor(color)
      setPosterAmbientColorKey(posterArtworkUrl)
    }).catch(() => {
      // Color sampling is decorative; use the neutral fade if it fails, while
      // still waiting for the actual artwork and configured poster details.
      if (cancelled) return
      setPosterAmbientColor(null)
      setPosterAmbientColorKey(posterArtworkUrl)
    })
    return () => { cancelled = true }
  }, [isVisible, posterArtworkUrl, posterFadeVisible, posterOverlay.colorMode])
  const posterFade = getPosterFadeAppearance(
    posterOverlay.fade,
    posterOverlay.colorMode,
    posterAmbientColorKey === posterArtworkUrl ? posterAmbientColor : null,
  )
  // Keep the title logo as a separate app-composed layer for both artwork
  // choices. Prefer the textless poster above, but do not silently drop the
  // logo when a provider's poster is the only available image.
  const posterLogoCandidate = layout === 'feature' ? logoUrl : getTmdbImageVariant(logoUrl, 'w500')
  const posterLogoUrl = posterLogoCandidate && failedImageUrls.has(posterLogoCandidate)
    ? posterLogoCandidate !== logoUrl && logoUrl && !failedImageUrls.has(logoUrl) ? logoUrl : undefined
    : posterLogoCandidate
  const posterBottomProgress = posterOverlay.enabled && posterOverlay.showProgress && posterOverlay.progressPlacement === 'along-bottom'
    ? showEpisodeProgress && displayItem.type === 'series' && posterEpisodeTotal != null && posterEpisodeTotal > 0
      ? <div className="mx-1 flex h-1 w-[calc(100%-0.5rem)] gap-px overflow-hidden rounded-full" role="progressbar" aria-label="Episodes watched" aria-valuemin={0} aria-valuemax={posterEpisodeTotal} aria-valuenow={posterEpisodeWatched}>{Array.from({ length: posterEpisodeSegmentCount }, (_, index) => {
        const segmentProgress = Math.max(0, Math.min(1, posterEpisodeSegmentFill - index))
        return <span key={index} className={`flex-1 ${segmentProgress >= 1 ? 'bg-white' : 'bg-white/35'}`} style={segmentProgress > 0 && segmentProgress < 1 ? { background: `linear-gradient(to right, #fff ${segmentProgress * 100}%, rgba(255,255,255,.35) ${segmentProgress * 100}%)` } : undefined} />
      })}</div>
      : showPosterProgress
        ? <div className="mx-1 h-1 w-[calc(100%-0.5rem)] overflow-hidden rounded-full bg-white/35" role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(posterProgressPct || 0, 100))}><div className="h-full rounded-full bg-white" style={{ width: `${Math.min(posterProgressPct || 0, 100)}%` }} /></div>
        : null
    : null
  const posterBottomStack = (className = '') => <PosterBottomStack
    className={`poster-bottom-stack--${posterOverlay.contentAlignment} ${className}`}
    logo={posterLogoUrl
      ? <img src={cachedImage(posterLogoUrl)} alt="" aria-hidden="true" className="max-h-10 max-w-[72%] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,.8)] sm:max-h-16" loading="eager" onLoad={(event) => handlePosterLogoLoad(event, posterLogoUrl)} onError={(event) => handleImageError(event, posterLogoUrl)} />
      : resolvedCleanPosterKey === posterAssetKey && resolvedProviderArtworkKey === posterAssetKey
        ? <h3 className="max-w-[88%] text-[10px] font-extrabold uppercase leading-tight tracking-[.12em] text-white drop-shadow-[0_2px_8px_rgba(0,0,0,.95)] sm:text-sm" style={{ textAlign: posterOverlay.contentAlignment }}>{displayItem.title}</h3>
        : undefined}
    footer={posterFooter}
    underDetailsProgress={posterProgressUnderDetails}
    bottomProgress={posterBottomProgress}
  />
  const needsPosterEpisodeSummary = posterOverlay.enabled && displayItem.type === 'series'
    && (posterOverlay.showEpisodes || posterOverlay.showEpisodesWatched || posterOverlay.showNextEpisode || (posterOverlay.showProgress && posterOverlay.splitEpisodeProgress))
  const isPosterCompositionReady = (art?: string, logo?: string) => Boolean(
    // Reveal as soon as the actual artwork and title logo are decoded.
    // The artwork tint is decorative and falls back to a neutral fade while
    // its asynchronous color sample is pending.
    (!art || loadedPosterArtworkUrl === art)
    && (!logo || loadedPosterLogoUrl === logo),
  )
  const landscapeBackdrop = backdropUrl
  const markImageFailed = (url?: string) => {
    if (!url) return
    setFailedImageUrls((prev) => {
      const next = new Set(prev)
      next.add(url)
      return next
    })
  }
  const handleImageError = (event: React.SyntheticEvent<HTMLImageElement>, url?: string) => {
    if (!retryImageFromSource(event.currentTarget, url)) markImageFailed(url)
  }
  const focusArtwork = backdropUrl || posterUrl
  const cinematicArtwork = layout === 'feature' ? activeCleanTmdbPoster || posterUrl : posterUrl
  const featureArtwork = activeCleanTmdbPoster || posterUrl || backdropUrl
  const posterImageRef = useStalledArtwork(posterUrl)
  const posterArtworkImageRef = useStalledArtwork(posterArtworkUrl)
  const backdropImageRef = useStalledArtwork(backdropUrl)
  const focusImageRef = useStalledArtwork(focusArtwork)
  const cinematicImageRef = useStalledArtwork(cinematicArtwork)
  const featureImageRef = useStalledArtwork(featureArtwork)
  const warmDetailArtwork = useCallback(() => {
    setDetailIntent(true)
    void warmCachedImage(backdropUrl, 'backdrop')
    void warmCachedImage(logoUrl)
  }, [backdropUrl, logoUrl])

  const showContextMenu = useContextMenu((s) => s.show)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (import.meta.env.DEV && e.shiftKey) {
      window.dispatchEvent(new CustomEvent('aurales:art-debug', {
        detail: {
          item: displayItem,
          displayed: { poster: posterUrl, backdrop: backdropUrl, logo: logoUrl },
          layers: {
            custom: customArt,
            provider: { poster: resolvedPoster, backdrop: resolvedBackdrop, logo: resolvedLogo },
            item: { poster: item.poster, backdrop: item.backdrop, logo: item.logo },
          },
        },
      }))
      return
    }
    showContextMenu(e.clientX, e.clientY, { kind: 'media', item })
  }, [item, showContextMenu, displayItem, posterUrl, backdropUrl, logoUrl, customArt, resolvedPoster, resolvedBackdrop, resolvedLogo])
  const longPressHandlers = useLongPressContextMenu(handleContextMenu)

  const handleClick = () => {
    if (item.mediaType === 'collection' && item.sourceConnectionId && item.sourceItemId) {
      const collectionCatalogId = `boxset:${item.sourceItemId}`
      const rowId = `jellyfin-${encodeURIComponent(item.sourceConnectionId)}-${encodeURIComponent(item.sourceItemId)}`
      const query = new URLSearchParams({ title: item.title, connection: item.sourceConnectionId, item: item.sourceItemId })
      navigate(`/catalog/${rowId}?${query}`, {
        state: {
          catalogRow: {
            id: rowId,
            title: item.title,
            sourceType: 'jellyfin',
            providerListId: JSON.stringify([item.sourceConnectionId, collectionCatalogId]),
            layout: 'poster',
            enabled: true,
            order: 0,
          },
        },
      })
      return
    }
    warmDetailArtwork()
    if (recordRecentlyWatched) {
      try {
        addRecentlyWatched(displayItem)
      } catch (_) { /* ignore */ }
    }
    const path = item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`
    navigate(path, {
      state: {
        poster: posterUrl,
        backdrop: backdropUrl,
        logo: logoUrl,
        title: displayItem.title,
        year: displayItem.year,
        rating: displayItem.rating,
        criticRating: displayItem.criticRating,
        overview: displayItem.overview,
        originalTitle: displayItem.originalTitle,
        certification: displayItem.certification,
        tagline: displayItem.tagline,
        runtime: displayItem.runtime,
        releaseDate: displayItem.releaseDate,
        genres: displayItem.genres,
        studios: displayItem.studios,
        people: displayItem.people,
        imdbId: displayItem.imdbId,
        tmdbId: displayItem.tmdbId,
        tvdbId: displayItem.tvdbId,
        malId: displayItem.malId,
        anilistId: displayItem.anilistId,
        isAnime: displayItem.isAnime,
        addonUrl: displayItem.addonUrl,
        provider: displayItem.provider,
        sourceAddonId: displayItem.sourceAddonId,
        sourceAddonItemId: displayItem.sourceAddonItemId,
        sourceConnectionId: displayItem.sourceConnectionId,
        sourceItemId: displayItem.sourceItemId,
        addonMeta: displayItem.addonMeta,
      },
    })
  }

  const revealExpandedCard = useCallback(() => {
    const card = cardRef.current
    if (!card || !cinematicMode || !cinematicExpand) return
    window.setTimeout(() => {
      const row = card.closest<HTMLElement>('.cinematic-row-track')
      if (!row) return
      const cardRect = card.getBoundingClientRect()
      const expandedViewport = card.querySelector<HTMLElement>('[data-hero-viewport]')
      // Ranked previews intentionally overflow their fixed slot so opening one
      // never reflows the shelf. Measure the visible viewport when deciding
      // whether the row needs to scroll, not only the unchanged button slot.
      const visualRect = expandedViewport?.getBoundingClientRect() ?? cardRect
      const rowRect = row.getBoundingClientRect()
      const inset = 24
      if (visualRect.right > rowRect.right - inset) {
        row.scrollBy({ left: visualRect.right - rowRect.right + inset, behavior: 'smooth' })
      } else if (visualRect.left < rowRect.left + inset) {
        row.scrollBy({ left: visualRect.left - rowRect.left - inset, behavior: 'smooth' })
      }
    }, 380)
  }, [cinematicMode, cinematicExpand])

  useEffect(() => {
    const closeTimer = closeTimerRef
    return () => {
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      hoverRequestRef.current += 1
    }
  }, [])

  const closeHoverPreview = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    hoverRequestRef.current += 1
    setSuppressPosterHover(true)
    setNativeTrailerVisible(false)
    setHoverTrailer(null)
    setHoverPreviewOpen(false)
  }, [])

  const openHoverPreview = useCallback(() => {
    setSuppressPosterHover(false)
    // "Card focus animations" is the static-card mode as well as the
    // expansion preference. Keep feature cards in their complete poster state
    // in that mode: artwork, logo/title, and metadata must not disappear when
    // a hover trailer takes ownership of the card.
    if (disableTrailerPreview || !homeCardAnimations || fixedHome || (!['poster', 'ranked', 'feature'].includes(layout) && !cinematicMode) || reducedMotion || !posterTrailerPreviews) return
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)

    hoverTimerRef.current = window.setTimeout(() => {
      const tmdbId = displayItem.tmdbId || (/^tmdb[-:]/i.test(String(displayItem.id)) ? String(displayItem.id).replace(/^tmdb[-:]/i, '') : undefined)
      const requestId = hoverRequestRef.current + 1
      hoverRequestRef.current = requestId

      getTrailerSource({
        type: displayItem.type,
        tmdbId,
        imdbId: displayItem.imdbId,
        title: displayItem.title,
        year: displayItem.year,
        language: trailerLanguage,
      }).then((trailer) => {
        if (hoverRequestRef.current !== requestId || !trailer) return
        setHoverTrailer(trailer)
        setHoverPreviewOpen(true)
      }).catch(() => undefined)
    }, posterTrailerHoverDelayMs)
  }, [cinematicMode, disableTrailerPreview, displayItem.id, displayItem.imdbId, displayItem.tmdbId, displayItem.title, displayItem.type, displayItem.year, fixedHome, homeCardAnimations, layout, posterTrailerHoverDelayMs, posterTrailerPreviews, reducedMotion, trailerLanguage])

  useEffect(() => {
    // Turning the preference off while a card is hovered should restore its
    // static presentation immediately rather than waiting for pointer leave.
    if (!homeCardAnimations) closeHoverPreview()
  }, [closeHoverPreview, homeCardAnimations])

  const useNativeTrailerPlayer = nativeTrailerPlayerSupported()

  if (cinematicMode) {
    const cinematicGenre = displayItem.genres?.[0]
      || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : null)
      || resolvedGenre
    const focusMedia = posterOverlay.enabled ? posterArtworkUrl : landscapeBackdrop || posterUrl
    const cinematicPoster = posterArtworkUrl
    const expanded = cinematicFocused && cinematicExpand
    const cinematicTrailer = hoverPreviewOpen && hoverTrailer
    const cinematicRanked = layout === 'ranked'
    const cinematicFeature = layout === 'feature'
    const cinematicSpecial = cinematicRanked || cinematicFeature
    const cinematicLogo = posterLogoUrl
    const cinematicSpecialHeight = cinematicRanked
      ? posterSize === 'compact' ? '240px' : posterSize === 'large' ? '350px' : posterSize === 'huge' ? '400px' : '300px'
      : posterSize === 'compact' ? '325px' : posterSize === 'large' ? '450px' : posterSize === 'huge' ? '525px' : '400px'
    const cinematicStyle = cinematicSpecial
      ? ({ '--cinematic-special-height': cinematicSpecialHeight } as React.CSSProperties)
      : undefined
    const cinematicBaseWidth = cinematicRanked
      ? 'w-[calc(var(--cinematic-special-height)*0.927)]'
      : cinematicFeature
        ? 'w-[calc(var(--cinematic-special-height)*0.8)]'
        : 'w-[clamp(10rem,13vw,13rem)]'
    const cinematicExpandedWidth = cinematicSpecial
      ? 'w-[calc(var(--cinematic-special-height)*1.72)]'
      : 'w-[min(38vw,38rem)]'
    const cinematicViewportHeight = cinematicSpecial
      ? 'h-[var(--cinematic-special-height)]'
      : 'h-[clamp(15rem,19.5vw,19.5rem)]'
    const cinematicViewportWidth = cinematicRanked
      ? expanded
        ? 'ml-[calc(var(--cinematic-special-height)*0.26)] w-[min(38vw,38rem)]'
        : 'ml-[calc(var(--cinematic-special-height)*0.26)] w-[calc(var(--cinematic-special-height)*0.667)]'
      : 'ml-0 w-full'
    const cinematicOuterWidth = cinematicRanked
      ? expanded
        ? 'w-[calc(var(--cinematic-special-height)*0.26+min(38vw,38rem))]'
        : cinematicBaseWidth
      : expanded ? cinematicExpandedWidth : cinematicBaseWidth
    const cinematicRankValue = rank || (cardIndex ?? 0) + 1
    return (
      <button
        ref={cardRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        {...longPressHandlers}
        onFocus={() => { warmDetailArtwork(); announceFocus(); revealExpandedCard(); openHoverPreview() }}
        onBlur={() => { onUnfocusItem?.(displayItem, cardIndex); closeHoverPreview() }}
        onMouseEnter={() => { warmDetailArtwork(); announceFocus(); revealExpandedCard(); openHoverPreview() }}
        onMouseMove={handleMouseFollow}
        onMouseLeave={(event) => { resetMouseFollow(event.currentTarget); onUnfocusItem?.(displayItem, cardIndex); closeHoverPreview() }}
        data-fixed-focused={(fixedHome && cinematicFocused) || undefined}
        data-mouse-follow={mouseFollowEnabled || undefined}
        data-cinematic-expanded={expanded || undefined}
        className={`relative flex-shrink-0 cursor-pointer overflow-visible text-left focus-ring transition-[width] duration-[var(--duration-card)] ease-expo ${cinematicOuterWidth}`}
        style={cinematicStyle}
      >
        {cinematicRanked && (
          <span
            aria-hidden="true"
            className="media-rank h-[var(--cinematic-special-height)] opacity-100"
            style={{ fontSize: 'calc(var(--cinematic-special-height) * 0.52)', width: 'calc(var(--cinematic-special-height) * 0.26)' }}
          >
            <span className="media-rank__value" data-digits={String(cinematicRankValue).length}>{cinematicRankValue}</span>
          </span>
        )}
        <div data-hero-viewport className={`relative ${cinematicViewportHeight} ${cinematicViewportWidth} overflow-hidden rounded-2xl border border-white/10 transition-[width,margin,box-shadow,transform] duration-[var(--duration-card)] ease-expo ${nativeTrailerVisible ? 'bg-transparent' : 'bg-surface-elevated'} ${cinematicFocused ? 'shadow-[0_18px_55px_rgba(0,0,0,.7)]' : ''}`}>
          {cinematicPoster && <img ref={cinematicImageRef} src={cachedImage(cinematicPoster)} alt={displayItem.title} className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${expanded || nativeTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading={isVisible ? 'eager' : 'lazy'} decoding="async" onLoad={(event) => handlePosterArtworkLoad(event, cinematicPoster)} onError={(event) => handleImageError(event, cinematicPoster)} />}
          {expanded && focusMedia && <img ref={focusImageRef} src={cachedImage(focusMedia)} alt="" className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${nativeTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading={isVisible ? 'eager' : 'lazy'} decoding="async" onError={(event) => handleImageError(event, focusMedia)} />}
          {cinematicTrailer && (useNativeTrailerPlayer ? (
            <React.Suspense fallback={null}><HeroMpvTrailer
              trailer={cinematicTrailer}
              muted={!posterTrailerSound}
              className="absolute inset-0 z-[5]"
              onEnded={closeHoverPreview}
              onUnavailable={closeHoverPreview}
              onPlayingChange={setNativeTrailerVisible}
            /></React.Suspense>
          ) : (
            <React.Suspense fallback={null}><TrailerPreview trailer={cinematicTrailer} title={displayItem.title} muted={!posterTrailerSound} preferVideoOnly={!posterTrailerSound} eager showShade={false} placeholderUrl={focusMedia} className="absolute inset-0 z-[5]" /></React.Suspense>
          ))}
          {!cinematicPoster && !focusMedia && <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface text-3xl font-bold text-white/20">{displayItem.title?.charAt(0) || '?'}</div>}
          {posterFadeVisible && <div className={`poster-artwork-fade absolute inset-x-0 bottom-0 ${posterFade.heightClass} ${posterFade.colorClass}`} style={{ background: posterFade.background }} />}
          {!cinematicFeature && posterDetailsBadges}
          {!cinematicFeature && posterWatchedLine}
          {cinematicFeature && posterDetailsBadges}
          {cinematicFeature && posterWatchedLine}
          {posterOverlay.enabled && posterProgressRing}
          {!expanded && posterBottomStack()}
          {expanded && !posterOverlay.enabled && <div className="absolute inset-x-4 bottom-4 z-10">
            {cinematicLogo ? <img src={cachedImage(cinematicLogo)} alt={displayItem.title} className="mb-1 max-h-16 max-w-[55%] object-contain object-left drop-shadow-xl" /> : <h3 className="truncate text-base font-black text-white drop-shadow-xl">{displayItem.title}</h3>}
          </div>}
          {!expanded && !nativeTrailerVisible && !isPosterCompositionReady(cinematicPoster, cinematicFeature ? cinematicLogo : posterLogoUrl) && <div aria-hidden="true" className="absolute inset-0 z-[60] bg-black" />}
        </div>
        {posterOverlay.showRatingBelow && ratingStr && <p className={`${POSTER_RATING_CAPTION_CLASS} pl-1`}><svg className={POSTER_RATING_CAPTION_STAR_CLASS} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</p>}
        <div className={`absolute top-full grid transition-[grid-template-rows,opacity] duration-300 ${cinematicRanked ? 'left-[calc(var(--cinematic-special-height)*0.26)] w-[min(38vw,38rem)]' : 'left-0 w-full'} ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden">
            <div className="px-2 pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-white/85">
                {cinematicGenre && <span>{cinematicGenre}</span>}
                {cinematicGenre && displayItem.year && <span className="text-white/50">•</span>}
                {displayItem.year && <span>{displayItem.year}</span>}
                {ratingStr && <><span className="text-white/50">•</span><span>★ {ratingStr}</span></>}
                {getDisplayProvider(displayItem) && <><span className="text-white/50">•</span><span className="capitalize">{getDisplayProvider(displayItem)}</span></>}
              </div>
              {displayItem.overview && <p className="line-clamp-3 max-w-none text-base leading-relaxed text-white/60">{displayItem.overview}</p>}
            </div>
          </div>
        </div>
      </button>
    )
  }

  if (layout === 'feature') {
    // This row is poster-led even though the cards are wider than the regular
    // poster layout. Feature cards always prefer textless TMDB artwork before
    // falling back to catalog art or a backdrop.
    const featureArt = posterArtworkUrl
    const featureLogo = posterLogoUrl
    const featureTrailer = hoverPreviewOpen && hoverTrailer ? hoverTrailer : null
    const featureUsesNativeTrailer = Boolean(featureTrailer && useNativeTrailerPlayer)
    const featureTrailerVisible = featureUsesNativeTrailer ? nativeTrailerVisible : Boolean(featureTrailer)
    // The Home preference applies when this row is rendered through the
    // standard Feature branch too (for example with Cinematic navigation but
    // another interface theme). Its static state must look identical to the
    // Dynamic Banner cinematic branch.
    const staticFeaturePresentation = !homeCardAnimations
    const featureOverlayVisible = staticFeaturePresentation || !featureTrailerVisible
    const rawFeatureGenre = displayItem.genres?.[0]
      || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : null)
      || resolvedGenre
    const featureGenre = typeof rawFeatureGenre === 'object' && rawFeatureGenre
      ? (rawFeatureGenre as any).name || (rawFeatureGenre as any).title
      : rawFeatureGenre
    return (
      <button
        ref={cardRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        {...longPressHandlers}
        onFocus={() => { warmDetailArtwork(); announceFocus(); openHoverPreview() }}
        onBlur={closeHoverPreview}
        onMouseEnter={() => { warmDetailArtwork(); announceFocus(); openHoverPreview() }}
        onMouseMove={handleMouseFollow}
        onMouseLeave={(event) => { resetMouseFollow(event.currentTarget); closeHoverPreview() }}
        data-fixed-focused={(fixedHome && cinematicFocused) || undefined}
        data-mouse-follow={mouseFollowEnabled || undefined}
        className={`group relative flex-shrink-0 cursor-pointer text-left focus-ring ${widthClass}`}
      >
        <div data-hero-viewport className={`relative aspect-[4/5] overflow-hidden rounded-[1.6rem] border border-white/10 shadow-[0_16px_45px_rgba(0,0,0,.28)] transition-[box-shadow,transform] duration-300 group-hover:shadow-[0_24px_60px_rgba(0,0,0,.45)] ${featureTrailer || isMobileWebViewport() ? '' : 'group-hover:-translate-y-1.5'} ${nativeTrailerVisible ? 'native-trailer-hole bg-transparent' : 'bg-surface-elevated'}`}>
          {!nativeTrailerVisible && (featureArt ? <img ref={featureImageRef} src={cachedImage(featureArt)} alt={displayItem.title} className={`h-full w-full object-cover transition-[transform,opacity] duration-500 ${!isMobileWebViewport() ? 'group-hover:scale-[1.04]' : ''} ${featureTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading={isVisible ? 'eager' : 'lazy'} decoding="async" onLoad={(event) => handlePosterArtworkLoad(event, featureArt)} onError={(event) => handleImageError(event, featureArt)} /> : <div className={`grid h-full place-items-center bg-gradient-to-br from-surface-elevated to-surface text-5xl font-black text-white/20 ${featureTrailerVisible ? 'opacity-0' : 'opacity-100'}`}>{displayItem.title?.charAt(0) || '?'}</div>)}
          {featureTrailer && (featureUsesNativeTrailer ? (
            <React.Suspense fallback={null}><HeroMpvTrailer
              trailer={featureTrailer}
              muted={!posterTrailerSound}
              className="absolute inset-0 z-20"
              onEnded={closeHoverPreview}
              onUnavailable={closeHoverPreview}
              onPlayingChange={setNativeTrailerVisible}
            /></React.Suspense>
          ) : (
            <React.Suspense fallback={null}><TrailerPreview
              trailer={featureTrailer}
              title={displayItem.title}
              muted={!posterTrailerSound}
              eager
              showShade={false}
              placeholderUrl={featureArt}
              allowIframeFallback={false}
              className="absolute inset-0 z-20"
              onUnavailable={closeHoverPreview}
            /></React.Suspense>
          ))}
          {posterFadeVisible && (!nativeTrailerVisible || staticFeaturePresentation) && <div className={`poster-artwork-fade absolute inset-x-0 bottom-0 z-10 ${posterFade.heightClass} ${posterFade.colorClass} transition-opacity duration-200 ${featureOverlayVisible ? 'opacity-100' : 'opacity-0'}`} style={{ background: posterFade.background }} />}
          {posterOverlay.enabled && posterDetailsBadges}
          {posterOverlay.enabled && posterProgressRing}
          {posterWatchedLine}
          {!nativeTrailerVisible && posterBottomStack()}
          {!nativeTrailerVisible && !isPosterCompositionReady(featureArt, featureLogo) && <div aria-hidden="true" className="absolute inset-0 z-[60] bg-black" />}
        </div>
        {posterOverlay.showRatingBelow && ratingStr && <p className={`${POSTER_RATING_CAPTION_CLASS} pl-1`}><svg className={POSTER_RATING_CAPTION_STAR_CLASS} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</p>}
      </button>
    )
  }

  if (layout === 'landscape') {
    const cinematicLandscapeExpanded = cinematicMode && cinematicFocused && cinematicExpand
    const cinematicWidth = cinematicMode
      ? cinematicLandscapeExpanded ? 'w-[min(52vw,52rem)]' : 'w-[clamp(15rem,18vw,21rem)]'
      : widthClass
    const landscapeArtwork = posterOverlay.enabled ? posterArtworkUrl : landscapeBackdrop || posterUrl
    return (
      <button
        ref={cardRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        {...longPressHandlers}
        onFocus={() => { warmDetailArtwork(); announceFocus() }}
        onMouseEnter={() => { warmDetailArtwork(); announceFocus() }}
        onMouseMove={handleMouseFollow}
        onMouseLeave={(event) => resetMouseFollow(event.currentTarget)}
        data-fixed-focused={(fixedHome && cinematicFocused) || undefined}
        data-mouse-follow={mouseFollowEnabled || undefined}
        className={`flex-shrink-0 group cursor-pointer focus-ring text-left transition-[width,transform] duration-[var(--duration-card)] ease-expo ${cinematicWidth}`}
      >
        <div data-hero-viewport className={`relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated border border-white/[0.04] transition-[box-shadow,transform] duration-[var(--duration-slow)] ease-expo group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)] ${isMobileWebViewport() ? '' : 'group-hover:-translate-y-1.5 group-hover:scale-[1.03]'}`}>
          {landscapeArtwork ? (
            <img
              ref={posterOverlay.enabled && posterOverlay.artwork === 'poster' ? posterImageRef : backdropImageRef}
              src={cachedImage(landscapeArtwork)}
              alt={displayItem.title}
              className={`media-card-artwork w-full h-full object-cover transition-transform duration-500 ease-out ${isMobileWebViewport() ? '' : 'group-hover:scale-105'}`}
              loading={isVisible ? 'eager' : 'lazy'}
              decoding="async"
              onLoad={(event) => handlePosterArtworkLoad(event, landscapeArtwork)}
              onError={(event) => handleImageError(event, landscapeArtwork)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
              <span className="text-2xl font-bold text-muted/30">{displayItem.title?.charAt(0) || '?'}</span>
            </div>
          )}

          {/* Permanent subtle dark gradient overlay for text readability */}
          {posterFadeVisible
            ? <div className={`poster-artwork-fade absolute inset-x-0 bottom-0 ${posterFade.heightClass} ${posterFade.colorClass}`} style={{ background: posterFade.background }} />
            : <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent transition-opacity duration-300 group-hover:from-black/95" />}
          {posterBottomStack()}
          {posterOverlay.enabled && posterDetailsBadges}
          {posterWatchedLine}

          {/* Rating badge (landscape) */}
          {!posterOverlay.enabled && showRatingsOnCards && ratingStr && (
            <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md border border-white/10 flex items-center gap-1 shadow-lg z-10 text-meta font-bold text-yellow-400">
              <svg className="w-3 h-3 fill-current text-yellow-400" viewBox="0 0 24 24">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
              <span>{ratingStr}</span>
            </div>
          )}
          {posterOverlay.enabled && posterProgressRing}

          {/* In-progress bar (landscape) */}
          {!posterOverlay.enabled && showPosterProgress && <div className="poster-progress-indicator" role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(progressPct!, 100))}><div className="poster-progress-indicator__value" style={{ width: `${Math.min(progressPct!, 100)}%` }} /></div>}
          {!isPosterCompositionReady(landscapeArtwork, posterLogoUrl) && <div aria-hidden="true" className="absolute inset-0 z-[60] bg-black" />}

          {/* Media Info Overlay */}
          {!posterOverlay.enabled && <div className="absolute bottom-3 left-3 right-3 flex flex-col gap-1">
            {cinematicLandscapeExpanded && logoUrl ? (
              <img src={cachedImage(logoUrl)} alt={displayItem.title} className="mb-1 max-h-16 max-w-[55%] object-contain object-left drop-shadow-xl" />
            ) : (
              <h3 className="text-sm md:text-base font-bold text-white tracking-wide truncate drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                {displayItem.title}
              </h3>
            )}
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
              {(posterOverlay.enabled ? posterOverlay.showGenre : showGenreOnCards) && landscapeGenre && <span className="truncate">{String(landscapeGenre)}</span>}
              {(posterOverlay.enabled ? posterOverlay.showGenre : showGenreOnCards) && landscapeGenre && displayItem.year && <span className="text-white/45">•</span>}
              {displayItem.year && (
                <span className="text-gray-300">
                  {displayItem.year}
                </span>
              )}
              {!posterOverlay.enabled && ratingStr && <><span className="text-white/45">•</span><span className="flex items-center gap-0.5 text-yellow-300"><svg className="h-3 w-3 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</span></>}
            </div>
          </div>}
        </div>
        {posterOverlay.showRatingBelow && ratingStr && <p className={`${POSTER_RATING_CAPTION_CLASS} pl-1`}><svg className={POSTER_RATING_CAPTION_STAR_CLASS} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</p>}
        {cinematicLandscapeExpanded && (
          <div className="px-2 pt-4 pb-1 animate-[cinematic-panel-in_180ms_cubic-bezier(.16,1,.3,1)]">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-white/85">
              {displayItem.genres?.slice(0, 2).map((genre) => {
                const text = typeof genre === 'object' && genre ? (genre as any).name || (genre as any).title || JSON.stringify(genre) : genre
                return <span key={text}>{text}</span>
              })}
              {displayItem.genres?.length && displayItem.year ? <span className="text-white/50">•</span> : null}
              {displayItem.year && <span>{displayItem.year}</span>}
              {ratingStr && <><span className="text-white/50">•</span><span>★ {ratingStr}</span></>}
              {getDisplayProvider(displayItem) && <><span className="text-white/50">•</span><span className="capitalize">{getDisplayProvider(displayItem)}</span></>}
            </div>
            {displayItem.overview && <p className="line-clamp-3 max-w-none text-base leading-relaxed text-white/60">{displayItem.overview}</p>}
          </div>
        )}
      </button>
    )
  }

  const rawGenre = displayItem.genres?.[0]
    || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : null)
    || resolvedGenre
  const genre = typeof rawGenre === 'object' && rawGenre
    ? (rawGenre as any).name || (rawGenre as any).title || JSON.stringify(rawGenre)
    : rawGenre
  const inlineTrailerPreview = hoverPreviewOpen && hoverTrailer ? hoverTrailer : null
  const ranked = layout === 'ranked'
  const rankedValue = rank || cardIndex! + 1
  // Native mpv needs to mount before it can report the first decoded frame.
  // The ranked preview may widen horizontally once a first frame is available,
  // but keeps the poster's height so the shelf never shifts vertically.
  const trailerExpanded = Boolean(inlineTrailerPreview && (!useNativeTrailerPlayer || nativeTrailerVisible))
  // Ranked cards reserve a fixed number column. Keeping the poster's left edge
  // and height identical in both states prevents the rank and artwork from
  // jumping when the portrait smoothly widens into a trailer.
  // Dynamic Cinematic shelves need a larger presentation than Classic rows:
  // feature cards beside them are substantially taller, so sharing Classic's
  // compact scale makes ranked artwork look detached from the hero. Fixed Home
  // keeps its viewport-derived size because that shelf has a strict height.
  // One custom property still keeps the rank, poster and preview in lockstep.
  const rankedCardHeight = fixedHome
    ? 'var(--fixed-cinematic-card-height)'
    : !compactSpecialLayouts
      ? posterSize === 'compact'
        ? '260px'
        : posterSize === 'large'
          ? '390px'
          : posterSize === 'huge'
            ? '445px'
            : '330px'
      : posterSize === 'compact'
        ? '210px'
        : posterSize === 'large'
          ? '282px'
          : posterSize === 'huge'
            ? '318px'
            : '246px'
  const rankedStyle = ranked
    ? ({ '--ranked-card-height': rankedCardHeight } as React.CSSProperties)
    : undefined
  const rankedTrailerWidthClass = 'w-[calc(var(--ranked-card-height)*1.72)]'
  const rankedTrailerHeightClass = 'h-[var(--ranked-card-height)]'
  const rankedSlotHeightClass = 'h-[calc(var(--ranked-card-height)+1.5rem)]'
  const rankedNumberSlotClass = 'ml-[calc(var(--ranked-card-height)*0.34)]'
  const rankedPosterWidthClass = 'w-[calc(var(--ranked-card-height)*2/3)]'
  const rankedExpandedContentWidthClass = 'w-[calc(var(--ranked-card-height)*1.35)]'
  const rankedContentClass = `${rankedNumberSlotClass} ${trailerExpanded ? rankedExpandedContentWidthClass : rankedPosterWidthClass}`
  // The numeral is sized from the poster it sits beside, not from the viewport.
  // The previous clamp(11rem, 17vw, 16rem) grew on a different curve than the
  // artwork, so the two drifted apart between window sizes. Keep a full-height
  // feel while ensuring even a wide single digit stays inside its own gutter.
  const rankedNumberFontSize = 'calc(var(--ranked-card-height) * 0.58)'
  // Must mirror rankedNumberSlotClass exactly -- this is the poster's left
  // offset, and the numeral column has to be the same width for the two to
  // line up. Applied inline rather than as a derived `w-[..]` class because
  // Tailwind only emits classes it can find literally in the source.
  const rankedNumberSlotWidth = 'calc(var(--ranked-card-height) * 0.34)'
  const rankedWidthClass = 'w-[calc(var(--ranked-card-height)*1.01)]'
  const cardWidthClass = ranked
    ? trailerExpanded ? rankedTrailerWidthClass : rankedWidthClass
    : trailerExpanded ? expandedPosterWidthClass : widthClass
  // A ranked row must not change its block height when preview details appear;
  // otherwise every catalog below it gets reflowed on hover.
  // Mobile posters already have an intrinsic 2:3 artwork height. Let the
  // title and optional rating add only the space they need instead of holding
  // every card to a desktop-sized minimum slot.
  const mobilePosterSlotHeightClass = isMobileWebViewport() && !ranked && !trailerExpanded ? 'h-auto' : null
  const cardSlotHeightClass = ranked ? rankedSlotHeightClass : trailerExpanded ? expandedTrailerSlotHeightClass : mobilePosterSlotHeightClass || posterSlotHeightClass
  // Touch browsers can keep :hover active after a tap, leaving a poster
  // permanently lifted and scaled. Keep the artwork geometry static there.
  const posterHoverClass = suppressPosterHover || isMobileWebViewport() ? '' : 'group-hover:-translate-y-2 group-hover:scale-[1.04]'
  const posterImageHoverClass = suppressPosterHover || isMobileWebViewport() ? '' : 'group-hover:scale-105'

  return (
    <button
      ref={cardRef}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      {...longPressHandlers}
      onMouseEnter={() => { warmDetailArtwork(); announceFocus(); openHoverPreview() }}
      onMouseMove={handleMouseFollow}
      onMouseLeave={(event) => { resetMouseFollow(event.currentTarget); closeHoverPreview() }}
      onFocus={() => { warmDetailArtwork(); announceFocus(); openHoverPreview() }}
      onBlur={closeHoverPreview}
      data-fixed-focused={(fixedHome && cinematicFocused) || undefined}
      data-mouse-follow={mouseFollowEnabled || undefined}
      className={`relative flex-shrink-0 overflow-visible group cursor-pointer focus-ring transition-[width,transform,opacity] duration-[var(--duration-card)] ease-expo ${cardWidthClass} ${cardSlotHeightClass}`}
      style={style ? { ...rankedStyle, ...style } : rankedStyle}
    >
      {/* The numeral occupies exactly the gutter the poster is offset by, and is
          right-aligned with tabular figures inside it. Previously it was a
          content-width box at -left-1: "1" and "10" therefore sat on different
          left edges, double digits ran under the artwork, and rank 1 bled
          outside the row's page gutter. Its size is expressed in ch of the slot
          rather than vw so it tracks the poster instead of the viewport. */}
      {ranked && (
        <span
          aria-hidden="true"
          className={`media-rank ${rankedTrailerHeightClass}`}
          style={{ fontSize: rankedNumberFontSize, width: rankedNumberSlotWidth }}
        >
          <span className="media-rank__value" data-digits={String(rankedValue).length}>
            {rankedValue}
          </span>
        </span>
      )}
      <div data-hero-viewport className={`poster-artwork-viewport relative z-[1] ${posterOverlay.enabled ? 'rounded-xl' : 'rounded-lg'} overflow-hidden mb-2.5 border border-white/[0.04] transition-[width,box-shadow,transform] duration-[var(--duration-card)] ease-expo group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)] ${nativeTrailerVisible ? 'bg-transparent' : posterOverlay.enabled ? posterBackgroundClass : 'bg-surface-elevated'} ${ranked ? `${rankedContentClass} ${rankedTrailerHeightClass}` : ''} ${trailerExpanded && !ranked ? expandedPosterHeightClass : !ranked ? `aspect-[2/3] ${posterOverlay.enabled ? 'rounded-xl' : 'rounded-lg'} ${posterHoverClass}` : `${posterOverlay.enabled ? 'rounded-xl' : 'rounded-lg'} ${posterHoverClass}`} `}>
        {inlineTrailerPreview ? (
          <div className="relative h-full w-full">
            {posterArtworkUrl && <img ref={posterArtworkImageRef} src={cachedImage(posterArtworkUrl)} alt={displayItem.title} className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${nativeTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading={isVisible ? 'eager' : 'lazy'} decoding="async" onLoad={(event) => handlePosterArtworkLoad(event, posterArtworkUrl)} onError={(event) => handleImageError(event, posterArtworkUrl)} />}
            {useNativeTrailerPlayer ? (
              <React.Suspense fallback={null}><HeroMpvTrailer
                trailer={inlineTrailerPreview}
                muted={!posterTrailerSound}
                className="absolute inset-0 z-[1]"
                onEnded={closeHoverPreview}
                onUnavailable={closeHoverPreview}
                onPlayingChange={setNativeTrailerVisible}
              /></React.Suspense>
            ) : (
              <React.Suspense fallback={null}><TrailerPreview
                trailer={inlineTrailerPreview}
                title={displayItem.title}
                muted={!posterTrailerSound}
                preferVideoOnly={!posterTrailerSound}
                eager
                showShade={false}
                placeholderUrl={posterUrl}
              /></React.Suspense>
            )}
          </div>
        ) : posterArtworkUrl ? (
          <img
            ref={posterArtworkImageRef}
            src={cachedImage(posterArtworkUrl)}
            alt={displayItem.title}
            className={`media-card-artwork w-full h-full object-cover transition-transform duration-500 ease-out ${posterImageHoverClass}`}
            loading={isVisible ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={(event) => handlePosterArtworkLoad(event, posterArtworkUrl)}
            onError={(event) => handleImageError(event, posterArtworkUrl)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
            <span className="text-3xl font-bold text-muted/30">{displayItem.title?.charAt(0) || '?'}</span>
          </div>
        )}

        {/* A neutral black fade keeps the artwork visible and poster details legible. */}
        {!inlineTrailerPreview && posterFadeVisible && <div className={`poster-artwork-fade absolute inset-x-0 bottom-0 ${posterFade.heightClass} ${posterFade.colorClass}`} style={{ background: posterFade.background }} />}
        {!inlineTrailerPreview && !posterFadeVisible && <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />}
        {!inlineTrailerPreview && posterBottomStack()}

        {!inlineTrailerPreview && posterDetailsBadges}
        {!inlineTrailerPreview && posterWatchedLine}

        {import.meta.env.DEV && displayItem.metadataFallback && (
          <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-amber-500/90 text-black text-tag font-bold z-20">metadata fallback</div>
        )}
        {posterOverlay.enabled && posterProgressRing}
        {!inlineTrailerPreview && !isPosterCompositionReady(posterArtworkUrl, posterLogoUrl) && <div aria-hidden="true" className="absolute inset-0 z-[60] bg-black" />}
      </div>
      {posterOverlay.showRatingBelow && ratingStr && <p className={`${POSTER_RATING_CAPTION_CLASS} ${ranked ? rankedNumberSlotClass : 'pl-1'}`} aria-label={`Rating ${ratingStr} out of 10`}><svg className={POSTER_RATING_CAPTION_STAR_CLASS} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</p>}
      {!fixedHome && <>
        {!ranked && <h3 className="text-xs font-semibold text-gray-300 truncate group-hover:text-white transition-colors pl-1">
          {displayItem.title}
        </h3>}
        {inlineTrailerPreview ? (
          ranked && trailerExpanded ? null : <>
            {(genre || displayItem.year) && (
              <p className="text-meta text-muted pl-1 mt-0.5 truncate">
                {[genre, displayItem.year].filter(Boolean).join(' · ')}
              </p>
            )}
          </>
        ) : displayItem.year && (
          <p className={`text-label text-muted pl-1 mt-0.5 ${ranked ? rankedNumberSlotClass : ''}`}>{displayItem.year}</p>
        )}
      </>}
    </button>
  )
}

export default React.memo(MediaCard)
