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
import { isMobileWebViewport } from '../platform/mobileWeb'
import { getMediaRowScrollTarget } from './mediaRowScroll'
import { preferredScrollBehavior } from '../services/motion'

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
  showAllItems?: SearchResult[]
  forceShowAll?: boolean
  /** Use a section-specific preview size instead of the profile-wide row count. */
  previewLimit?: number
  /** Render the entire capped preview at once, for small editorial lists like Top 10. */
  renderAllPreviewItems?: boolean
  disableArtOverride?: boolean
  disableTrailerPreview?: boolean
  showRank?: boolean
  headerLeftControls?: React.ReactNode
  headerRightControls?: React.ReactNode
  /** Set false to keep cinematic cards at poster size (no landscape expansion on focus). */
  cinematicExpand?: boolean
  /** Render standard-sized cards even when the app-wide theme is cinematic. */
  disableCinematic?: boolean
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

function MediaRow({ title, items, layout = 'poster', showAllPath, showAllItems, forceShowAll = false, previewLimit, renderAllPreviewItems = false, disableArtOverride = false, disableTrailerPreview = false, headerLeftControls, headerRightControls, cinematicExpand = true, disableCinematic = false }: MediaRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const rowEntryCount = useAppStore((s) => s.rowEntryCount)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic' && !disableCinematic
  const homeCardAnimations = useAppStore((s) => s.homeCardAnimations)
  const fixedHome = useAppStore((s) => s.homeHeroMode) === 'fixed' && location.pathname === '/' && !isMobileWebViewport()
  // Titles are not unique: a page can show several sections called "Trending".
  // Include their leading media identities so each rail gets its own restored
  // position and progressive-render count.
  const shelfContentKey = items.slice(0, 3).map(mediaIdentity).join('|')
  // Older positions were saved while "Show all" was the only snap target,
  // which forced affected rails to their right edge. Start those rails fresh.
  const shelfViewKey = `${routeViewKey(location.pathname, location.search)}:${showAllPath || title}:${layout}:${shelfContentKey}:snap-v2`
  // Layout is authoritative. Older shelf records may still carry showRank=true;
  // that must never turn a user-selected Poster shelf back into Ranked. Feature
  // cards retain their chosen presentation on Fixed Home as well—the fixed-home
  // card sizing in MediaCard keeps them inside the hero-safe shelf area.
  const isJellyfinCollectionRow = items.length > 0 && items.every((item) => item.mediaType === 'collection')
  const effectiveLayout = isJellyfinCollectionRow ? 'landscape' : layout
  const specialLayout = effectiveLayout === 'ranked' || effectiveLayout === 'feature'
  // Focus belongs to a rendered card instance, not to a media ID. Catalogs can
  // legitimately contain duplicate/canonicalized entries with the same ID.
  const [focusedCardIndex, setFocusedCardIndex] = useState<number | null>(null)
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false })
  const scrollTargetRef = useRef<number | null>(null)
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

  const updateScrollEdges = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
    const next = { left: element.scrollLeft > 1, right: element.scrollLeft < maxScroll - 1 }
    setScrollEdges((current) => current.left === next.left && current.right === next.right ? current : next)
  }, [])

  const scroll = (direction: 'left' | 'right') => {
    const element = scrollRef.current
    if (!element) return
    const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
    if (maxScroll <= 1) {
      scrollTargetRef.current = 0
      updateScrollEdges()
      return
    }
    const cards = Array.from(element.querySelectorAll<HTMLElement>(':scope > .media-row-card-slot'))
    const trackRect = element.getBoundingClientRect()
    const startInset = Number.parseFloat(getComputedStyle(element).paddingLeft) || 0
    const cardTargets = cards.map((card) => Math.max(0, Math.min(maxScroll,
      element.scrollLeft + card.getBoundingClientRect().left - trackRect.left - startInset,
    )))
    if (!cardTargets.length) return

    // Navigate by actual card starts instead of a guessed pixel distance.
    // This keeps rapid taps deterministic and clamps the final step to the
    // real scroll extent when the last card is only partly visible.
    const current = scrollTargetRef.current ?? element.scrollLeft
    const firstCardWidth = cards[0]?.getBoundingClientRect().width || 1
    const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0
    const cardsPerPage = Math.max(1, Math.floor((element.clientWidth + gap) / (firstCardWidth + gap)))
    const target = getMediaRowScrollTarget({ cardStarts: cardTargets, current, maxScroll, direction, cardsPerPage })
    if (target == null || Math.abs(target - element.scrollLeft) <= 1) {
      updateScrollEdges()
      return
    }
    scrollTargetRef.current = target
    element.scrollTo({ left: target, behavior: preferredScrollBehavior() })
    updateScrollEdges()
    window.setTimeout(() => {
      if (scrollTargetRef.current === target) scrollTargetRef.current = null
    }, 450)
  }

  const handleRowWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (Math.abs(amount) < 1) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: amount, behavior: preferredScrollBehavior() })
  }

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!cinematic || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(':scope > .media-row-card-slot > button'))
    const index = cards.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    const next = cards[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus({ preventScroll: true })
    next.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'nearest', inline: 'center' })
  }

  const visibleItems = useMemo(
    () => dedupeMediaItems(items.filter((item) => item.poster || item.backdrop || item.tmdbId || item.imdbId)),
    [items],
  )
  const rowLimit = previewLimit ?? rowEntryCount
  const shouldShowAll = Boolean(showAllPath && (forceShowAll || visibleItems.length > rowLimit))
  const rowItems = useMemo(
    () => shouldShowAll ? visibleItems.slice(0, rowLimit) : visibleItems,
    [rowLimit, shouldShowAll, visibleItems],
  )
  const renderedItems = useMemo(
    // A list is vertically laid out and has no horizontal edge at which to
    // request another batch, so applying shelf progressive rendering here
    // would permanently hide everything after the initial batch.
    () => layout === 'list' || renderAllPreviewItems ? rowItems : rowItems.slice(0, renderedCount),
    [layout, renderAllPreviewItems, rowItems, renderedCount],
  )
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const fillViewport = () => {
      if (element.clientWidth > 0 && element.scrollWidth <= element.clientWidth + 1) {
        setRenderedCount((count) => count < rowItems.length
          ? Math.min(rowItems.length, count + CARD_RENDER_BATCH)
          : count)
      }
    }
    fillViewport()
    updateScrollEdges()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { fillViewport(); updateScrollEdges() })
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [renderedCount, rowItems.length, shelfViewKey, updateScrollEdges])
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
  const openShowAll = () => { if (showAllPath) navigate(showAllPath, { state: { showAllItems: showAllItems || visibleItems } }) }
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
            {showAllPath ? <button onClick={openShowAll} aria-label={`Open ${title} catalog`} title="Open full list" className="focus-ring rounded-lg text-left"><h2 className="text-xl font-bold tracking-tight text-white/95">{title}</h2></button> : <h2 className="text-xl font-bold tracking-tight text-white/95">{title}</h2>}
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
              aria-label={`Open ${title} catalog`}
              className="group/title flex items-center gap-1.5 cursor-pointer focus-ring rounded-lg"
              title="Open full list"
            >
              <h2 className="text-xl font-bold tracking-tight text-white/95 transition-colors group-hover/title:text-white">{title}</h2>
              <svg className="w-4 h-4 text-white/45 transition-all duration-200 group-hover/title:text-white/80 group-hover/title:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
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
            disabled={!scrollEdges.left}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center transition-colors cursor-pointer text-white/50 hover:text-white disabled:opacity-20 disabled:cursor-default"
            aria-label="Scroll left"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => scroll('right')}
            disabled={!scrollEdges.right}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center transition-colors cursor-pointer text-white/50 hover:text-white disabled:opacity-20 disabled:cursor-default"
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
        data-media-row-track
        onPointerDown={() => { scrollTargetRef.current = null }}
        onKeyDown={handleRowKeyDown}
        onScroll={(event) => { handleRowScroll(event); updateScrollEdges() }}
        onWheel={handleRowWheel}
        className={`flex items-start overflow-x-auto overflow-y-hidden overscroll-x-contain px-6 pt-4 -mt-4 pb-4 scrollbar-none ${effectiveLayout === 'ranked' ? 'gap-1' : effectiveLayout === 'feature' ? 'gap-5' : 'gap-4'} ${cinematic ? 'cinematic-row-track px-8 pb-8' : ''}`}
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {renderedItems.map((item, idx) => {
          const focused = focusedCardIndex === idx || (fixedHome && focusedCardIndex == null && idx === 0)
          return (
            <React.Fragment key={mediaIdentity(item)}>
              <div className="media-row-card-slot relative flex-none" style={{ '--discover-card-delay': `${(idx % 10) * 32}ms` } as React.CSSProperties}>
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
                cinematicExpand={cinematicExpand && homeCardAnimations && !fixedHome && !isMobileWebViewport()}
                fixedHome={fixedHome}
              />
              </div>
              {fixedHome && homeCardAnimations && !isMobileWebViewport() && focused && <FixedShelfDetails item={item} />}
            </React.Fragment>
          )
        })}
      </div>
    </section>
  )
}

export default React.memo(MediaRow)
