import React, { useState, useRef, useEffect } from 'react'

interface ServiceCardProps {
  title: string
  videoURL: string
  backgroundURL: string
  isActive: boolean
  onClick: () => void
}

function ServiceCard({ title, videoURL, backgroundURL, isActive, onClick }: ServiceCardProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (isHovered) {
      if (videoRef.current) {
        videoRef.current.load()
        videoRef.current.play().catch(() => {})
      }
    } else {
      if (videoRef.current) {
        videoRef.current.pause()
        setVideoLoaded(false)
      }
    }
  }, [isHovered])

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`relative flex-shrink-0 w-36 md:w-44 aspect-video rounded-2xl overflow-hidden bg-neutral-900 border transition-all duration-300 cursor-pointer focus-ring outline-none hover:-translate-y-1 hover:scale-[1.03] ${
        isActive
          ? 'border-accent shadow-[0_0_15px_rgba(var(--accent-rgb),0.35)] scale-[1.02]'
          : 'border-white/5 hover:border-white/20 hover:shadow-lg hover:shadow-black/50'
      }`}
    >
      {/* Background Cover Image */}
      <img
        src={backgroundURL}
        alt={title}
        className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 ease-out"
        loading="lazy"
      />

      {/* Video Overlay */}
      {isHovered && (
        <video
          ref={videoRef}
          src={videoURL}
          muted
          loop
          playsInline
          onPlay={() => setVideoLoaded(true)}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
            videoLoaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* Glow highlight / inner border for active state */}
      {isActive && (
        <div className="absolute inset-0 border-2 border-accent rounded-2xl pointer-events-none" />
      )}

      {/* Title bottom label on hover */}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 transition-opacity duration-300 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
        <span className="text-[10px] font-bold text-white tracking-wider block text-center truncate">
          {title}
        </span>
      </div>
    </button>
  )
}

export default React.memo(ServiceCard)
