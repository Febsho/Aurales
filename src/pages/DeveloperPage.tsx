import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getLogs, clearLogs, subscribeLogs, logEvent } from '../services/diagnostics'
import { useAppStore } from '../stores/appStore'
import { launchEmbeddedPlayer } from '../services/player'

interface MpvInfo {
  path: string
  candidates: string[]
  os: string
  arch: string
}

export default function DeveloperPage() {
  const [mpvInfo, setMpvInfo] = useState<MpvInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [testUrl, setTestUrl] = useState('')
  const [testTitle, setTestTitle] = useState('Developer Test Playback')
  const [error, setError] = useState('')
  const [playbackState, setPlaybackState] = useState<any>(null)
  const [logEntries, setLogEntries] = useState(getLogs())
  const logEndRef = useRef<HTMLDivElement>(null)

  const store = useAppStore()

  // Fetch MPV Path and Candidates info from backend
  useEffect(() => {
    invoke('get_mpv_info')
      .then((res: any) => {
        setMpvInfo(res)
        setLoading(false)
      })
      .catch((err) => {
        setError(String(err))
        setLoading(false)
      })
  }, [])

  // Subscribe to log updates
  useEffect(() => {
    setLogEntries(getLogs())
    const unsubscribe = subscribeLogs(() => {
      setLogEntries([...getLogs()])
    })
    return unsubscribe
  }, [])

  // Poll current player properties if running
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const timePos = await invoke('mpv_get_property', { property: 'time-pos' })
        const duration = await invoke('mpv_get_property', { property: 'duration' })
        const volume = await invoke('mpv_get_property', { property: 'volume' })
        const pause = await invoke('mpv_get_property', { property: 'pause' })
        const buffering = await invoke('mpv_get_property', { property: 'buffering' })
        const cacheBuffState = await invoke('mpv_get_property', { property: 'cache-buffering-state' })
        const demuxerCacheDur = await invoke('mpv_get_property', { property: 'demuxer-cache-duration' })
        const eofReached = await invoke('mpv_get_property', { property: 'eof-reached' })
        const idleActive = await invoke('mpv_get_property', { property: 'idle-active' })
        const coreIdle = await invoke('mpv_get_property', { property: 'core-idle' })

        if (timePos !== null || duration !== null || buffering !== null) {
          setPlaybackState({
            timePos,
            duration,
            volume,
            pause,
            buffering,
            cacheBuffState,
            demuxerCacheDur,
            eofReached,
            idleActive,
            coreIdle
          })
        } else {
          setPlaybackState(null)
        }
      } catch {
        setPlaybackState(null)
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  // Play Direct stream handler
  const handlePlayTestStream = async () => {
    if (!testUrl.trim()) return
    setError('')
    logEvent('PLAYER DEBUG', `Test direct stream started with URL: ${testUrl}`)
    try {
      await launchEmbeddedPlayer({
        url: testUrl,
        title: testTitle,
        startTime: 0,
        volume: 100,
        hwdecMode: store.hwdecMode,
        cacheBufferSize: store.cacheBufferSize,
        mpvCacheSecs: store.mpvCacheSecs,
        mpvNetworkTimeout: store.mpvNetworkTimeout,
        mpvCustomArgs: store.mpvCustomArgs,
        viewport: {
          x: 0,
          y: 0,
          width: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
          height: Math.round(window.innerHeight * (window.devicePixelRatio || 1))
        }
      })
      logEvent('PLAYER DEBUG', `launchEmbeddedPlayer returned success for test stream`)
    } catch (err: any) {
      setError(String(err))
      logEvent('PLAYER DEBUG', `launchEmbeddedPlayer failed for test stream: ${err}`)
    }
  }

  // Copy debug report function
  const handleCopyReport = () => {
    const report = {
      os: mpvInfo?.os || 'unknown',
      arch: mpvInfo?.arch || 'unknown',
      appVersion: 'v0.1.0',
      mpvPath: mpvInfo?.path || 'Not Found',
      mpvArgs: {
        hwdecMode: store.hwdecMode,
        cacheBufferSize: store.cacheBufferSize,
        mpvCacheSecs: store.mpvCacheSecs,
        mpvNetworkTimeout: store.mpvNetworkTimeout,
        mpvCustomArgs: store.mpvCustomArgs
      },
      playbackState: playbackState || 'No active session',
      events: logEntries.map(e => `[${e.timestamp}] [${e.prefix}] ${e.message}`)
    }

    navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      .then(() => alert('Player diagnostics report copied to clipboard!'))
      .catch(() => alert('Failed to copy report to clipboard.'))
  }

  return (
    <div className="flex-1 bg-[#0a0a0c] text-white p-8 overflow-y-auto min-h-screen">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 pb-5">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-white flex items-center gap-2">
              Developer Diagnostics
            </h1>
            <p className="text-white/40 text-sm mt-1">Verify video player stability, properties, and system setup.</p>
          </div>
          <button
            onClick={handleCopyReport}
            className="flex items-center gap-2 px-4 py-2.5 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent/90 transition-all shadow-lg shadow-accent/15 cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Copy Debug Report
          </button>
        </div>

        {error && (
          <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/10 text-red-200 text-sm font-semibold">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Left Column (System Info + MPV Config) */}
          <div className="lg:col-span-1 space-y-8">
            
            {/* System Info Card */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.04] space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white/45">System Specs</h3>
              <div className="space-y-3.5 text-sm">
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-white/50">App Version</span>
                  <span className="font-semibold">v0.1.0</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-white/50">OS Platform</span>
                  <span className="font-semibold capitalize">{mpvInfo?.os || 'Windows'}</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-white/50">Architecture</span>
                  <span className="font-semibold uppercase">{mpvInfo?.arch || 'x86_64'}</span>
                </div>
              </div>
            </div>

            {/* MPV Binary Info */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.04] space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white/45">MPV Path Status</h3>
              <div className="space-y-3.5 text-sm">
                <div>
                  <span className="text-white/50 block mb-1">Resolved Executable</span>
                  <code className="text-xs break-all bg-black/45 px-2 py-1.5 rounded-lg border border-white/5 block text-accent font-semibold">
                    {loading ? 'Detecting...' : mpvInfo?.path || 'Not Found'}
                  </code>
                </div>
                <div>
                  <span className="text-white/50 block mb-1">Checked Search Locations</span>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto text-xs bg-black/20 p-2 rounded-lg border border-white/5">
                    {mpvInfo?.candidates.map((cand, idx) => (
                      <div key={idx} className="break-all font-mono opacity-60">
                        {cand}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Play Test Stream */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.04] space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white/45">Direct stream test</h3>
              <div className="space-y-3.5">
                <div>
                  <label className="text-xs text-white/50 block mb-1">Stream Direct URL</label>
                  <input
                    type="text"
                    placeholder="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
                    value={testUrl}
                    onChange={(e) => setTestUrl(e.target.value)}
                    className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-xs text-white placeholder-white/20 focus:outline-none focus:border-accent/50"
                  />
                </div>
                <div>
                  <label className="text-xs text-white/50 block mb-1">Media Title</label>
                  <input
                    type="text"
                    value={testTitle}
                    onChange={(e) => setTestTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-xs text-white focus:outline-none focus:border-accent/50"
                  />
                </div>
                <button
                  onClick={handlePlayTestStream}
                  className="w-full py-2 bg-white/10 hover:bg-white/15 text-white font-semibold rounded-xl text-xs transition-all cursor-pointer"
                >
                  Play Direct Stream
                </button>
              </div>
            </div>

          </div>

          {/* Right Column (Live Session + Logs Console) */}
          <div className="lg:col-span-2 space-y-8">
            
            {/* Live Playback Properties */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.04] space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white/45">Active MPV Session Properties</h3>
              {playbackState ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm font-medium">
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Timeline pos</span>
                    <span className="text-base text-accent font-black">{Math.round(playbackState.timePos ?? 0)}s</span>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Duration</span>
                    <span className="text-base font-bold">{Math.round(playbackState.duration ?? 0)}s</span>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Volume</span>
                    <span className="text-base font-bold">{playbackState.volume}%</span>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Paused</span>
                    <span className="text-base font-bold capitalize">{String(playbackState.pause)}</span>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Buffering</span>
                    <span className="text-base font-bold capitalize">{String(playbackState.buffering)}</span>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Cache State</span>
                    <span className="text-base font-bold">{playbackState.cacheBuffState ?? 0}%</span>
                  </div>
                  <div className="bg-black/30 p-3.5 rounded-xl border border-white/5 col-span-2 sm:col-span-3">
                    <span className="text-white/40 text-[10px] uppercase block tracking-wider">Demuxer Cache Duration</span>
                    <span className="text-base text-purple-300 font-bold">{Math.round(playbackState.demuxerCacheDur ?? 0)}s</span>
                  </div>
                </div>
              ) : (
                <div className="h-24 flex items-center justify-center bg-black/25 rounded-xl border border-white/5 text-white/30 text-xs italic">
                  No video playback is currently active
                </div>
              )}
            </div>

            {/* Terminal Console Logs */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.04] space-y-4 flex flex-col h-[520px]">
              <div className="flex items-center justify-between border-b border-white/5 pb-3 flex-shrink-0">
                <h3 className="text-sm font-bold uppercase tracking-wider text-white/45">Diagnostics logs (Last 50 Events)</h3>
                <button
                  onClick={() => clearLogs()}
                  className="text-xs font-semibold text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                >
                  Clear Console
                </button>
              </div>

              <div className="flex-1 min-h-0 bg-[#060608] rounded-xl border border-white/5 font-mono text-[11px] p-4 overflow-y-auto space-y-2 select-text selection:bg-accent/30 selection:text-white">
                {logEntries.length === 0 ? (
                  <div className="text-white/20 italic text-center pt-8">No diagnostics events logged yet.</div>
                ) : (
                  logEntries.map((log, idx) => {
                    const color = 
                      log.prefix === 'PLAYER DEBUG' ? 'text-accent' :
                      log.prefix === 'MPV DEBUG' ? 'text-blue-300' :
                      log.prefix === 'PLAYBACK SYNC DEBUG' ? 'text-purple-300' :
                      log.prefix === 'WATCH TOGETHER DEBUG' ? 'text-orange-300' :
                      'text-white/40';

                    return (
                      <div key={idx} className="leading-relaxed hover:bg-white/[0.02] px-1 rounded transition-colors">
                        <span className="text-white/20 select-none mr-2">[{log.timestamp.split('T')[1].slice(0, 8)}]</span>
                        <span className={`${color} font-bold mr-1.5`}>[{log.prefix}]</span>
                        <span className="text-white/80">{log.message}</span>
                      </div>
                    )
                  })
                )}
                <div ref={logEndRef} />
              </div>
            </div>

          </div>

        </div>

      </div>
    </div>
  )
}
