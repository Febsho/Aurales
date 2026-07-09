import { useEffect, useMemo, useRef, useState } from 'react'
import { buildYoutubeEmbedUrl, youtubeThumbnailUrl, type TrailerSource } from '../services/trailers'
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
}: TrailerPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const trailerVolume = useAppStore((s) => s.trailerVolume)
  const [embedLoadedKey, setEmbedLoadedKey] = useState<string | null>(null)
  const [thumbnailFailedKey, setThumbnailFailedKey] = useState<string | null>(null)
  const embedLoaded = embedLoadedKey === trailer.key
  const thumbnailFailed = thumbnailFailedKey === trailer.key
  const thumbnailSrc = useMemo(
    () => thumbnailFailed ? youtubeThumbnailUrl(trailer.key, 'high') : trailer.thumbnailUrl || youtubeThumbnailUrl(trailer.key),
    [thumbnailFailed, trailer.key, trailer.thumbnailUrl],
  )
  const embedUrl = useMemo(
    () => buildYoutubeEmbedUrl(trailer.key, { muted: true }),
    [trailer.key],
  )

  useEffect(() => {
    if (!embedLoaded) return
    const player = iframeRef.current?.contentWindow
    if (!player) return

    const sendCommand = (func: string, args: unknown[] = []) => {
      player.postMessage(JSON.stringify({ event: 'command', func, args }), 'https://www.youtube-nocookie.com')
    }
    sendCommand(muted ? 'mute' : 'unMute')
    sendCommand('setVolume', [Math.round(Math.min(1, Math.max(0, trailerVolume / 100)) * 100)])
  }, [embedLoaded, muted, trailerVolume])

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`}>
      <img
        src={thumbnailSrc}
        alt=""
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${embedLoaded ? 'opacity-0' : 'opacity-100'}`}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onError={() => setThumbnailFailedKey(trailer.key)}
      />
      <div className={`absolute inset-0 overflow-hidden bg-black transition-opacity duration-200 ${embedLoaded ? 'opacity-100' : 'opacity-0'}`}>
        <iframe
          ref={iframeRef}
          src={embedUrl}
          title={`${title} trailer`}
          className="pointer-events-none absolute -inset-[9%] h-[118%] w-[118%] border-0"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen={false}
          referrerPolicy="strict-origin-when-cross-origin"
          tabIndex={-1}
          onLoad={() => setEmbedLoadedKey(trailer.key)}
        />
      </div>
      {showShade && <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10" />}
    </div>
  )
}
