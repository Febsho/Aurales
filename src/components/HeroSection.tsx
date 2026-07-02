import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import { applySearchResultArt } from '../services/artwork'
import { getTmdbHeroCast, getTmdbLandscapeBackdrop } from '../services/tmdb'
import RatingsStrip from './RatingsStrip'
import { Button } from './ui'

interface HeroSectionProps {
  items: SearchResult[]
  isSmall?: boolean
  onActiveBackdropChange?: (url: string | undefined) => void
}

function HeroSection({ items, isSmall = false, onActiveBackdropChange }: HeroSectionProps) {
  const navigate = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  const [logoError, setLogoError] = useState(false)
  const [scrollBlur, setScrollBlur] = useState(0)
  const [cast, setCast] = useState<{ name: string; photo?: string }[]>([])
  const heroRef = useRef<HTMLDivElement>(null)
  const count = items.length

  const goTo = useCallback(
    (i: number) => setActiveIndex(((i % count) + count) % count),
    [count],
  )

  useEffect(() => {
    setLogoError(false)
  }, [activeIndex])

  useEffect(() => {
    setActiveIndex(0)
  }, [items])

  const [scrolledAway, setScrolledAway] = useState(false)

  useEffect(() => {
    if (count <= 1) return
    if (scrolledAway) return
    const id = setInterval(() => setActiveIndex((prev) => (prev + 1) % count), 8000)
    return () => clearInterval(id)
  }, [count, scrolledAway])

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

  useEffect(() => {
    let cancelled = false
    const toFetch = items.filter((itm) => {
      const tmdbId = itm.tmdbId || (String(itm.id).startsWith('tmdb-') ? String(itm.id).replace('tmdb-', '') : undefined)
      return tmdbId && !upgradedBackdrops[String(itm.id)]
    })
    toFetch.forEach((itm) => {
      const tmdbId = itm.tmdbId || String(itm.id).replace('tmdb-', '')
      const t = itm.type === 'series' ? 'series' : 'movie'
      getTmdbLandscapeBackdrop(t, tmdbId)
        .then((url) => {
          if (!cancelled && url) {
            setUpgradedBackdrops((prev) => ({ ...prev, [String(itm.id)]: url }))
          }
        })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [items])

  const displayItems = items.map(applySearchResultArt)
  const item = displayItems[activeIndex]
  const type = item?.type === 'series' ? 'series' : 'movie'

  // Report active backdrop to parent for blurred background
  useEffect(() => {
    if (!onActiveBackdropChange || isSmall) return
    const activeItem = displayItems[activeIndex]
    if (!activeItem) { onActiveBackdropChange(undefined); return }
    const backdrop = upgradedBackdrops[String(activeItem.id)] || activeItem.backdrop || activeItem.poster
    onActiveBackdropChange(backdrop)
  }, [activeIndex, upgradedBackdrops, isSmall])

  // Fetch top 3 cast for the active hero item
  useEffect(() => {
    if (!item) return
    const tmdbId = item.tmdbId || (String(item.id).startsWith('tmdb-') ? String(item.id).replace('tmdb-', '') : undefined)
    if (!tmdbId) { setCast([]); return }

    let cancelled = false
    getTmdbHeroCast(type, tmdbId)
      .then((c) => { if (!cancelled) setCast(c) })
      .catch(() => { if (!cancelled) setCast([]) })
    return () => { cancelled = true }
  }, [item?.id, item?.tmdbId, type])

  if (!items.length || !item) return null

  const sharedState = {
    poster: item.poster,
    backdrop: item.backdrop,
    title: item.title,
    year: item.year,
    rating: item.rating,
    overview: item.overview,
    imdbId: 'imdbId' in item ? item.imdbId : undefined,
    addonUrl: 'addonUrl' in item ? item.addonUrl : undefined,
    provider: 'provider' in item ? item.provider : undefined,
  }

  const nav = () =>
    navigate(type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`, { state: sharedState })

  const genreStr = item.genres?.[0] || ''
  const ratingLabel = item.rating ? `R` : ''
  const metaLine = [item.year, genreStr, ratingLabel].filter(Boolean).join(' · ')

  const heroHeight = isSmall ? '380px' : 'clamp(550px, calc(100vh - 270px), 1200px)'

  const maskGradient = 'linear-gradient(to bottom, black 75%, rgba(0,0,0,0.4) 90%, transparent 100%)'

  return (
    <div
      ref={heroRef}
      className={`relative w-full overflow-hidden select-none group ${isSmall ? 'rounded-2xl border border-white/[0.06] shadow-2xl' : ''}`}
      style={{ height: heroHeight }}
    >
      {/* Masked backdrop layer — fade only affects backgrounds, not text */}
      {!isSmall && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ maskImage: maskGradient, WebkitMaskImage: maskGradient }}
        >
          {renderBackdrops()}
        </div>
      )}
      {isSmall && renderBackdrops()}
      {renderOverlay()}
    </div>
  )

  function renderBackdrops() {
    return (
      <>
        {displayItems.map((itm, i) => {
          const isAdjacentSlide = i === activeIndex || i === (activeIndex + 1) % count || i === ((activeIndex - 1) + count) % count
          if (!isAdjacentSlide) return null
          return (
            <div
              key={`${itm.id ?? i}-${i}`}
              className="absolute inset-0 transition-opacity duration-1000 ease-in-out"
              style={{
                opacity: i === activeIndex ? 1 : 0,
                pointerEvents: 'none',
                filter: scrollBlur > 0 ? `blur(${scrollBlur}px)` : undefined,
                transform: scrollBlur > 0 ? 'scale(1.05)' : undefined,
                transition: 'opacity 1s ease-in-out, filter 0.15s ease-out, transform 0.15s ease-out',
              }}
            >
              {(upgradedBackdrops[String(itm.id)] || itm.backdrop) ? (
                <img
                  src={upgradedBackdrops[String(itm.id)] || itm.backdrop!.replace(/\/w\d+\//, '/w1280/')}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ objectPosition: 'center 20%' }}
                  draggable={false}
                  loading={i === activeIndex ? 'eager' : 'lazy'}
                />
              ) : itm.poster ? (
                <>
                  <img
                    src={itm.poster}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover blur-3xl scale-125"
                    draggable={false}
                  />
                  <div className="absolute inset-0 bg-black/50" />
                </>
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-surface-elevated to-surface" />
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
        <div className={`absolute bottom-0 left-0 right-0 z-10 px-8 ${isSmall ? 'pb-8' : 'pb-6'}`}>
          {/* Title */}
          <div className={`${isSmall ? 'mb-2.5 min-h-[40px]' : 'mb-3 min-h-[60px]'} flex items-end`}>
            {item.logo && !logoError ? (
              <img
                src={item.logo}
                alt={item.title}
                className={`${isSmall ? 'max-h-[65px]' : 'max-h-[110px] md:max-h-[140px]'} max-w-[90%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]`}
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
          <RatingsStrip
            mediaType={type}
            imdbId={item.imdbId}
            tmdbId={item.tmdbId}
            tvdbId={item.tvdbId}
            className={isSmall ? 'mb-2.5' : 'mb-3'}
            compact
          />

          {/* Overview */}
          {item.overview && (
            <p className={`text-white/55 leading-relaxed max-w-xl ${isSmall ? 'text-xs line-clamp-1 mb-3' : 'text-[15px] line-clamp-2 mb-4'}`}>
              {item.overview}
            </p>
          )}

          {/* Actor avatars */}
          {!isSmall && cast.length > 0 && (
            <div className="flex items-center gap-2 mb-5">
              <div className="flex -space-x-1.5">
                {cast.map((actor) => (
                  <div key={actor.name} className="w-8 h-8 rounded-full border-2 border-black/60 overflow-hidden bg-surface-elevated flex-shrink-0">
                    {actor.photo ? (
                      <img src={actor.photo} alt={actor.name} className="w-full h-full object-cover" loading="lazy" />
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
            <Button
              variant="white"
              size={isSmall ? 'md' : 'lg'}
              onClick={nav}
            >
              Go to {type === 'movie' ? 'Movie' : 'Series'}
            </Button>

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
