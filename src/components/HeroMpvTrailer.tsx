import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import TrailerPreview from './TrailerPreview'
import type { TrailerSource } from '../services/trailers'
import {
  getEmbeddedPlayerOwner,
  launchEmbeddedPlayer,
  resizeEmbeddedPlayer,
  sendPlayerCommand,
  getPlayerProperty,
  stopEmbeddedPlayerIfOwner,
} from '../services/player'
import { useAppStore } from '../stores/appStore'

// Hero trailer via embedded mpv + yt-dlp: real 1080p, no YouTube UI. The mpv
// child window renders behind the transparent webview, so while the video is
// visible this component (and HeroSection via onPlayingChange) must keep the
// pixels above the hero rect transparent. Falls back to TrailerPreview
// (proxied 360p muxed stream) when yt-dlp is unavailable or resolution fails.

interface HeroMpvTrailerProps {
  trailer: TrailerSource
  title: string
  muted: boolean
  className?: string
  onEnded?: () => void
  onUnavailable?: () => void
  onPlayingChange?: (playing: boolean) => void
}

interface ResolvedStreams {
  videoUrl: string
  audioUrl?: string
  expiresAt: number
}

const resolveCache = new Map<string, Promise<ResolvedStreams | null>>()

function resolveHeroStreams(videoId: string): Promise<ResolvedStreams | null> {
  const cached = resolveCache.get(videoId)
  if (cached) {
    return cached.then((streams) => {
      if (streams && streams.expiresAt > Date.now() + 60_000) return streams
      resolveCache.delete(videoId)
      return resolveHeroStreams(videoId)
    })
  }
  const promise = invoke<string[]>('ytdlp_resolve', { videoId })
    .then((urls) => {
      if (!urls.length) return null
      return {
        videoUrl: urls[0],
        audioUrl: urls[1],
        // googlevideo URLs expire after ~6h; refresh well before that.
        expiresAt: Date.now() + 4 * 60 * 60 * 1000,
      }
    })
    .catch((err) => {
      console.warn('[HeroMpvTrailer] yt-dlp resolve failed:', err)
      return null
    })
  resolveCache.set(videoId, promise)
  promise.then((streams) => {
    if (!streams) resolveCache.delete(videoId)
  })
  return promise
}

