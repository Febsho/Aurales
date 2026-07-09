import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const applyPlayback = useCallback(() => {
    const video = videoRef.current
    if (!video || !stream) return

    const targetVolume = Math.min(1, Math.max(0, trailerVolume / 100))
    const applyRequestedAudio = () => {
      video.volume = muted ? 0 : targetVolume
      video.muted = muted
    }

    if (!video.paused) {
      applyRequestedAudio()
      return
    }

    video.muted = true
    video.volume = 0
    video.play()
      .then(() => {
        applyRequestedAudio()
      })
      .catch(() => {
        applyRequestedAudio()
        video.play().catch(() => {
          video.muted = true
          video.volume = 0
        })
      })
  }, [muted, stream, trailerVolume])

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
    applyPlayback()
  }, [applyPlayback])

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
          muted
          loop
          playsInline
          preload={eager ? 'auto' : 'metadata'}
          disablePictureInPicture
          controls={false}
          onCanPlay={() => {
            setLoaded(true)
            applyPlayback()
          }}
          onPlaying={() => {
            setLoaded(true)
            applyPlayback()
          }}
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
