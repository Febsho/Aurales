import { useEffect, useRef, useState } from 'react'
import type { SubtitleResult } from '../types'
import { formatTime } from '../services/player'
import { onSimklPlaybackStart, onSimklPlaybackStop, onSimklPlaybackPause } from '../services/simkl/playback'
import type { PlaybackItem } from '../services/simkl/playback'
import { isAuthenticated as isTraktAuthenticated } from '../services/trakt/auth'
import {
  scrobbleStart as traktScrobbleStart,
  scrobblePause as traktScrobblePause,
  scrobbleStop as traktScrobbleStop,
  buildMovieScrobble,
  buildEpisodeScrobble,
  buildMappedEpisodeScrobble,
} from '../services/trakt/scrobble'
import { useAppStore, APP_LANGUAGES } from '../stores/appStore'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import {
  play as wtPlay,
  pause as wtPause,
  seek as wtSeek,
  sendBuffering as wtSendBuffering,
  sendSyncState as wtSendSyncState,
} from '../services/watch-together/wsClient'
import { shouldCorrectDrift, markCorrectionApplied, resetDriftState } from '../services/watch-together/driftCorrection'

interface InAppPlayerProps {
  url: string
  title: string
  subtitle?: string
  subtitles?: SubtitleResult[]
  playbackItem?: PlaybackItem
  startTime?: number
  poster?: string
  backdrop?: string
  onClose: () => void
  onPickAnother: () => void
}

interface AudioTrackInfo {
  id: string
  label: string
  index: number
  enabled: boolean
}

interface PreparedSubtitle {
  id: string
  url: string
  lang: string
  label: string
}

function srtToVtt(input: string): string {
  const normalized = input.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return normalized.trimStart().startsWith('WEBVTT') ? normalized : `WEBVTT\n\n${normalized}`
}

