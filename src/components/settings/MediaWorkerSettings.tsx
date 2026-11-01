import { useEffect, useState } from 'react'
import { connectIntegratedMediaWorker, disconnectIntegratedMediaWorker, getMediaWorkerCapabilities, getMediaWorkerConfig, isIntegratedMediaWorkerBuild, isIntegratedMediaWorkerConnected, saveMediaWorkerConfig } from '../../services/mediaWorker'

export default function MediaWorkerSettings() {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [integratedConnected, setIntegratedConnected] = useState(false)
  const [status, setStatus] = useState('Optional. Browser stream ranking stays local when no worker is configured.')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setIntegratedConnected(isIntegratedMediaWorkerConnected())
    const config = getMediaWorkerConfig()
    if (!config) return
    setBaseUrl(config.baseUrl)
    setApiKey(config.apiKey)
  }, [])

  const describeCapabilities = (capabilities: Awaited<ReturnType<typeof getMediaWorkerCapabilities>>) => {
    const unsupported = [
      capabilities.mediaRemux && 'remux',
      capabilities.audioTranscode && 'audio transcoding',
      capabilities.videoTranscode && 'video transcoding',
    ].filter(Boolean)
    return capabilities.streamRanking
      ? `Connected. Shared Rust stream ranking is enabled.${capabilities.mediaDirectProxy ? ' Allowlisted stream probing and direct-media/HLS proxying are available.' : ' Stream probing and media proxying are not configured on this worker.'}${capabilities.pmdbProxy ? ' PMDB browser requests can use this worker.' : ''}${capabilities.mdblistProxy ? ' MDBList browser account and OAuth requests can use this worker.' : ''}${capabilities.traktProxy ? ' Trakt browser account and sync requests can use this worker.' : ''}${capabilities.torboxProxy ? ' TorBox device login and account requests can use this worker.' : ''}${capabilities.auralesSyncProxy ? ' Aurales Sync sign-in and data transfer can use this worker for self-hosted browser origins.' : ''}${unsupported.length ? ` Available media conversion: ${unsupported.join(', ')}.` : ' Remux and transcoding are unavailable.'}`
      : 'Worker responded but does not provide stream ranking.'
  }

  const connectIntegrated = async () => {
    setChecking(true)
    setStatus('Unlocking Aurales media service…')
    try {
      await connectIntegratedMediaWorker(accessCode)
      setIntegratedConnected(true)
      setAccessCode('')
      setStatus(describeCapabilities(await getMediaWorkerCapabilities()))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not connect to the integrated worker.')
    } finally {
      setChecking(false)
    }
  }

  const testConnection = async () => {
    setChecking(true)
    setStatus('Checking worker…')
    try {
      saveMediaWorkerConfig({ baseUrl, apiKey })
      const capabilities = await getMediaWorkerCapabilities()
      setStatus(describeCapabilities(capabilities))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not connect to the worker.')
    } finally {
      setChecking(false)
    }
  }

  const disconnect = async () => {
    if (isIntegratedMediaWorkerBuild()) {
      await disconnectIntegratedMediaWorker()
      setIntegratedConnected(false)
      setStatus('Disconnected. Browser playback and stream ranking use local/browser capabilities.')
      return
    }
    saveMediaWorkerConfig(null)
    setBaseUrl('')
    setApiKey('')
    setStatus('Disconnected. Browser stream ranking uses the local scorer; provider and Aurales Sync requests use direct browser HTTPS and depend on provider CORS.')
  }

  return (
    <section className="space-y-3" aria-labelledby="media-worker-title">
      <div>
        <h3 id="media-worker-title" className="px-1 text-sm font-semibold text-white/65">{isIntegratedMediaWorkerBuild() ? 'Aurales media service' : 'Optional self-hosted media worker'}</h3>
        <p className="px-1 mt-1 text-xs text-white/45">{isIntegratedMediaWorkerBuild() ? 'The built-in media service can rank and range-probe allowlisted streams, proxy configured HTTPS hostnames when browser playback fails, rewrite HLS playlists, relay provider requests and Aurales Sync calls to fixed API origins, and convert browser-incompatible media.' : 'The optional worker can rank and range-probe allowlisted streams, proxy configured HTTPS hostnames when browser playback fails, rewrite HLS playlists, relay provider requests and Aurales Sync calls to fixed API origins, and optionally convert browser-incompatible media when FFmpeg is enabled on the worker.'} If a browser rejects a direct-play source, Aurales automatically tries a stream-copy remux, then AAC audio with the original video, then H.264/AAC when available. The original file is not changed.</p>
      </div>
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5 space-y-3">
        {isIntegratedMediaWorkerBuild() ? (
          <>
            {!integratedConnected && <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-white/70">Instance access code</span>
              <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} type="password" autoComplete="current-password" className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-accent/50" />
              <span className="block text-[11px] text-white/40">Enter the code provided by the Aurales instance owner once on this device. Aurales keeps only a server-authenticated, HttpOnly session cookie; the worker API key is never sent to the browser.</span>
            </label>}
          </>
        ) : (
          <>
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-white/70">Worker HTTPS URL</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} type="url" inputMode="url" placeholder="https://media.example.com" autoComplete="url" className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-accent/50" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-white/70">Private worker API key</span>
              <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="new-password" className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-accent/50" />
              <span className="block text-[11px] text-white/40">Saved only on this device; excluded from Aurales Sync and profile exports. Use a worker you trust: provider keys/tokens and TorBox credentials are forwarded only to fixed provider APIs. If you use this worker for Aurales Sync, your Sync password, access token, and sync records also transit it and are forwarded only to sync.febsho.me.</span>
            </label>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {isIntegratedMediaWorkerBuild()
            ? !integratedConnected && <button type="button" onClick={() => void connectIntegrated()} disabled={checking || accessCode.length < 16} className="min-h-11 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">{checking ? 'Unlocking…' : 'Unlock service'}</button>
            : <button type="button" onClick={() => void testConnection()} disabled={checking} className="min-h-11 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">{checking ? 'Checking…' : 'Save and test'}</button>}
          {(getMediaWorkerConfig() || integratedConnected) && <button type="button" onClick={() => void disconnect()} className="min-h-11 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-white/75">Disconnect</button>}
        </div>
        <p role="status" className="text-xs text-white/55">{status}</p>
      </div>
    </section>
  )
}
