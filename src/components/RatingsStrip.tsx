import { useEffect, useState } from 'react'
import { getMdblistRatings, getRatingIconUrl, type MdblistRating } from '../services/mdblist'
import { useAppStore } from '../stores/appStore'

interface RatingsStripProps {
  mediaType: 'movie' | 'series'
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  season?: number
  episode?: number
  className?: string
  compact?: boolean
  episodeRating?: string
  tmdbRating?: number
}

export default function RatingsStrip(props: RatingsStripProps) {
  const [ratings, setRatings] = useState<MdblistRating[]>([])

  useEffect(() => {
    if (props.episodeRating) {
      let val = props.episodeRating.trim()
      if (val.includes('/10')) {
        val = val.split('/10')[0].trim()
      }
      setRatings([
        {
          source: 'imdb',
          label: 'IMDb',
          value: val,
          icon: 'IMDb',
          iconUrl: getRatingIconUrl('imdb') ?? undefined,
        },
      ])
      return
    }

    if (props.episode != null && props.tmdbRating != null && props.tmdbRating > 0) {
      setRatings([
        {
          source: 'tmdb',
          label: 'TMDB',
          value: props.tmdbRating.toFixed(1),
          icon: 'TMDB',
          iconUrl: getRatingIconUrl('tmdb') ?? undefined,
        },
      ])
      return
    }

    // Bypassing getMdblistRatings for episodes, since MdbList show-rating fallback is not desired.
    if (props.episode != null) {
      setRatings([])
      return
    }

    let cancelled = false
    getMdblistRatings({
      mediaType: props.mediaType,
      imdbId: props.imdbId,
      tmdbId: props.tmdbId,
      tvdbId: props.tvdbId,
      season: props.season,
      episode: props.episode,
    })
      .then((items) => {
        if (!cancelled) {
          if (props.episode != null) {
            setRatings(items.filter((r) => r.source === 'imdb'))
          } else {
            setRatings(items)
          }
        }
      })
      .catch(() => { if (!cancelled) setRatings([]) })
    return () => { cancelled = true }
  }, [props.mediaType, props.imdbId, props.tmdbId, props.tvdbId, props.season, props.episode, props.episodeRating, props.tmdbRating])

  const visibleHeroRatings = useAppStore((s) => s.visibleHeroRatings)

  const visibleRatings = ratings.filter((r) => {
    const sourceKey = r.source.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (sourceKey === 'rottentomatoes' || sourceKey === 'tomato' || sourceKey === 'tomatometer') {
      return visibleHeroRatings.includes('rottentomatoes')
    }
    if (sourceKey === 'tomatoesaudience' || sourceKey === 'popcorn') {
      return visibleHeroRatings.includes('tomatoesaudience')
    }
    return visibleHeroRatings.includes(sourceKey)
  })

  if (visibleRatings.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center gap-2 ${props.className || ''}`}>
      {visibleRatings.map((rating) => (
        <div
          key={`${rating.source}-${rating.value}`}
          className={`inline-flex items-center gap-1.5 rounded-full bg-black/35 border border-white/10 backdrop-blur-md text-white shadow-sm ${
            props.compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
          }`}
          title={`${rating.label}: ${rating.value}`}
        >
          <span className={`inline-flex min-w-5 h-5 items-center justify-center rounded-full px-1 text-[10px] font-black leading-none ${
            rating.iconUrl ? 'bg-transparent' : 'bg-white/12 text-white'
          }`}>
            {rating.iconUrl ? (
              <img src={rating.iconUrl} alt={rating.label} className="h-3.5 w-3.5 object-contain" loading="lazy" />
            ) : (
              rating.icon
            )}
          </span>
          <span className="font-semibold text-white/90">{rating.value}</span>
          {!props.compact && <span className="text-white/45">{rating.label}</span>}
        </div>
      ))}
    </div>
  )
}
