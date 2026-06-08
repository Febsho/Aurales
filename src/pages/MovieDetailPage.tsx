import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import type { MovieDetails, StreamResult } from '../types'
import { MOCK_HERO_MOVIE, MOCK_TRENDING } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { getInstalledAddons, getAddonStreams } from '../services/addons'
import { launchPlayer } from '../services/player'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'

export default function MovieDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [movie, setMovie] = useState<MovieDetails | null>(null)
  const [streams, setStreams] = useState<StreamResult[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        if (id?.startsWith('tmdb-')) {
          const data = await tmdbProvider.getMovie(id)
          setMovie(data)
        } else {
          setMovie({ ...MOCK_HERO_MOVIE, id: id || 'mock-1' })
        }
      } catch {
        setMovie({ ...MOCK_HERO_MOVIE, id: id || 'mock-1' })
      }

      const addons = getInstalledAddons()
      const streamResults: StreamResult[] = []
      for (const addon of addons) {
        if (addon.manifest.resources.includes('stream')) {
          try {
            const s = await getAddonStreams(addon.url, 'movie', id || '')
            streamResults.push(...s)
          } catch { /* skip */ }
        }
      }
      setStreams(streamResults)
      setLoading(false)
    }
    load()
  }, [id])

  if (loading || !movie) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const handlePlay = (stream?: StreamResult) => {
    const url = stream?.url || streams[0]?.url
    if (url) {
      launchPlayer({ url, title: movie.title })
    }
  }

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
                onClick={() => handlePlay()}
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

      {streams.length > 0 && (
        <div className="px-6 mb-8">
          <h2 className="text-lg font-semibold mb-3">Available Streams</h2>
          <div className="space-y-2">
            {streams.map((stream, i) => (
              <button
                key={i}
                onClick={() => handlePlay(stream)}
                className="w-full flex items-center justify-between p-3 bg-surface-elevated hover:bg-surface-hover rounded-xl transition-colors text-left"
              >
                <div>
                  <div className="text-sm font-medium">{stream.name || stream.title || `Stream ${i + 1}`}</div>
                  {stream.url && <div className="text-xs text-muted truncate max-w-md">{stream.url}</div>}
                </div>
                <svg className="w-5 h-5 text-accent" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      <TrailerRow title="Videos & Trailers" videos={movie.trailers} />
      <CastRow cast={movie.cast} />

      {movie.recommendations.length > 0 && (
        <MediaRow title="More Like This" items={movie.recommendations} layout="poster" />
      )}

      {movie.recommendations.length === 0 && (
        <MediaRow title="You May Also Like" items={MOCK_TRENDING.filter((m) => m.id !== movie.id)} layout="poster" />
      )}
    </div>
  )
}
