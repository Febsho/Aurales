import { useEffect, useState } from 'react'
import { getMdblistRatings, getRatingIconUrl, type MdblistRating } from '../services/mdblist'
import { useAppStore } from '../stores/appStore'

interface RatingsStripProps {
  mediaType: 'movie' | 'series'
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  season?: number
  episode?: number
  className?: string
  compact?: boolean
  /** Detail-hero presentation: leads with the strongest score and names every
   *  source, so the row reads as ratings rather than as anonymous icons. */
  variant?: 'hero'
  episodeRating?: string
  isAnime?: boolean
}

export default function RatingsStrip(props: RatingsStripProps) {
  const [ratings, setRatings] = useState<MdblistRating[]>([])

  useEffect(() => {
    const imdbEpisodeRating = toImdbRating(props.episodeRating)

    if (props.episode != null && !props.isAnime) {
      setRatings(imdbEpisodeRating ? [imdbEpisodeRating] : [])
      return
    }

    if (props.episode != null && props.isAnime) {
      let cancelled = false
      import('../services/jikan')
        .then(({ getJikanEpisodeRating }) => getJikanEpisodeRating(props.malId, props.episode))
        .then((score) => {
          if (cancelled) return
          const malEpisodeRating = score != null ? toMalRating(score) : null
          setRatings(malEpisodeRating ? [malEpisodeRating] : imdbEpisodeRating ? [imdbEpisodeRating] : [])
        })
        .catch(() => {
          if (!cancelled) setRatings(imdbEpisodeRating ? [imdbEpisodeRating] : [])
        })
      return () => { cancelled = true }
    }

    let cancelled = false
    getMdblistRatings({
      mediaType: props.mediaType,
      imdbId: props.imdbId,
      tmdbId: props.tmdbId,
      tvdbId: props.tvdbId,
      malId: props.malId,
      season: props.season,
      episode: props.episode,
    })
      .then((items) => {
        if (cancelled) return
        setRatings(items)
      })
      .catch(() => { if (!cancelled) setRatings([]) })
    return () => { cancelled = true }
  }, [props.mediaType, props.imdbId, props.tmdbId, props.tvdbId, props.malId, props.season, props.episode, props.episodeRating, props.isAnime])

  const visibleHeroRatings = useAppStore((s) => s.visibleHeroRatings)

  const visibleRatings = ratings.filter((r) => {
    const sourceKey = r.source.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (sourceKey === 'rottentomatoes' || sourceKey === 'tomato' || sourceKey === 'tomatometer') {
      return visibleHeroRatings.includes('rottentomatoes')
    }
    if (sourceKey === 'tomatoesaudience' || sourceKey === 'popcorn') {
      return visibleHeroRatings.includes('tomatoesaudience')
    }
    if (sourceKey === 'mal') {
      return visibleHeroRatings.includes('myanimelist')
    }
    return visibleHeroRatings.includes(sourceKey)
  })

  if (visibleRatings.length === 0) return null

  if (props.variant === 'hero') {
    // Section 5: metadata must be readable at a glance rather than becoming a
    // dense row of unrelated icons. The previous compact strip showed six
    // scores side by side -- /10, %, and /5 scales mixed together with no
    // source names. Here the leading score is emphasised, the rest stay
    // secondary, every score is named, and the row is capped so a
    // well-covered title cannot sprawl.
    const [lead, ...rest] = visibleRatings
    return (
      <div className={`ratings-hero ${props.className || ''}`}>
        <div className="ratings-hero__lead" title={`${lead.label}: ${lead.value}`}>
          {lead.iconUrl
            ? <img src={lead.iconUrl} alt="" className="ratings-hero__icon" loading="lazy" />
            : <span className="ratings-hero__glyph">{lead.icon}</span>}
          <span className="ratings-hero__value">{lead.value}</span>
          <span className="ratings-hero__label">{lead.label}</span>
        </div>
        {rest.length > 0 && (
          <div className="ratings-hero__rest">
            {rest.slice(0, 3).map((rating) => (
              <div
                key={`${rating.source}-${rating.value}`}
                className="ratings-hero__item"
                title={`${rating.label}: ${rating.value}`}
              >
                {rating.iconUrl
                  ? <img src={rating.iconUrl} alt="" className="ratings-hero__icon" loading="lazy" />
                  : <span className="ratings-hero__glyph">{rating.icon}</span>}
                <span className="ratings-hero__value">{rating.value}</span>
                <span className="ratings-hero__label">{rating.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (props.compact) {
    return (
      <div className={`flex flex-wrap items-center gap-3 ${props.className || ''}`}>
        {visibleRatings.map((rating) => (
          <div
            key={`${rating.source}-${rating.value}`}
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-white/90"
            title={`${rating.label}: ${rating.value}`}
          >
            {rating.iconUrl ? (
              <img src={rating.iconUrl} alt={rating.label} className="h-[18px] w-[18px] object-contain" loading="lazy" />
            ) : (
              <span className="text-xs font-black opacity-80">{rating.icon}</span>
            )}
            <span>{rating.value}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${props.className || ''}`}>
      {visibleRatings.map((rating) => (
        <div
          key={`${rating.source}-${rating.value}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-black/35 border border-white/10 backdrop-blur-md text-white shadow-sm px-3 py-1.5 text-xs"
          title={`${rating.label}: ${rating.value}`}
        >
          <span className={`inline-flex min-w-5 h-5 items-center justify-center rounded-full px-1 text-meta font-black leading-none ${
            rating.iconUrl ? 'bg-transparent' : 'bg-white/12 text-white'
          }`}>
            {rating.iconUrl ? (
              <img src={rating.iconUrl} alt={rating.label} className="h-3.5 w-3.5 object-contain" loading="lazy" />
            ) : (
              rating.icon
            )}
          </span>
          <span className="font-semibold text-white/90">{rating.value}</span>
          <span className="text-white/60">{rating.label}</span>
        </div>
      ))}
    </div>
  )
}

function toImdbRating(value?: string): MdblistRating | null {
  if (!value) return null
  let val = value.trim()
  if (!val) return null
  if (val.includes('/10')) {
    val = val.split('/10')[0].trim()
  }
  return {
    source: 'imdb',
    label: 'IMDb',
    value: val,
    icon: 'IMDb',
    iconUrl: getRatingIconUrl('imdb') ?? undefined,
  }
}

function toMalRating(value: number): MdblistRating {
  return {
    source: 'myanimelist',
    label: 'MAL',
    value: value.toFixed(1),
    icon: 'MAL',
    iconUrl: getRatingIconUrl('myanimelist') ?? undefined,
  }
}
