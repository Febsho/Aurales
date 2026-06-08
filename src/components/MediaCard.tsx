import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'

interface MediaCardProps {
  item: SearchResult
  layout?: 'poster' | 'landscape'
}

export default function MediaCard({ item, layout = 'poster' }: MediaCardProps) {
  const navigate = useNavigate()

  const handleClick = () => {
    navigate(item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`)
  }

  if (layout === 'landscape') {
    return (
      <button
        onClick={handleClick}
        className="flex-shrink-0 w-72 group cursor-pointer focus:outline-none"
      >
        <div className="relative aspect-video rounded-xl overflow-hidden bg-surface-elevated mb-2">
          {item.backdrop ? (
            <img
              src={item.backdrop}
              alt={item.title}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : item.poster ? (
            <img
              src={item.poster}
              alt={item.title}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted">
              No Image
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
          <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <div className="flex items-center gap-1.5">
              {item.rating && (
                <span className="text-xs text-accent font-semibold flex items-center gap-0.5">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {item.rating.toFixed(1)}
                </span>
              )}
              {item.year && <span className="text-xs text-gray-300">{item.year}</span>}
            </div>
          </div>
        </div>
        <h3 className="text-sm font-medium text-gray-200 truncate group-hover:text-white transition-colors">
          {item.title}
        </h3>
      </button>
    )
  }

  return (
    <button
      onClick={handleClick}
      className="flex-shrink-0 w-36 group cursor-pointer focus:outline-none"
    >
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface-elevated mb-2">
        {item.poster ? (
          <img
            src={item.poster}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted text-xs">
            No Poster
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
        {item.rating && (
          <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm rounded-md px-1.5 py-0.5 text-xs font-semibold text-accent">
            {item.rating.toFixed(1)}
          </div>
        )}
      </div>
      <h3 className="text-xs font-medium text-gray-300 truncate group-hover:text-white transition-colors">
        {item.title}
      </h3>
      {item.year && (
        <p className="text-xs text-muted">{item.year}</p>
      )}
    </button>
  )
}
