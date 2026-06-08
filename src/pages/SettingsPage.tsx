import { useState } from 'react'
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

  const handleTraktConnect = async () => {
    try {
      const code = await getDeviceCode()
      setTraktCode(code)
      setTraktPolling(true)

      const interval = setInterval(async () => {
        const tokens = await pollForToken(code.deviceCode)
        if (tokens) {
          clearInterval(interval)
          setTraktPolling(false)
          setTraktCode(null)
          store.setTraktConnected(true)
        }
      }, (code.interval || 5) * 1000)

      setTimeout(() => {
        clearInterval(interval)
        setTraktPolling(false)
      }, code.expiresIn * 1000)
    } catch (e) {
      console.error('Trakt connect error:', e)
    }
  }

  const handleTraktDisconnect = () => {
    clearTokens()
    store.setTraktConnected(false)
    setTraktCode(null)
    setTraktPolling(false)
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

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-accent" />
          Trakt
        </h2>
        <div className="bg-surface-elevated rounded-2xl p-5 space-y-4">
          {store.traktConnected || isAuthenticated() ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-accent" />
                <span className="text-sm">Connected to Trakt</span>
              </div>
              <button
                onClick={handleTraktDisconnect}
                className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-sm transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="text-xs text-muted mb-1 block">Client ID</label>
                  <input
                    type="text"
                    value={store.traktClientId}
                    onChange={(e) => store.setTraktClientId(e.target.value)}
                    placeholder="Trakt Client ID"
                    className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Client Secret</label>
                  <input
                    type="password"
                    value={store.traktClientSecret}
                    onChange={(e) => store.setTraktClientSecret(e.target.value)}
                    placeholder="Trakt Client Secret"
                    className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-xl text-sm focus:outline-none focus:border-accent/50"
                  />
                </div>
              </div>
              <button
                onClick={handleTraktConnect}
                disabled={!store.traktClientId || traktPolling}
                className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-medium rounded-xl text-sm transition-colors"
              >
                {traktPolling ? 'Waiting for authorization...' : 'Connect with Trakt'}
              </button>
              {traktCode && (
                <div className="mt-3 p-3 bg-surface rounded-xl">
                  <p className="text-sm text-muted mb-1">Go to: <a href={traktCode.verificationUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">{traktCode.verificationUrl}</a></p>
                  <p className="text-sm">Enter code: <span className="font-mono text-accent text-lg font-bold">{traktCode.userCode}</span></p>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

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
                  <div>
                    <div className="text-sm font-medium">{addon.manifest.name}</div>
                    <div className="text-xs text-muted">{addon.manifest.description || addon.url}</div>
                  </div>
                  <button
                    onClick={() => store.removeAddon(addon.manifest.id)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

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
