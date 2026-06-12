import { useRef } from 'react'
import type { Video } from '../types'

interface TrailerRowProps {
  title: string
  videos: Video[]
}

export default function TrailerRow({ title, videos }: TrailerRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  if (videos.length === 0) return null

  const getThumbnail = (video: Video): string | undefined => {
    if (video.thumbnail) return video.thumbnail
    if (video.site?.toLowerCase() === 'youtube' && video.key) {
      return `https://img.youtube.com/vi/${video.key}/hqdefault.jpg`
    }
    return undefined
  }

  return (
    <div className="mb-12 pt-2">
      <h2 className="text-2xl font-bold px-8 mb-5">{title}</h2>
      <div
        ref={scrollRef}
        className="flex gap-6 overflow-x-auto px-8 pb-3"
        style={{ scrollbarWidth: 'none' }}
      >
        {videos.map((video) => {
          const thumbnail = getThumbnail(video)
          return (
          <a
            key={video.id}
            href={`https://www.youtube.com/watch?v=${video.key}`}
            target="_blank"
            rel="noopener noreferrer"
            className="trailer-showcase-card flex-shrink-0 group"
          >
            <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated mb-3 ring-1 ring-white/10 shadow-xl">
              {thumbnail ? (
                <img
                  src={thumbnail}
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
            <h3 className="text-base font-semibold text-white/85 truncate group-hover:text-white transition-colors">
              {video.name}
            </h3>
            <p className="text-sm text-white/40 mt-0.5">{video.type}</p>
          </a>
        )})}
      </div>
    </div>
  )
}
