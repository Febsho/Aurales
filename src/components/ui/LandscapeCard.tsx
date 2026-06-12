import { useState, useMemo } from 'react'

interface LandscapeCardProps {
  title: string
  backdrop?: string
  poster?: string
  year?: number
  rating?: number | string
  progress?: number
  watched?: boolean
  showRating?: boolean
  size?: 'compact' | 'default' | 'large' | 'huge'
  onClick?: () => void
  className?: string
}

const sizeWidths = {
  compact: 'w-[240px]',
  default: 'w-[288px]',
  large: 'w-[320px]',
  huge: 'w-[384px]',
}

export default function LandscapeCard({
  title,
  backdrop,
  poster,
  year,
  rating,
  progress,
  watched,
  showRating = true,
  size = 'default',
  onClick,
  className = '',
}: LandscapeCardProps) {
  const [imgError, setImgError] = useState(false)
  const [backdropError, setBackdropError] = useState(false)

  const ratingStr = useMemo(() => {
    if (!rating) return null
    return String(rating).replace(/\/10$/, '').trim()
  }, [rating])

  const image = backdrop && !backdropError ? backdrop : poster && !imgError ? poster : null

  return (
    <button
      onClick={onClick}
      className={[
        'flex-shrink-0 group cursor-pointer focus-ring text-left',
        'transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
        sizeWidths[size],
        className,
      ].join(' ')}
    >
      <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-card border border-white/[0.04] transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-hover:-translate-y-1.5 group-hover:scale-[1.03] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)]">
        {image ? (
          <img
            src={image}
            alt={title}
            className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            loading="lazy"
            onError={() => {
              if (image === backdrop) setBackdropError(true)
              else setImgError(true)
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-card to-surface">
            <span className="text-2xl font-bold text-white/15">{title?.charAt(0) || '?'}</span>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent transition-opacity duration-300 group-hover:from-black/90" />

        {watched && (
          <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-accent flex items-center justify-center shadow-lg z-10">
            <svg className="w-3.5 h-3.5 text-black" fill="none" stroke="currentColor" strokeWidth="2.8" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {showRating && ratingStr && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-lg bg-black/60 backdrop-blur-md border border-white/10 flex items-center gap-1 shadow-lg z-10 text-[10px] font-bold text-yellow-400">
            <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
            </svg>
            {ratingStr}
          </div>
        )}

        {!watched && progress != null && progress > 2 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40 z-10">
            <div className="h-full bg-accent rounded-r-full transition-all" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
        )}

        <div className="absolute bottom-3 left-3 right-3 flex flex-col gap-1 z-10">
          <h3 className="text-sm font-bold text-white tracking-wide truncate drop-shadow-lg">
            {title}
          </h3>
          {year && (
            <span className="text-xs text-white/60 font-medium drop-shadow-md">{year}</span>
          )}
        </div>
      </div>
    </button>
  )
}
