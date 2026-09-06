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
      // IMDb is already attached to the episode by the season-level request.
      // Show it immediately while MAL is being resolved, then replace it only
      // when MAL has an actual per-episode score.
      setRatings(imdbEpisodeRating ? [imdbEpisodeRating] : [])
      const load = async () => {
        const tvdbId = Number(String(props.tvdbId ?? '').replace(/^tvdb[-:]/i, ''))
        const mapped = Number.isFinite(tvdbId) && props.season != null
          ? await import('../services/animeLists')
            .then(({ mapTvdbEpisodeToAnimeProvidersLocal }) => mapTvdbEpisodeToAnimeProvidersLocal(
              tvdbId,
              props.season!,
              props.episode!,
            ))
            .catch(() => null)
          : null
        // A show-level MAL id normally represents the first cour. Never reuse
        // it for later TVDB seasons when the season-specific mapping is absent.
        const malId = mapped?.malId ?? (props.season === 1 ? props.malId : undefined)
        const malEpisode = mapped?.episode ?? props.episode
        const score = await import('../services/jikan')
          .then(({ getJikanEpisodeRating }) => getJikanEpisodeRating(malId, malEpisode))
          .catch(() => null)
        if (cancelled) return
        const malRating = score != null ? toMalRating(score) : null
        setRatings(malRating ? [malRating] : imdbEpisodeRating ? [imdbEpisodeRating] : [])
      }
      void load()
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
    // Keep the leading score prominent and cap secondary sources so a
    // well-covered title cannot sprawl. Provider names remain available in
    // tooltips; the visible row stays compact as icon + value only.
    const [lead, ...rest] = visibleRatings
    return (
      <div className={`ratings-hero ${props.className || ''}`}>
        <div className="ratings-hero__lead" title={`${lead.label}: ${lead.value}`}>
          {lead.iconUrl
            ? <img src={lead.iconUrl} alt="" className="ratings-hero__icon" loading="lazy" />
            : <span className="ratings-hero__glyph">{lead.icon}</span>}
          <span className="ratings-hero__value">{lead.value}</span>
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
