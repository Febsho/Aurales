import React, { useRef, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import MediaCard from './MediaCard'
import { useAppStore } from '../stores/appStore'

const CATALOG_PREVIEW_LIMIT = 25

interface MediaRowProps {
  title: string
  items: SearchResult[]
  layout?: 'poster' | 'landscape' | 'list'
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

function MediaRow({ title, items, layout = 'poster', showAllPath, forceShowAll = false, disableArtOverride = false, disableTrailerPreview = false, showRank = false, headerLeftControls, headerRightControls, cinematicExpand = true }: MediaRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const posterSize = useAppStore((s) => s.posterSize)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const [focusedItem, setFocusedItem] = useState<SearchResult | null>(null)

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0
    }
  }, [items, title])

  const showAllWidthClass = useMemo(() => {
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

  const visibleItems = items.filter((item) => item.poster || item.backdrop || item.tmdbId || item.imdbId)
  const shouldShowAll = Boolean(showAllPath && (forceShowAll || visibleItems.length > CATALOG_PREVIEW_LIMIT || items.length > CATALOG_PREVIEW_LIMIT))
  const rowItems = shouldShowAll ? visibleItems.slice(0, CATALOG_PREVIEW_LIMIT) : visibleItems
  // Pass the full row along so catalogs without a backing config (e.g. Discover
  // sections) can render everything even when the seeded cache is unavailable
  const openShowAll = () => { if (showAllPath) navigate(showAllPath, { state: { showAllItems: visibleItems } }) }

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
          {rowItems.map((item) => (
            <MediaCard key={item.id} item={item} layout="landscape" disableTrailerPreview={disableTrailerPreview} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <section className={`media-row mb-8 ${cinematic ? 'cinematic-media-row !mb-2' : ''}`}>
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
        className={`flex items-start gap-4 overflow-x-auto overflow-y-hidden overscroll-x-contain px-6 pt-4 -mt-4 pb-4 scrollbar-none scroll-gpu ${cinematic ? 'cinematic-row-track gap-5 px-8 pb-8' : ''}`}
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {rowItems.map((item, idx) => (
          <MediaCard
            key={item.id}
            item={item}
            layout={cinematic || layout === 'landscape' ? 'landscape' : 'poster'}
            disableArtOverride={disableArtOverride}
            disableTrailerPreview={disableTrailerPreview}
            rank={showRank ? idx + 1 : undefined}
            onFocusItem={cinematic ? setFocusedItem : undefined}
            onUnfocusItem={cinematic ? (unfocused) => setFocusedItem((current) => current?.id === unfocused.id ? null : current) : undefined}
            cinematicMode={cinematic}
            cinematicFocused={cinematic && focusedItem?.id === item.id}
            cinematicExpand={cinematicExpand}
          />
        ))}
        {shouldShowAll && showAllPath && (
          <button
            onClick={openShowAll}
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
