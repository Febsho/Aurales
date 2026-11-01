import { useEffect, useState } from 'react'
import InAppPlayer from '../components/InAppPlayer'
import { getAppVersion } from '../services/updater'
import { requestDiagnostics, type RequestDiagnostics } from '../services/network/requestCoordinator'
import { getPlatformCapabilities } from '../platform/capabilities'

interface LocalVideo {
  name: string
  url: string
}

export default function WebDeveloperPage() {
  const [video, setVideo] = useState<LocalVideo | null>(null)
  const [requests, setRequests] = useState<RequestDiagnostics>(() => requestDiagnostics())
  const [copyMessage, setCopyMessage] = useState('')

  useEffect(() => {
    const timer = window.setInterval(() => setRequests(requestDiagnostics()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    return () => {
      if (video) URL.revokeObjectURL(video.url)
    }
  }, [video])

  const openFile = (file?: File) => {
    if (!file) return
    setVideo({ name: file.name, url: URL.createObjectURL(file) })
  }

  const copyReport = async () => {
    const report = {
      appVersion: `v${getAppVersion()}`,
      platform: 'web',
      userAgent: navigator.userAgent,
      playbackCapabilities: getPlatformCapabilities(),
      requestCounters: {
        cacheHits: requests.cacheHits,
        cacheMisses: requests.cacheMisses,
        networkCalls: requests.networkCalls,
        deduplicated: requests.deduplicated,
        cancelled: requests.cancelled,
        queued: requests.queued,
        active: requests.active,
        rateLimited: requests.rateLimited,
      },
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setCopyMessage('Browser diagnostics copied. No stream URL or provider credentials were included.')
    } catch {
      setCopyMessage('Clipboard access is unavailable. Allow clipboard access or copy the visible browser details manually.')
    }
  }

  const counters = [
    ['Cache hits', requests.cacheHits],
    ['Cache misses', requests.cacheMisses],
    ['Network calls', requests.networkCalls],
    ['Deduplicated', requests.deduplicated],
    ['Cancelled', requests.cancelled],
    ['Queued', requests.queued],
    ['Active', requests.active],
    ['HTTP 429', requests.rateLimited],
  ] as const

  return (
    <main className="min-h-screen flex-1 overflow-y-auto bg-[#0a0a0c] px-4 py-6 text-white sm:px-8 sm:py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-accent">Aurales · Browser</p>
            <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-3xl">Browser diagnostics</h1>
            <p className="mt-2 max-w-2xl text-sm text-white/60">Check browser playback support, try a local video, and inspect privacy-safe request counters.</p>
          </div>
          <button type="button" onClick={() => void copyReport()} className="min-h-11 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-black hover:bg-accent-hover">
            Copy browser report
          </button>
        </header>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-6" aria-labelledby="local-video-heading">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 id="local-video-heading" className="text-lg font-bold">Test local video</h2>
              <p className="mt-1 text-sm text-white/55">The selected file stays in this browser tab and is played by Aurales’ shared HTML video player.</p>
            </div>
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2 text-sm font-semibold hover:bg-white/10">
              Choose video
              <input className="sr-only" type="file" accept="video/*" onChange={(event) => openFile(event.currentTarget.files?.[0])} />
            </label>
          </div>
          {video && <p className="mt-3 truncate text-xs text-white/55">Selected: {video.name}</p>}
        </section>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-6" aria-labelledby="capabilities-heading">
          <h2 id="capabilities-heading" className="text-lg font-bold">Playback capabilities</h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ['Platform', 'Browser'],
              ['Native HLS', getPlatformCapabilities(document.createElement('video')).nativeHls ? 'Available' : 'Unavailable'],
              ['Media Source Extensions', getPlatformCapabilities().mediaSource ? 'Available' : 'Unavailable'],
              ['Picture in Picture', getPlatformCapabilities(document.createElement('video')).pictureInPicture ? 'Available' : 'Unavailable'],
              ['AirPlay picker', getPlatformCapabilities(document.createElement('video')).airPlay ? 'Available' : 'Unavailable'],
              ['Service worker', getPlatformCapabilities().serviceWorker ? 'Available' : 'Unavailable'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <dt className="text-[10px] font-bold uppercase tracking-wider text-white/45">{label}</dt>
                <dd className="mt-1 text-sm font-semibold text-white/85">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-white/45">Codec, HDR, Dolby Vision, subtitles, casting and media-provider support vary by browser, operating system and source. Aurales reports browser APIs here; they do not guarantee a particular stream will play.</p>
        </section>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-6" aria-labelledby="requests-heading">
          <h2 id="requests-heading" className="text-lg font-bold">Request traffic</h2>
          <p className="mt-1 text-sm text-white/55">Counters contain no URLs, search terms, headers or credentials.</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {counters.map(([label, value]) => (
              <div key={label} className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <dt className="text-[10px] font-bold uppercase tracking-wider text-white/45">{label}</dt>
                <dd className="mt-1 text-xl font-black">{value}</dd>
              </div>
            ))}
          </dl>
          {copyMessage && <p role="status" className="mt-4 text-xs text-white/60">{copyMessage}</p>}
        </section>
      </div>

      {video && <InAppPlayer
        key={video.url}
        url={video.url}
        title={video.name}
        onClose={() => setVideo(null)}
        onPickAnother={() => setVideo(null)}
      />}
    </main>
  )
}
