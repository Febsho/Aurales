import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import MediaCard from './MediaCard'
import { useAppStore } from '../stores/appStore'
import { dedupeMediaItems, mediaIdentity } from '../services/mediaPresentation'
import { getTmdbCardMetadata } from '../services/tmdb'
import RatingsStrip from './RatingsStrip'
import { warmCachedImages } from '../services/imageCache'

const CATALOG_PREVIEW_LIMIT = 25
const INITIAL_RENDERED_CARDS = 30
const CARD_RENDER_BATCH = 18

interface MediaRowProps {
  title: string
  items: SearchResult[]
  layout?: 'poster' | 'ranked' | 'feature' | 'landscape' | 'list'
  showAllPath?: string
  forceShowAll?: boolean
  disableArtOverride?: boolean
  disableTrailerPreview?: boolean
  showRank?: boolean
  headerLeftControls?: React.ReactNode
  headerRightControls?: React.ReactNode
  /** Set false to keep cinematic cards at poster size (no landscape expansion on focus). */
  cinematicExpand?: boolean
}

function FixedShelfDetails({ item }: { item: SearchResult }) {
  const [resolvedLogo, setResolvedLogo] = useState(item.logo)
  const genre = item.genres?.[0]
  const genreLabel = typeof genre === 'object' && genre
    ? (genre as { name?: string; title?: string }).name || (genre as { title?: string }).title
    : genre
  const rating = item.rating != null ? Number(item.rating).toFixed(1).replace(/\.0$/, '') : null

  useEffect(() => {
    let cancelled = false
    setResolvedLogo(item.logo)
    if (item.logo) return () => { cancelled = true }

    ;(async () => {
      let tmdbId = item.tmdbId || (/^tmdb[-:]/i.test(String(item.id)) ? String(item.id).replace(/^tmdb[-:]/i, '') : undefined)
      if (!tmdbId && item.imdbId) {
        const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
        const found = await tmdbFindByExternalId(item.imdbId, 'imdb_id')
        tmdbId = found.tmdbId ? String(found.tmdbId) : undefined
      }
      if (!tmdbId || cancelled) return
      const metadata = await getTmdbCardMetadata(item.type, tmdbId, item.imdbId)
      if (!cancelled) setResolvedLogo(metadata.englishLogo || metadata.logo)
    })().catch(() => undefined)

    return () => { cancelled = true }
  }, [item.id, item.imdbId, item.logo, item.tmdbId, item.type])

  return (
    <div className="fixed-focus-card__details fixed-focus-card__details--shelf flex-none self-center">
      <div className="fixed-focus-card__details-inner">
        {resolvedLogo ? (
          <img src={resolvedLogo} alt={item.title} className="mb-3 max-h-20 max-w-[78%] object-contain object-left drop-shadow-xl" onError={() => setResolvedLogo(undefined)} />
        ) : (
          <h3 className="mb-2 text-2xl font-black tracking-tight text-white drop-shadow-xl">{item.title}</h3>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-white/72">
          <span>{item.type === 'series' ? 'Series' : 'Movie'}</span>
          {item.year && <><span className="text-white/30">•</span><span>{item.year}</span></>}
          {genreLabel && <><span className="text-white/30">•</span><span>{String(genreLabel)}</span></>}
          {rating && <><span className="text-white/30">•</span><span>★ {rating}</span></>}
        </div>
        <RatingsStrip
          mediaType={item.type === 'series' ? 'series' : 'movie'}
          imdbId={item.imdbId}
          tmdbId={item.tmdbId}
          tvdbId={item.tvdbId}
          malId={item.malId}
          className="mb-3"
          compact
        />
        {item.overview && <p className="line-clamp-2 text-[13px] leading-relaxed text-white/62">{item.overview}</p>}
      </div>
    </div>
  )
}

function MediaRow({ title, items, layout = 'poster', showAllPath, forceShowAll = false, disableArtOverride = false, disableTrailerPreview = false, headerLeftControls, headerRightControls, cinematicExpand = true }: MediaRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const posterSize = useAppStore((s) => s.posterSize)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const homeCardAnimations = useAppStore((s) => s.homeCardAnimations)
  const fixedHome = useAppStore((s) => s.homeHeroMode) === 'fixed' && location.pathname === '/'
  // Layout is authoritative. Older shelf records may still carry showRank=true;
  // that must never turn a user-selected Poster shelf back into Ranked. Feature
  // cards retain their chosen presentation on Fixed Home as well—the fixed-home
  // card sizing in MediaCard keeps them inside the hero-safe shelf area.
  const effectiveLayout = layout
  const specialLayout = effectiveLayout === 'ranked' || effectiveLayout === 'feature'
  // Focus belongs to a rendered card instance, not to a media ID. Catalogs can
  // legitimately contain duplicate/canonicalized entries with the same ID.
  const [focusedCardIndex, setFocusedCardIndex] = useState<number | null>(null)
  const [renderedCount, setRenderedCount] = useState(INITIAL_RENDERED_CARDS)
  const handleCardFocus = useCallback((_item: SearchResult, cardIndex?: number) => {
    if (cardIndex != null) setFocusedCardIndex(cardIndex)
  }, [])
  const handleCardUnfocus = useCallback((_item: SearchResult, cardIndex?: number) => {
    if (cardIndex != null) {
      setFocusedCardIndex((current) => current === cardIndex ? null : current)
    }
  }, [])
  const showAllWidthClass = useMemo(() => {
    if (layout === 'landscape' || layout === 'feature') {
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

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const amount = Math.max(640, Math.floor(scrollRef.current.clientWidth * 0.85))
    const scrollAmount = direction === 'left' ? -amount : amount
    scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' })
  }

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!cinematic || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(':scope > button'))
    const index = cards.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    const next = cards[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus({ preventScroll: true })
    next.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }

  const visibleItems = useMemo(
    () => dedupeMediaItems(items.filter((item) => item.poster || item.backdrop || item.tmdbId || item.imdbId)),
    [items],
  )
  const shouldShowAll = Boolean(showAllPath && (forceShowAll || visibleItems.length > CATALOG_PREVIEW_LIMIT))
  const rowItems = useMemo(
    () => shouldShowAll ? visibleItems.slice(0, CATALOG_PREVIEW_LIMIT) : visibleItems,
    [shouldShowAll, visibleItems],
  )
  const renderedItems = useMemo(
    () => rowItems.slice(0, renderedCount),
    [rowItems, renderedCount],
  )
  useEffect(() => setRenderedCount(INITIAL_RENDERED_CARDS), [rowItems])
  useEffect(() => {
    // Start with enough artwork for the initial viewport and a few horizontal
    // scroll steps. The shared queue keeps many Home/Discover shelves from
    // saturating the network or native image cache at once.
    const timer = window.setTimeout(() => {
      void warmCachedImages(rowItems.slice(0, 14).flatMap((item) => [item.poster, item.backdrop, item.logo]))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [rowItems])
  // Pass the full row along so catalogs without a backing config (e.g. Discover
  // sections) can render everything even when the seeded cache is unavailable
  const openShowAll = () => { if (showAllPath) navigate(showAllPath, { state: { showAllItems: visibleItems } }) }
  const renderMoreCards = useCallback((element: HTMLDivElement) => {
    if (renderedCount >= rowItems.length) return
    // Grow only when the user approaches the rendered edge. This preserves
    // keyboard/controller navigation while avoiding an unbounded initial DOM.
    if (element.scrollLeft + element.clientWidth >= element.scrollWidth - element.clientWidth * 1.5) {
      setRenderedCount((count) => Math.min(rowItems.length, count + CARD_RENDER_BATCH))
    }
  }, [renderedCount, rowItems.length])

  if (visibleItems.length === 0) return null

  if (layout === 'list' && !cinematic) {
    return (
      <div className="mb-8 px-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            {headerLeftControls}
            <h2 className="text-xl font-bold tracking-tight text-white/95">{title}</h2>
          </div>
          <div>
            {headerRightControls}
          </div>
        </div>
        <div className="space-y-2">
          {renderedItems.map((item, index) => (
            <MediaCard key={`${mediaIdentity(item)}:${index}`} item={item} layout="landscape" disableTrailerPreview={disableTrailerPreview} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <section className={`media-row media-row--${effectiveLayout} mb-8 ${cinematic ? 'cinematic-media-row !mb-2' : ''}`}>
      <div className="flex items-center justify-between px-6 mb-4">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          {showAllPath ? (
            <button
              onClick={openShowAll}
              className="group/title flex items-center gap-1.5 cursor-pointer focus-ring rounded-lg"
              title="Show all"
            >
              <h2 className="text-xl font-bold tracking-tight text-white/95 transition-colors group-hover/title:text-white">{title}</h2>
              <svg className="w-4 h-4 text-white/0 transition-all duration-200 group-hover/title:text-white/60 group-hover/title:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <h2 className="text-xl font-bold tracking-tight text-white/95">{title}</h2>
          )}
        </div>
        <div className="flex items-center gap-3">
          {headerRightControls}
          <div className="flex gap-1">
          <button
            onClick={() => scroll('left')}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center transition-colors cursor-pointer text-white/50 hover:text-white"
            aria-label="Scroll left"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => scroll('right')}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center transition-colors cursor-pointer text-white/50 hover:text-white"
            aria-label="Scroll right"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            </button>
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        onKeyDown={handleRowKeyDown}
        onScroll={(event) => renderMoreCards(event.currentTarget)}
        className={`flex items-start overflow-x-auto overflow-y-hidden overscroll-x-contain px-6 pt-4 -mt-4 pb-4 scrollbar-none ${effectiveLayout === 'ranked' ? 'gap-1' : effectiveLayout === 'feature' ? 'gap-5' : 'gap-4'} ${cinematic ? 'cinematic-row-track px-8 pb-8' : ''}`}
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {renderedItems.map((item, idx) => {
          const focused = focusedCardIndex === idx || (fixedHome && focusedCardIndex == null && idx === 0)
          return (
            <React.Fragment key={`${mediaIdentity(item)}:${idx}`}>
              <MediaCard
                item={item}
                layout={specialLayout ? effectiveLayout as 'ranked' | 'feature' : (cinematic && !fixedHome) || effectiveLayout === 'landscape' ? 'landscape' : 'poster'}
                disableArtOverride={disableArtOverride}
                // Fixed-home shelves sit beneath the featured hero. Keep their
                // artwork static so the hero remains the sole trailer surface.
                disableTrailerPreview={disableTrailerPreview || fixedHome}
                rank={effectiveLayout === 'ranked' ? idx + 1 : undefined}
                cardIndex={idx}
                onFocusItem={cinematic ? handleCardFocus : undefined}
                onUnfocusItem={cinematic && !fixedHome ? handleCardUnfocus : undefined}
                cinematicMode={cinematic && !fixedHome}
                cinematicFocused={cinematic && focused}
                cinematicExpand={cinematicExpand && homeCardAnimations && !fixedHome}
                fixedHome={fixedHome}
              />
              {fixedHome && homeCardAnimations && focused && <FixedShelfDetails item={item} />}
            </React.Fragment>
          )
        })}
        {shouldShowAll && showAllPath && (
          <button
            onClick={openShowAll}
            data-show-all-layout={effectiveLayout}
            className={`flex-shrink-0 bg-white/5 hover:bg-white/10 border border-white/10 flex flex-col items-center justify-center text-white transition-colors self-start ${
              cinematic
                ? 'w-[clamp(10rem,13vw,13rem)] h-[clamp(15rem,19.5vw,19.5rem)] rounded-2xl focus-ring'
                : `rounded-xl ${showAllWidthClass} ${layout === 'landscape' ? 'aspect-video' : 'aspect-[2/3]'}`
            }`}
          >
            <div className="w-12 h-12 rounded-full bg-accent/15 flex items-center justify-center mb-3">
              <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </div>
            <span className="text-sm font-semibold">Show all</span>
          </button>
        )}
      </div>
    </section>
  )
}

export default React.memo(MediaRow)
