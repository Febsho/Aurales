import { useState, useMemo } from 'react'

interface PosterCardProps {
  title: string
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
  compact: 'w-[112px]',
  default: 'w-[144px]',
  large: 'w-[176px]',
  huge: 'w-[208px]',
}

export default function PosterCard({
  title,
  poster,
  year,
  rating,
  progress,
  watched,
  showRating = true,
  size = 'default',
  onClick,
  className = '',
}: PosterCardProps) {
  const [imgError, setImgError] = useState(false)

  const ratingStr = useMemo(() => {
    if (!rating) return null
    return String(rating).replace(/\/10$/, '').trim()
  }, [rating])

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
      <div className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-surface-card mb-2.5 border border-white/[0.04] transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-hover:-translate-y-2 group-hover:scale-[1.04] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)]">
        {poster && !imgError ? (
          <img
            src={poster}
            alt={title}
            className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-card to-surface">
            <span className="text-3xl font-bold text-white/15">{title?.charAt(0) || '?'}</span>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

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
      </div>

      <h3 className="text-xs font-semibold text-white/70 truncate group-hover:text-white transition-colors pl-1">
        {title}
      </h3>
      {year && (
        <p className="text-[11px] text-white/35 pl-1 mt-0.5">{year}</p>
      )}
    </button>
  )
}
