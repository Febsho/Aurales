import { useEffect, useMemo, useRef, useState } from 'react'
import { getTrailerVideoStream, youtubeThumbnailUrl, type TrailerSource, type TrailerVideoStream } from '../services/trailers'
import { useAppStore } from '../stores/appStore'

interface TrailerPreviewProps {
  trailer: TrailerSource
  title: string
  className?: string
  muted?: boolean
  eager?: boolean
  showShade?: boolean
  preferVideoOnly?: boolean
}

export default function TrailerPreview({
  trailer,
  title,
  className = '',
  muted = true,
  eager = false,
  showShade = true,
  preferVideoOnly = false,
}: TrailerPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trailerVolume = useAppStore((s) => s.trailerVolume)
  const [loaded, setLoaded] = useState(false)
  const [streamFailed, setStreamFailed] = useState(false)
  const [stream, setStream] = useState<TrailerVideoStream | null>(null)
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const thumbnailSrc = useMemo(
    () => thumbnailFailed ? youtubeThumbnailUrl(trailer.key, 'high') : trailer.thumbnailUrl || youtubeThumbnailUrl(trailer.key),
    [thumbnailFailed, trailer.key, trailer.thumbnailUrl],
  )

  useEffect(() => {
    setLoaded(false)
    setStreamFailed(false)
    setStream(null)
    setThumbnailFailed(false)
    let cancelled = false
    getTrailerVideoStream(trailer.key, { preferVideoOnly })
      .then((nextStream) => {
        if (!cancelled) {
          setStream(nextStream)
          if (nextStream) setLoaded(false)
        }
      })
      .catch(() => {
        if (!cancelled) setStream(null)
      })
    return () => { cancelled = true }
  }, [trailer.key, preferVideoOnly])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = muted
    video.volume = muted ? 0 : Math.min(1, Math.max(0, trailerVolume / 100))
    if (!muted) video.play().catch(() => {})
  }, [muted, stream, trailerVolume])

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`}>
      <img
        src={thumbnailSrc}
        alt=""
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${stream && !streamFailed && loaded ? 'opacity-0' : 'opacity-100'}`}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onLoad={() => {
          if (!stream || streamFailed) setLoaded(true)
        }}
        onError={() => setThumbnailFailed(true)}
      />
      {stream && !streamFailed ? (
        <video
          ref={videoRef}
          src={stream.url}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          autoPlay
          muted={muted}
          loop
          playsInline
          preload={eager ? 'auto' : 'metadata'}
          disablePictureInPicture
          controls={false}
          onCanPlay={() => setLoaded(true)}
          onPlaying={() => setLoaded(true)}
          onError={() => {
            setStreamFailed(true)
            setLoaded(true)
          }}
        />
      ) : null}
      {showShade && <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10" />}
    </div>
  )
}
