import { useNavigate } from 'react-router-dom'
import type { MovieDetails, ShowDetails } from '../types'

interface HeroSectionProps {
  item: MovieDetails | ShowDetails
  type: 'movie' | 'series'
}

export default function HeroSection({ item, type }: HeroSectionProps) {
  const navigate = useNavigate()

  const handlePlay = () => {
    navigate(type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`)
  }

  return (
    <div className="relative w-full h-[520px] overflow-hidden">
      {item.backdrop && (
        <img
          src={item.backdrop}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-surface/80 via-transparent to-transparent" />

      <div className="absolute bottom-0 left-0 right-0 p-8 pb-10">
        <div className="max-w-2xl">
          {item.logo ? (
            <img src={item.logo} alt={item.title} className="h-16 mb-4 drop-shadow-lg" />
          ) : (
            <h1 className="text-4xl font-bold mb-4 drop-shadow-lg">{item.title}</h1>
          )}

          <div className="flex items-center gap-3 mb-3 text-sm">
            {item.rating && (
              <span className="flex items-center gap-1 text-accent font-semibold">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                {item.rating.toFixed(1)}
              </span>
            )}
            {'voteCount' in item && item.voteCount && (
              <span className="text-muted">{item.voteCount.toLocaleString()} votes</span>
            )}
            {item.year && <span className="text-muted">{item.year}</span>}
            {item.genres?.length > 0 && (
              <span className="text-muted">{item.genres.slice(0, 3).join(' · ')}</span>
            )}
            {item.certification && (
              <span className="px-1.5 py-0.5 border border-muted rounded text-xs text-muted">
                {item.certification}
              </span>
            )}
            {'runtime' in item && item.runtime && (
              <span className="text-muted">{Math.floor(item.runtime / 60)}h {item.runtime % 60}m</span>
            )}
          </div>

          {item.overview && (
            <p className="text-sm text-gray-300 line-clamp-3 mb-5 leading-relaxed max-w-xl">
              {item.overview}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handlePlay}
              className="flex items-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-black font-semibold rounded-xl transition-all duration-200 hover:scale-105 active:scale-95"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              Play
            </button>
            <button
              onClick={handlePlay}
              className="flex items-center gap-2 px-5 py-3 bg-white/10 hover:bg-white/20 text-white font-medium rounded-xl transition-all duration-200 backdrop-blur-sm"
            >
              More Info
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