export default function InAppPlayer({ url, title, subtitle, subtitles = [], playbackItem, startTime, poster, backdrop, onClose, onPickAnother }: InAppPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedTimeRef = useRef(0)
  const [paused, setPaused] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [selectedSubtitle, setSelectedSubtitle] = useState('off')
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([])
  const [selectedAudio, setSelectedAudio] = useState('0')
  const [preparedSubtitles, setPreparedSubtitles] = useState<PreparedSubtitle[]>([])
  const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const changePlaybackSpeed = (speed: number) => {
    setPlaybackSpeed(speed)
    setShowSpeedMenu(false)
    if (videoRef.current) videoRef.current.playbackRate = speed
  }

  const scrobbleSimkl = useAppStore((s) => s.scrobbleSimkl)
  const scrobbleTrakt = useAppStore((s) => s.scrobbleTrakt)

  const [showTranslateModal, setShowTranslateModal] = useState(false)
  const [translatingSub, setTranslatingSub] = useState(false)
  const [translationError, setTranslationError] = useState('')

  const openrouterApiKey = useAppStore((s) => s.openrouterApiKey)
  const openrouterModel = useAppStore((s) => s.openrouterModel)

  const handleTranslateSubtitle = async (langCode: string, langName: string) => {
    if (selectedSubtitle === 'off') return
    const trackIdx = Number(selectedSubtitle)
    const track = preparedSubtitles[trackIdx]
    if (!track) return

    setTranslatingSub(true)
    setTranslationError('')
    try {
      const res = await fetch(track.url)
      if (!res.ok) throw new Error('Could not fetch source subtitle content')
      const text = await res.text()

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openrouterApiKey}`,
          'HTTP-Referer': 'https://github.com/itsrenoria/aurales',
          'X-Title': 'Aurales Media Player',
        },
        body: JSON.stringify({
          model: openrouterModel || 'google/gemini-2.5-flash',
          messages: [
            {
              role: 'system',
              content: `You are an expert subtitle translator. You are translating a WebVTT or SRT subtitle file into ${langName}.
             
IMPORTANT RULES:
1. Translate all dialogue lines into natural, fluent ${langName}, preserving emotional tone and character context.
2. Keep all WebVTT/SRT timing formatting, timestamps, cue IDs, and metadata structure EXACTLY identical.
3. Do NOT translate timestamps, numbers, or technical keys.
4. Output ONLY the translated file content. Do NOT wrap output in markdown blocks (like \`\`\`vtt or \`\`\`srt). Do not include any explanations, warnings, or intro/outro text.`
            },
            {
              role: 'user',
              content: text
            }
          ]
        })
      })

      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      let translatedText = data.choices?.[0]?.message?.content || ''
      if (!translatedText) throw new Error('Received empty translation response')

      translatedText = translatedText.replace(/```(vtt|srt|webvtt)?/gi, '').replace(/```/g, '').trim()

      const blob = new Blob([srtToVtt(translatedText)], { type: 'text/vtt' })
      const objectUrl = URL.createObjectURL(blob)

      const newTrack: PreparedSubtitle = {
        id: `ai-translated-${langCode}-${Date.now()}`,
        url: objectUrl,
        lang: langCode,
        label: `✨ AI Translated (${langName})`
      }

      const newIndex = preparedSubtitles.length
      setPreparedSubtitles((prev) => [...prev, newTrack])
      setSelectedSubtitle(String(newIndex))

      if (videoRef.current) {
        const video = videoRef.current
        setTimeout(() => {
          Array.from(video.textTracks).forEach((t, idx) => {
            t.mode = idx === newIndex ? 'showing' : 'disabled'
          })
        }, 100)
      }

      setShowTranslateModal(false)
    } catch (err: any) {
      console.error('AI Subtitle Translation error:', err)
      setTranslationError(err?.message || 'Translation failed')
    } finally {
      setTranslatingSub(false)
    }
  }

  const saveLocalProgress = (time: number, dur: number, completedFlag: boolean) => {
    if (!playbackItem) return
    const key = playbackItem.season != null && playbackItem.episode != null
      ? `${playbackItem.localId}:${playbackItem.season}:${playbackItem.episode}`
      : playbackItem.localId

    const progressPct = dur > 0 ? (time / dur) * 100 : 0
    const isCompleted = completedFlag || progressPct >= 85

    useAppStore.getState().setWatchProgress(key, {
      id: key,
      mediaType: playbackItem.mediaType === 'show' ? 'series' : playbackItem.mediaType,
      mediaId: playbackItem.localId,
      title: playbackItem.title,
      poster,
      backdrop,
      season: playbackItem.season,
      episode: playbackItem.episode,
      progressSeconds: Math.floor(time),
      durationSeconds: Math.floor(dur),
      completed: isCompleted,
      updatedAt: new Date().toISOString(),
    })
  }

  const showControlsTemporarily = () => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused) setControlsVisible(false)
    }, 2600)
  }

  useEffect(() => {
    showControlsTemporarily()
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setLoading(true)
    setError('')
    setPaused(false)
    video.volume = volume
    video.muted = false
    video.load()
    const playTimer = setTimeout(() => {
      video.play().then(() => {
        setPaused(false)
        if (startTime && startTime > 0) {
          video.currentTime = startTime
        }
        if (playbackItem) {
          const startProgress = startTime && video.duration > 0 ? startTime / video.duration : 0
          if (scrobbleSimkl) {
            onSimklPlaybackStart(playbackItem, startProgress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
            const startProgressPct = Math.round(startProgress * 10000) / 100
            const traktPayload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
              ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, startProgressPct)
              : buildMovieScrobble(playbackItem.imdbId, startProgressPct)
            traktScrobbleStart(traktPayload).catch(() => {})
          }
        }
      }).catch(() => setPaused(true))
    }, 50)
    return () => clearTimeout(playTimer)
  }, [url])

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []

    Promise.all(subtitles.map(async (track, index): Promise<PreparedSubtitle> => {
      const fallback = {
        id: track.id || `sub-${index}`,
        url: track.url,
        lang: track.lang || 'und',
        label: track.label || track.lang || `Subtitle ${index + 1}`,
      }

      try {
        const res = await fetch(track.url)
        if (!res.ok) return fallback
        const text = await res.text()
        const blob = new Blob([srtToVtt(text)], { type: 'text/vtt' })
        const objectUrl = URL.createObjectURL(blob)
        objectUrls.push(objectUrl)
        return { ...fallback, url: objectUrl }
      } catch (_) {
        return fallback
      }
    })).then((tracks) => {
      if (!cancelled) setPreparedSubtitles(tracks)
    })

    return () => {
      cancelled = true
      objectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl))
    }
  }, [subtitles])

  // ── Watch Together sync ───────────────────────────────────────────────────
  const wtIgnoreNextEvent = useRef(false)

  useEffect(() => {
    const wtState = useWatchTogetherStore.getState()
    if (!wtState.currentRoom) return

    resetDriftState()

    const onSyncRequest = (e: Event) => {
      const { time, isPlaying } = (e as CustomEvent).detail as { time: number; isPlaying: boolean; sentAt: number }
      const video = videoRef.current
      if (!video) return

      const { driftThreshold } = useWatchTogetherStore.getState()
      const { shouldSeek, targetTime } = shouldCorrectDrift(
        video.currentTime,
        { currentTime: time, isPlaying, lastUpdatedAt: Date.now() },
        driftThreshold,
        3000,
      )

      if (shouldSeek) {
        wtIgnoreNextEvent.current = true
        video.currentTime = targetTime
        markCorrectionApplied()
      }

      if (isPlaying && video.paused) {
        wtIgnoreNextEvent.current = true
        video.play().catch(() => {})
      } else if (!isPlaying && !video.paused) {
        wtIgnoreNextEvent.current = true
        video.pause()
      }
    }

    window.addEventListener('wt:sync_request', onSyncRequest)
    return () => {
      window.removeEventListener('wt:sync_request', onSyncRequest)
      resetDriftState()
    }
  }, [])

  const wtSendPlay = () => {
    const video = videoRef.current
    const wt = useWatchTogetherStore.getState()
    if (!video || !wt.currentRoom) return
    if (wtIgnoreNextEvent.current) { wtIgnoreNextEvent.current = false; return }
    wtPlay(video.currentTime)
  }

  const wtSendPause = () => {
    const video = videoRef.current
    const wt = useWatchTogetherStore.getState()
    if (!video || !wt.currentRoom) return
    if (wtIgnoreNextEvent.current) { wtIgnoreNextEvent.current = false; return }
    wtPause(video.currentTime)
  }

  const wtSendSeek = () => {
    const video = videoRef.current
    const wt = useWatchTogetherStore.getState()
    if (!video || !wt.currentRoom) return
    if (wtIgnoreNextEvent.current) { wtIgnoreNextEvent.current = false; return }
    wtSeek(video.currentTime)
  }

  const refreshAudioTracks = () => {
    const video = videoRef.current as (HTMLVideoElement & { audioTracks?: Array<{ enabled: boolean; id?: string; label?: string; language?: string }> }) | null
    const tracks = video?.audioTracks
    if (!tracks?.length) {
      setAudioTracks([])
      return
    }

    const next = Array.from(tracks).map((track, index) => ({
      id: track.id || String(index),
      label: track.label || track.language || `Audio ${index + 1}`,
      index,
      enabled: track.enabled,
    }))
    if (next.length > 0 && !next.some((track) => track.enabled)) {
      tracks[0].enabled = true
      next[0].enabled = true
    }
    setAudioTracks(next)
    setSelectedAudio(String(next.find((track) => track.enabled)?.index ?? 0))
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    showControlsTemporarily()

    if (video.paused) {
      setError('')
      video.play().then(() => {
        setPaused(false)
        if (playbackItem) {
          const progress = video.duration > 0 ? video.currentTime / video.duration : 0
          saveLocalProgress(video.currentTime, video.duration || 0, false)
          if (scrobbleSimkl) {
            onSimklPlaybackStart(playbackItem, progress).catch(() => {})
          }
          if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
            const progressPct = Math.round(progress * 10000) / 100
            const traktPayload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
              ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
              : buildMovieScrobble(playbackItem.imdbId, progressPct)
            traktScrobbleStart(traktPayload).catch(() => {})
          }
        }
      }).catch(() => {
        setError('The embedded WebView player could not start this stream. Pick another stream if this does not retry.')
      })
    } else {
      video.pause()
      setPaused(true)
      setControlsVisible(true)
      if (playbackItem) {
        const progress = video.duration > 0 ? video.currentTime / video.duration : 0
        saveLocalProgress(video.currentTime, video.duration || 0, false)
        if (scrobbleSimkl) {
          onSimklPlaybackPause(playbackItem, progress).catch(() => {})
        }
        if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
          const progressPct = Math.round(progress * 10000) / 100
          const traktPayload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
            ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
            : buildMovieScrobble(playbackItem.imdbId, progressPct)
          traktScrobblePause(traktPayload).catch(() => {})
        }
      }
    }
  }

  const handleClose = () => {
    if (playbackItem) {
      const video = videoRef.current
      const progress = video && video.duration > 0 ? video.currentTime / video.duration : 0
      const cur = video ? video.currentTime : 0
      const dur = video ? video.duration || 0 : 0
      saveLocalProgress(cur, dur, false)
      const { keepFramesFor, savedFramesCount, setSavedFramesCount } = useAppStore.getState()
      if (keepFramesFor !== 'none') {
        setSavedFramesCount(savedFramesCount + 1)
      }
      if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
        const progressPct = Math.round(progress * 10000) / 100
        const traktPayload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
          ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
          : buildMovieScrobble(playbackItem.imdbId, progressPct)
        traktScrobbleStop(traktPayload).catch(() => {})
      }
      if (scrobbleSimkl) {
        onSimklPlaybackStop(playbackItem, progress).catch(() => {})
      }
    }
    onClose()
  }

  const handlePickAnother = () => {
    if (playbackItem) {
      const video = videoRef.current
      const progress = video && video.duration > 0 ? video.currentTime / video.duration : 0
      const cur = video ? video.currentTime : 0
      const dur = video ? video.duration || 0 : 0
      saveLocalProgress(cur, dur, false)
      const { keepFramesFor, savedFramesCount, setSavedFramesCount } = useAppStore.getState()
      if (keepFramesFor !== 'none') {
        setSavedFramesCount(savedFramesCount + 1)
      }
      if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
        const progressPct = Math.round(progress * 10000) / 100
        const traktPayload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
          ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, progressPct)
          : buildMovieScrobble(playbackItem.imdbId, progressPct)
        traktScrobbleStop(traktPayload).catch(() => {})
      }
      if (scrobbleSimkl) {
        onSimklPlaybackStop(playbackItem, progress).catch(() => {})
      }
    }
    onPickAnother()
  }

  const handleEnded = () => {
    if (playbackItem) {
      const dur = videoRef.current ? videoRef.current.duration || 0 : 0
      saveLocalProgress(dur, dur, true)
      if (scrobbleSimkl) {
        onSimklPlaybackStop(playbackItem, 1).catch(() => {})
      }
      if (scrobbleTrakt && isTraktAuthenticated() && playbackItem.imdbId) {
        const traktPayload = playbackItem.mediaType === 'show' && playbackItem.season != null && playbackItem.episode != null
          ? buildEpisodeScrobble(playbackItem.imdbId, playbackItem.season, playbackItem.episode, 100)
          : buildMovieScrobble(playbackItem.imdbId, 100)
        traktScrobbleStop(traktPayload).catch(() => {})
      }
    }
  }

  const seekBy = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds))
    showControlsTemporarily()
    wtSendSeek()
  }

  const seekTo = (value: string) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Number(value)
    showControlsTemporarily()
    wtSendSeek()
  }

  const changeVolume = (value: string) => {
    const next = Number(value)
    setVolume(next)
    if (videoRef.current) {
      videoRef.current.volume = next
      videoRef.current.muted = next === 0
    }
    showControlsTemporarily()
  }

  const changeSubtitle = (id: string) => {
    setSelectedSubtitle(id)
    const video = videoRef.current
    if (!video) return
    Array.from(video.textTracks).forEach((track, index) => {
      track.mode = id === String(index) ? 'showing' : 'disabled'
    })
    showControlsTemporarily()
  }

  const changeAudio = (index: string) => {
    const video = videoRef.current as (HTMLVideoElement & { audioTracks?: Array<{ enabled: boolean }> }) | null
    const tracks = video?.audioTracks
    if (!tracks?.length) return
    Array.from(tracks).forEach((track, trackIndex) => {
      track.enabled = String(trackIndex) === index
    })
    setSelectedAudio(index)
    refreshAudioTracks()
    showControlsTemporarily()
  }

  const handleTimeUpdate = (time: number, dur: number) => {
    setCurrentTime(time)
    if (Math.abs(time - lastSavedTimeRef.current) >= 2) {
      lastSavedTimeRef.current = time
      saveLocalProgress(time, dur, false)
    }
  }

  return (
    <div
      className={`fixed inset-0 z-[60] bg-black text-white ${controlsVisible ? 'cursor-default' : 'cursor-none'}`}
      onMouseMove={showControlsTemporarily}
      onClick={showControlsTemporarily}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full bg-black object-contain"
        preload="auto"
        playsInline
        autoPlay
        onPlay={() => { setPaused(false); showControlsTemporarily(); wtSendPlay() }}
        onPause={() => { setPaused(true); setControlsVisible(true); wtSendPause() }}
        onWaiting={() => { setLoading(true); const wt = useWatchTogetherStore.getState(); if (wt.currentRoom) wtSendBuffering(true, videoRef.current?.currentTime ?? 0) }}
        onCanPlay={() => {
          setLoading(false)
          const video = videoRef.current
          if (video?.paused) video.play().catch(() => setPaused(true))
        }}
        onPlaying={() => { setLoading(false); setPaused(false); const wt = useWatchTogetherStore.getState(); if (wt.currentRoom) wtSendBuffering(false, videoRef.current?.currentTime ?? 0) }}
        onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget.currentTime, event.currentTarget.duration || 0)}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration || 0)
          refreshAudioTracks()
          if (startTime && startTime > 0) {
            event.currentTarget.currentTime = startTime
          }
        }}
        onEnded={handleEnded}
        onError={() => {
          setLoading(false)
          setError('This stream could not be played by the embedded WebView player. Pick another stream or use a direct HTTP/HLS source.')
        }}
      >
        <source src={url} />
        {preparedSubtitles.map((track, index) => (
          <track
            key={`${track.id}-${track.url}`}
            src={track.url}
            srcLang={track.lang || 'und'}
            label={track.label || track.lang || `Subtitle ${index + 1}`}
            kind="subtitles"
          />
        ))}
      </video>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-2 border-white/80 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-white/60">Buffering stream...</p>
          </div>
        </div>
      )}

      {paused && !loading && (
        <button onClick={togglePlay} className="absolute inset-0 flex items-center justify-center">
          <span className="w-24 h-24 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur-xl flex items-center justify-center">
            <svg className="w-12 h-12 ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}

      <div className={`absolute inset-x-0 top-0 flex items-start justify-between p-7 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button onClick={handleClose} className="w-11 h-11 rounded-full bg-white/5 hover:bg-white/15 flex items-center justify-center">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="text-right">
          <h2 className="font-bold text-lg">{title}</h2>
          {subtitle && <p className="text-xs text-white/55 uppercase tracking-[0.2em]">{subtitle}</p>}
        </div>
      </div>

      {error && (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 rounded-2xl border border-red-500/20 bg-red-500/10 px-5 py-3 text-sm text-red-200 backdrop-blur-xl">
          {error}
        </div>
      )}

      <div className={`absolute inset-x-0 bottom-0 p-7 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-3 text-xs text-white/70 mb-4">
          <span className="tabular-nums">{formatTime(currentTime)}</span>
          <div className="relative flex-1 h-1.5 group cursor-pointer transition-[height] duration-150 hover:h-2.5">
            <div className="absolute inset-0 rounded-full bg-white/20 group-hover:bg-white/30 transition-colors" />
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/90" style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' }} />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 6px)` }}
            />
            <input type="range" min="0" max={duration || 0} step="0.1" value={currentTime} onChange={(event) => seekTo(event.target.value)} className="absolute inset-0 w-full opacity-0 cursor-pointer h-6 -top-2.5" />
          </div>
          <span className="tabular-nums">{duration ? formatTime(duration) : '--:--'}</span>
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <button onClick={() => seekBy(-10)} title="Back 10s" className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
                <text x="11.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>
            <button onClick={togglePlay} className="w-14 h-14 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors">
              {paused ? (
                <svg className="w-7 h-7 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              ) : (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
              )}
            </button>
            <button onClick={() => seekBy(10)} title="Forward 10s" className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.16-3.16-1.88-5.12-1.88-3.54 0-6.55 2.31-7.6 5.5l-2.37-.78C2.92 11.03 6.85 8 11.5 8z" />
                <text x="12.5" y="17.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
              </svg>
            </button>
            <button onClick={handlePickAnother} className="px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm">Pick another</button>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              {showSpeedMenu && (
                <div className="absolute bottom-full mb-2 left-0 bg-black/90 backdrop-blur-xl border border-white/15 rounded-xl py-1.5 shadow-2xl z-50 min-w-[100px]">
                  {SPEED_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => changePlaybackSpeed(s)}
                      className={`w-full px-4 py-1.5 text-xs font-semibold text-left transition-colors ${
                        playbackSpeed === s ? 'text-accent bg-white/10' : 'text-white/70 hover:text-white hover:bg-white/8'
                      }`}
                    >
                      {s === 1 ? 'Normal' : `${s}x`}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => setShowSpeedMenu((v) => !v)}
                title="Playback speed"
                className={`px-3 py-2 rounded-xl text-sm font-bold transition-colors ${
                  playbackSpeed !== 1 ? 'bg-accent/20 text-accent border border-accent/30' : 'bg-black/80 text-white border border-white/15 hover:bg-white/10'
                }`}
              >
                {playbackSpeed === 1 ? '1x' : `${playbackSpeed}x`}
              </button>
            </div>
            <select value={selectedAudio} onChange={(event) => changeAudio(event.target.value)} className="bg-black/80 text-white border border-white/15 rounded-xl px-3 py-2 text-sm outline-none">
              {audioTracks.length > 0 ? audioTracks.map((track) => (
                <option key={track.id} value={track.index}>{track.label}</option>
              )) : (
                <option value="0">Default audio</option>
              )}
            </select>
            <select value={selectedSubtitle} onChange={(event) => changeSubtitle(event.target.value)} className="bg-black/80 text-white border border-white/15 rounded-xl px-3 py-2 text-sm outline-none">
              <option value="off">Subtitles off</option>
              {preparedSubtitles.map((track, index) => (
                <option key={`${track.id}-${track.url}`} value={index}>{track.label || track.lang || `Subtitle ${index + 1}`}</option>
              ))}
            </select>
            {selectedSubtitle !== 'off' && (
              <button
                onClick={() => {
                  setTranslationError('')
                  setShowTranslateModal(true)
                }}
                className="bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/30 text-purple-200 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
                title="AI Translate Subtitles"
              >
                <span>✨ AI Translate</span>
              </button>
            )}
            <input type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => changeVolume(event.target.value)} className="w-28 accent-white" />
            <button onClick={() => videoRef.current?.requestFullscreen()} className="text-white/75 hover:text-white">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* AI Subtitle Translation Modal */}
      {showTranslateModal && (
        <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-md flex items-center justify-center p-4" onClick={() => !translatingSub && setShowTranslateModal(false)}>
          <div 
            className="w-full max-w-lg bg-surface-elevated/90 border border-border-subtle rounded-2xl p-6 shadow-2xl backdrop-blur-xl animate-fade-in text-white relative overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
              <div>
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <span className="flex items-center justify-center w-5 h-5 rounded bg-purple-500/20 text-purple-300 text-xs font-black">
                    AI
                  </span>
                  Translate Subtitles
                </h3>
                <p className="text-xs text-muted mt-1">Translate the active subtitle track using OpenRouter.</p>
              </div>
              {!translatingSub && (
                <button 
                  onClick={() => setShowTranslateModal(false)}
                  className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center cursor-pointer transition-colors text-white/70 hover:text-white"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Error message */}
            {translationError && (
              <div className="bg-red-500/15 border border-red-500/20 rounded-xl p-3 mb-4 text-xs text-red-200 flex gap-2">
                <svg className="w-4 h-4 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" />
                </svg>
                <span>{translationError}</span>
              </div>
            )}

            {!openrouterApiKey ? (
              <div className="space-y-4">
                <div className="bg-yellow-500/10 border border-yellow-500/25 rounded-xl p-4 text-sm text-yellow-250 leading-relaxed">
                  OpenRouter API Key is not configured. Please go to Settings -&gt; Accounts &amp; API Keys to set up your OpenRouter credentials first.
                </div>
                <button
                  onClick={() => setShowTranslateModal(false)}
                  className="w-full py-2.5 bg-white/5 hover:bg-white/10 text-white rounded-xl text-sm font-semibold transition-colors cursor-pointer"
                >
                  Go Back
                </button>
              </div>
            ) : translatingSub ? (
              <div className="flex flex-col items-center justify-center py-10 space-y-4">
                <div className="w-10 h-10 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                <div className="text-center">
                  <p className="text-sm font-bold text-white">Translating Subtitles...</p>
                  <p className="text-xs text-muted mt-1 max-w-xs leading-relaxed">
                    Analyzing dialogue and generating translation via {openrouterModel}. This may take 10-20 seconds.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-muted font-bold uppercase tracking-wider">Select Target Language</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                  {APP_LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => handleTranslateSubtitle(lang.code, lang.name)}
                      className="flex items-center gap-2 p-2.5 bg-white/5 hover:bg-purple-500/15 border border-white/5 hover:border-purple-500/30 rounded-xl text-left transition-all cursor-pointer group"
                    >
                      <span className="text-sm">{lang.flag}</span>
                      <span className="text-xs font-semibold text-white/80 group-hover:text-white truncate">{lang.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
