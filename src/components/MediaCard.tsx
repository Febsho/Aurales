import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import { applyInitialArtworkPreference, applySearchResultArt, getSearchResultCustomArt, resolveArtFromProviders } from '../services/artwork'
import { getTmdbCardMetadata, getTmdbLandscapeBackdrop } from '../services/tmdb'
import { getTrailerSource, type TrailerSource } from '../services/trailers'
import { cachedImage, warmCachedImage } from '../services/imageCache'
import { useAppStore } from '../stores/appStore'
import { useWatchedCacheStore } from '../stores/watchedCacheStore'
import { useContextMenu } from '../hooks/useContextMenu'
import TrailerPreview from './TrailerPreview'
import HeroMpvTrailer from './HeroMpvTrailer'
import { cardArtworkUrl } from '../services/mediaPresentation'
import { nativePlayerSupported } from '../services/player'
import { useVisibilityOnce } from '../hooks/useVisibilityOnce'

const TMDB_GENRES: Record<number, string> = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',
  18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',
  9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',
  10752:'War',37:'Western',10759:'Action & Adventure',10762:'Kids',10763:'News',
  10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics',
}

interface MediaCardProps {
  item: SearchResult
  layout?: 'poster' | 'landscape'
  disableArtOverride?: boolean
  disableTrailerPreview?: boolean
  rank?: number
  onFocusItem?: (item: SearchResult) => void
  onUnfocusItem?: (item: SearchResult) => void
  cinematicMode?: boolean
  cinematicFocused?: boolean
  /** Set false to keep cinematic cards at poster size (no landscape expansion on focus). */
  cinematicExpand?: boolean
}

