import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { buildYoutubeEmbedUrl, youtubeThumbnailUrl, type TrailerSource } from '../services/trailers'
import { getDirectYoutubeStream, proxyAdaptiveYoutubeStream, type DirectStream } from '../services/youtubeDirect'
import { resolveHeroStreams } from '../services/heroTrailerStreams'
import { useAppStore } from '../stores/appStore'

interface TrailerPreviewProps {
  trailer: TrailerSource
  title: string
  className?: string
  muted?: boolean
  eager?: boolean
  showShade?: boolean
  preferVideoOnly?: boolean
  /** Prefer an adaptive 1080p stream pair instead of the compatible 360p
   * muxed rendition. Intended for large Hero surfaces. */
  highQuality?: boolean
  onEnded?: () => void
  allowIframeFallback?: boolean
  /** Skip direct WebKit video playback and use the YouTube embed. Useful on
   * transformed card surfaces where WebKitGTK can output audio with black video. */
  forceIframe?: boolean
  onUnavailable?: () => void
  /** Artwork to keep visible while playback starts instead of a trailer thumbnail. */
  placeholderUrl?: string
}

const AUDIO_SYNC_THRESHOLD_SECONDS = 0.3

export default function TrailerPreview({
  trailer,
  title,
  className = '',
  muted = true,
  eager = false,
  showShade = true,
  onEnded,
  allowIframeFallback = true,
  onUnavailable,
  placeholderUrl,
  highQuality = false,
  forceIframe = false,
}: TrailerPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trailerVolume = useAppStore((s) => s.trailerVolume)
  const [embedLoadedKey, setEmbedLoadedKey] = useState<string | null>(null)
  const [embedPlaying, setEmbedPlaying] = useState(false)
  const [thumbnailFailedKey, setThumbnailFailedKey] = useState<string | null>(null)
  const [placeholderFailedKey, setPlaceholderFailedKey] = useState<string | null>(null)
  // undefined = resolving, null = no direct stream (use iframe fallback)
  const [directStream, setDirectStream] = useState<DirectStream | null | undefined>(undefined)
  const [videoPlaying, setVideoPlaying] = useState(false)
  const [embedRevealKey, setEmbedRevealKey] = useState<string | null>(null)
  const [containerAspect, setContainerAspect] = useState(16 / 9)
  // WebKitGTK can keep decoding the adaptive audio stream while the <video>
  // compositing surface freezes on the first frame. The privacy-enhanced
  // YouTube iframe uses a separate, stable compositor path. Keep direct URLs
  // (for non-YouTube studio trailers) intact, but use that fallback by default
  // for YouTube previews in the packaged Linux app.
  const forceIframeOnLinux = !!(window as any).__TAURI_INTERNALS__
    && navigator.userAgent.includes('Linux')
  const shouldForceIframe = forceIframe || forceIframeOnLinux
  const embedLoaded = embedLoadedKey === trailer.key
  const embedVisible = embedRevealKey === trailer.key
  const thumbnailFailed = thumbnailFailedKey === trailer.key
  const placeholderFailed = placeholderFailedKey === trailer.key
  const thumbnailSrc = useMemo(
    () => {
      if (placeholderUrl) return placeholderFailed ? undefined : placeholderUrl
      return thumbnailFailed ? youtubeThumbnailUrl(trailer.key, 'high') : trailer.thumbnailUrl || youtubeThumbnailUrl(trailer.key)
    },
    [placeholderFailed, placeholderUrl, thumbnailFailed, trailer.key, trailer.thumbnailUrl],
  )
  const embedUrl = useMemo(
    () => buildYoutubeEmbedUrl(trailer.key, { muted: true }),
    [trailer.key],
  )

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const updateAspect = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0) setContainerAspect(width / height)
    }
    updateAspect()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateAspect)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setDirectStream(undefined)
    setVideoPlaying(false)
    setEmbedPlaying(false)
    setEmbedRevealKey(null)
    if (shouldForceIframe && !trailer.directUrl) {
      setDirectStream(null)
      return () => { cancelled = true }
    }
    if (trailer.directUrl) {
      setDirectStream({ videoUrl: trailer.directUrl, expiresAt: Date.now() + 60 * 60 * 1000 })
      return () => { cancelled = true }
    }
    // Do not leave the preview stuck on artwork if the native resolver hangs.
    // The iframe is slower/less clean, but it is a reliable playback fallback.
    const resolveDirect = highQuality
      ? resolveHeroStreams(trailer.key, 1080).then((stream) => stream
          ? proxyAdaptiveYoutubeStream({ ...stream, height: 1080 })
          : getDirectYoutubeStream(trailer.key))
      : getDirectYoutubeStream(trailer.key)
    Promise.race<DirectStream | null>([
      resolveDirect,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 6000)),
    ])
      .then((stream) => {
        if (!cancelled) setDirectStream(stream)
      })
      .catch(() => {
        if (!cancelled) setDirectStream(null)
      })
    return () => {
      cancelled = true
    }
  }, [trailer.key, trailer.directUrl, highQuality, shouldForceIframe])

  useEffect(() => {
    if (directStream === null && !allowIframeFallback) onUnavailable?.()
  }, [directStream, allowIframeFallback, onUnavailable])

  // Keep the separate audio track locked to the video: same play state, same
  // clock (within AUDIO_SYNC_THRESHOLD_SECONDS), shared mute/volume.
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    const volume = Math.min(1, Math.max(0, trailerVolume / 100))

    if (!audio) {
      // Muxed stream: the video element carries the audio.
      video.muted = muted
      video.volume = volume
      return
    }

    video.muted = true
    audio.muted = muted
    audio.volume = volume

    const syncClock = () => {
      if (Math.abs(audio.currentTime - video.currentTime) > AUDIO_SYNC_THRESHOLD_SECONDS) {
        audio.currentTime = video.currentTime
      }
    }
    const onPlay = () => {
      syncClock()
      audio.play().catch(() => undefined)
    }
    const onPause = () => audio.pause()

    if (!video.paused) onPlay()
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('seeked', syncClock)
    video.addEventListener('timeupdate', syncClock)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('seeked', syncClock)
      video.removeEventListener('timeupdate', syncClock)
      audio.pause()
    }
  }, [directStream, muted, trailerVolume])

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

  useEffect(() => {
    if (!embedLoaded) return
    const player = iframeRef.current?.contentWindow
    if (!player) return
    const subscribe = () => {
      player.postMessage(JSON.stringify({ event: 'listening', id: `aurales-${trailer.key}` }), 'https://www.youtube-nocookie.com')
      player.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), 'https://www.youtube-nocookie.com')
      player.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onError'] }), 'https://www.youtube-nocookie.com')
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== player) return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data?.event === 'onStateChange' && data.info === 1) setEmbedPlaying(true)
        if (data?.event === 'onStateChange' && data.info === 0) { setEmbedPlaying(false); onEnded?.() }
        if (data?.event === 'onError') onUnavailable?.()
      } catch { /* Ignore unrelated iframe messages. */ }
    }
    window.addEventListener('message', handleMessage)
    subscribe()
    return () => window.removeEventListener('message', handleMessage)
  }, [embedLoaded, trailer.key, onEnded, onUnavailable])

  // YouTube briefly paints its own centre pause glyph when autoplay begins.
  // Keep the existing artwork in place until that transient control fully
  // fades; the old 900ms reveal still exposed it on slower WebKit starts.
  useEffect(() => {
    if (!embedPlaying) {
      setEmbedRevealKey(null)
      return
    }
    const timer = window.setTimeout(() => setEmbedRevealKey(trailer.key), 1600)
    return () => window.clearTimeout(timer)
  }, [embedPlaying, trailer.key])

  const showMedia = directStream ? videoPlaying : embedVisible
  const iframeCoverStyle: CSSProperties = containerAspect >= 16 / 9
    ? { left: '50%', top: '50%', width: '118%', height: 'auto', aspectRatio: '16 / 9', transform: 'translate(-50%, -50%)' }
    : { left: '50%', top: '50%', width: 'auto', height: '118%', aspectRatio: '16 / 9', transform: 'translate(-50%, -50%)' }
  // Callers that place the preview over artwork pass an explicit position
  // class. Do not also emit `relative`: Tailwind orders `.relative` after
  // `.absolute`, which moved the playing preview below the poster where the
  // card's overflow clipping hid its video while audio kept running.
  const hasExplicitPosition = /(?:^|\s)(?:absolute|fixed|sticky|relative)(?:\s|$)/.test(className)

  return (
    <div ref={containerRef} className={`${hasExplicitPosition ? '' : 'relative'} h-full w-full overflow-hidden bg-black ${className}`}>
      {thumbnailSrc && <img
          src={thumbnailSrc}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${showMedia ? 'opacity-0' : 'opacity-100'}`}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onError={() => placeholderUrl ? setPlaceholderFailedKey(trailer.key) : setThumbnailFailedKey(trailer.key)}
        />}
      {directStream ? (
        <>
          <video
            ref={videoRef}
            src={directStream.videoUrl}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${videoPlaying ? 'opacity-100' : 'opacity-0'}`}
            autoPlay
            muted
            playsInline
            preload="auto"
            tabIndex={-1}
            onPlaying={() => setVideoPlaying(true)}
            onEnded={() => { setVideoPlaying(false); onEnded?.() }}
            onError={(e) => {
              const err = e.currentTarget.error
              console.warn('[TrailerPreview] direct video failed, using iframe', trailer.key, err?.code, err?.message)
              // TEMP DEBUG: dump media error to %TEMP%\aurales-subtitles for inspection.
              invoke('write_temp_subtitle', {
                content: `videoElement error key=${trailer.key} code=${err?.code} msg=${err?.message} time=${new Date().toISOString()}`,
                extension: 'ytlog',
              }).catch(() => undefined)
              setDirectStream(null)
            }}
          />
          {directStream.audioUrl && (
            <audio
              ref={audioRef}
              src={directStream.audioUrl}
              preload="auto"
              onError={(e) => {
                const err = e.currentTarget.error
                console.warn('[TrailerPreview] trailer audio failed', trailer.key, err?.code, err?.message)
                // TEMP DEBUG: dump media error to %TEMP%\aurales-subtitles for inspection.
                invoke('write_temp_subtitle', {
                  content: `audioElement error key=${trailer.key} code=${err?.code} msg=${err?.message} time=${new Date().toISOString()}`,
                  extension: 'ytlog',
                }).catch(() => undefined)
              }}
            />
          )}
        </>
      ) : directStream === null && allowIframeFallback ? (
        <div className={`absolute inset-0 overflow-hidden bg-black transition-opacity duration-300 ${embedVisible ? 'opacity-100' : 'opacity-0'}`}>
          <iframe
            ref={iframeRef}
            src={embedUrl}
            title={`${title} trailer`}
            className="pointer-events-none absolute max-w-none border-0"
            style={iframeCoverStyle}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen={false}
            referrerPolicy="strict-origin-when-cross-origin"
            tabIndex={-1}
            onLoad={() => setEmbedLoadedKey(trailer.key)}
          />
        </div>
      ) : null}
      {showShade && <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10" />}
    </div>
  )
}
