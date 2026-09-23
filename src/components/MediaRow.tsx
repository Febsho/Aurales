import React, { useCallback, useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import MediaCard from './MediaCard'
import { useAppStore } from '../stores/appStore'
import { dedupeMediaItems, mediaIdentity } from '../services/mediaPresentation'
import { getTmdbCardMetadata } from '../services/tmdb'
import RatingsStrip from './RatingsStrip'
import { warmCachedImages } from '../services/imageCache'
import { applySearchResultArt, resolveBetterPoster } from '../services/artwork'
import { getShelfView, rememberShelfView, routeViewKey } from '../services/sessionViewState'

// A Home page can activate several shelves together. Rendering every preview
// card on each one makes WebKit decode hundreds of full-resolution posters at
// startup; keep the visible run compact and extend it only near the edge.
const INITIAL_RENDERED_CARDS = 8
const CARD_RENDER_BATCH = 8

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
  const rowEntryCount = useAppStore((s) => s.rowEntryCount)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const homeCardAnimations = useAppStore((s) => s.homeCardAnimations)
  const fixedHome = useAppStore((s) => s.homeHeroMode) === 'fixed' && location.pathname === '/'
  const shelfViewKey = `${routeViewKey(location.pathname, location.search)}:${showAllPath || title}:${layout}`
  // Layout is authoritative. Older shelf records may still carry showRank=true;
  // that must never turn a user-selected Poster shelf back into Ranked. Feature
  // cards retain their chosen presentation on Fixed Home as well—the fixed-home
  // card sizing in MediaCard keeps them inside the hero-safe shelf area.
  const effectiveLayout = layout
  const specialLayout = effectiveLayout === 'ranked' || effectiveLayout === 'feature'
  // Focus belongs to a rendered card instance, not to a media ID. Catalogs can
  // legitimately contain duplicate/canonicalized entries with the same ID.
  const [focusedCardIndex, setFocusedCardIndex] = useState<number | null>(null)
  const [renderedCount, setRenderedCount] = useState(() => getShelfView(shelfViewKey)?.renderedCount || INITIAL_RENDERED_CARDS)
  const renderMoreFrameRef = useRef(0)
  const handleCardFocus = useCallback((_item: SearchResult, cardIndex?: number) => {
    if (cardIndex != null) setFocusedCardIndex(cardIndex)
  }, [])
  const handleCardUnfocus = useCallback((_item: SearchResult, cardIndex?: number) => {
    if (cardIndex != null) {
      setFocusedCardIndex((current) => current === cardIndex ? null : current)
    }
  }, [])
  const showAllGeometry = useMemo<React.CSSProperties>(() => {
    if (fixedHome) {
      if (effectiveLayout === 'feature') return { width: 'calc(var(--fixed-cinematic-card-height) * .8)', height: 'var(--fixed-cinematic-card-height)', borderRadius: '1.6rem' }
      // Unlike ranked titles, this action has no numeral gutter. Let it occupy
      // the same portrait footprint as a normal poster rather than leaving a
      // visually empty ranked-card-width tile at the end of the rail.
      if (effectiveLayout === 'ranked') return { width: 'calc(var(--fixed-cinematic-card-height) * 2 / 3)', height: 'var(--fixed-cinematic-card-height)', borderRadius: '1rem' }
      if (effectiveLayout === 'landscape') return { width: 'var(--fixed-cinematic-landscape-width)', height: 'var(--fixed-cinematic-landscape-height)', borderRadius: '1rem' }
      return { width: 'var(--fixed-cinematic-card-width)', height: 'var(--fixed-cinematic-card-height)', borderRadius: '1rem' }
    }

    if (cinematic) {
      if (effectiveLayout === 'feature' || effectiveLayout === 'ranked') {
        const height = effectiveLayout === 'ranked'
          ? posterSize === 'compact' ? '240px' : posterSize === 'large' ? '350px' : posterSize === 'huge' ? '400px' : '300px'
          : posterSize === 'compact' ? '325px' : posterSize === 'large' ? '450px' : posterSize === 'huge' ? '525px' : '400px'
        return {
          width: `calc(${height} * ${effectiveLayout === 'feature' ? '.8' : '2 / 3'})`,
          height,
          borderRadius: '1rem',
        }
      }
      if (effectiveLayout === 'landscape') return { width: 'clamp(15rem, 18vw, 21rem)', aspectRatio: '16 / 9', borderRadius: '1rem' }
      return { width: 'clamp(10rem, 13vw, 13rem)', height: 'clamp(15rem, 19.5vw, 19.5rem)', borderRadius: '1rem' }
    }

    if (effectiveLayout === 'feature') {
      const width = posterSize === 'compact' ? 200 : posterSize === 'large' ? 280 : posterSize === 'huge' ? 330 : 240
      return { width, aspectRatio: '4 / 5', borderRadius: '1.6rem' }
    }
    if (effectiveLayout === 'ranked') {
      const height = posterSize === 'compact' ? 210 : posterSize === 'large' ? 282 : posterSize === 'huge' ? 318 : 246
      return { width: Math.round(height * 2 / 3), height, borderRadius: '1rem' }
    }
    if (effectiveLayout === 'landscape') {
      const width = posterSize === 'compact' ? 240 : posterSize === 'large' ? 320 : posterSize === 'huge' ? 384 : 288
      return { width, aspectRatio: '16 / 9', borderRadius: '1rem' }
    }
    const width = posterSize === 'compact' ? 112 : posterSize === 'large' ? 176 : posterSize === 'huge' ? 208 : 144
    return { width, aspectRatio: '2 / 3', borderRadius: '1rem' }
  }, [cinematic, effectiveLayout, fixedHome, posterSize])

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const amount = Math.max(640, Math.floor(scrollRef.current.clientWidth * 0.85))
    const scrollAmount = direction === 'left' ? -amount : amount
    scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' })
  }

  const handleRowWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (Math.abs(amount) < 1) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: amount, behavior: 'smooth' })
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
  const shouldShowAll = Boolean(showAllPath && (forceShowAll || visibleItems.length > rowEntryCount))
  const rowItems = useMemo(
    () => shouldShowAll ? visibleItems.slice(0, rowEntryCount) : visibleItems,
    [rowEntryCount, shouldShowAll, visibleItems],
  )
  const renderedItems = useMemo(
    // A list is vertically laid out and has no horizontal edge at which to
    // request another batch, so applying shelf progressive rendering here
    // would permanently hide everything after the initial batch.
    () => layout === 'list' ? rowItems : rowItems.slice(0, renderedCount),
    [layout, rowItems, renderedCount],
  )
  useEffect(() => {
    setRenderedCount((count) => Math.max(count, getShelfView(shelfViewKey)?.renderedCount || INITIAL_RENDERED_CARDS))
  }, [rowItems, shelfViewKey])
  useEffect(() => {
    // Warming remains useful for later horizontal browsing, but it must start
    // after the first interaction/paint budget. Starting every shelf's full
    // artwork queue 150 ms after mount competed with scroll image decoding.
    const warm = () => {
      // Resolve Better Posters before deciding which URLs to warm. This keeps
      // an idle prefetch from filling the normal-poster cache only to replace
      // it later, while the resolver's global in-flight map deduplicates cards
      // and shelves that reach the same title at once.
      // Never prefetch the complete artwork set for a shelf. A single card
      // can have poster, backdrop and logo files at original resolution;
      // warming all three for two batches made scrolling decode hundreds of
      // megabytes that were never visible. The rendered cards load their own
      // poster lazily, so warm only the next visible card image.
      const warmItems = rowItems.slice(0, INITIAL_RENDERED_CARDS)
      void Promise.all(disableArtOverride ? [] : warmItems.map((item) => resolveBetterPoster(item)))
        .then(() => warmCachedImages(warmItems.map((item) => {
          const displayed = disableArtOverride ? item : applySearchResultArt(item)
          return displayed.poster || displayed.backdrop
        })))
    }
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    if (idleWindow.requestIdleCallback) {
      const idleId = idleWindow.requestIdleCallback(warm, { timeout: 3_000 })
      return () => idleWindow.cancelIdleCallback?.(idleId)
    }
    const timer = window.setTimeout(warm, 1_000)
    return () => window.clearTimeout(timer)
  }, [rowItems, disableArtOverride])
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
  const handleRowScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (renderMoreFrameRef.current) return
    const element = event.currentTarget
    renderMoreFrameRef.current = window.requestAnimationFrame(() => {
      renderMoreFrameRef.current = 0
      renderMoreCards(element)
      rememberShelfView(shelfViewKey, { scrollLeft: element.scrollLeft, renderedCount })
    })
  }, [renderMoreCards, renderedCount, shelfViewKey])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const restore = () => {
      const saved = getShelfView(shelfViewKey)
      if (saved) element.scrollLeft = saved.scrollLeft
    }
    restore()
    const frame = window.requestAnimationFrame(restore)
    return () => {
      window.cancelAnimationFrame(frame)
      rememberShelfView(shelfViewKey, { scrollLeft: element.scrollLeft, renderedCount })
    }
  }, [renderedCount, shelfViewKey])
  useEffect(() => () => {
    if (renderMoreFrameRef.current) window.cancelAnimationFrame(renderMoreFrameRef.current)
  }, [])

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
          {renderedItems.map((item) => (
            <MediaCard key={mediaIdentity(item)} item={item} layout="landscape" disableTrailerPreview={disableTrailerPreview} />
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
        onScroll={handleRowScroll}
        onWheel={handleRowWheel}
        className={`flex items-start overflow-x-auto overflow-y-hidden overscroll-x-contain px-6 pt-4 -mt-4 pb-4 scrollbar-none ${effectiveLayout === 'ranked' ? 'gap-1' : effectiveLayout === 'feature' ? 'gap-5' : 'gap-4'} ${cinematic ? 'cinematic-row-track px-8 pb-8' : ''}`}
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {renderedItems.map((item, idx) => {
          const focused = focusedCardIndex === idx || (fixedHome && focusedCardIndex == null && idx === 0)
          return (
            <React.Fragment key={mediaIdentity(item)}>
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
            className={`show-all-card focus-ring group flex flex-shrink-0 flex-col items-center justify-center self-start overflow-hidden border border-white/10 text-white ${effectiveLayout === 'ranked' ? 'ml-4' : ''}`}
            style={showAllGeometry}
          >
            <div className="show-all-card__icon relative z-10 mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/[.12]">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.25" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </div>
            <span className="relative z-10 text-sm font-bold tracking-tight">Show all</span>
          </button>
        )}
      </div>
    </section>
  )
}

export default React.memo(MediaRow)
