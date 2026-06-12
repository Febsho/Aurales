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

  const directors = crew?.filter((c) => c.job === 'Director') ?? []
  const creators = crew?.filter((c) => c.job === 'Creator' || c.job === 'Executive Producer') ?? []
  const topCast = cast?.slice(0, 3) ?? []

  const creditLabel = type === 'series' ? 'Created by' : 'Directed by'
  const creditPeople = type === 'series'
    ? (creators.length > 0 ? creators : directors)
    : directors

  return (
    <div className="detail-hero-panel relative w-full overflow-hidden" style={{ height: '100%' }}>
      {/* Backdrop image */}
      {backdrop && !backdropError ? (
        <img
          src={backdrop}
          alt=""
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${backdropLoaded ? 'opacity-100' : 'opacity-0'}`}
          style={{ objectPosition: 'center 15%' }}
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

      {/* Loading skeleton behind backdrop */}
      {backdrop && !backdropLoaded && !backdropError && (
        <div className="absolute inset-0 bg-surface animate-pulse" />
      )}

      {/* Cinematic gradient overlays */}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 via-50% to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/30 via-40% to-transparent" />
      {/* Top vignette */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-transparent" style={{ height: '30%' }} />
      {/* Edge vignette */}
      <div className="absolute inset-0" style={{ boxShadow: 'inset 0 0 200px 60px rgba(0,0,0,0.4)' }} />

      {/* Content container */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-10 pb-12">
        <div className="flex items-end justify-between gap-12">
          {/* Left column — main info */}
          <div className="flex-1 min-w-0 max-w-3xl">
            {/* Tagline */}
            {tagline && (
              <p className="text-sm text-white/40 font-medium tracking-wide uppercase mb-3">{tagline}</p>
            )}

            {/* Title */}
            <div className="mb-5 min-h-[60px] flex items-end">
              {logo && !logoError ? (
                <img
                  src={logo}
                  alt={title}
                  className="max-h-[110px] md:max-h-[140px] max-w-[90%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]"
                  onError={() => setLogoError(true)}
                  draggable={false}
                />
              ) : (
                <h1 className="text-6xl font-extrabold drop-shadow-2xl leading-[1.05] tracking-tight max-w-2xl">
                  {title}
                </h1>
              )}
            </div>

            {/* Metadata line: Type · Genre · Genre · [Certification] */}
            <div className="flex flex-wrap items-center gap-2.5 mb-5 text-[15px] text-white/60 font-medium">
              <span className="capitalize">{type === 'series' ? 'TV Show' : 'Movie'}</span>
              {genres && genres.length > 0 && genres.slice(0, 3).map((g) => (
                <span key={g} className="flex items-center gap-2">
                  <span className="text-white/20">·</span>
                  <span>{g}</span>
                </span>
              ))}
              {certification && (
                <span className="ml-1 px-2 py-0.5 text-[10px] font-bold text-white/60 border border-white/15 rounded">
                  {certification}
                </span>
              )}
            </div>

            {/* Overview */}
            {overview && (
              <p className="text-[17px] text-white/58 line-clamp-3 mb-6 leading-relaxed max-w-2xl">
                {overview}
              </p>
            )}

            {/* Year · Runtime · Rating · Seasons */}
            <div className="flex flex-wrap items-center gap-3 mb-6 text-[15px]">
              {year && <span className="text-white/50 font-semibold">{year}</span>}
              {runtimeStr && (
                <>
                  <span className="text-white/15">·</span>
                  <span className="text-white/50 font-semibold">{runtimeStr}</span>
                </>
              )}
              {rating && (
                <>
                  <span className="text-white/15">·</span>
                  <span className="flex items-center gap-1 text-yellow-400/90 font-bold">
                    <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    {rating.toFixed(1)}
                  </span>
                </>
              )}
              {numberOfSeasons && (
                <>
                  <span className="text-white/15">·</span>
                  <span className="text-white/50 font-semibold">
                    {numberOfSeasons} Season{numberOfSeasons > 1 ? 's' : ''}
                  </span>
                </>
              )}
              {status && status !== 'Released' && status !== 'Ended' && (
                <span className="px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-white/10 text-white/60 rounded-full">
                  {status}
                </span>
              )}
            </div>

            {/* Ratings strip */}
            {ratingsStrip}

            {/* Action buttons */}
            {actions}
          </div>

          {/* Right column — credits info */}
          {(topCast.length > 0 || creditPeople.length > 0) && (
            <div className="hidden lg:flex flex-col gap-3 flex-shrink-0 max-w-sm text-right">
              {topCast.length > 0 && (
                <div>
                  <p className="text-[11px] text-white/30 font-semibold uppercase tracking-wider mb-1">Starring</p>
                  <p className="text-[14px] text-white/70 leading-relaxed">
                    {topCast.map((c, i) => (
                      <span key={i}>
                        <span className="text-white/90 font-semibold">{c.name}</span>
                        {i < topCast.length - 1 && (i === topCast.length - 2 ? ' and ' : ', ')}
                      </span>
                    ))}
                  </p>
                </div>
              )}
              {creditPeople.length > 0 && (
                <div>
                  <p className="text-[11px] text-white/30 font-semibold uppercase tracking-wider mb-1">{creditLabel}</p>
                  <p className="text-[14px] text-white/90 font-semibold">
                    {creditPeople.slice(0, 2).map((c) => c.name).join(', ')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
