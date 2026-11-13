import { useMemo, useState } from 'react'
import { PosterBottomStack } from '../media/PosterBottomStack'
import { getPosterFadeAppearance, POSTER_RATING_CAPTION_CLASS, POSTER_RATING_CAPTION_STAR_CLASS } from '../../services/posterLayout'

interface PosterCardProps {
  title: string
  poster?: string
  /** Separate transparent title-logo artwork, composed above the poster image. */
  logo?: string
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
  logo,
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
    if (rating == null || rating === '') return null
    return String(rating).replace(/\/10$/, '').trim()
  }, [rating])
  const fade = getPosterFadeAppearance('short', 'dark')
  const footer = (watched || showRating && ratingStr) ? (
    <div className="flex min-h-4 w-full items-center justify-center gap-1 text-white drop-shadow-md">
      {watched && <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" aria-label="Watched"><circle cx="12" cy="12" r="10" fill="white" /><path d="m7.5 12.2 3 3L17 8.8" fill="none" stroke="#111" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      {showRating && ratingStr && <span className={POSTER_RATING_CAPTION_CLASS}><svg className={POSTER_RATING_CAPTION_STAR_CLASS} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>{ratingStr}</span>}
    </div>
  ) : undefined
  const bottomProgress = progress != null && progress > 2 && !watched ? (
    <div className="mx-1 h-1 w-[calc(100%-0.5rem)] overflow-hidden rounded-full bg-white/35" role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(progress, 100))}>
      <div className="h-full rounded-full bg-white" style={{ width: `${Math.min(progress, 100)}%` }} />
    </div>
  ) : undefined

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex-shrink-0 group cursor-pointer focus-ring text-left',
        'transition-all duration-[var(--duration-slow)] ease-expo',
        sizeWidths[size],
        className,
      ].join(' ')}
    >
      <div className="poster-artwork-viewport relative mb-2.5 aspect-[2/3] overflow-hidden rounded-2xl border border-white/[0.04] bg-surface-card transition-all duration-[var(--duration-slow)] ease-expo group-hover:-translate-y-2 group-hover:scale-[1.04] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)]">
        {poster && !imgError ? (
          <img src={poster} alt={title} className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105" loading="lazy" decoding="async" onError={() => setImgError(true)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-card to-surface">
            <span className="text-3xl font-bold text-white/15">{title?.charAt(0) || '?'}</span>
          </div>
        )}
        <div className={`poster-artwork-fade absolute inset-x-0 bottom-0 ${fade.heightClass} ${fade.colorClass}`} style={{ background: fade.background }} />
        <PosterBottomStack
          logo={logo ? <img src={logo} alt="" aria-hidden="true" className="max-h-10 max-w-[72%] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,.8)] sm:max-h-16" loading="lazy" /> : undefined}
          footer={footer}
          bottomProgress={bottomProgress}
        />
      </div>
      <h3 className="truncate pl-1 text-xs font-semibold text-white/70 transition-colors group-hover:text-white">{title}</h3>
      {year && <p className="mt-0.5 pl-1 text-label text-white/60">{year}</p>}
    </button>
  )
}
