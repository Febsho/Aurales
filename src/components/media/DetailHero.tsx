import { useState, type ReactNode } from 'react'
import type { CastMember, CrewMember } from '../../types'

interface DetailHeroProps {
  title: string
  originalTitle?: string
  year?: number
  overview?: string
  tagline?: string
  runtime?: number
  rating?: number
  genres?: string[]
  certification?: string
  poster?: string
  backdrop?: string
  logo?: string
  imdbId?: string
  type: 'movie' | 'series'
  status?: string
  numberOfSeasons?: number
  actions?: ReactNode
  ratingsStrip?: ReactNode
  cast?: CastMember[]
  crew?: CrewMember[]
}

function formatRuntime(minutes?: number): string | null {
  if (!minutes || minutes <= 10) return null
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}m`
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

export default function DetailHero({
  title,
  year,
  overview,
  tagline,
  runtime,
  rating,
  genres,
  certification,
  poster,
  backdrop,
  logo,
  imdbId,
  type,
  status,
  numberOfSeasons,
  actions,
  ratingsStrip,
  cast,
  crew,
}: DetailHeroProps) {
  const [backdropLoaded, setBackdropLoaded] = useState(false)
  const [backdropError, setBackdropError] = useState(false)
  const [logoError, setLogoError] = useState(false)

  const runtimeStr = formatRuntime(runtime)
  const topCast = cast?.slice(0, 3) ?? []

  const metaParts = [
    year,
    genres?.[0],
    runtimeStr,
    numberOfSeasons ? `${numberOfSeasons} Season${numberOfSeasons > 1 ? 's' : ''}` : null,
    certification,
  ].filter(Boolean)
  const metaLine = metaParts.join(' · ')

  return (
    <div className="detail-hero-panel relative w-full overflow-hidden" style={{ height: '100%' }}>
      {/* Backdrop image */}
      {backdrop && !backdropError ? (
        <img
          src={backdrop.replace('/w780/', '/original/').replace('/w1280/', '/original/')}
          alt=""
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${backdropLoaded ? 'opacity-100' : 'opacity-0'}`}
          style={{ objectPosition: 'center 20%' }}
          draggable={false}
          onLoad={() => setBackdropLoaded(true)}
          onError={() => setBackdropError(true)}
        />
      ) : poster ? (
        <img
          src={poster}
          alt=""
          className="absolute inset-0 w-full h-full object-cover blur-3xl scale-125 opacity-50"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-surface-elevated to-surface" />
      )}

      {backdrop && !backdropLoaded && !backdropError && (
        <div className="absolute inset-0 bg-surface animate-pulse" />
      )}

      {/* Cinematic gradients */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/20 to-transparent" />

      {/* Content — bottom-left */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-8 pb-12">
        {/* Tagline */}
        {tagline && (
          <p className="text-sm text-white/40 font-medium tracking-wide uppercase mb-3">{tagline}</p>
        )}

        {/* Title */}
        <div className="mb-3 min-h-[60px] flex items-end">
          {logo && !logoError ? (
            <img
              src={logo}
              alt={title}
              className="max-h-[110px] md:max-h-[140px] max-w-[90%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]"
              onError={() => setLogoError(true)}
              draggable={false}
            />
          ) : (
            <h1 className="text-6xl font-bold drop-shadow-xl leading-[1.05] tracking-tight max-w-2xl">
              {title}
            </h1>
          )}
        </div>

        {/* Meta line: year · genre · runtime · seasons · certification */}
        {metaLine && (
          <p className="text-sm text-white/50 font-medium tracking-wide mb-3">
            {metaLine}
            {status && status !== 'Released' && status !== 'Ended' && (
              <span className="ml-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-white/10 text-white/60 rounded-full">
                {status}
              </span>
            )}
          </p>
        )}

        {/* Compact colored rating badges */}
        {ratingsStrip}

        {/* Overview */}
        {overview && (
          <p className="text-[15px] text-white/55 leading-relaxed max-w-xl line-clamp-2 mb-4">
            {overview}
          </p>
        )}

        {/* Actor avatars */}
        {topCast.length > 0 && (
          <div className="flex items-center gap-2 mb-5">
            <div className="flex -space-x-1.5">
              {topCast.map((actor) => (
                <div key={actor.id} className="w-8 h-8 rounded-full border-2 border-black/60 overflow-hidden bg-surface-elevated flex-shrink-0">
                  {actor.profilePath ? (
                    <img src={actor.profilePath} alt={actor.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] font-bold text-white/40">
                      {actor.name.charAt(0)}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <span className="text-xs text-white/45 font-medium truncate max-w-sm">
              {topCast.map((a) => a.name).join(', ')}
            </span>
          </div>
        )}

        {/* Action buttons */}
        {actions}
      </div>
    </div>
  )
}
