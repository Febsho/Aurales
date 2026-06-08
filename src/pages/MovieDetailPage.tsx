import { useState, useEffect } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import type { MovieDetails } from '../types'
import { MOCK_HERO_MOVIE, MOCK_TRENDING } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { getAddonMeta, getMetaAddons } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'
import StreamSelector from '../components/StreamSelector'

interface LocationState {
  poster?: string
  backdrop?: string
  title?: string
  year?: number
  rating?: number
  overview?: string
  imdbId?: string
  addonUrl?: string
  provider?: string
}

function addonMetaToMovie(meta: Record<string, unknown>, id: string): MovieDetails {
  const genres = Array.isArray(meta.genres) ? meta.genres as string[] :
    (typeof meta.genre === 'string' ? (meta.genre as string).split(',').map(g => g.trim()) :
    (Array.isArray(meta.genre) ? meta.genre as string[] : []))

  return {
    id,
    title: (meta.name || meta.title || 'Unknown') as string,
    originalTitle: meta.originalTitle as string | undefined,
    year: meta.releaseInfo ? parseInt(String(meta.releaseInfo)) : (meta.year ? Number(meta.year) : undefined),
    releaseDate: meta.released as string | undefined,
    overview: (meta.description || meta.overview) as string | undefined,
    tagline: meta.tagline as string | undefined,
    runtime: meta.runtime ? parseInt(String(meta.runtime)) : undefined,
    rating: meta.imdbRating ? parseFloat(String(meta.imdbRating)) : undefined,
    voteCount: meta.imdbVotes ? parseInt(String(meta.imdbVotes).replace(/,/g, '')) : undefined,
    genres,
    poster: meta.poster as string | undefined,
    backdrop: (meta.background || meta.banner) as string | undefined,
    logo: meta.logo as string | undefined,
    certification: meta.certification as string | undefined,
    cast: Array.isArray(meta.cast) ? (meta.cast as string[]).map((name, i) => ({
      id: `cast-${i}`, name, character: '', profilePath: undefined,
    })) : [],
    crew: [],
    recommendations: [],
    trailers: Array.isArray(meta.trailers) ? (meta.trailers as Record<string, string>[]).map((t, i) => ({
      id: `trailer-${i}`, name: t.title || `Trailer ${i + 1}`,
      key: t.source || '', site: t.type || 'YouTube', type: 'Trailer',
    })) : [],
    imdbId: (meta.imdb_id || meta.imdbId || (typeof meta.id === 'string' && (meta.id as string).startsWith('tt') ? meta.id : undefined)) as string | undefined,
  }
}

export default function MovieDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const state = (location.state || {}) as LocationState
  const [movie, setMovie] = useState<MovieDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [streamOpen, setStreamOpen] = useState(false)
  const addons = useAppStore((s) => s.addons)

  useEffect(() => {
    async function load() {
      setLoading(true)

      // Try TMDB first if it's a TMDB ID
      if (id?.startsWith('tmdb-')) {
        try {
          const data = await tmdbProvider.getMovie(id)
          setMovie(data)
          setLoading(false)
          return
        } catch { /* fall through */ }
      }

      // Try addon meta if we have addon context or the ID looks like IMDB
      if (state.addonUrl || id?.startsWith('tt') || state.provider === 'addon') {
        const addonUrl = state.addonUrl
        if (addonUrl) {
          try {
            const meta = await getAddonMeta(addonUrl, 'movie', id || '')
            if (meta) {
              setMovie(addonMetaToMovie(meta, id || ''))
              setLoading(false)
              return
            }
          } catch { /* fall through */ }
        }

        // Try all meta addons
        const metaAddons = getMetaAddons('movie')
        const storeMetaAddons = addons.filter((a) => a.enabled)
        const allMeta = metaAddons.length > 0 ? metaAddons : storeMetaAddons

        for (const addon of allMeta) {
          try {
            const meta = await getAddonMeta(addon.url, 'movie', id || '')
            if (meta) {
              setMovie(addonMetaToMovie(meta, id || ''))
              setLoading(false)
              return
            }
          } catch { /* continue */ }
        }
      }

      // Build from route state if we have it
      if (state.title) {
        setMovie({
          id: id || 'unknown',
          title: state.title,
          year: state.year,
          overview: state.overview,
          rating: state.rating,
          poster: state.poster,
          backdrop: state.backdrop,
          imdbId: state.imdbId,
          genres: [],
          cast: [],
          crew: [],
          recommendations: [],
          trailers: [],
        })
        setLoading(false)
        return
      }

      // Mock fallback
      setMovie({ ...MOCK_HERO_MOVIE, id: id || 'mock-1' })
      setLoading(false)
    }
    load()
  }, [id, state.addonUrl, state.provider, state.title, addons])

  if (loading || !movie) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const streamId = movie.imdbId || id || ''

  return (
    <div className="pb-12">
      <div className="relative w-full h-[480px] overflow-hidden">
        {movie.backdrop && (
          <img src={movie.backdrop} alt="" className="absolute inset-0 w-full h-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-surface/80 via-transparent to-transparent" />

        <div className="absolute bottom-0 left-0 right-0 p-8">
          <div className="max-w-2xl">
            {movie.logo ? (
              <img src={movie.logo} alt={movie.title} className="h-14 mb-4 drop-shadow-lg" />
            ) : (
              <h1 className="text-4xl font-bold mb-3">{movie.title}</h1>
            )}

            <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
              {movie.rating && (
                <span className="flex items-center gap-1 text-accent font-semibold">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {movie.rating.toFixed(1)}
                </span>
              )}
              {movie.voteCount && <span className="text-muted">{movie.voteCount.toLocaleString()} votes</span>}
              {movie.year && <span className="text-muted">{movie.year}</span>}
              {movie.genres.length > 0 && <span className="text-muted">{movie.genres.join(' · ')}</span>}
              {movie.certification && (
                <span className="px-1.5 py-0.5 border border-muted rounded text-xs text-muted">{movie.certification}</span>
              )}
              {movie.runtime && <span className="text-muted">{Math.floor(movie.runtime / 60)}h {movie.runtime % 60}m</span>}
            </div>

            {movie.overview && (
              <p className="text-sm text-gray-300 line-clamp-4 mb-5 leading-relaxed max-w-xl">{movie.overview}</p>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={() => setStreamOpen(true)}
                className="flex items-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play
              </button>
            </div>
          </div>
        </div>
      </div>

      <StreamSelector
        open={streamOpen}
        onClose={() => setStreamOpen(false)}
        mediaType="movie"
        mediaId={streamId}
        title={movie.title}
      />

      {movie.trailers.length > 0 && <TrailerRow title="Videos & Trailers" videos={movie.trailers} />}
      {movie.cast.length > 0 && <CastRow cast={movie.cast} />}

      {movie.recommendations.length > 0 && (
        <MediaRow title="More Like This" items={movie.recommendations} layout="poster" />
      )}

      {movie.recommendations.length === 0 && (
        <MediaRow title="You May Also Like" items={MOCK_TRENDING.filter((m) => m.id !== movie.id)} layout="poster" />
      )}
    </div>
  )
}
