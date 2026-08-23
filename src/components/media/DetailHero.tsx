import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Award } from 'lucide-react'
import type { CastMember, CrewMember } from '../../types'
import { cachedImage, retryImageFromSource } from '../../services/imageCache'
import type { StreamFeature } from '../../services/streams/streamFeatures'
import { editorialAccolade, fetchTitleAccolade, isGenericAwardAccolade } from '../../services/accolades'

function ExpandableOverview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    setExpanded(false)
    const el = textRef.current
    if (!el) return
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])

  const interactive = clamped || expanded
  return (
    <p
      ref={textRef}
      onClick={interactive ? () => setExpanded((value) => !value) : undefined}
      title={!expanded && clamped ? 'Show full description' : undefined}
      className={`text-[17px] text-white/55 leading-relaxed max-w-2xl mb-5 transition-colors ${expanded ? '' : 'line-clamp-3'} ${interactive ? 'cursor-pointer hover:text-white/75' : ''}`}
    >
      {text}
    </p>
  )
}

/** Dolby's double-D mark, drawn inline so the badge needs no asset. */
function DolbyMark() {
  return (
    <svg viewBox="0 0 20 14" className="h-[13px] w-[19px] flex-shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M0 0h8.4v14H0V0zm2.6 2.6v8.8L6 7 2.6 2.6z" />
      <path d="M20 0h-8.4v14H20V0zm-2.6 2.6v8.8L14 7l3.4-4.4z" />
    </svg>
  )
}

/**
 * Two shapes, the way Apple TV renders them: brand lockups (Dolby) stay bare
 * so the wordmark reads as itself, everything else sits in a soft chip.
 */
function FeatureBadge({ feature }: { feature: StreamFeature }) {
  if (feature.sublabel) {
    return (
      <span className="inline-flex items-center gap-1 h-[26px] text-white/90" title={`${feature.label} ${feature.sublabel}`}>
        {feature.mark === 'dolby' && <DolbyMark />}
        <span className="flex flex-col leading-none">
          <span className="text-[14px] font-medium tracking-tight">{feature.label}</span>
          <span className="text-[9px] font-semibold uppercase tracking-[0.1em]">{feature.sublabel}</span>
        </span>
      </span>
    )
  }
  // Knockout: `screen` leaves the white pill white and lets black glyphs fall
  // through to the backdrop, so the label reads as cut out of the chip. This
  // only works while no ancestor between the chip and the backdrop image
  // creates a stacking context — see the content wrapper below.
  return (
    <span className="inline-flex items-center h-[26px] px-2 rounded-[6px] bg-white text-black text-[13px] font-bold tracking-[0.02em] leading-none mix-blend-screen">
      {feature.label}
    </span>
  )
}

interface DetailHeroProps {
  title: string
  originalTitle?: string
  year?: number
  releaseDate?: string
  overview?: string
  runtime?: number
  rating?: number
  voteCount?: number
  genres?: string[]
  certification?: string
  poster?: string
  backdrop?: string
  logo?: string
  imdbId?: string
  type: 'movie' | 'series'
  status?: string
  seriesType?: string
  numberOfSeasons?: number
  latestSeasonAirDate?: string
  actions?: ReactNode
  ratingsStrip?: ReactNode
  cast?: CastMember[]
  crew?: CrewMember[]
  /** Tech-spec badges read off the top stream (4K, Dolby Vision, Atmos, CC…). */
  streamFeatures?: StreamFeature[]
}

