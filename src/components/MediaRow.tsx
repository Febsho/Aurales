import { useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import MediaCard from './MediaCard'
import { useAppStore } from '../stores/appStore'

interface MediaRowProps {
  title: string
  items: SearchResult[]
  layout?: 'poster' | 'landscape' | 'list'
  showAllPath?: string
  disableArtOverride?: boolean
  headerLeftControls?: React.ReactNode
  headerRightControls?: React.ReactNode
}

export default function MediaRow({ title, items, layout = 'poster', showAllPath, disableArtOverride = true, headerLeftControls, headerRightControls }: MediaRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const posterSize = useAppStore((s) => s.posterSize)

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

  if (items.length === 0) return null

  if (layout === 'list') {
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
          {items.map((item) => (
            <MediaCard key={item.id} item={item} layout="landscape" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between px-6 mb-4">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className="text-xl font-bold tracking-tight text-white/95">{title}</h2>
        </div>
        <div className="flex items-center gap-3">
          {headerRightControls}
          <div className="flex gap-1">
          <button
            onClick={() => scroll('left')}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={() => scroll('right')}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 5l7 7-7 7" />
            </svg>
            </button>
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto overscroll-x-contain px-6 pb-2 scrollbar-none"
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {items.map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            layout={layout === 'landscape' ? 'landscape' : 'poster'}
            disableArtOverride={disableArtOverride}
          />
        ))}
        {showAllPath && (
          <button
            onClick={() => navigate(showAllPath)}
            className={`flex-shrink-0 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex flex-col items-center justify-center text-white transition-colors self-start ${showAllWidthClass} ${
              layout === 'landscape' ? 'aspect-video' : 'aspect-[2/3]'
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
    </div>
  )
}
