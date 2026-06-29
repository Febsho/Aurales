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
  episodeRating?: string
  isAnime?: boolean
}

const RATING_COLORS: Record<string, string> = {
  imdb: 'bg-[#f5c518]/90 text-black',
  rottentomatoes: 'bg-[#fa320a]/80 text-white',
  tomatometer: 'bg-[#fa320a]/80 text-white',
  tomato: 'bg-[#fa320a]/80 text-white',
  tomatoesaudience: 'bg-[#f77c31]/80 text-white',
  popcorn: 'bg-[#f77c31]/80 text-white',
  metacritic: 'bg-[#00ce7a]/80 text-black',
  metacriticuser: 'bg-[#00ce7a]/60 text-white',
  tmdb: 'bg-[#01b4e4]/80 text-white',
  trakt: 'bg-[#ed1c24]/80 text-white',
  letterboxd: 'bg-[#00e054]/80 text-black',
  myanimelist: 'bg-[#2e51a2]/80 text-white',
  mal: 'bg-[#2e51a2]/80 text-white',
  anilist: 'bg-[#3db4f2]/80 text-white',
  rogerebert: 'bg-[#2c2c2c]/80 text-white',
}

function getRatingColor(source: string): string {
  const norm = source.toLowerCase().replace(/[^a-z0-9]/g, '')
  return RATING_COLORS[norm] || 'bg-white/15 text-white'
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

  if (props.compact) {
    return (
      <div className={`flex flex-wrap items-center gap-1.5 ${props.className || ''}`}>
        {visibleRatings.map((rating) => (
          <div
            key={`${rating.source}-${rating.value}`}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-white/90"
            title={`${rating.label}: ${rating.value}`}
          >
            {rating.iconUrl ? (
              <img src={rating.iconUrl} alt={rating.label} className="h-3 w-3 object-contain" loading="lazy" />
            ) : (
              <span className="text-[9px] font-black opacity-80">{rating.icon}</span>
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
          <span className="text-white/45">{rating.label}</span>
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
    value: Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '').replace(/\.0$/, ''),
    icon: 'MAL',
    iconUrl: getRatingIconUrl('myanimelist') ?? undefined,
  }
}