function physicalViewport(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const scale = window.devicePixelRatio || 1
  return {
    x: Math.round(rect.left * scale),
    y: Math.round(rect.top * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  }
}

export default function HeroMpvTrailer({
  trailer,
  title,
  muted,
  className = '',
  onEnded,
  onUnavailable,
  onPlayingChange,
}: HeroMpvTrailerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const trailerVolume = useAppStore((s) => s.trailerVolume)
  const [mode, setMode] = useState<'pending' | 'mpv' | 'fallback'>('pending')
  const [videoVisible, setVideoVisible] = useState(false)
  const launchedRef = useRef(false)
  const endedRef = useRef(false)

  // Resolve + launch
  useEffect(() => {
    let cancelled = false
    launchedRef.current = false
    endedRef.current = false
    setVideoVisible(false)
    setMode('pending')

    ;(async () => {
      const streams = await resolveHeroStreams(trailer.key)
      if (cancelled) return
      if (!streams) {
        setMode('fallback')
        return
      }
      const el = containerRef.current
      if (!el) return
      const args = [
        streams.audioUrl ? `--audio-files=${streams.audioUrl}` : '',
        `--mute=${muted ? 'yes' : 'no'}`,
        '--loop-file=no',
        '--force-media-title=trailer',
      ].filter(Boolean).join(' ')
      try {
        if (!document.hasFocus()) {
          if (!cancelled) onEnded?.()
          return
        }
        await launchEmbeddedPlayer(
          {
            url: streams.videoUrl,
            volume: Math.min(100, Math.max(0, trailerVolume)),
            viewport: physicalViewport(el),
            mpvCustomArgs: args,
          },
          'hero-trailer',
        )
        if (cancelled) {
          stopEmbeddedPlayerIfOwner('hero-trailer').catch(() => undefined)
          return
        }
        launchedRef.current = true
        setMode('mpv')
      } catch (err) {
        console.warn('[HeroMpvTrailer] mpv launch failed:', err)
        if (!cancelled) setMode('fallback')
      }
    })()

    return () => {
      cancelled = true
      if (launchedRef.current) {
        stopEmbeddedPlayerIfOwner('hero-trailer').catch(() => undefined)
      }
      onPlayingChange?.(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailer.key])

  // Track playback state: reveal video once frames are rendering, detect EOF,
  // and stand down if the real player claims the mpv instance.
  useEffect(() => {
    if (mode !== 'mpv') return
    const interval = window.setInterval(async () => {
      if (getEmbeddedPlayerOwner() !== 'hero-trailer') {
        launchedRef.current = false
        setVideoVisible(false)
        onPlayingChange?.(false)
        window.clearInterval(interval)
        return
      }
      try {
        const [timePos, eof] = await Promise.all([
          getPlayerProperty('time-pos'),
          getPlayerProperty('eof-reached'),
        ])
        if (eof === true || (endedRef.current === false && timePos == null && videoVisible)) {
          if (!endedRef.current) {
            endedRef.current = true
            setVideoVisible(false)
            onPlayingChange?.(false)
            stopEmbeddedPlayerIfOwner('hero-trailer').catch(() => undefined)
            launchedRef.current = false
            onEnded?.()
          }
          window.clearInterval(interval)
          return
        }
        if (typeof timePos === 'number' && timePos > 0.05 && !videoVisible) {
          setVideoVisible(true)
          onPlayingChange?.(true)
        }
      } catch (_) { /* player briefly unavailable */ }
    }, 500)
    return () => window.clearInterval(interval)
  }, [mode, videoVisible, onEnded, onPlayingChange])

  // The transparent-hole compositing only holds while the app window is
  // focused — unfocused, the hole exposes the desktop. End the trailer on
  // blur (pausing embedded mpv is not an option: known WASAPI wedge).
  useEffect(() => {
    if (mode !== 'mpv') return
    const onBlur = () => {
      if (endedRef.current) return
      endedRef.current = true
      setVideoVisible(false)
      onPlayingChange?.(false)
      stopEmbeddedPlayerIfOwner('hero-trailer').catch(() => undefined)
      launchedRef.current = false
      onEnded?.()
    }
    
    if (!document.hasFocus()) {
      onBlur()
      return
    }

    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [mode, onEnded, onPlayingChange])

  // Keep the mpv child window glued to the hero rect through scroll/resize.
  useEffect(() => {
    if (mode !== 'mpv') return
    const el = containerRef.current
    if (!el) return
    let frame = 0
    const sync = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (getEmbeddedPlayerOwner() !== 'hero-trailer') return
        resizeEmbeddedPlayer(physicalViewport(el)).catch(() => undefined)
      })
    }
    const scrollParent = el.closest('main') || window
    scrollParent.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => {
      scrollParent.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [mode])

  // Mute / volume live updates
  useEffect(() => {
    if (mode !== 'mpv' || !launchedRef.current) return
    if (getEmbeddedPlayerOwner() !== 'hero-trailer') return
    sendPlayerCommand('set_property', ['mute', muted ? 'yes' : 'no']).catch(() => undefined)
    sendPlayerCommand('set_property', ['volume', Math.min(100, Math.max(0, trailerVolume))]).catch(() => undefined)
  }, [mode, muted, trailerVolume])

  // Transparent hole: while the video is visible, everything above the hero
  // rect must not paint opaque pixels (same trick NativeMpvPlayer uses).
  useEffect(() => {
    if (!videoVisible) return
    const html = document.documentElement
    const body = document.body
    const root = document.getElementById('root')
    const prev = [html.style.background, body.style.background, root?.style.background]
    html.style.background = 'transparent'
    body.style.background = 'transparent'
    if (root) root.style.background = 'transparent'
    html.classList.add('hero-mpv-active')
    return () => {
      html.style.background = prev[0] || ''
      body.style.background = prev[1] || ''
      if (root) root.style.background = prev[2] || ''
      html.classList.remove('hero-mpv-active')
    }
  }, [videoVisible])

  if (mode === 'fallback') {
    return (
      <TrailerPreview
        trailer={trailer}
        title={title}
        muted={muted}
        eager
        className={className}
        allowIframeFallback={false}
        onEnded={onEnded}
        onUnavailable={onUnavailable}
      />
    )
  }

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className}`}>
      {/* Thumbnail cover until mpv renders frames; afterwards this area stays
          fully transparent so the mpv child window shows through. */}
      <img
        src={trailer.thumbnailUrl}
        alt=""
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${videoVisible ? 'opacity-0' : 'opacity-100'}`}
        draggable={false}
      />
    </div>
  )
}