function formatRuntime(minutes?: number): string | null {
  if (!minutes || minutes <= 10) return null
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}m`
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function safeDisplayText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  if (!text || text === '[object Object]' || text === 'undefined' || text === 'null') return null
  return text
}

export default function DetailHero({
  title,
  year,
  releaseDate,
  overview,
  runtime,
  rating,
  voteCount,
  genres,
  certification,
  poster,
  backdrop,
  logo,
  imdbId,
  type,
  status,
  seriesType,
  numberOfSeasons,
  latestSeasonAirDate,
  actions,
  ratingsStrip,
  cast,
  crew,
  streamFeatures,
}: DetailHeroProps) {
  // Scope image state to its URL. Resetting booleans in an effect races a fast
  // cached image: onLoad can run first, then the effect sets loaded=false and
  // the same URL never emits another load event, leaving the Hero black.
  const [loadedBackdropUrl, setLoadedBackdropUrl] = useState<string | null>(null)
  const [failedBackdropUrl, setFailedBackdropUrl] = useState<string | null>(null)
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null)
  const [accolade, setAccolade] = useState<string | null | undefined>(undefined)
  const backdropLoaded = Boolean(backdrop && loadedBackdropUrl === backdrop)
  const backdropError = Boolean(backdrop && failedBackdropUrl === backdrop)
  const logoError = Boolean(logo && failedLogoUrl === logo)

  useEffect(() => {
    setAccolade(undefined)
    if (!imdbId) {
      setAccolade(null)
      return
    }

    const controller = new AbortController()
    fetchTitleAccolade(imdbId, controller.signal)
      .then((label) => setAccolade(label))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setAccolade(null)
        }
      })
    return () => controller.abort()
  }, [imdbId])
  const editorialLabel = editorialAccolade({
    type,
    year,
    releaseDate,
    rating,
    voteCount,
    status,
    seriesType,
    latestSeasonAirDate,
    crewNames: crew?.map((member) => member.name),
  })
  const displayAccolade = accolade === undefined
    ? null
    : accolade && !isGenericAwardAccolade(accolade)
      ? accolade
      : editorialLabel || accolade

  const runtimeStr = formatRuntime(runtime)
  const topCast = cast?.slice(0, 3) ?? []

  // Genres arrive either as plain strings or as TMDB-style {id, name} objects.
  const genreNames = (genres ?? []).slice(0, 2).map((raw) => {
    const value = raw as unknown
    return value && typeof value === 'object'
      ? safeDisplayText((value as Record<string, unknown>).name || (value as Record<string, unknown>).title)
      : safeDisplayText(value)
  }).filter((name): name is string => Boolean(name))

  let certStr: string | null = null
  if (certification) {
    if (typeof certification === 'string') {
      certStr = safeDisplayText(certification)
    } else if (typeof certification === 'object') {
      const record = certification as unknown as Record<string, unknown>
      certStr = safeDisplayText(record.certification || record.rating || record.name || record.value)
    }
  }

  const statusStr = safeDisplayText(status)

  // Apple TV splits the metadata in two: kind + genres sit above the synopsis,
  // release/runtime + tech badges sit directly above the Play button.
  const kindLabel = type === 'series' ? 'TV Show' : 'Movie'
  const classificationLine = [kindLabel, ...genreNames].join(' · ')
  const specParts = [
    year ? String(year) : null,
    runtimeStr,
    numberOfSeasons ? `${numberOfSeasons} Season${numberOfSeasons > 1 ? 's' : ''}` : null,
  ].filter((part): part is string => Boolean(part))
  const features = streamFeatures ?? []

  return (
    <div className="detail-hero-panel relative w-full overflow-hidden" style={{ height: '100%' }}>
      {/* Backdrop image */}
      {backdrop && !backdropError ? (
        <img
          src={cachedImage(backdrop)}
          alt=""
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${backdropLoaded ? 'opacity-100' : 'opacity-0'}`}
          style={{ objectPosition: 'center 20%' }}
          draggable={false}
          onLoad={() => {
            setLoadedBackdropUrl(backdrop)
            setFailedBackdropUrl((failed) => failed === backdrop ? null : failed)
          }}
          onError={(event) => {
            if (!retryImageFromSource(event.currentTarget, backdrop)) setFailedBackdropUrl(backdrop)
          }}
        />
      ) : poster ? (
        <img
          src={cachedImage(poster)}
          alt=""
          className="absolute inset-0 w-full h-full object-cover blur-3xl scale-125 opacity-50"
          draggable={false}
          onError={(event) => { retryImageFromSource(event.currentTarget, poster) }}
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

      {/* Content — bottom-left. Intentionally no z-index: it would create a
          stacking context and cut the tech badges' knockout blend off from the
          backdrop. DOM order already paints this above the gradients. */}
      <div className="detail-hero-panel__content absolute bottom-0 left-0 right-0 px-12 pb-14">
        {/* Sourced accolade highlight; absent when the provider has no notable
            award summary, so the hero never invents editorial claims. */}
        {displayAccolade && (
          <div className="mb-4">
            <span className="inline-flex h-8 items-center gap-2 rounded-full bg-white/[0.09] px-3.5 text-[13px] font-semibold tracking-[0.01em] text-white/85 ring-1 ring-inset ring-white/[0.12] shadow-[0_8px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl">
              <Award className="h-4 w-4 text-white/55" strokeWidth={1.8} aria-hidden="true" />
              {displayAccolade}
            </span>
          </div>
        )}

        {/* Title */}
        <div className="mb-4 min-h-[80px] flex items-end">
          {logo && !logoError ? (
            <img
              src={cachedImage(logo)}
              alt={title}
              className="max-h-[150px] md:max-h-[190px] max-w-[90%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]"
              onError={(event) => {
                if (!retryImageFromSource(event.currentTarget, logo)) setFailedLogoUrl(logo)
              }}
              draggable={false}
            />
          ) : (
            <h1 className="detail-hero-panel__title text-7xl font-bold drop-shadow-xl leading-[1.05] tracking-tight max-w-3xl">
              {title}
            </h1>
          )}
        </div>

        {/* Kind · genres · certification */}
        <div className="flex items-center gap-2.5 flex-wrap mb-4">
          <span className="text-[17px] text-white/90 tracking-[0.01em]">{classificationLine}</span>
          {certStr && (
            <span className="inline-flex items-center h-[22px] px-1.5 text-[12px] font-semibold uppercase tracking-wide text-white/85 border border-white/35 rounded-[5px] leading-none">
              {certStr}
            </span>
          )}
          {statusStr && statusStr !== 'Released' && statusStr !== 'Ended' && (
            <span className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider bg-white/10 text-white/65 rounded-full leading-none">
              {statusStr}
            </span>
          )}
        </div>

        {/* Compact colored rating badges */}
        {ratingsStrip}

        {/* Overview: clamped to 3 lines; click to expand when it overflows */}
        {overview && <ExpandableOverview text={overview} />}

        {/* Actor avatars */}
        {topCast.length > 0 && (
          <div className="flex items-center gap-3 mb-6">
            <div className="flex -space-x-2">
              {topCast.map((actor) => (
                <div key={actor.id} className="w-10 h-10 rounded-full border-2 border-black/60 overflow-hidden bg-surface-elevated flex-shrink-0">
                  {actor.profilePath ? (
                    <img src={actor.profilePath} alt={actor.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs font-bold text-white/40">
                      {actor.name.charAt(0)}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <span className="text-sm text-white/50 font-medium truncate max-w-md">
              {topCast.map((a) => a.name).join(', ')}
            </span>
          </div>
        )}

        {/* Release specs + tech badges from the top available stream */}
        {(specParts.length > 0 || features.length > 0) && (
          <div className="flex items-center gap-x-2.5 gap-y-2 flex-wrap mb-6">
            {specParts.length > 0 && (
              <span className="mr-1.5 text-[17px] text-white/90 tracking-[0.01em]">{specParts.join(' · ')}</span>
            )}
            {features.map((feature) => (
              <FeatureBadge key={feature.id} feature={feature} />
            ))}
          </div>
        )}

        {/* Action buttons */}
        {actions}
      </div>
    </div>
  )
}
