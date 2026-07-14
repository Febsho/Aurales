import React, { useState, useEffect, useCallback, memo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
<<<<<<< Updated upstream
import { applySearchResultArt } from '../services/artwork'
=======
import { applySearchResultArt, resolveArtFromProviders } from '../services/artwork'
import { getTmdbHeroCast, getTmdbLandscapeBackdrop } from '../services/tmdb'
import { getTrailerSource, preloadTrailerSource, type TrailerSource } from '../services/trailers'
import { cachedImage } from '../services/imageCache'
import { useAppStore } from '../stores/appStore'
>>>>>>> Stashed changes
import RatingsStrip from './RatingsStrip'
import { Button } from './ui'

interface HeroSectionProps {
  items: SearchResult[]
  isSmall?: boolean
}

function HeroSection({ items, isSmall = false }: HeroSectionProps) {
  const navigate = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  const [logoError, setLogoError] = useState(false)
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

  useEffect(() => {
    if (count <= 1) return
    const id = setInterval(() => setActiveIndex((prev) => (prev + 1) % count), 8000)
    return () => clearInterval(id)
  }, [count])

  if (!items.length) return null

  const displayItems = items.map(applySearchResultArt)
  const item = displayItems[activeIndex]
  const type = item.type === 'series' ? 'series' : 'movie'

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

  return (
    <div
      className={`relative w-full overflow-hidden select-none group ${isSmall ? 'rounded-2xl border border-white/[0.06] shadow-2xl' : ''}`}
      style={isSmall ? { height: '380px' } : { height: 'clamp(550px, calc(100vh - 270px), 1200px)' }}
    >
<<<<<<< Updated upstream
      {/* Backdrop slides — only render adjacent slides for performance */}
      {displayItems.map((itm, i) => {
        const isAdjacentSlide = i === activeIndex || i === (activeIndex + 1) % count || i === ((activeIndex - 1) + count) % count
        if (!isAdjacentSlide) return null
        return (
          <div
            key={`${itm.id ?? i}-${i}`}
            className="absolute inset-0 transition-opacity duration-1000 ease-in-out"
            style={{ opacity: i === activeIndex ? 1 : 0, pointerEvents: 'none' }}
=======
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
                {(i === activeIndex ? presentedBackdrop : (upgradedBackdrops[String(slideItem.id)] || slideItem.backdrop)) ? (
                  <img
                    src={cachedImage(i === activeIndex ? presentedBackdrop : (upgradedBackdrops[String(slideItem.id)] || slideItem.backdrop))}
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
                ) : slideItem.poster ? (
                  <>
                    <img
                      src={cachedImage(slideItem.poster)}
                      alt=""
                    className={`absolute inset-0 w-full h-full object-cover ${cinematic ? '' : 'blur-3xl scale-125'}`}
                    draggable={false}
                    onLoad={i === activeIndex ? onActiveImageSettled : undefined}
                    onError={i === activeIndex ? onActiveImageSettled : undefined}
                    />
                    <div className="absolute inset-0 bg-black/50" />
                  </>
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
>>>>>>> Stashed changes
          >
            {itm.backdrop ? (
              <img
                src={itm.backdrop.replace('/w780/', '/original/').replace('/w1280/', '/original/')}
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

      {/* Cinematic gradients — heavier bottom fade */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />

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
      <div className={`absolute bottom-0 left-0 right-0 z-10 px-8 ${isSmall ? 'pb-8' : 'pb-12'}`}>
        {/* Meta badges */}
        <div className={`flex items-center gap-2.5 ${isSmall ? 'mb-2' : 'mb-3'}`}>
          {item.type && (
            <span className="px-2.5 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-[0.15em] bg-white/10 text-white/80 border border-white/10">
              {item.type}
            </span>
          )}
          {item.year && <span className="text-sm text-white/50 font-medium">{item.year}</span>}
          {item.rating && (
            <span className="flex items-center gap-1 text-sm text-yellow-400/90 font-bold">
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              {item.rating.toFixed(1)}
            </span>
          )}
        </div>

        {/* Title */}
        <div className={`${isSmall ? 'mb-2.5 min-h-[40px]' : 'mb-4 min-h-[60px]'} flex items-end`}>
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

        <RatingsStrip
          mediaType={type}
          imdbId={item.imdbId}
          tmdbId={item.tmdbId}
          tvdbId={item.tvdbId}
          className={isSmall ? 'mb-2.5' : 'mb-4'}
        />

        {/* Overview */}
        {item.overview && (
          <p className={`text-white/55 leading-relaxed max-w-xl ${isSmall ? 'text-xs line-clamp-1 mb-4' : 'text-[15px] line-clamp-2 mb-6'}`}>
            {item.overview}
          </p>
        )}

        {/* Actions + dots */}
        <div className="flex items-center gap-3">
          <Button
            variant="white"
            size={isSmall ? 'md' : 'lg'}
            onClick={nav}
            icon={
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            }
          >
            Play
          </Button>
          <Button variant="glass" size={isSmall ? 'md' : 'lg'} onClick={nav}>
            More Info
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
    </div>
  )
}

export default React.memo(HeroSection)
