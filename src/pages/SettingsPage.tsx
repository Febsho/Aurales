import { useState, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { getDeviceCode, pollForToken, clearTokens, isAuthenticated } from '../services/trakt/auth'
import { loadAddonManifest, installAddon } from '../services/addons'
import type { TraktDeviceCode } from '../types'

export default function SettingsPage() {
  const store = useAppStore()
  const [addonUrl, setAddonUrl] = useState('')
  const [addonLoading, setAddonLoading] = useState(false)
  const [addonError, setAddonError] = useState('')
  const [traktCode, setTraktCode] = useState<TraktDeviceCode | null>(null)
  const [traktPolling, setTraktPolling] = useState(false)
  const [traktError, setTraktError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleTraktConnect = async () => {
    if (!store.traktClientId) {
      setTraktError('Enter your Trakt Client ID first (create an app at trakt.tv/oauth/applications)')
      return
    }
    setTraktError('')
    try {
      const code = await getDeviceCode()
      setTraktCode(code)
      setTraktPolling(true)

      pollRef.current = setInterval(async () => {
        try {
          const tokens = await pollForToken(code.deviceCode)
          if (tokens) {
            if (pollRef.current) clearInterval(pollRef.current)
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            setTraktPolling(false)
            setTraktCode(null)
            store.setTraktConnected(true)
          }
        } catch {
          // polling error, keep trying
        }
      }, (code.interval || 5) * 1000)

      timeoutRef.current = setTimeout(() => {
        if (pollRef.current) clearInterval(pollRef.current)
        setTraktPolling(false)
        setTraktError('Authorization timed out. Try again.')
      }, code.expiresIn * 1000)
    } catch (e) {
      setTraktError(`Failed to start auth: ${e}`)
    }
  }

  const handleTraktDisconnect = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    clearTokens()
    store.setTraktConnected(false)
    setTraktCode(null)
    setTraktPolling(false)
    setTraktError('')
  }

  const handleAddAddon = async () => {
    if (!addonUrl.trim()) return
    setAddonLoading(true)
    setAddonError('')
    try {
      const manifest = await loadAddonManifest(addonUrl)
      installAddon(manifest, addonUrl)
      store.addAddon({ manifest, url: addonUrl, enabled: true })
      setAddonUrl('')
    } catch (e) {
      setAddonError(`Failed to load addon: ${e}`)
    } finally {
      setAddonLoading(false)
    }
  }

  const isConnected = store.traktConnected || isAuthenticated()

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {/* Trakt */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-accent" />
          Trakt
        </h2>
        <div className="bg-surface-elevated rounded-2xl p-5 space-y-4">
          {isConnected ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-accent" />
                <span className="text-sm font-medium">Connected to Trakt</span>
              </div>
              <button
                onClick={handleTraktDisconnect}
                className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-sm transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-muted mb-1 block">Client ID</label>
                <input
                  type="text"
                  value={store.traktClientId}
                  onChange={(e) => store.setTraktClientId(e.target.value)}
                  placeholder="Paste your Trakt app Client ID"
                  className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
                />
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Client Secret</label>
                <input
                  type="password"
                  value={store.traktClientSecret}
                  onChange={(e) => store.setTraktClientSecret(e.target.value)}
                  placeholder="Paste your Trakt app Client Secret"
                  className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
                />
                <p className="text-xs text-muted mt-1">Create an app at trakt.tv/oauth/applications to get these</p>
              </div>

              {!traktCode ? (
                <button
                  onClick={handleTraktConnect}
                  disabled={!store.traktClientId || traktPolling}
                  className="px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-colors"
                >
                  Authorize with PIN
                </button>
              ) : (
                <div className="p-4 bg-surface rounded-xl border border-border-subtle">
                  <p className="text-sm text-muted mb-3">
                    1. Go to{' '}
                    <a
                      href={traktCode.verificationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline font-medium"
                    >
                      {traktCode.verificationUrl}
                    </a>
                  </p>
                  <p className="text-sm text-muted mb-4">2. Enter this PIN code:</p>
                  <div className="flex items-center gap-3 mb-4">
                    <span className="font-mono text-3xl font-bold text-accent tracking-widest select-all">
                      {traktCode.userCode}
                    </span>
                    <button
                      onClick={() => navigator.clipboard.writeText(traktCode.userCode)}
                      className="px-2 py-1 text-xs bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                  {traktPolling && (
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-muted">Waiting for you to authorize...</span>
                    </div>
                  )}
                </div>
              )}
              {traktError && <p className="text-xs text-red-400">{traktError}</p>}
            </div>
          )}
        </div>
      </section>

      {/* Metadata Providers */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-blue-400" />
          Metadata Providers
        </h2>
        <div className="bg-surface-elevated rounded-2xl p-5 space-y-4">
          <div>
            <label className="text-xs text-muted mb-1 block">TMDB API Key</label>
            <input
              type="text"
              value={store.tmdbApiKey}
              onChange={(e) => store.setTmdbApiKey(e.target.value)}
              placeholder="Enter your TMDB API key"
              className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
            />
            <p className="text-xs text-muted mt-1">Get one at themoviedb.org/settings/api</p>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">TVDB API Key</label>
            <input
              type="text"
              value={store.tvdbApiKey}
              onChange={(e) => store.setTvdbApiKey(e.target.value)}
              placeholder="Enter your TVDB API key"
              className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
            />
            <p className="text-xs text-muted mt-1">Get one at thetvdb.com/api-information</p>
          </div>
        </div>
      </section>

      {/* Addons */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-purple-400" />
          Addons
        </h2>
        <div className="bg-surface-elevated rounded-2xl p-5 space-y-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={addonUrl}
              onChange={(e) => setAddonUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddAddon()}
              placeholder="https://addon-url.com/manifest.json"
              className="flex-1 px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
            />
            <button
              onClick={handleAddAddon}
              disabled={addonLoading}
              className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-medium rounded-xl text-sm transition-colors"
            >
              {addonLoading ? 'Loading...' : 'Add'}
            </button>
          </div>
          {addonError && <p className="text-xs text-red-400">{addonError}</p>}

          {store.addons.length > 0 && (
            <div className="space-y-2 mt-3">
              {store.addons.map((addon) => (
                <div key={addon.manifest.id} className="flex items-center justify-between p-3 bg-surface rounded-xl">
                  <div className="flex items-center gap-3 min-w-0">
                    {addon.manifest.logo && (
                      <img src={addon.manifest.logo} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{addon.manifest.name}</div>
                      <div className="text-xs text-muted truncate">{addon.manifest.description || addon.url}</div>
                      {addon.manifest.catalogs.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {addon.manifest.catalogs.map((cat) => (
                            <span key={cat.id} className="px-1.5 py-0.5 bg-white/5 rounded text-[10px] text-muted">
                              {cat.name || cat.id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => store.removeAddon(addon.manifest.id)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors flex-shrink-0 ml-3"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Player */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-orange-400" />
          Player
        </h2>
        <div className="bg-surface-elevated rounded-2xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-accent" />
            <p className="text-sm">mpv is bundled with Orynt and ready to use.</p>
          </div>
        </div>
      </section>

      {/* Cache */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-gray-400" />
          Cache
        </h2>
        <div className="bg-surface-elevated rounded-2xl p-5">
          <button
            onClick={() => {
              localStorage.clear()
              window.location.reload()
            }}
            className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-sm transition-colors"
          >
            Clear All Cache & Settings
          </button>
        </div>
      </section>
    </div>
  )
}
