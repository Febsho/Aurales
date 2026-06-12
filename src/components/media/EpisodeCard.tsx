import { useState } from 'react'

interface EpisodeCardProps {
  episodeNumber: number
  seasonNumber: number
  name: string
  overview?: string
  runtime?: number
  still?: string
  rating?: number
  watched?: boolean
  progress?: number
  onPlay?: () => void
  className?: string
}

export default function EpisodeCard({
  episodeNumber,
  name,
  overview,
  runtime,
  still,
  rating,
  watched,
  progress,
  onPlay,
  className = '',
}: EpisodeCardProps) {
  const [imgError, setImgError] = useState(false)

  return (
    <button
      onClick={onPlay}
      className={[
        'w-full flex gap-4 p-3 rounded-xl',
        'bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-white/[0.10]',
        'transition-all duration-200 cursor-pointer group text-left',
        'focus-ring',
        className,
      ].join(' ')}
    >
      {/* Thumbnail */}
      <div className="relative w-44 flex-shrink-0 aspect-video rounded-lg overflow-hidden bg-surface-card">
        {still && !imgError ? (
          <img
            src={still}
            alt={name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-card to-surface">
            <span className="text-lg font-bold text-white/15">E{episodeNumber}</span>
          </div>
        )}

        {/* Play overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>

        {/* Progress bar */}
        {!watched && progress != null && progress > 2 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40">
            <div className="h-full bg-accent rounded-r-full" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
        )}

        {/* Watched badge */}
        {watched && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
            <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 py-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-bold text-accent">E{episodeNumber}</span>
          {runtime && (
            <span className="text-xs text-white/30">{runtime}m</span>
          )}
          {rating && (
            <span className="flex items-center gap-0.5 text-xs text-yellow-400/70 font-semibold">
              <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              {rating.toFixed(1)}
            </span>
          )}
        </div>
        <h4 className="text-sm font-semibold text-white/85 truncate group-hover:text-white transition-colors">
          {name}
        </h4>
        {overview && (
          <p className="text-xs text-white/35 line-clamp-2 mt-1 leading-relaxed">{overview}</p>
        )}
      </div>
    </button>
  )
}
