import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { buildYoutubeEmbedUrl, youtubeThumbnailUrl, type TrailerSource } from '../services/trailers'
import { getDirectYoutubeStream, type DirectStream } from '../services/youtubeDirect'
import { useAppStore } from '../stores/appStore'

interface TrailerPreviewProps {
  trailer: TrailerSource
  title: string
  className?: string
  muted?: boolean
  eager?: boolean
  showShade?: boolean
  preferVideoOnly?: boolean
  onEnded?: () => void
  allowIframeFallback?: boolean
  onUnavailable?: () => void
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
}: TrailerPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const trailerVolume = useAppStore((s) => s.trailerVolume)
  const [embedLoadedKey, setEmbedLoadedKey] = useState<string | null>(null)
  const [thumbnailFailedKey, setThumbnailFailedKey] = useState<string | null>(null)
  // undefined = resolving, null = no direct stream (use iframe fallback)
  const [directStream, setDirectStream] = useState<DirectStream | null | undefined>(undefined)
  const [videoPlaying, setVideoPlaying] = useState(false)
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
    let cancelled = false
    setDirectStream(undefined)
    setVideoPlaying(false)
    getDirectYoutubeStream(trailer.key)
      .then((stream) => {
        if (!cancelled) setDirectStream(stream)
      })
      .catch(() => {
        if (!cancelled) setDirectStream(null)
      })
    return () => {
      cancelled = true
    }
  }, [trailer.key])

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
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== player) return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data?.event === 'onStateChange' && data.info === 0) onEnded?.()
      } catch { /* Ignore unrelated iframe messages. */ }
    }
    window.addEventListener('message', handleMessage)
    subscribe()
    return () => window.removeEventListener('message', handleMessage)
  }, [embedLoaded, trailer.key, onEnded])

  const showMedia = directStream ? videoPlaying : embedLoaded

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`}>
      <img
        src={thumbnailSrc}
        alt=""
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${showMedia ? 'opacity-0' : 'opacity-100'}`}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onError={() => setThumbnailFailedKey(trailer.key)}
      />
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
      ) : null}
      {showShade && <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10" />}
    </div>
  )
}
