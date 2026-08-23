import { useMemo, useState } from 'react'
import { detectAudioFormats, isEncodedAudioOutput, type NativePlayerDebugSnapshot } from '../services/playerDebug'

interface PlayerDebugPanelProps {
  snapshot: NativePlayerDebugSnapshot | null
  sourceHint: string
  passthroughConfigured: boolean
  loading: boolean
  error?: string
  onRefresh: () => void
  onUseDecodedAudio?: () => void
  onClose: () => void
}

function valueText(value: unknown): string {
  if (value == null || value === '') return 'Unavailable'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function DebugRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 border-b border-white/6 py-2 last:border-0">
      <dt className="text-meta font-bold uppercase tracking-wider text-white/60">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-label text-white/75">{valueText(value)}</dd>
    </div>
  )
}

export default function PlayerDebugPanel({ snapshot, sourceHint, passthroughConfigured, loading, error, onRefresh, onUseDecodedAudio, onClose }: PlayerDebugPanelProps) {
  const [copied, setCopied] = useState(false)
  const formats = useMemo(() => snapshot ? detectAudioFormats(snapshot, sourceHint) : [], [snapshot, sourceHint])
  const selectedAudio = snapshot?.tracks.find((track) => track.type === 'audio' && track.selected)
  const selectedVideo = snapshot?.tracks.find((track) => track.type === 'video' && track.selected)
  const encodedOutput = snapshot ? isEncodedAudioOutput(snapshot) : false

  const copySnapshot = async () => {
    if (!snapshot) return
    await navigator.clipboard.writeText(JSON.stringify({ ...snapshot, formats, passthroughConfigured, encodedOutput }, null, 2))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="absolute bottom-full left-0 z-[80] mb-4 flex max-h-[min(70vh,46rem)] w-[min(48rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-amber-400/25 bg-[#0d0d0d] text-left shadow-[0_24px_80px_rgba(0,0,0,0.75)]" data-player-popover>
      <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-amber-400 px-1.5 py-0.5 text-tag font-black tracking-wider text-black">DEV</span>
            <h3 className="text-sm font-bold text-white">Player format diagnostics</h3>
          </div>
          <p className="mt-1 text-label text-white/60">Live mpv values. “Detected” means the active stream signals that format.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={copySnapshot} disabled={!snapshot} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-meta font-semibold text-white/60 hover:bg-white/8 hover:text-white disabled:opacity-30">{copied ? 'Copied' : 'Copy JSON'}</button>
          <button type="button" onClick={onRefresh} disabled={loading} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-meta font-semibold text-white/60 hover:bg-white/8 hover:text-white disabled:opacity-30">{loading ? 'Reading…' : 'Refresh'}</button>
          <button type="button" onClick={onClose} aria-label="Close player diagnostics" className="grid h-7 w-7 place-items-center rounded-full text-lg text-white/60 hover:bg-white/10 hover:text-white">×</button>
        </div>
      </div>

      <div className="overflow-y-auto p-5">
        {error && <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        {passthroughConfigured && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2.5">
            <p className="text-xs leading-5 text-amber-100/80">No sound? Your receiver may not support this stream's bitstream. Switch to decoded audio for this device.</p>
            <button type="button" onClick={onUseDecodedAudio} className="shrink-0 rounded-lg bg-amber-300 px-3 py-1.5 text-label font-bold text-black transition-colors hover:bg-amber-200">Use decoded audio</button>
          </div>
        )}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-meta font-bold uppercase tracking-[0.18em] text-white/60">Audio formats</h4>
            <span className={`rounded-full px-2 py-1 text-tag font-bold ${encodedOutput ? 'bg-emerald-400/15 text-emerald-300' : passthroughConfigured ? 'bg-amber-400/15 text-amber-300' : 'bg-white/7 text-white/60'}`}>
              Passthrough: {encodedOutput ? 'active' : passthroughConfigured ? 'enabled, decoded output' : 'off'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {formats.map((format) => (
              <div key={format.id} title={format.detail} className={`rounded-xl border px-3 py-2 ${format.state === 'detected' ? 'border-emerald-400/25 bg-emerald-400/10' : format.state === 'carrier' ? 'border-amber-400/20 bg-amber-400/8' : 'border-white/7 bg-white/[0.025]'}`}>
                <p className={`text-label font-semibold ${format.state === 'detected' ? 'text-emerald-200' : format.state === 'carrier' ? 'text-amber-200' : 'text-white/60'}`}>{format.label}</p>
                <p className="mt-0.5 text-tag uppercase tracking-wider text-white/50">{format.state === 'detected' ? 'Detected' : format.state === 'carrier' ? 'Carrier only' : 'Not detected'}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-5 grid gap-x-6 md:grid-cols-2">
          <dl>
            <h4 className="mb-1 text-meta font-bold uppercase tracking-[0.18em] text-white/60">Audio path</h4>
            <DebugRow label="Codec" value={snapshot?.audioCodecName || snapshot?.audioCodec || selectedAudio?.codec} />
            <DebugRow label="Track" value={selectedAudio?.title || selectedAudio?.lang || selectedAudio?.id} />
            <DebugRow label="Input params" value={snapshot?.audioParams} />
            <DebugRow label="Output params" value={snapshot?.audioOutParams} />
            <DebugRow label="Audio output" value={snapshot?.audioOutput} />
            <DebugRow label="Device" value={snapshot?.audioDevice} />
          </dl>
          <dl className="mt-5 md:mt-0">
            <h4 className="mb-1 text-meta font-bold uppercase tracking-[0.18em] text-white/60">Video path</h4>
            <DebugRow label="Codec" value={snapshot?.videoCodec || selectedVideo?.codec} />
            <DebugRow label="Pixel format" value={snapshot?.videoFormat} />
            <DebugRow label="Video params" value={snapshot?.videoParams} />
            <DebugRow label="Hardware decoder" value={snapshot?.hardwareDecoder || 'Software / unavailable'} />
            <DebugRow label="FPS" value={snapshot?.estimatedFps} />
            <DebugRow label="Display FPS" value={snapshot?.displayFps} />
            <DebugRow label="Container" value={snapshot?.fileFormat} />
          </dl>
        </div>
        {snapshot && <p className="mt-4 text-right font-mono text-tag text-white/25">Updated {new Date(snapshot.capturedAt).toLocaleTimeString()}</p>}
      </div>
    </div>
  )
}
