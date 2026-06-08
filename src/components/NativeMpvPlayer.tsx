import { useEffect, useRef, useState, useCallback } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { SubtitleResult } from '../types'
import { launchEmbeddedPlayer, resizeEmbeddedPlayer, sendPlayerCommand, stopEmbeddedPlayer, getPlayerProperty } from '../services/player'

interface NativeMpvPlayerProps {
  url: string
  title: string
  subtitle?: string
  subtitles?: SubtitleResult[]
  onClose: () => void
  onPickAnother: () => void
}

interface MpvTrack {
  id: number
  type: 'video' | 'audio' | 'sub'
  lang?: string
  title?: string
  selected?: boolean
  default?: boolean
  forced?: boolean
  external?: boolean
}

interface TrackOption {
  id: number
  label: string
}

function buildVideoViewport() {
  const scale = window.devicePixelRatio || 1
  return {
    x: 0,
    y: 0,
    width: Math.round(window.innerWidth * scale),
    height: Math.round(window.innerHeight * scale),
  }
}

export default function NativeMpvPlayer({ url, title, subtitle, subtitles = [], onClose, onPickAnother }: NativeMpvPlayerProps) {
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [paused, setPaused] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [error, setError] = useState('')
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subTracks, setSubTracks] = useState<TrackOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState<number>(1)
  const [selectedSub, setSelectedSub] = useState<number | 'no'>('no')
  const [tracksLoaded, setTracksLoaded] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3500)
  }, [])

  const command = useCallback((name: string, args: unknown[] = []) => {
    showControls()
    sendPlayerCommand(name, args).catch((e) => setError(String(e)))
  }, [showControls])

  // Boot: make window background transparent so mpv shows through
  useEffect(() => {
    const orig = document.documentElement.style.background
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.style.background = ''
      document.documentElement.style.background = orig
    }
  }, [])

  // Start mpv
  useEffect(() => {
    let cancelled = false
    const start = async () => {
      try {
        await launchEmbeddedPlayer({ url, title, viewport: buildVideoViewport() })
        if (cancelled) return

        // Load addon subtitles
        subtitles.forEach((track) => {
          if (track.url) {
            sendPlayerCommand('sub-add', [track.url, 'auto', track.label || track.lang || 'Subtitle']).catch(() => {})
          }
        })

        // Query tracks after mpv has had time to open the stream
        setTimeout(async () => {
          if (cancelled) return
          try {
            const data = await getPlayerProperty('track-list') as MpvTrack[]
            if (!Array.isArray(data)) return

            const audio: TrackOption[] = data
              .filter((t) => t.type === 'audio')
              .map((t) => ({
                id: t.id,
                label: [t.title, t.lang ? `[${t.lang}]` : ''].filter(Boolean).join(' ') || `Audio ${t.id}`,
              }))

            const sub: TrackOption[] = data
              .filter((t) => t.type === 'sub')
              .map((t) => ({
                id: t.id,
                label: [t.title, t.lang ? `[${t.lang}]` : '', t.forced ? '(forced)' : '', t.external ? '(ext)' : ''].filter(Boolean).join(' ') || `Sub ${t.id}`,
              }))

            const selectedAudioTrack = data.find((t) => t.type === 'audio' && t.selected)
            const selectedSubTrack = data.find((t) => t.type === 'sub' && t.selected)

            setAudioTracks(audio)
            setSubTracks(sub)
            if (selectedAudioTrack) setSelectedAudio(selectedAudioTrack.id)
            if (selectedSubTrack) setSelectedSub(selectedSubTrack.id)
            else setSelectedSub('no')
            setTracksLoaded(true)
          } catch {
            // IPC query failed — that's OK, use defaults
            setTracksLoaded(true)
          }
        }, 2500)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }

    start()
    showControls()

    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      stopEmbeddedPlayer().catch(() => {})
    }
  }, [url, title])

  // Sync window resize → mpv viewport
  useEffect(() => {
    const onResize = () => resizeEmbeddedPlayer(buildVideoViewport()).catch(() => {})
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Poll playback position
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      try {
        const pos = await getPlayerProperty('time-pos') as number | null
        const dur = await getPlayerProperty('duration') as number | null
        if (pos != null) setCurrentTime(pos)
        if (dur != null && dur > 0) setDuration(dur)
      } catch { /* ignore */ }
    }, 1000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const close = async () => {
    // Restore window to non-fullscreen before leaving
    if (isFullscreen) {
      await getCurrentWindow().setFullscreen(false).catch(() => {})
    }
    await stopEmbeddedPlayer().catch(() => {})
    onClose()
  }

  const pickAnother = async () => {
    if (isFullscreen) {
      await getCurrentWindow().setFullscreen(false).catch(() => {})
      setIsFullscreen(false)
    }
    await stopEmbeddedPlayer().catch(() => {})
    onPickAnother()
  }

  const togglePlay = () => {
    setPaused((p) => !p)
    command('cycle', ['pause'])
  }

  const seekBy = (secs: number) => command('seek', [secs, 'relative'])

  const seekTo = (pct: number) => command('set_property', ['percent-pos', pct])

  const changeVolume = (val: number) => command('set_property', ['volume', val])

  const changeAudio = (id: number) => {
    setSelectedAudio(id)
    command('set_property', ['aid', id])
  }

  const changeSub = (id: number | 'no') => {
    setSelectedSub(id)
    if (id === 'no') command('set_property', ['sid', 'no'])
    else command('set_property', ['sid', id])
  }

  const toggleFullscreen = async () => {
    const win = getCurrentWindow()
    const next = !isFullscreen
    setIsFullscreen(next)
    await win.setFullscreen(next).catch(() => {})
    // Resize mpv after the window resizes (brief delay)
    setTimeout(() => resizeEmbeddedPlayer(buildVideoViewport()).catch(() => {}), 150)
    showControls()
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`
  }

  return (
    <div
      className={`fixed inset-0 z-[60] text-white select-none ${controlsVisible ? 'cursor-default' : 'cursor-none'}`}
      style={{ background: 'transparent' }}
      onMouseMove={showControls}
      onClick={showControls}
    >
      {/* ── Top bar ── */}
      <div
        className={`absolute inset-x-0 top-0 z-10 flex items-center justify-between px-7 py-5 bg-gradient-to-b from-black/85 via-black/40 to-transparent transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <button
          onClick={close}
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="text-right">
          <h2 className="font-semibold text-base leading-tight">{title}</h2>
          {subtitle && <p className="text-[11px] text-white/50 uppercase tracking-[0.18em] mt-0.5">{subtitle}</p>}
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="absolute left-1/2 top-20 z-20 -translate-x-1/2 max-w-md rounded-2xl border border-red-500/25 bg-red-900/60 backdrop-blur-xl px-5 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* ── Bottom bar ── */}
      <div
        className={`absolute inset-x-0 bottom-0 z-10 px-7 pt-10 pb-5 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        {/* Progress */}
        <div className="flex items-center gap-3 text-xs text-white/60 mb-4">
          <span className="w-10 text-right">{duration > 0 ? formatTime(currentTime) : '--:--'}</span>
          <div className="relative flex-1 h-1 group">
            <div className="absolute inset-0 rounded-full bg-white/20" />
            <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${progressPct}%` }} />
            <input
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={progressPct}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="absolute inset-0 w-full opacity-0 cursor-pointer"
            />
          </div>
          <span className="w-10">{duration > 0 ? formatTime(duration) : '--:--'}</span>
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-between gap-4">
          {/* Left: playback */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => seekBy(-10)}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-sm font-medium transition-colors"
            >
              −10
            </button>
            <button
              onClick={togglePlay}
              className="w-12 h-12 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
            >
              {paused ? (
                <svg className="w-6 h-6 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              ) : (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
              )}
            </button>
            <button
              onClick={() => seekBy(10)}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-sm font-medium transition-colors"
            >
              +10
            </button>
            <button
              onClick={pickAnother}
              className="px-3.5 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
            >
              Pick another
            </button>
          </div>

          {/* Right: audio / sub / vol / fullscreen */}
          <div className="flex items-center gap-2.5">
            {/* Audio */}
            <div className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-white/50 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
              </svg>
              <select
                value={selectedAudio}
                onChange={(e) => changeAudio(Number(e.target.value))}
                className="bg-white/10 hover:bg-white/20 text-white border-0 rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer max-w-[130px] truncate"
              >
                {audioTracks.length > 0 ? audioTracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                )) : (
                  <option value={1}>Default audio</option>
                )}
              </select>
            </div>

            {/* Subtitles */}
            <div className="flex items-center gap-1.5">
              <svg className="w-4 h-4 text-white/50 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 15h4m0 0h6M7 11h10" />
              </svg>
              <select
                value={selectedSub === 'no' ? 'no' : selectedSub}
                onChange={(e) => changeSub(e.target.value === 'no' ? 'no' : Number(e.target.value))}
                className="bg-white/10 hover:bg-white/20 text-white border-0 rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer max-w-[130px] truncate"
              >
                <option value="no">Off</option>
                {subTracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Volume */}
            <input
              type="range"
              min={0}
              max={130}
              defaultValue={100}
              onChange={(e) => changeVolume(Number(e.target.value))}
              className="w-24 accent-white cursor-pointer"
            />

            {/* Fullscreen */}
            <button
              onClick={toggleFullscreen}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M8 3v3a2 2 0 01-2 2H3M16 3v3a2 2 0 002 2h3M8 21v-3a2 2 0 00-2-2H3M16 21v-3a2 2 0 012-2h3" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Loading overlay ── */}
      {!tracksLoaded && !error && (
        <div className="absolute left-1/2 bottom-32 z-20 -translate-x-1/2 flex items-center gap-2 text-xs text-white/40">
          <div className="w-3.5 h-3.5 border border-white/30 border-t-transparent rounded-full animate-spin" />
          Detecting tracks…
        </div>
      )}
    </div>
  )
}
