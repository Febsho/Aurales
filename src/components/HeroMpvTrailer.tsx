import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TrailerSource } from '../services/trailers'
import { resolveHeroStreams } from '../services/heroTrailerStreams'
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
// pixels above the hero rect transparent. If native playback is unavailable,
// the attempt ends without exposing a YouTube iframe or thumbnail.

interface HeroMpvTrailerProps {
  trailer: TrailerSource
  muted: boolean
  className?: string
  onEnded?: () => void
  onUnavailable?: () => void
  onPlayingChange?: (playing: boolean) => void
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

function cssViewport(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

export default function HeroMpvTrailer({
  trailer,
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
  const [heroViewport, setHeroViewport] = useState(() => ({ x: 0, y: 0, width: 1, height: 1 }))
  const [maxHeight, setMaxHeight] = useState(2160)
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
      const streams = trailer.directUrl
        ? { videoUrl: trailer.directUrl, expiresAt: Date.now() + 60 * 60 * 1000 }
        : await resolveHeroStreams(trailer.key, maxHeight)
      if (cancelled) return
      if (!streams) {
        setMode('fallback')
        return
      }
      const el = containerRef.current
      if (!el) return
      const viewportEl = el.closest<HTMLElement>('[data-hero-viewport]') || el
      setHeroViewport(cssViewport(viewportEl))
      const args = [
        streams.audioUrl ? `--audio-files=${streams.audioUrl}` : '',
        trailer.directUrl?.includes('itunes.apple.com') ? '--hls-bitrate=max' : '',
        `--mute=${muted ? 'yes' : 'no'}`,
        '--loop-file=no',
        '--profile=high-quality',
        // Hero trailers are backgrounds: fill the banner like CSS object-cover
        // instead of letterboxing a 16:9 video inside an ultrawide viewport.
        '--panscan=1.0',
        '--scale=ewa_lanczossharp',
        '--cscale=ewa_lanczossharp',
        '--dscale=mitchell',
        '--deband=yes',
        '--deband-iterations=2',
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
            volume: muted ? trailerVolume : Math.max(30, trailerVolume),
            viewport: physicalViewport(viewportEl),
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
  }, [trailer.key, maxHeight])

  useEffect(() => {
    setMaxHeight(2160)
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

  // launch_embedded_mpv can succeed even when the remote host subsequently
  // rejects the stream. Do not leave the Hero frozen on its artwork forever:
  // promote the browser video fallback when no decoded frame arrives.
  useEffect(() => {
    if (mode !== 'mpv' || videoVisible) return
    const timeout = window.setTimeout(() => {
      if (videoVisible || getEmbeddedPlayerOwner() !== 'hero-trailer') return
      stopEmbeddedPlayerIfOwner('hero-trailer').catch(() => undefined)
      launchedRef.current = false
      if (!trailer.directUrl && maxHeight > 1080) {
        // Some YouTube 1440p/4K streams require delivery features that direct
        // URLs cannot satisfy. Retry once with the broadly compatible AVC tier.
        setMaxHeight(1080)
      } else {
        setMode('fallback')
      }
    }, 7000)
    return () => window.clearTimeout(timeout)
  }, [mode, videoVisible, trailer.directUrl, maxHeight])

  // Native resolution already tried the same YouTube source. End the Hero
  // trailer attempt instead of hiding its artwork behind another pending
  // browser fallback (which can remain black for blocked/restricted videos).
  useEffect(() => {
    if (mode !== 'fallback') return
    onPlayingChange?.(false)
    onUnavailable?.()
  }, [mode, onPlayingChange, onUnavailable])

  // The transparent-hole compositing only holds while the app window is
  // focused — unfocused, the hole exposes the desktop. End the trailer on
  // blur (pausing embedded mpv is not an option: known WASAPI wedge).
  useEffect(() => {
    if (mode !== 'mpv') return
    let blurTimer: ReturnType<typeof window.setTimeout> | undefined
    const onBlur = () => {
      if (blurTimer) window.clearTimeout(blurTimer)
      blurTimer = window.setTimeout(() => {
        if (document.hasFocus() || endedRef.current) return
        endedRef.current = true
        setVideoVisible(false)
        onPlayingChange?.(false)
        stopEmbeddedPlayerIfOwner('hero-trailer').catch(() => undefined)
        launchedRef.current = false
        onEnded?.()
      }, 750)
    }
    const onFocus = () => { if (blurTimer) window.clearTimeout(blurTimer) }

    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      if (blurTimer) window.clearTimeout(blurTimer)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [mode, onEnded, onPlayingChange])

  // Keep the mpv child window glued to the hero rect through scroll/resize.
  useEffect(() => {
    if (mode !== 'mpv') return
    const el = containerRef.current
    if (!el) return
    const viewportEl = el.closest<HTMLElement>('[data-hero-viewport]') || el
    let frame = 0
    const sync = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (getEmbeddedPlayerOwner() !== 'hero-trailer') return
        setHeroViewport(cssViewport(viewportEl))
        resizeEmbeddedPlayer(physicalViewport(viewportEl)).catch(() => undefined)
      })
    }
    const scrollParent = el.closest('main') || window
    scrollParent.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    const observer = new ResizeObserver(sync)
    observer.observe(viewportEl)
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
    sendPlayerCommand('set_property', ['volume', muted ? trailerVolume : Math.max(30, trailerVolume)]).catch(() => undefined)
  }, [mode, muted, trailerVolume])

  // Transparent hole: while the video is visible, everything above the hero
  // rect must not paint opaque pixels (same trick NativeMpvPlayer uses).
  useLayoutEffect(() => {
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

  return (
    <>
      {videoVisible && createPortal(
        <div className="hero-mpv-shell-backdrop" aria-hidden="true">
          <div style={{ inset: `0 0 auto 0`, height: heroViewport.y }}><span /></div>
          <div style={{ left: 0, top: heroViewport.y, width: heroViewport.x, height: heroViewport.height }}>
            <span style={{ top: -heroViewport.y }} />
          </div>
          <div style={{ left: heroViewport.x + heroViewport.width, right: 0, top: heroViewport.y, height: heroViewport.height }}>
            <span style={{ left: -(heroViewport.x + heroViewport.width), top: -heroViewport.y }} />
          </div>
          <div style={{ inset: `${heroViewport.y + heroViewport.height}px 0 0 0` }}>
            <span style={{ top: -(heroViewport.y + heroViewport.height) }} />
          </div>
          <div className="hero-mpv-corner hero-mpv-corner-tl" style={{ left: heroViewport.x, top: heroViewport.y }}>
            <span style={{ left: -heroViewport.x, top: -heroViewport.y }} />
          </div>
          <div className="hero-mpv-corner hero-mpv-corner-tr" style={{ left: heroViewport.x + heroViewport.width - 32, top: heroViewport.y }}>
            <span style={{ left: -(heroViewport.x + heroViewport.width - 32), top: -heroViewport.y }} />
          </div>
          <div className="hero-mpv-corner hero-mpv-corner-bl" style={{ left: heroViewport.x, top: heroViewport.y + heroViewport.height - 32 }}>
            <span style={{ left: -heroViewport.x, top: -(heroViewport.y + heroViewport.height - 32) }} />
          </div>
          <div className="hero-mpv-corner hero-mpv-corner-br" style={{ left: heroViewport.x + heroViewport.width - 32, top: heroViewport.y + heroViewport.height - 32 }}>
            <span style={{ left: -(heroViewport.x + heroViewport.width - 32), top: -(heroViewport.y + heroViewport.height - 32) }} />
          </div>
        </div>,
        document.body,
      )}
      {/* HeroSection keeps its normal artwork visible until mpv renders the
          first frame, so there is no thumbnail or error-frame flash. */}
      <div ref={containerRef} className={`relative h-full w-full ${className}`} />
    </>
  )
}
