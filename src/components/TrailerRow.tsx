import { useRef } from 'react'
import type { Video } from '../types'

interface TrailerRowProps {
  title: string
  videos: Video[]
}

export default function TrailerRow({ title, videos }: TrailerRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  if (videos.length === 0) return null

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold px-6 mb-3">{title}</h2>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto px-6 pb-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {videos.map((video) => (
          <a
            key={video.id}
            href={`https://www.youtube.com/watch?v=${video.key}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 w-64 group"
          >
            <div className="relative aspect-video rounded-xl overflow-hidden bg-surface-elevated mb-2">
              {video.thumbnail ? (
                <img
                  src={video.thumbnail}
                  alt={video.name}
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted">
                  Video
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center group-hover:bg-accent/80 transition-colors">
                  <svg className="w-5 h-5 ml-0.5" fill="white" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            </div>
            <h3 className="text-xs font-medium text-gray-300 truncate group-hover:text-white transition-colors">
              {video.name}
            </h3>
            <p className="text-xs text-muted">{video.type}</p>
          </a>
        ))}
      </div>
    </div>
  )
}
