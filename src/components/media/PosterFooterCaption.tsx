import type { ReactNode } from 'react'

export type PosterContentAlignment = 'left' | 'center' | 'right'

interface PosterFooterCaptionProps {
  alignment: PosterContentAlignment
  status?: ReactNode
  favorite?: ReactNode
  genre?: ReactNode
  ageRating?: ReactNode
  rating?: ReactNode
  showSeparator?: boolean
  className?: string
}

/** Shared footer composition for live posters and their settings preview. */
export function PosterFooterCaption({ alignment, status, favorite, genre, ageRating, rating, showSeparator = false, className = '' }: PosterFooterCaptionProps) {
  const justification = alignment === 'left' ? 'justify-start' : alignment === 'right' ? 'justify-end' : 'justify-center'
  return (
    <div className={`poster-footer-caption flex min-w-0 w-full flex-row flex-wrap items-center gap-x-1 gap-y-1 leading-none text-white sm:flex-nowrap sm:gap-1.5 ${justification} ${className}`}>
      {status}
      {favorite}
      {genre != null && <span className={`poster-footer-caption__genre order-first basis-full line-clamp-2 min-w-0 flex-1 text-center text-[11px] leading-tight font-semibold [text-shadow:0_1px_0_rgba(0,0,0,.85)] sm:order-none sm:basis-auto sm:line-clamp-1 sm:flex-none sm:max-w-[42%] sm:truncate sm:whitespace-nowrap sm:text-meta sm:tracking-wide ${alignment === 'left' ? 'sm:text-left' : alignment === 'right' ? 'sm:text-right' : 'sm:text-center'}`}>{genre}</span>}
      {ageRating}
      {showSeparator && genre != null && rating != null && <span className="hidden shrink-0 text-white/90 sm:inline">·</span>}
      {rating != null && <span className="poster-footer-caption__rating flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums sm:gap-1 sm:text-meta [text-shadow:0_1px_1px_rgba(0,0,0,.85)]">{rating}</span>}
    </div>
  )
}
