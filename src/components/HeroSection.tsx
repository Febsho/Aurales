import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import { applySearchResultArt } from '../services/artwork'
import RatingsStrip from './RatingsStrip'
import { Button } from './ui'

interface HeroSectionProps {
  items: SearchResult[]
}

export default function HeroSection({ items }: HeroSectionProps) {
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
      className="relative w-full overflow-hidden select-none group"
      style={{ height: 'clamp(500px, 70vh, 850px)' }}
    >
      {/* Backdrop slides */}
      {displayItems.map((itm, i) => (
        <div
          key={`${itm.id ?? i}-${i}`}
          className="absolute inset-0 transition-opacity duration-1000 ease-in-out"
          style={{ opacity: i === activeIndex ? 1 : 0, pointerEvents: 'none' }}
        >
          {itm.backdrop ? (
            <img
              src={itm.backdrop}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              style={{ objectPosition: 'center 20%' }}
              draggable={false}
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
      ))}

      {/* Cinematic gradients — heavier bottom fade */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />

      {/* Prev / Next */}
      {count > 1 && (
        <>
          <button
            onClick={() => goTo(activeIndex - 1)}
            className="absolute left-6 top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full bg-black/30 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/60 hover:text-white transition-all duration-200 opacity-0 group-hover:opacity-100 cursor-pointer"
            aria-label="Previous"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => goTo(activeIndex + 1)}
            className="absolute right-6 top-1/2 -translate-y-1/2 z-20 w-11 h-11 rounded-full bg-black/30 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/60 hover:text-white transition-all duration-200 opacity-0 group-hover:opacity-100 cursor-pointer"
            aria-label="Next"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* Content — bottom-left, generous padding for sidebar clearance */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-10 pb-12">
        {/* Meta badges */}
        <div className="flex items-center gap-2.5 mb-3">
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
        <div className="mb-4 min-h-[60px] flex items-end">
          {item.logo && !logoError ? (
            <img
              src={item.logo}
              alt={item.title}
              className="max-h-[110px] md:max-h-[140px] max-w-[90%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]"
              onError={() => setLogoError(true)}
              draggable={false}
            />
          ) : (
            <h1 className="text-6xl font-bold drop-shadow-xl leading-[1.05] tracking-tight max-w-2xl">
              {item.title}
            </h1>
          )}
        </div>

        <RatingsStrip
          mediaType={type}
          imdbId={item.imdbId}
          tmdbId={item.tmdbId}
          tvdbId={item.tvdbId}
          className="mb-4"
        />

        {/* Overview */}
        {item.overview && (
          <p className="text-[15px] text-white/55 line-clamp-2 mb-6 leading-relaxed max-w-xl">
            {item.overview}
          </p>
        )}

        {/* Actions + dots */}
        <div className="flex items-center gap-3">
          <Button
            variant="white"
            size="lg"
            onClick={nav}
            icon={
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            }
          >
            Play
          </Button>
          <Button variant="glass" size="lg" onClick={nav}>
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
