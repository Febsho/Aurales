import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Volume2, VolumeX } from 'lucide-react'
import type { SearchResult } from '../types'
import { applyInitialArtworkPreference, applySearchResultArt, resolveArtFromProviders } from '../services/artwork'
import { getTmdbHeroCast, getTmdbLandscapeBackdrop } from '../services/tmdb'
import { getTrailerSource, preloadTrailerSource, type TrailerSource } from '../services/trailers'
import { cachedImage } from '../services/imageCache'
import { useAppStore } from '../stores/appStore'
import RatingsStrip from './RatingsStrip'
import HeroMpvTrailer from './HeroMpvTrailer'
import { Button } from './ui'
import WatchlistButton from './WatchlistButton'
import { waitForContinueWatchingSettled } from '../services/cache/homeStartupCoordinator'
import { metadataTaskQueue, scheduleTask } from '../services/cache/backgroundTaskQueue'

interface HeroSectionProps {
  items: SearchResult[]
  isSmall?: boolean
  fixed?: boolean
  onActiveBackdropChange?: (url: string | undefined) => void
  enableTrailers?: boolean
  onActiveImageSettled?: () => void
}

function preloadImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(url)
    img.onerror = reject
    img.src = url
  })
}

function usableBackdrop(item?: SearchResult): string | undefined {
  if (!item?.backdrop || item.backdrop === item.poster) return undefined
  return item.backdrop
}

