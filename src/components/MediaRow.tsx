import { useRef } from 'react'
import type { SearchResult } from '../types'
import MediaCard from './MediaCard'

interface MediaRowProps {
  title: string
  items: SearchResult[]
  layout?: 'poster' | 'landscape' | 'list'
}

export default function MediaRow({ title, items, layout = 'poster' }: MediaRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const amount = direction === 'left' ? -400 : 400
    scrollRef.current.scrollBy({ left: amount, behavior: 'smooth' })
  }

  if (items.length === 0) return null

  if (layout === 'list') {
    return (
      <div className="mb-8 px-6">
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
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
      <div className="flex items-center justify-between px-6 mb-3">
        <h2 className="text-lg font-semibold">{title}</h2>
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
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto px-6 pb-2 scrollbar-none"
        style={{ scrollbarWidth: 'none' }}
      >
        {items.map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            layout={layout === 'landscape' ? 'landscape' : 'poster'}
          />
        ))}
      </div>
    </div>
  )
}