function MediaCard({ item, layout = 'poster', disableArtOverride = false, disableTrailerPreview = false, rank, onFocusItem, onUnfocusItem, cinematicMode = false, cinematicFocused = false, cinematicExpand = true }: MediaCardProps) {
  const cardRef = useRef<HTMLButtonElement>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const hoverRequestRef = useRef(0)
  const collapseResetRef = useRef<number | null>(null)
  const isVisible = useVisibilityOnce(cardRef, { rootMargin: '200px' })
  const [hoverTrailer, setHoverTrailer] = useState<TrailerSource | null>(null)
  const [hoverPreviewOpen, setHoverPreviewOpen] = useState(false)
  const [nativeTrailerVisible, setNativeTrailerVisible] = useState(false)
  const [snapCollapse, setSnapCollapse] = useState(false)
  const [suppressPosterHover, setSuppressPosterHover] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  const navigate = useNavigate()
  const displayItem = disableArtOverride ? item : applySearchResultArt(item)
  const initialArtItem = disableArtOverride
    ? displayItem
    : applyInitialArtworkPreference(displayItem, displayItem.type, Boolean(displayItem.isAnime))
  const announceFocus = () => {
    const focusedItem = {
      ...displayItem,
      poster: posterUrl || initialArtItem.poster,
      backdrop: backdropUrl || initialArtItem.backdrop,
      logo: logoUrl || initialArtItem.logo,
    }
    onFocusItem?.(focusedItem)
    window.dispatchEvent(new CustomEvent<SearchResult>('aurales:media-focus', { detail: focusedItem }))
  }
  const customArt = disableArtOverride ? {} : getSearchResultCustomArt(item)
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(new Set())
  const [resolvedBackdrop, setResolvedBackdrop] = useState<string | undefined>(undefined)
  const [resolvedPoster, setResolvedPoster] = useState<string | undefined>(undefined)
  const [resolvedLogo, setResolvedLogo] = useState<string | undefined>(undefined)
  const [resolvedCustomArt, setResolvedCustomArt] = useState<{ poster?: string; backdrop?: string; logo?: string }>({})
  const [resolvedGenre, setResolvedGenre] = useState<string | undefined>(undefined)
  const providerWatched = useWatchedCacheStore((s) => {
    const keys = s.watchedKeys
    if (item.imdbId && keys.has(`imdb:${item.imdbId}`)) return true
    if (item.tmdbId && keys.has(`tmdb:${item.tmdbId}`)) return true
    if (item.tvdbId && keys.has(`tvdb:${String(item.tvdbId).replace('tvdb-', '')}`)) return true
    if (item.malId && keys.has(`mal:${item.malId}`)) return true
    if (item.anilistId && keys.has(`anilist:${item.anilistId}`)) return true
    return false
  })
  const posterSize = useAppStore((s) => s.posterSize)
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
  const appManagedMetadata = useAppStore((s) => s.appManagedMetadata)
  const addRecentlyWatched = useAppStore((s) => s.addRecentlyWatched)
  const artProviderKey = useMemo(() => JSON.stringify(artProviders), [artProviders])
  const customArtKey = useMemo(() => JSON.stringify(customArtUrls), [customArtUrls])
  const trailerLanguage = preferredAudio[0] || preferredSubtitles[0] || 'en'

  const localCompleted = useAppStore((s) => {
    const ci = s.completedIds
    if (item.id && ci.has(String(item.id))) return true
    if (item.imdbId && ci.has(String(item.imdbId))) return true
    if (item.type === 'series' && item.season != null && item.episode != null) {
      if (item.id && ci.has(`${item.id}:${item.season}:${item.episode}`)) return true
      if (item.imdbId && ci.has(`${item.imdbId}:${item.season}:${item.episode}`)) return true
    }
    return false
  })

  const progressPct = useAppStore((s) => {
    const p = (item.id && s.watchProgress.get(String(item.id)))
      || (item.imdbId && s.watchProgress.get(item.imdbId))
    if (p && !p.completed && p.durationSeconds > 0) {
      return (p.progressSeconds / p.durationSeconds) * 100
    }
    return null
  })

  const ratingStr = useMemo(() => {
    if (!displayItem.rating) return null
    const n = Number(displayItem.rating)
    if (isNaN(n)) return null
    const formatted = n % 1 === 0 ? String(n) : n.toFixed(1)
    return formatted.replace(/\/10$/, '').trim()
  }, [displayItem.rating])

  const getDisplayProvider = (item: SearchResult) => {
    if (item.provider === 'addon') {
      const genres = item.genres?.map((g) => g.toLowerCase()) || []
      const isAnime = item.isAnime || 
                      /^(mal|anilist)[-:]/i.test(item.id) || 
                      genres.includes('anime') || 
                      ((item.genreIds?.includes(16) || genres.includes('animation')) && ['ja', 'zh', 'ko'].includes(item.originalLanguage || ''))
      if (isAnime) {
        return useAppStore.getState().animeMetadataSource ?? 'tvdb'
      }
      if (item.type === 'movie') {
        return useAppStore.getState().movieMetadataSource ?? 'tmdb'
      }
      return useAppStore.getState().seriesMetadataSource ?? 'tmdb'
    }
    return item.provider
  }

  const widthClass = useMemo(() => {
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
  }, [layout, posterSize])

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

  const isCompleted = localCompleted || providerWatched

  useEffect(() => {
    if (!isVisible) return
    let cancelled = false
    setFailedImageUrls(new Set())
    setResolvedPoster(undefined)
    setResolvedBackdrop(undefined)
    setResolvedCustomArt({})
    // Preserve the addon's art without starting TMDB/TVDB/Fanart bridge and
    // artwork requests for every card when managed metadata is disabled.
    if (!appManagedMetadata) return
    const tmdbId = displayItem.tmdbId || (String(displayItem.id).startsWith('tmdb-') ? String(displayItem.id).replace('tmdb-', '') : undefined)
    const imdbId = displayItem.imdbId || (String(displayItem.id).startsWith('tt') ? displayItem.id : undefined)

    const needsPoster = layout !== 'landscape' && !displayItem.poster
    const needsBackdrop = layout === 'landscape' && !displayItem.backdrop
    const needsGenre = showGenreOnCards && !displayItem.genres?.length && !displayItem.genreIds?.length
    const wantsProviderArt = !disableArtOverride

    if (!needsPoster && !needsBackdrop && !needsGenre && !wantsProviderArt) {
      if (layout === 'landscape' && !displayItem.backdrop && tmdbId) {
        getTmdbLandscapeBackdrop(displayItem.type, tmdbId)
          .then((backdrop) => { if (!cancelled && backdrop) setResolvedBackdrop(backdrop) })
          .catch(() => undefined)
      }
      return () => { cancelled = true }
    }

    ;(async () => {
      try {
        let resolvedTmdbId = tmdbId
        let resolvedImdbId = imdbId
        if (!resolvedTmdbId && imdbId) {
          const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
          const found = await tmdbFindByExternalId(imdbId, 'imdb_id')
          if (found.tmdbId) resolvedTmdbId = String(found.tmdbId)
        }
        if (!resolvedImdbId && (resolvedTmdbId || displayItem.tvdbId) && customArtKey.includes('{imdb_id}')) {
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
        let finalPoster: string | undefined
        let finalBackdrop: string | undefined
        let finalLogo: string | undefined
        let finalGenre: string | undefined

        if (resolvedTmdbId && (needsPoster || needsBackdrop || needsGenre)) {
          const meta = await getTmdbCardMetadata(displayItem.type, resolvedTmdbId, resolvedImdbId)
          if (meta.poster) finalPoster = meta.poster
          if (meta.backdrop) finalBackdrop = meta.backdrop
          if (meta.genre) finalGenre = meta.genre
        }

        if (wantsProviderArt) {
          const providerArt = await resolveArtFromProviders(
            displayItem.type,
            { tmdbId: resolvedTmdbId || tmdbId, tvdbId: displayItem.tvdbId as string | number | undefined, imdbId: resolvedImdbId },
            displayItem.isAnime,
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
    })()
    return () => { cancelled = true }
  }, [isVisible, layout, disableArtOverride, displayItem.poster, displayItem.backdrop, displayItem.id, displayItem.tmdbId, displayItem.tvdbId, displayItem.imdbId, displayItem.type, displayItem.isAnime, showGenreOnCards, artProviderKey, fanartApiKey, customArtKey, appManagedMetadata])

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
  const logoUrl = pickWorkingUrl(customArt.logo, resolvedCustomArt.logo, resolvedLogo, initialArtItem.logo)
  const landscapeBackdrop = backdropUrl
  const markImageFailed = (url?: string) => {
    if (!url) return
    setFailedImageUrls((prev) => {
      const next = new Set(prev)
      next.add(url)
      return next
    })
  }
  const warmDetailArtwork = useCallback(() => {
    void warmCachedImage(backdropUrl)
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

  const handleClick = () => {
    warmDetailArtwork()
    try {
      addRecentlyWatched(displayItem)
    } catch (_) { /* ignore */ }
    const path = item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`
    navigate(path, {
      state: {
        poster: posterUrl,
        backdrop: backdropUrl,
        logo: logoUrl,
        title: displayItem.title,
        year: displayItem.year,
        rating: displayItem.rating,
        overview: displayItem.overview,
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
      const rowRect = row.getBoundingClientRect()
      const inset = 24
      if (cardRect.right > rowRect.right - inset) {
        row.scrollBy({ left: cardRect.right - rowRect.right + inset, behavior: 'smooth' })
      } else if (cardRect.left < rowRect.left + inset) {
        row.scrollBy({ left: cardRect.left - rowRect.left - inset, behavior: 'smooth' })
      }
    }, 380)
  }, [cinematicMode, cinematicExpand])

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const sync = () => setReducedMotion(query.matches)
    sync()
    query.addEventListener?.('change', sync)
    return () => query.removeEventListener?.('change', sync)
  }, [])

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
      if (collapseResetRef.current) window.cancelAnimationFrame(collapseResetRef.current)
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
    if (collapseResetRef.current) window.cancelAnimationFrame(collapseResetRef.current)
    setSnapCollapse(true)
    setSuppressPosterHover(true)
    setNativeTrailerVisible(false)
    setHoverTrailer(null)
    setHoverPreviewOpen(false)
    collapseResetRef.current = window.requestAnimationFrame(() => {
      setSnapCollapse(false)
      collapseResetRef.current = null
    })
  }, [])

  const openHoverPreview = useCallback(() => {
    setSuppressPosterHover(false)
    if (disableTrailerPreview || (layout !== 'poster' && !cinematicMode) || reducedMotion || !posterTrailerPreviews) return
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)

    hoverTimerRef.current = window.setTimeout(() => {
      const tmdbId = displayItem.tmdbId || (String(displayItem.id).startsWith('tmdb-') ? String(displayItem.id).replace('tmdb-', '') : undefined)
      const requestId = hoverRequestRef.current + 1
      hoverRequestRef.current = requestId

      getTrailerSource({
        type: displayItem.type,
        tmdbId,
        title: displayItem.title,
        year: displayItem.year,
        language: trailerLanguage,
      }).then((trailer) => {
        if (hoverRequestRef.current !== requestId || !trailer) return
        setHoverTrailer(trailer)
        setHoverPreviewOpen(true)
      }).catch(() => undefined)
    }, posterTrailerHoverDelayMs)
  }, [cinematicMode, cinematicExpand, disableTrailerPreview, displayItem.id, displayItem.tmdbId, displayItem.title, displayItem.type, displayItem.year, layout, posterTrailerHoverDelayMs, posterTrailerPreviews, reducedMotion, trailerLanguage])

  const useNativeTrailerPlayer = nativePlayerSupported()

  if (cinematicMode) {
    const cinematicGenre = displayItem.genres?.[0]
      || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : null)
      || resolvedGenre
    const focusMedia = landscapeBackdrop || posterUrl
    const expanded = cinematicFocused && cinematicExpand
    const cinematicTrailer = hoverPreviewOpen && hoverTrailer
    return (
      <button
        ref={cardRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onFocus={() => { warmDetailArtwork(); announceFocus(); revealExpandedCard(); openHoverPreview() }}
        onBlur={() => { onUnfocusItem?.(displayItem); closeHoverPreview() }}
        onMouseEnter={() => { warmDetailArtwork(); announceFocus(); revealExpandedCard(); openHoverPreview() }}
        onMouseLeave={() => { onUnfocusItem?.(displayItem); closeHoverPreview() }}
        className={`relative flex-shrink-0 cursor-pointer text-left focus-ring transition-[width] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${expanded ? 'w-[min(38vw,38rem)]' : 'w-[clamp(10rem,13vw,13rem)]'}`}
      >
        <div data-hero-viewport className={`relative h-[clamp(15rem,19.5vw,19.5rem)] overflow-hidden rounded-2xl border transition-[border-color,box-shadow,transform] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${nativeTrailerVisible ? 'bg-transparent' : 'bg-surface-elevated'} ${cinematicFocused ? 'border-white/75 shadow-[0_18px_55px_rgba(0,0,0,.7)]' : 'border-white/10'}`}>
          {posterUrl && <img src={cachedImage(posterUrl)} alt={displayItem.title} className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${expanded || nativeTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading="lazy" decoding="async" onError={() => markImageFailed(posterUrl)} />}
          {expanded && focusMedia && <img src={cachedImage(focusMedia)} alt="" className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${nativeTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading="lazy" decoding="async" onError={() => markImageFailed(focusMedia)} />}
          {cinematicTrailer && (useNativeTrailerPlayer ? (
            <HeroMpvTrailer
              trailer={cinematicTrailer}
              muted={!posterTrailerSound}
              className="absolute inset-0 z-[5]"
              onEnded={closeHoverPreview}
              onUnavailable={closeHoverPreview}
              onPlayingChange={setNativeTrailerVisible}
            />
          ) : (
            <TrailerPreview trailer={cinematicTrailer} title={displayItem.title} muted={!posterTrailerSound} preferVideoOnly={!posterTrailerSound} eager showShade={false} placeholderUrl={focusMedia} className="absolute inset-0 z-[5]" />
          ))}
          {!posterUrl && !focusMedia && <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface text-3xl font-bold text-white/20">{displayItem.title?.charAt(0) || '?'}</div>}
          <div className={`absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent transition-opacity duration-300 ${expanded ? 'opacity-100' : 'opacity-60'}`} />
          {expanded && <div className="absolute inset-x-4 bottom-4 z-10">
            {logoUrl ? <img src={cachedImage(logoUrl)} alt={displayItem.title} className="mb-1 max-h-16 max-w-[55%] object-contain object-left drop-shadow-xl" /> : <h3 className="truncate text-base font-black text-white drop-shadow-xl">{displayItem.title}</h3>}
          </div>}
          {!isCompleted && progressPct != null && progressPct > 2 && <div className="absolute inset-x-0 bottom-0 z-20 h-1 bg-black/40"><div className="h-full bg-accent" style={{ width: `${Math.min(progressPct, 100)}%` }} /></div>}
        </div>
        <div className={`absolute left-0 top-full grid w-full transition-[grid-template-rows,opacity] duration-300 ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden">
            <div className="px-2 pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-white/85">
                {cinematicGenre && <span>{cinematicGenre}</span>}
                {cinematicGenre && displayItem.year && <span className="text-white/30">•</span>}
                {displayItem.year && <span>{displayItem.year}</span>}
                {ratingStr && <><span className="text-white/30">•</span><span>★ {ratingStr}</span></>}
                {getDisplayProvider(displayItem) && <><span className="text-white/30">•</span><span className="capitalize">{getDisplayProvider(displayItem)}</span></>}
              </div>
              {displayItem.overview && <p className="line-clamp-2 max-w-md text-base leading-relaxed text-white/55 h-[3.25rem]">{displayItem.overview}</p>}
            </div>
          </div>
        </div>
      </button>
    )
  }

  if (layout === 'landscape') {
    const cinematicLandscapeExpanded = cinematicMode && cinematicFocused && cinematicExpand
    const cinematicWidth = cinematicMode
      ? cinematicLandscapeExpanded ? 'w-[min(52vw,52rem)]' : 'w-[clamp(15rem,18vw,21rem)]'
      : widthClass
    return (
      <button
        ref={cardRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onFocus={() => { warmDetailArtwork(); announceFocus() }}
        onMouseEnter={() => { warmDetailArtwork(); announceFocus() }}
        className={`flex-shrink-0 group cursor-pointer focus-ring text-left transition-[width,transform] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${cinematicWidth}`}
      >
        <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated border border-white/[0.04] transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)] group-hover:-translate-y-1.5 group-hover:scale-[1.03]">
          {landscapeBackdrop ? (
            <img
              src={cachedImage(landscapeBackdrop)}
              alt={displayItem.title}
              className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              loading="lazy"
              decoding="async"
              onError={() => markImageFailed(landscapeBackdrop)}
            />
          ) : posterUrl ? (
            <img
              src={cachedImage(posterUrl)}
              alt={displayItem.title}
              className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              loading="lazy"
              decoding="async"
              onError={() => markImageFailed(posterUrl)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
              <span className="text-2xl font-bold text-muted/30">{displayItem.title?.charAt(0) || '?'}</span>
            </div>
          )}
          
          {/* Permanent subtle dark gradient overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent transition-opacity duration-300 group-hover:from-black/95" />
          
          {/* Rating badge (landscape) */}
          {showRatingsOnCards && ratingStr && (
            <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md border border-white/10 flex items-center gap-1 shadow-lg z-10 text-[10px] font-bold text-yellow-400">
              <svg className="w-3 h-3 fill-current text-yellow-400" viewBox="0 0 24 24">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
              <span>{ratingStr}</span>
            </div>
          )}

          {/* In-progress bar (landscape) */}
          {!isCompleted && progressPct != null && progressPct > 2 && (
            <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40 z-10">
              <div className="h-full bg-accent rounded-r-full" style={{ width: `${Math.min(progressPct, 100)}%` }} />
            </div>
          )}

          {/* Media Info Overlay */}
          <div className="absolute bottom-3 left-3 right-3 flex flex-col gap-1">
            {cinematicLandscapeExpanded && logoUrl ? (
              <img src={cachedImage(logoUrl)} alt={displayItem.title} className="mb-1 max-h-16 max-w-[55%] object-contain object-left drop-shadow-xl" />
            ) : (
              <h3 className="text-sm md:text-base font-bold text-white tracking-wide truncate drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                {displayItem.title}
              </h3>
            )}
            <div className="flex items-center gap-2">
              {displayItem.year && (
                <span className="text-xs text-gray-300 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {displayItem.year}
                </span>
              )}
            </div>
          </div>
        </div>
        {cinematicLandscapeExpanded && (
          <div className="px-2 pt-4 pb-1 animate-[cinematic-panel-in_180ms_cubic-bezier(.16,1,.3,1)]">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold text-white/85">
              {displayItem.genres?.slice(0, 2).map((genre) => {
                const text = typeof genre === 'object' && genre ? (genre as any).name || (genre as any).title || JSON.stringify(genre) : genre
                return <span key={text}>{text}</span>
              })}
              {displayItem.genres?.length && displayItem.year ? <span className="text-white/30">•</span> : null}
              {displayItem.year && <span>{displayItem.year}</span>}
              {ratingStr && <><span className="text-white/30">•</span><span>★ {ratingStr}</span></>}
              {getDisplayProvider(displayItem) && <><span className="text-white/30">•</span><span className="capitalize">{getDisplayProvider(displayItem)}</span></>}
            </div>
            {displayItem.overview && <p className="line-clamp-2 max-w-xl text-base leading-relaxed text-white/55 h-[3.25rem]">{displayItem.overview}</p>}
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
  const cardWidthClass = inlineTrailerPreview ? expandedPosterWidthClass : widthClass
  const cardLiftClass = inlineTrailerPreview ? '-translate-y-2' : ''
  const posterHoverClass = suppressPosterHover || snapCollapse ? '' : 'group-hover:-translate-y-2 group-hover:scale-[1.04]'
  const posterImageHoverClass = suppressPosterHover || snapCollapse ? '' : 'group-hover:scale-105'

  return (
    <button
      ref={cardRef}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => { warmDetailArtwork(); announceFocus(); openHoverPreview() }}
      onMouseLeave={closeHoverPreview}
      onFocus={() => { warmDetailArtwork(); announceFocus(); openHoverPreview() }}
      onBlur={closeHoverPreview}
      className={`relative flex-shrink-0 overflow-visible group cursor-pointer focus-ring ${snapCollapse ? 'transition-none' : 'transition-[width,transform,opacity] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)]'} ${cardWidthClass} ${posterSlotHeightClass} ${cardLiftClass}`}
    >
      <div data-hero-viewport className={`relative rounded-lg overflow-hidden mb-2.5 border border-white/[0.04] transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)] ${nativeTrailerVisible ? 'bg-transparent' : 'bg-surface-elevated'} ${inlineTrailerPreview ? expandedPosterHeightClass : `aspect-[2/3] rounded-2xl ${posterHoverClass}`}`}>
        {inlineTrailerPreview ? (
          <div className="relative h-full w-full">
            {posterUrl && <img src={cachedImage(posterUrl)} alt={displayItem.title} className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${nativeTrailerVisible ? 'opacity-0' : 'opacity-100'}`} loading="lazy" decoding="async" onError={() => markImageFailed(posterUrl)} />}
            {useNativeTrailerPlayer ? (
              <HeroMpvTrailer
                trailer={inlineTrailerPreview}
                muted={!posterTrailerSound}
                className="absolute inset-0 z-[1]"
                onEnded={closeHoverPreview}
                onUnavailable={closeHoverPreview}
                onPlayingChange={setNativeTrailerVisible}
              />
            ) : (
              <TrailerPreview
                trailer={inlineTrailerPreview}
                title={displayItem.title}
                muted={!posterTrailerSound}
                preferVideoOnly={!posterTrailerSound}
                eager
                showShade={false}
                placeholderUrl={posterUrl}
              />
            )}
          </div>
        ) : posterUrl ? (
          <img
            src={cachedImage(posterUrl)}
            alt={displayItem.title}
            className={`w-full h-full object-cover transition-transform duration-500 ease-out ${posterImageHoverClass}`}
            loading="lazy"
            decoding="async"
            onError={() => markImageFailed(posterUrl)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
            <span className="text-3xl font-bold text-muted/30">{displayItem.title?.charAt(0) || '?'}</span>
          </div>
        )}

        {/* Bottom gradient overlay with genre + rating */}
        {!inlineTrailerPreview && <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/90 via-black/50 to-transparent" />}
        {!inlineTrailerPreview && (showGenreOnCards || showRatingsOnCards) && (
          <div className="absolute bottom-2.5 left-2.5 right-2.5 z-10 flex items-center justify-center gap-1.5">
            {showGenreOnCards && genre && (
              <span className="text-[10px] font-semibold text-white/70 tracking-wide">
                {genre}
              </span>
            )}
            {showGenreOnCards && genre && showRatingsOnCards && ratingStr && (
              <span className="text-white/30">·</span>
            )}
            {showRatingsOnCards && ratingStr && (
              <span className="flex items-center gap-0.5 text-[10px] font-bold text-yellow-400">
                <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                  <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                </svg>
                {ratingStr}
              </span>
            )}
          </div>
        )}

        {import.meta.env.DEV && displayItem.metadataFallback && (
          <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-amber-500/90 text-black text-[9px] font-bold z-20">metadata fallback</div>
        )}

        {/* In-progress bar */}
        {!isCompleted && progressPct != null && progressPct > 2 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40 z-10">
            <div className="h-full bg-accent rounded-r-full" style={{ width: `${Math.min(progressPct, 100)}%` }} />
          </div>
        )}
      </div>
      <h3 className="text-xs font-semibold text-gray-300 truncate group-hover:text-white transition-colors pl-1">
        {displayItem.title}
      </h3>
      {inlineTrailerPreview ? (
        <>
          {(genre || displayItem.year) && (
            <p className="text-[10px] text-muted/80 pl-1 mt-0.5 truncate">
              {[genre, displayItem.year].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      ) : displayItem.year && (
        <p className="text-[11px] text-muted/80 pl-1 mt-0.5">{displayItem.year}</p>
      )}
    </button>
  )
}

export default React.memo(MediaCard)