function HeroSection({ items, isSmall = false, fixed = false, onActiveBackdropChange, enableTrailers = true, onActiveImageSettled }: HeroSectionProps) {
  const navigate = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  // Keep the currently displayed slide stable.  Artwork providers resolve
  // asynchronously and may return a different backdrop/logo than the catalog
  // supplied; applying that result halfway through a slide looks like the hero
  // rapidly changes to another title.
  const [presentedItem, setPresentedItem] = useState<SearchResult>(() => items[0])
  const [presentedBackdrop, setPresentedBackdrop] = useState<string | undefined>(() => usableBackdrop(items[0]))
  const [logoError, setLogoError] = useState(false)
  const [scrollBlur, setScrollBlur] = useState(0)
  const [cast, setCast] = useState<{ name: string; photo?: string }[]>([])
  const heroRef = useRef<HTMLDivElement>(null)
  const count = items.length
  // Parents may derive a new array during an unrelated render.  Its identity
  // should not restart the carousel unless the actual set of hero items changed.
  const itemSetKey = useMemo(() => items.map((item) => String(item.id)).join('|'), [items])
  const artProviders = useAppStore((s) => s.artProviders)
  const fanartApiKey = useAppStore((s) => s.fanartApiKey)
  const customArtUrls = useAppStore((s) => s.customArtUrls)
  const heroTrailerDelay = useAppStore((s) => s.heroTrailerDelay)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const usesTopNav = useAppStore((s) => s.navigationStyle) === 'topbar'
  const preferredAudio = useAppStore((s) => s.preferredAudio)
  const preferredSubtitles = useAppStore((s) => s.preferredSubtitles)
  const artProviderKey = useMemo(() => JSON.stringify(artProviders), [artProviders])
  const customArtKey = useMemo(() => JSON.stringify(customArtUrls), [customArtUrls])
  const trailerLanguage = preferredAudio[0] || preferredSubtitles[0] || 'en'
  const [heroTrailer, setHeroTrailer] = useState<TrailerSource | null>(null)
  const [heroTrailerPlaying, setHeroTrailerPlaying] = useState(false)
  const [heroTrailerMuted, setHeroTrailerMuted] = useState(true)
  // True while the embedded mpv trailer renders frames — the slide's backdrop
  // must stop painting so the video shows through the transparent webview.
  const [heroMpvVisible, setHeroMpvVisible] = useState(false)
  const [startupEnrichmentReady, setStartupEnrichmentReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    waitForContinueWatchingSettled().then(() => { if (!cancelled) setStartupEnrichmentReady(true) })
    return () => { cancelled = true }
  }, [])

  const goTo = useCallback(
    (i: number) => {
      setHeroMpvVisible(false)
      setHeroTrailerPlaying(false)
      setHeroTrailer(null)
      setActiveIndex(((i % count) + count) % count)
    },
    [count],
  )

  useEffect(() => {
    setLogoError(false)
    setHeroTrailerMuted(true)
  }, [activeIndex])

  useEffect(() => {
    setActiveIndex(0)
  }, [itemSetKey])

  const [scrolledAway, setScrolledAway] = useState(false)

  useEffect(() => {
    if (count <= 1) return
    if (scrolledAway) return
    if (heroTrailerPlaying) return
    const id = setInterval(() => setActiveIndex((prev) => (prev + 1) % count), 8000)
    return () => clearInterval(id)
  }, [count, scrolledAway, heroTrailerPlaying])

  // Scroll blur: listen to the scroll container (closest overflow-y parent)
  useEffect(() => {
    if (isSmall) return
    const el = heroRef.current
    if (!el) return
    const scrollParent = el.closest('[class*="overflow-y"]') as HTMLElement | null
    if (!scrollParent) return

    const onScroll = () => {
      const t = scrollParent.scrollTop
      setScrollBlur(Math.min(t / 400, 1) * 20)
      setScrolledAway(t > 100)
    }
    scrollParent.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollParent.removeEventListener('scroll', onScroll)
  }, [isSmall])

  // Upgrade backdrops to highest-voted from TMDB images endpoint
  const [upgradedBackdrops, setUpgradedBackdrops] = useState<Record<string, string>>({})
  const [providerArt, setProviderArt] = useState<Record<string, { poster?: string; backdrop?: string; logo?: string }>>({})

  useEffect(() => {
    if (!startupEnrichmentReady) return
    let cancelled = false
    const toFetch = items.filter((itm) => {
      const tmdbId = itm.tmdbId || (String(itm.id).startsWith('tmdb-') ? String(itm.id).replace('tmdb-', '') : undefined)
      return tmdbId && !upgradedBackdrops[String(itm.id)]
    })
    toFetch.forEach((itm) => {
      const tmdbId = itm.tmdbId || String(itm.id).replace('tmdb-', '')
      const t = itm.type === 'series' ? 'series' : 'movie'
      scheduleTask(metadataTaskQueue, {
        id: `hero-backdrop:${itm.id}`,
        dedupKey: `hero-backdrop:${itm.id}`,
        priority: 'low',
        group: 'metadata',
        execute: () => getTmdbLandscapeBackdrop(t, tmdbId),
      })
        .then((url) => {
          if (!cancelled && url) {
            preloadImage(url)
              .then(() => {
                if (!cancelled) {
                  setUpgradedBackdrops((prev) => ({ ...prev, [String(itm.id)]: url }))
                }
              })
              .catch(() => {
                if (!cancelled) {
                  setUpgradedBackdrops((prev) => ({ ...prev, [String(itm.id)]: url }))
                }
              })
          }
        })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [items, startupEnrichmentReady])

  useEffect(() => {
    if (!startupEnrichmentReady) return
    let cancelled = false
    setProviderArt({})
    items.forEach((itm) => {
      const key = String(itm.id)
      scheduleTask(metadataTaskQueue, {
        id: `hero-art:${key}`,
        dedupKey: `hero-art:${key}`,
        priority: 'idle',
        group: 'metadata',
        execute: () => resolveArtFromProviders(
          itm.type === 'series' ? 'series' : 'movie',
          { tmdbId: itm.tmdbId, tvdbId: itm.tvdbId, imdbId: itm.imdbId },
          itm.isAnime,
        ),
      }).then(async (art) => {
        if (!cancelled) {
          const preloads = []
          if (art.backdrop) preloads.push(preloadImage(art.backdrop).catch(() => {}))
          if (art.poster) preloads.push(preloadImage(art.poster).catch(() => {}))
          await Promise.all(preloads)

          if (!cancelled) {
            setProviderArt((prev) => ({ ...prev, [key]: art }))
          }
        }
      }).catch(() => undefined)
    })
    return () => { cancelled = true }
  }, [items, artProviderKey, fanartApiKey, startupEnrichmentReady])

  const displayItems = useMemo(() => items.map((raw) => {
    const art = providerArt[String(raw.id)]
    const initial = applyInitialArtworkPreference(raw, raw.type, Boolean(raw.isAnime))
    return applySearchResultArt(art ? { ...initial, ...art } : initial)
  }), [items, providerArt])
  useEffect(() => {
    const nextItem = displayItems[activeIndex]
    if (nextItem) {
      setPresentedItem(nextItem)
      setPresentedBackdrop(upgradedBackdrops[String(nextItem.id)] || usableBackdrop(nextItem))
    }
  // Deliberately do not depend on displayItems or upgradedBackdrops: artwork
  // arriving while this slide is visible is saved for its next appearance,
  // rather than swapped in over the current hero.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, itemSetKey])

  // Catalogs occasionally label a poster as a backdrop. Once TMDB has supplied
  // its verified landscape artwork, replace the active slide instead of waiting
  // for the carousel to return to it.
  useEffect(() => {
    const upgraded = upgradedBackdrops[String(presentedItem.id)]
    if (upgraded && upgraded !== presentedBackdrop) setPresentedBackdrop(upgraded)
  }, [presentedItem.id, presentedBackdrop, upgradedBackdrops])

  const item = presentedItem
  const type = item?.type === 'series' ? 'series' : 'movie'

  // Report active backdrop to parent for blurred background
  useEffect(() => {
    if (!onActiveBackdropChange || isSmall) return
    const activeItem = presentedItem
    if (!activeItem) { onActiveBackdropChange(undefined); return }
    const backdrop = presentedBackdrop || usableBackdrop(activeItem)
    onActiveBackdropChange(backdrop)
  }, [presentedItem, presentedBackdrop, customArtKey, isSmall])

  // Fetch top 3 cast for the active hero item
  useEffect(() => {
    if (!item || !startupEnrichmentReady) return
    const tmdbId = item.tmdbId || (String(item.id).startsWith('tmdb-') ? String(item.id).replace('tmdb-', '') : undefined)
    if (!tmdbId) { setCast([]); return }

    let cancelled = false
    getTmdbHeroCast(type, tmdbId)
      .then((c) => { if (!cancelled) setCast(c) })
      .catch(() => { if (!cancelled) setCast([]) })
    return () => { cancelled = true }
  }, [item?.id, item?.tmdbId, type, startupEnrichmentReady])

  useEffect(() => {
    if (!enableTrailers || !item || heroTrailerDelay <= 0 || scrolledAway) {
      setHeroTrailer(null)
      setHeroTrailerPlaying(false)
      return
    }

    const tmdbId = item.tmdbId || (String(item.id).startsWith('tmdb-') ? String(item.id).replace('tmdb-', '') : undefined)
    let cancelled = false
    setHeroTrailer(null)
    setHeroTrailerPlaying(false)
    setHeroTrailerMuted(true)

    const timer = window.setTimeout(() => {
      getTrailerSource({
        type,
        tmdbId,
        title: item.title,
        year: item.year,
        language: trailerLanguage,
      }).then((trailer) => {
        if (!cancelled && trailer) {
          setHeroTrailer(trailer)
          setHeroTrailerPlaying(true)
        }
      }).catch(() => undefined)
    }, heroTrailerDelay * 1000)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      setHeroTrailerPlaying(false)
    }
  }, [enableTrailers, item?.id, item?.tmdbId, item?.title, item?.year, type, heroTrailerDelay, trailerLanguage, scrolledAway])

  useEffect(() => {
    if (!enableTrailers) return
    if (heroTrailerDelay <= 0) return
    if (!displayItems.length) return
    displayItems.slice(activeIndex, activeIndex + 3).forEach((candidate) => {
      const candidateTmdbId = candidate.tmdbId || (String(candidate.id).startsWith('tmdb-') ? String(candidate.id).replace('tmdb-', '') : undefined)
      if (!candidateTmdbId) return
      preloadTrailerSource({
        type: candidate.type === 'series' ? 'series' : 'movie',
        tmdbId: candidateTmdbId,
        title: candidate.title,
        year: candidate.year,
        language: trailerLanguage,
      })
    })
  }, [activeIndex, displayItems, enableTrailers, heroTrailerDelay, trailerLanguage])

  if (!items.length || !item) return null

  const sharedState = {
    poster: item.poster,
    backdrop: item.backdrop,
    logo: item.logo,
    title: item.title,
    year: item.year,
    rating: item.rating,
    overview: item.overview,
    imdbId: 'imdbId' in item ? item.imdbId : undefined,
    addonUrl: 'addonUrl' in item ? item.addonUrl : undefined,
    provider: 'provider' in item ? item.provider : undefined,
    isAnime: item.isAnime,
  }

  const nav = (autoPlay = false) =>
    navigate(type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`, { state: { ...sharedState, autoPlay } })

  const genreStr = item.genres?.[0] || ''
  const ratingLabel = item.rating ? `R` : ''
  const metaLine = [item.year, genreStr, ratingLabel].filter(Boolean).join(' · ')

  // Fixed cinematic Home keeps a shelf anchored below the banner. Give the
  // banner a little more vertical presence and reduce its top offset so neither
  // gap feels oversized, without affecting dynamic heroes or other themes.
  const heroHeight = isSmall ? '380px' : cinematic ? (fixed ? 'clamp(580px, 74vh, 900px)' : 'clamp(520px, 68vh, 820px)') : 'clamp(550px, 85vh, 1200px)'

  const maskGradient = 'linear-gradient(to bottom, black 80%, rgba(0,0,0,0.5) 92%, transparent 100%)'

  return (
    <div
      ref={heroRef}
      className={`relative overflow-hidden select-none group ${cinematic && !isSmall ? 'mx-8 w-[calc(100%-4rem)] rounded-[2rem] border border-white/10 shadow-[0_24px_80px_rgba(0,0,0,.65)]' : 'w-full'} ${cinematic && !isSmall ? (usesTopNav ? (fixed ? 'mt-[5.5rem]' : 'mt-[7.25rem]') : 'mt-8') : ''} ${isSmall ? 'rounded-2xl border border-white/[0.06] shadow-2xl' : ''}`}
      style={{ height: heroHeight }}
    >
      {!isSmall ? (
        <div
          className={`absolute inset-0 pointer-events-none ${cinematic ? 'cinematic-hero-artwork' : ''}`}
          style={{ maskImage: maskGradient, WebkitMaskImage: maskGradient }}
        >
          {renderBackdrops()}
        </div>
      ) : renderBackdrops()}
      {renderOverlay()}
    </div>
  )

  function renderBackdrops() {
    return (
      <>
        {displayItems.map((itm, i) => {
          const isAdjacentSlide = i === activeIndex || (startupEnrichmentReady && (i === (activeIndex + 1) % count || i === ((activeIndex - 1) + count) % count))
          if (!isAdjacentSlide) return null
          const slideItem = i === activeIndex ? presentedItem : itm
          return (
            <div
              key={`${itm.id ?? i}-${i}`}
              className="absolute inset-0 transition-opacity duration-1000 ease-in-out"
              style={{
                opacity: i === activeIndex ? 1 : 0,
                pointerEvents: 'none',
                filter: !cinematic && scrollBlur > 0 ? `blur(${scrollBlur}px)` : undefined,
                transform: !cinematic && scrollBlur > 0 ? 'scale(1.05)' : undefined,
                transition: 'opacity 1s ease-in-out, filter 0.15s ease-out, transform 0.15s ease-out',
              }}
            >
              <div className={`absolute inset-0 transition-opacity duration-300 ${heroMpvVisible && i === activeIndex ? 'opacity-0' : 'opacity-100'}`}>
                {(i === activeIndex ? presentedBackdrop : (upgradedBackdrops[String(slideItem.id)] || usableBackdrop(slideItem))) ? (
                  <img
                    src={cachedImage(i === activeIndex ? presentedBackdrop : (upgradedBackdrops[String(slideItem.id)] || usableBackdrop(slideItem)))}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                    style={{ objectPosition: 'center 20%' }}
                    draggable={false}
                    loading={i === activeIndex ? 'eager' : 'lazy'}
                    decoding="async"
                    fetchPriority={i === activeIndex ? 'high' : 'auto'}
                    onLoad={i === activeIndex ? onActiveImageSettled : undefined}
                    onError={i === activeIndex ? onActiveImageSettled : undefined}
                  />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-surface-elevated to-surface" />
                )}
              </div>
              {enableTrailers && i === activeIndex && heroTrailerPlaying && heroTrailer && (
                <HeroMpvTrailer
                  trailer={heroTrailer}
                  muted={heroTrailerMuted}
                  className="pointer-events-none absolute inset-0"
                  onPlayingChange={setHeroMpvVisible}
                  onEnded={() => {
                    setHeroTrailerPlaying(false)
                    setHeroTrailer(null)
                    setHeroMpvVisible(false)
                  }}
                  onUnavailable={() => {
                    setHeroTrailerPlaying(false)
                    setHeroTrailer(null)
                    setHeroMpvVisible(false)
                  }}
                />
              )}
            </div>
          )
        })}

        {/* Cinematic gradients */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, transparent 0%, rgba(0,0,0,0.15) 10%, rgba(0,0,0,0.45) 40%, rgba(0,0,0,0.15) 70%, transparent 100%)' }} />
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/15 to-transparent" />
      </>
    )
  }

  function renderOverlay() {
    return (
      <>
        {/* Prev / Next */}
        {enableTrailers && heroTrailerPlaying && heroTrailer && !isSmall && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setHeroTrailerMuted((value) => !value)
            }}
            className="absolute right-6 top-6 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/75 shadow-xl backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
            aria-label={heroTrailerMuted ? 'Unmute hero trailer' : 'Mute hero trailer'}
            title={heroTrailerMuted ? 'Unmute trailer' : 'Mute trailer'}
          >
            {heroTrailerMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        )}

        {/* Prev / Next */}
        {count > 1 && (
          <>
            <button
              onClick={() => goTo(activeIndex - 1)}
              className={`absolute ${isSmall ? 'left-4' : 'left-6'} top-1/2 -translate-y-1/2 z-20 ${isSmall ? 'w-9 h-9' : 'w-11 h-11'} rounded-full bg-black/30 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/60 hover:text-white transition-all duration-200 opacity-0 group-hover:opacity-100 cursor-pointer`}
              aria-label="Previous"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => goTo(activeIndex + 1)}
              className={`absolute ${isSmall ? 'right-4' : 'right-6'} top-1/2 -translate-y-1/2 z-20 ${isSmall ? 'w-9 h-9' : 'w-11 h-11'} rounded-full bg-black/30 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/60 hover:text-white transition-all duration-200 opacity-0 group-hover:opacity-100 cursor-pointer`}
              aria-label="Next"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </>
        )}

        {/* Content — bottom-left */}
        <div className={`absolute bottom-0 left-0 right-0 z-10 ${isSmall || cinematic ? 'px-8 pb-8' : 'px-6 pb-14'}`}>
          {/* Title */}
          <div className={`${isSmall ? 'mb-2.5 min-h-[40px]' : 'mb-3 min-h-[60px]'} flex items-end`}>
            {item.logo && !logoError ? (
              <img
                src={cachedImage(item.logo)}
                alt={item.title}
                className={`${isSmall ? 'h-14 max-w-[70%]' : 'h-[112px] md:h-[132px] max-w-[60%]'} w-auto object-contain object-left drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]`}
                onError={() => setLogoError(true)}
                draggable={false}
              />
            ) : (
              <h1 className={`${isSmall ? 'text-4xl' : 'text-6xl'} font-bold drop-shadow-xl leading-[1.05] tracking-tight max-w-2xl`}>
                {item.title}
              </h1>
            )}
          </div>

          {/* Year · Genre · Rating */}
          {metaLine && (
            <p className={`text-white/50 font-medium tracking-wide ${isSmall ? 'text-xs mb-2' : 'text-sm mb-3'}`}>
              {metaLine}
            </p>
          )}

          {/* Compact colored rating badges */}
          {!cinematic && <RatingsStrip
            mediaType={type}
            imdbId={item.imdbId}
            tmdbId={item.tmdbId}
            tvdbId={item.tvdbId}
            className={isSmall ? 'mb-2.5' : 'mb-3'}
            compact
          />}

          {/* Overview */}
          {item.overview && (
            <p className={`text-white/55 leading-relaxed max-w-xl ${isSmall ? 'text-xs line-clamp-1 mb-3' : 'text-[15px] line-clamp-2 mb-4'}`}>
              {item.overview}
            </p>
          )}

          {/* Actor avatars */}
          {!isSmall && !cinematic && cast.length > 0 && (
            <div className="flex items-center gap-2 mb-5">
              <div className="flex -space-x-1.5">
                {cast.map((actor) => (
                  <div key={actor.name} className="w-8 h-8 rounded-full border-2 border-black/60 overflow-hidden bg-surface-elevated flex-shrink-0">
                    {actor.photo ? (
                      <img src={cachedImage(actor.photo)} alt={actor.name} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] font-bold text-white/40">
                        {actor.name.charAt(0)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <span className="text-xs text-white/45 font-medium truncate max-w-sm">
                {cast.map((a) => a.name).join(', ')}
              </span>
            </div>
          )}

          {/* Actions + dots */}
          <div className="flex items-center gap-3">
            {cinematic ? (
              <>
                <Button variant="white" size="lg" onClick={() => nav(true)}>Play</Button>
                <Button variant="secondary" size="lg" onClick={() => nav(false)}>More Info</Button>
                <WatchlistButton mediaRef={{ localId: item.id, title: item.title, year: item.year, type: item.isAnime ? 'anime' : type === 'series' ? 'show' : 'movie', isAnime: item.isAnime, contentType: type === 'series' ? 'series' : 'movie', imdbId: item.imdbId, tmdbId: item.tmdbId ? Number(item.tmdbId) : undefined }} mediaType={type} isAnime={item.isAnime} anilistId={item.anilistId} malId={item.malId} tvdbId={item.tvdbId} />
              </>
            ) : (
              <Button variant="white" size={isSmall ? 'md' : 'lg'} onClick={() => nav(false)}>
                Go to {type === 'movie' ? 'Movie' : 'Series'}
              </Button>
            )}

            {count > 1 && (
              <div className="flex items-center gap-1.5 ml-auto">
                {items.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => goTo(i)}
                    className={[
                      'rounded-full transition-all duration-300 cursor-pointer',
                      i === activeIndex
                        ? 'w-7 h-2 bg-white'
                        : 'w-2 h-2 bg-white/25 hover:bg-white/50',
                    ].join(' ')}
                    aria-label={`Go to slide ${i + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </>
    )
  }
}

export default React.memo(HeroSection)
