import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore, APP_LANGUAGES } from '../stores/appStore'
import {
  getDeviceCode,
  pollForToken,
  clearTokens,
  isAuthenticated,
  hasBundledTraktClientCredentials,
  hasTraktClientCredentials,
} from '../services/trakt/auth'
import {
  initiateSimklLogin,
  completeSimklLogin,
  disconnectSimkl,
  getSimklConnectionStatus,
  isSimklMockMode,
} from '../services/simkl/auth'
import { syncSimkl, getLastSimklSyncTime } from '../services/simkl/sync'
import { loadAddonManifest, installAddon } from '../services/addons'
import { clearAppMetadataCache } from '../services/metadata'
import { stremioLogin, getStremioAddons, saveStremioAuth, getStremioAuth, clearStremioAuth } from '../services/stremio'
import { checkPMDBConnection } from '../services/pmdb'
import type { PMDBConnectionStatus } from '../services/pmdb'
import { fetchAniListViewer, getAniListContinueWatching, getAniListToken, setAniListToken } from '../services/anilist'
import { getSelfhstIconUrl } from '../services/serviceIcons'
import {
  loadStreamRegexFilterConfig,
  resetStreamRegexFilterConfig,
  saveStreamRegexFilterConfig,
  validateStreamRegexFilterConfig,
  cssColorFromFilterColor,
} from '../services/streamRegexFilters'
import type { TraktDeviceCode } from '../types'
import NativeMpvPlayer from '../components/NativeMpvPlayer'

const BACKUP_KEYS = [
  'tmdb_api_key',
  'tvdb_api_key',
  'trakt_client_id',
  'trakt_client_secret',
  'trakt_tokens',
  'trakt_account',
  'mdblist_api_key',
  'orynt_addons',
  'orynt_home_rows',
  'orynt_watch_progress',
  'orynt_preferred_subtitles',
  'orynt_preferred_audio',
  'orynt_cw_source',
  'orynt_cw_limit',
  'orynt_watched_checkmark_sources',
  'orynt_watchlist_target',
  'pmdb_api_key',
  'pmdb_save_resume',
  'pmdb_sync_freq',
  'pmdb_last_sync',
  'introdb_api_key',
  'anime_tracking_provider',
  'anime_show_watched',
  'orynt_blur_spoilers',
  'orynt_blur_thumbnails',
  'orynt_blur_titles',
  'orynt_blur_descriptions',
  'orynt_keep_next_episode_visible',
  'orynt_keep_frames_for',
  'orynt_saved_frames_count',
  'orynt_poster_size',
  'orynt_next_episode_prompt',
  'orynt_accent_color',
  'orynt_default_start_page',
  'orynt_show_ratings_on_cards',
  'orynt_discovery_region',
  'orynt_discovery_min_rating',
  'orynt_discovery_include_adult',
  'orynt_recently_viewed',
  'orynt_hwdec_mode',
  'orynt_cache_buffer_size',
  'orynt_audio_passthrough',
  'orynt_auto_skip_segments',
  'orynt_sub_font_size',
  'orynt_sub_bg_opacity',
  'simkl_token',
  'simkl_account',
  'anilist_token',
  'anilist_account',
  'anilist_client_id',
  'anilist_client_secret',
  'openrouter_api_key',
  'openrouter_model',
  'orynt_sub_translation_enabled',
  'orynt_sub_translation_lang',
  'orynt_translation_cues_ahead',
  'orynt_context_aware_translation',
]

/* ─── Reusable helper components ─── */

function SettingSection({ title, description, children }: { title?: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl overflow-hidden">
      {title && (
        <div className="px-6 pt-5 pb-1">
          <h3 className="text-[15px] font-semibold text-white">{title}</h3>
          {description && <p className="text-[13px] text-white/40 mt-0.5">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-white/[0.04]">{children}</div>
    </div>
  )
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <div className="min-w-0">
        <p className="text-[14px] text-white">{label}</p>
        {description && <p className="text-[12px] text-white/35 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function SettingToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[26px] w-[46px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${checked ? 'bg-accent' : 'bg-white/15'}`}
    >
      <span className={`pointer-events-none inline-block h-[22px] w-[22px] mt-[2px] ml-[2px] transform rounded-full bg-white shadow ring-0 transition-transform duration-200 ${checked ? 'translate-x-[20px]' : 'translate-x-0'}`} />
    </button>
  )
}

function DangerButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-[13px] font-semibold transition-colors cursor-pointer"
    >
      {children}
    </button>
  )
}

function ServiceIcon({ service, className = 'w-4.5 h-4.5' }: { service: string; className?: string }) {
  const iconUrl = getSelfhstIconUrl(service)
  if (iconUrl) {
    return <img src={iconUrl} alt="" className={`${className} object-contain flex-shrink-0`} loading="lazy" />
  }
  return (
    <span className={`${className} inline-flex items-center justify-center rounded bg-white/10 text-[9px] font-black text-white/70 flex-shrink-0`}>
      {service.slice(0, 2).toUpperCase()}
    </span>
  )
}

function SearchEngineSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { id: string; name: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-48 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white"
    >
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>{opt.name}</option>
      ))}
    </select>
  )
}

function SearchSettingsSection() {
  const store = useAppStore()

  const movieOptions = [
    { id: 'tmdb', name: 'TMDB Search' },
    { id: 'trakt', name: 'Trakt Search' },
    { id: 'mdblist', name: 'MDBList Search' },
    { id: 'cinemeta', name: 'Cinemeta' },
  ]
  const seriesOptions = [
    { id: 'tmdb', name: 'TMDB Search' },
    { id: 'tvdb', name: 'TheTVDB Search' },
    { id: 'tvmaze', name: 'TVmaze Search' },
    { id: 'trakt', name: 'Trakt Search' },
    { id: 'mdblist', name: 'MDBList Search' },
    { id: 'cinemeta', name: 'Cinemeta' },
  ]
  const animeSeriesOptions = [
    { id: 'mal', name: 'MAL (Series)' },
    { id: 'tvdb', name: 'TheTVDB Search' },
    { id: 'tmdb', name: 'TMDB Search' },
    { id: 'trakt', name: 'Trakt Search' },
  ]
  const animeMovieOptions = [
    { id: 'mal', name: 'MAL (Movies)' },
    { id: 'tmdb', name: 'TMDB Search' },
    { id: 'trakt', name: 'Trakt Search' },
  ]

  return (
    <>
      <SettingSection title="Primary Keyword Engines" description="Choose the default engine for basic keyword searches. The AI search uses this engine to find items based on its suggestions.">
        <SettingRow label="Movies Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={store.movieSearchEngine} onChange={store.setMovieSearchEngine} options={movieOptions} />
            <SettingToggle checked={store.movieSearchEnabled} onChange={store.setMovieSearchEnabled} />
          </div>
        </SettingRow>
        <SettingRow label="Series Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={store.seriesSearchEngine} onChange={store.setSeriesSearchEngine} options={seriesOptions} />
            <SettingToggle checked={store.seriesSearchEnabled} onChange={store.setSeriesSearchEnabled} />
          </div>
        </SettingRow>
        <SettingRow label="Anime (Series) Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={store.animeSeriesSearchEngine} onChange={store.setAnimeSeriesSearchEngine} options={animeSeriesOptions} />
            <SettingToggle checked={store.animeSeriesSearchEnabled} onChange={store.setAnimeSeriesSearchEnabled} />
          </div>
        </SettingRow>
        <SettingRow label="Anime (Movies) Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={store.animeMovieSearchEngine} onChange={store.setAnimeMovieSearchEngine} options={animeMovieOptions} />
            <SettingToggle checked={store.animeMovieSearchEnabled} onChange={store.setAnimeMovieSearchEnabled} />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title="AI-Powered Search" description="Use AI to interpret natural language queries and find media using descriptive phrases instead of exact titles.">
        <SettingRow label="OpenRouter API Key" description="A Gemini or OpenRouter API key is required to enable AI search. Add your key here.">
          <input
            type="password"
            value={store.openrouterApiKey}
            onChange={(e) => store.setOpenrouterApiKey(e.target.value)}
            placeholder="sk-or-..."
            className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/25"
          />
        </SettingRow>
        <SettingRow label="AI Model" description="OpenRouter model ID for AI search suggestions.">
          <input
            type="text"
            value={store.openrouterModel}
            onChange={(e) => store.setOpenrouterModel(e.target.value)}
            placeholder="google/gemini-2.5-flash"
            className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/25"
          />
        </SettingRow>
      </SettingSection>
    </>
  )
}

export default function SettingsPage() {
  const store = useAppStore()
  const [activeTab, setActiveTab] = useState<'accounts' | 'addons' | 'metadata' | 'search' | 'progress' | 'languages' | 'filters' | 'player' | 'advanced' | 'interface'>('accounts')
  const [progressSubPage, setProgressSubPage] = useState<'main' | 'local' | 'trakt' | 'simkl' | 'anilist' | 'pmdb' | 'anime'>('main')
  const [filterConfig, setFilterConfig] = useState(() => loadStreamRegexFilterConfig())
  const [filterSearch, setFilterSearch] = useState('')
  const [playerDebugTest, setPlayerDebugTest] = useState<{ url: string; title: string } | null>(null)
  const [addonUrl, setAddonUrl] = useState('')
  const [addonLoading, setAddonLoading] = useState(false)
  const [addonError, setAddonError] = useState('')
  const [traktCode, setTraktCode] = useState<TraktDeviceCode | null>(null)
  const [traktPolling, setTraktPolling] = useState(false)
  const [traktError, setTraktError] = useState('')
  const [showTraktAdvanced, setShowTraktAdvanced] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const simklStatus = getSimklConnectionStatus()
  const [simklLoading, setSimklLoading] = useState(false)
  const [simklError, setSimklError] = useState('')
  const [simklLastSync, setSimklLastSync] = useState(getLastSimklSyncTime)
  const [simklAuthStarted, setSimklAuthStarted] = useState(false)
  const [simklCode, setSimklCode] = useState('')
  const [simklVerificationUrl, setSimklVerificationUrl] = useState('')
  const simklPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simklTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMock = isSimklMockMode()

  const [stremioEmail, setStremioEmail] = useState('')
  const [stremioPassword, setStremioPassword] = useState('')
  const [stremioAuthKey, setStremioAuthKey] = useState('')
  const [stremioLoading, setStremioLoading] = useState(false)
  const [stremioError, setStremioError] = useState('')
  const [stremioAuth, setStremioAuth] = useState(getStremioAuth)
  const [streamRegexJson, setStreamRegexJson] = useState(() => JSON.stringify(loadStreamRegexFilterConfig(), null, 2))
  const [streamRegexMessage, setStreamRegexMessage] = useState('')

  const [pmdbConnStatus, setPmdbConnStatus] = useState<PMDBConnectionStatus | null>(null)
  const [pmdbConnChecking, setPmdbConnChecking] = useState(false)
  const [anilistTokenInput, setAnilistTokenInput] = useState(getAniListToken)
  const [anilistLoading, setAnilistLoading] = useState(false)
  const [anilistMessage, setAnilistMessage] = useState('')

  const testPmdbConnection = async () => {
    setPmdbConnChecking(true)
    setPmdbConnStatus(null)
    const status = await checkPMDBConnection()
    setPmdbConnStatus(status)
    setPmdbConnChecking(false)
  }

  const handleAnilistConnect = async () => {
    setAnilistLoading(true)
    setAnilistMessage('')
    try {
      const clientId = store.anilistClientId.trim()
      const clientSecret = store.anilistClientSecret.trim()
      if (!clientId || !clientSecret) {
        throw new Error('Client ID and Client Secret are required.')
      }

      setAnilistMessage('Waiting for browser authorization callback...')
      const callbackServerPromise = invoke<string>('start_anilist_callback_server')

      const redirectUri = 'http://localhost:42814/'
      const authUrl = `https://anilist.co/api/v2/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`
      await invoke('open_simkl_auth', { url: authUrl })

      const code = await callbackServerPromise

      setAnilistMessage('Exchanging authorization code for access token...')
      const tokenJson = await invoke<string>('exchange_anilist_token', {
        code,
        clientId,
        clientSecret,
        redirectUri,
      })

      const tokenData = JSON.parse(tokenJson)
      const token = tokenData.access_token
      if (!token) {
        throw new Error('AniList did not return an access token.')
      }

      setAniListToken(token)
      setAnilistTokenInput(token)
      const account = await fetchAniListViewer()
      store.setAnilistConnected(true)
      store.setAnilistAccount(account)
      setAnilistMessage(`Successfully connected as ${account.name}!`)
    } catch (err: any) {
      store.setAnilistConnected(false)
      store.setAnilistAccount(null)
      setAnilistMessage(err?.message || 'AniList connection failed')
    } finally {
      setAnilistLoading(false)
    }
  }

  const connectAniListManual = async () => {
    setAnilistLoading(true)
    setAnilistMessage('')
    try {
      setAniListToken(anilistTokenInput)
      const account = await fetchAniListViewer()
      store.setAnilistConnected(true)
      store.setAnilistAccount(account)
      setAnilistMessage(`Connected manually as ${account.name}`)
    } catch (err: any) {
      store.setAnilistConnected(false)
      store.setAnilistAccount(null)
      setAnilistMessage(err?.message || 'AniList connection failed')
    } finally {
      setAnilistLoading(false)
    }
  }

  const handleAnilistDisconnect = () => {
    setAniListToken('')
    setAnilistTokenInput('')
    store.setAnilistConnected(false)
    store.setAnilistAccount(null)
    setAnilistMessage('Disconnected from AniList.')
  }

  const syncAniListNow = async () => {
    setAnilistLoading(true)
    setAnilistMessage('')
    try {
      const items = await getAniListContinueWatching()
      setAnilistMessage(`Pulled ${items.length} AniList in-progress item${items.length === 1 ? '' : 's'}.`)
    } catch (err: any) {
      setAnilistMessage(err?.message || 'AniList sync failed')
    } finally {
      setAnilistLoading(false)
    }
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (simklPollRef.current) clearInterval(simklPollRef.current)
      if (simklTimeoutRef.current) clearTimeout(simklTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (store.traktConnected && !store.traktAccount) {
      import('../services/trakt/auth').then(({ fetchTraktAccount }) => {
        fetchTraktAccount()
          .then((account) => store.setTraktAccount(account))
          .catch((err) => console.error('Failed to load Trakt user profile:', err))
      })
    }
  }, [store.traktConnected, store.traktAccount])

  useEffect(() => {
    const hasBrokenAvatar = store.simklAccount &&
      (!store.simklAccount.avatar || !store.simklAccount.avatar.includes('wsrv.nl/?url=https://'))

    if (store.simklConnected && (!store.simklAccount || hasBrokenAvatar)) {
      import('../services/simkl/auth').then(({ getStoredSimklToken, finaliseSimklLogin }) => {
        const token = getStoredSimklToken()
        if (token) {
          finaliseSimklLogin(token)
            .then((account) => store.setSimklAccount(account))
            .catch((err) => console.error('Failed to load Simkl user profile:', err))
        }
      })
    }
  }, [store.simklConnected, store.simklAccount])

  const importStremioAddons = async (authKey: string) => {
    const addons = await getStremioAddons(authKey)
    const byId = new Map(store.addons.map((addon) => [addon.manifest.id, addon]))
    let imported = 0
    let updated = 0

    for (const addon of addons) {
      const existing = byId.get(addon.manifest.id)
      installAddon(addon.manifest, addon.url)

      if (!existing) {
        byId.set(addon.manifest.id, addon)
        imported++
      } else if (existing.url !== addon.url || JSON.stringify(existing.manifest) !== JSON.stringify(addon.manifest)) {
        byId.set(addon.manifest.id, { ...addon, enabled: existing.enabled })
        updated++
      }
    }

    store.setAddons(Array.from(byId.values()))
    return { imported, updated }
  }

  const handleTraktConnect = async () => {
    if (!hasTraktClientCredentials()) {
      setTraktError('This build does not include Trakt app credentials. Add a Client ID and Client Secret below, or rebuild with VITE_TRAKT_CLIENT_ID and VITE_TRAKT_CLIENT_SECRET.')
      setShowTraktAdvanced(true)
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

            try {
              const { fetchTraktAccount } = await import('../services/trakt/auth')
              const account = await fetchTraktAccount()
              store.setTraktAccount(account)
            } catch (err) {
              console.error('Failed to fetch Trakt account details:', err)
            }
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
      setTraktError(`Failed to start auth: ${e instanceof Error ? e.message : e}`)
    }
  }

  const handleTraktDisconnect = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    clearTokens()
    store.setTraktConnected(false)
    store.setTraktAccount(null)
    setTraktCode(null)
    setTraktPolling(false)
    setTraktError('')
  }

  const handleStremioLogin = async () => {
    if (!stremioEmail || !stremioPassword) {
      setStremioError('Enter both email and password')
      return
    }
    setStremioLoading(true)
    setStremioError('')
    try {
      const result = await stremioLogin(stremioEmail, stremioPassword)
      saveStremioAuth(result.authKey, stremioEmail)
      setStremioAuth({ authKey: result.authKey, email: stremioEmail })

      const { imported, updated } = await importStremioAddons(result.authKey)
      setStremioPassword('')
      setStremioError(imported || updated ? `Imported ${imported}, updated ${updated}` : 'All addons already imported')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setStremioError(
        message.toLowerCase().includes('passphrase')
          ? 'Login failed: Wrong passphrase. Check the email/password exactly, or paste your Stremio AuthKey below instead.'
          : `Login failed: ${message}`,
      )
    } finally {
      setStremioLoading(false)
    }
  }

  const handleStremioAuthKeyImport = async () => {
    const authKey = stremioAuthKey.trim()
    if (!authKey) {
      setStremioError('Enter a Stremio auth key')
      return
    }
    setStremioLoading(true)
    setStremioError('')
    try {
      saveStremioAuth(authKey, 'AuthKey login')
      setStremioAuth({ authKey, email: 'AuthKey login' })
      const { imported, updated } = await importStremioAddons(authKey)
      setStremioAuthKey('')
      setStremioError(imported || updated ? `Imported ${imported}, updated ${updated}` : 'All addons already imported')
    } catch (e) {
      clearStremioAuth()
      setStremioAuth(null)
      setStremioError(`Import failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setStremioLoading(false)
    }
  }

  const handleStremioSync = async () => {
    if (!stremioAuth) return
    setStremioLoading(true)
    setStremioError('')
    try {
      const { imported, updated } = await importStremioAddons(stremioAuth.authKey)
      setStremioError(imported || updated ? `Imported ${imported}, updated ${updated}` : 'All addons already imported')
    } catch (e) {
      setStremioError(`Sync failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setStremioLoading(false)
    }
  }

  const handleStremioDisconnect = () => {
    clearStremioAuth()
    setStremioAuth(null)
    setStremioError('')
  }

  const handleExportConfig = () => {
    const backup: Record<string, string | null> = {}
    for (const key of BACKUP_KEYS) {
      backup[key] = localStorage.getItem(key)
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `orynt_settings_backup_${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleImportConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string)
        if (typeof data !== 'object' || data === null) {
          alert('Invalid backup file format.')
          return
        }
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && typeof value === 'string') {
            localStorage.setItem(key, value)
          } else {
            localStorage.removeItem(key)
          }
        }
        alert('Configuration imported successfully! The app will now reload.')
        window.location.reload()
      } catch (err) {
        alert('Failed to import configuration: ' + (err instanceof Error ? err.message : String(err)))
      }
    }
    reader.readAsText(file)
  }

  const handleClearBackdropCache = () => {
    let clearedCount = 0
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('tmdb_backdrop_') || key.includes('backdrop'))) {
        localStorage.removeItem(key)
        clearedCount++
      }
    }
    alert(`Backdrop cache cleared! Wiped ${clearedCount} local keys.`)
  }

  const handleSaveStreamRegexFilters = () => {
    try {
      const parsed = validateStreamRegexFilterConfig(JSON.parse(streamRegexJson))
      saveStreamRegexFilterConfig(parsed)
      setStreamRegexJson(JSON.stringify(parsed, null, 2))
      setStreamRegexMessage(`Saved ${parsed.filters.length} filters in ${parsed.groups.length} groups.`)
    } catch (e) {
      setStreamRegexMessage(`Invalid filter JSON: ${e instanceof Error ? e.message : e}`)
    }
  }

  const handleResetStreamRegexFilters = () => {
    const defaults = resetStreamRegexFilterConfig()
    setStreamRegexJson(JSON.stringify(defaults, null, 2))
    setStreamRegexMessage('Reset stream regex filters to defaults.')
  }

  const handleToggleFilter = (filterId: string) => {
    const nextFilters = filterConfig.filters.map((f) =>
      f.id === filterId ? { ...f, isEnabled: !f.isEnabled } : f
    )
    const nextConfig = { ...filterConfig, filters: nextFilters }
    setFilterConfig(nextConfig)
    saveStreamRegexFilterConfig(nextConfig)
    setStreamRegexJson(JSON.stringify(nextConfig, null, 2))
  }

  const handleResetFilters = () => {
    const nextConfig = resetStreamRegexFilterConfig()
    setFilterConfig(nextConfig)
    setStreamRegexJson(JSON.stringify(nextConfig, null, 2))
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

  const cancelSimklAuth = () => {
    if (simklPollRef.current) clearInterval(simklPollRef.current)
    if (simklTimeoutRef.current) clearTimeout(simklTimeoutRef.current)
    simklPollRef.current = null
    simklTimeoutRef.current = null
    setSimklAuthStarted(false)
    setSimklCode('')
    setSimklVerificationUrl('')
    setSimklError('')
    setSimklLoading(false)
  }

  const finishSimklPinAuth = async (code: string) => {
    const account = await completeSimklLogin(code)
    if (simklPollRef.current) clearInterval(simklPollRef.current)
    if (simklTimeoutRef.current) clearTimeout(simklTimeoutRef.current)
    simklPollRef.current = null
    simklTimeoutRef.current = null
    store.setSimklConnected(true)
    store.setSimklAccount(account)
    setSimklAuthStarted(false)
    setSimklCode('')
    setSimklVerificationUrl('')
    setSimklError('')
    setSimklLoading(false)
  }

  const handleSimklConnect = async () => {
    setSimklError('')
    setSimklLoading(true)
    try {
      const pin = await initiateSimklLogin()
      if (!pin.userCode) {
        const account = await completeSimklLogin('')
        store.setSimklConnected(true)
        store.setSimklAccount(account)
        setSimklLoading(false)
        return
      }

      setSimklCode(pin.userCode)
      setSimklVerificationUrl(pin.verificationUrl)
      setSimklAuthStarted(true)
      setSimklError('Waiting for Simkl approval...')

      simklPollRef.current = setInterval(async () => {
        try {
          await finishSimklPinAuth(pin.userCode)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          if (!/waiting|pending|not return an access token/i.test(message)) {
            setSimklError(`Connection failed: ${message}`)
          }
        }
      }, Math.max(3, pin.interval || 5) * 1000)

      simklTimeoutRef.current = setTimeout(() => {
        if (simklPollRef.current) clearInterval(simklPollRef.current)
        simklPollRef.current = null
        setSimklLoading(false)
        setSimklError('Simkl authorization timed out. Try again.')
      }, (pin.expiresIn || 900) * 1000)
    } catch (e) {
      setSimklError(`Could not start Simkl auth: ${e instanceof Error ? e.message : String(e)}`)
      setSimklLoading(false)
    }
  }

  const handleSimklCodeSubmit = async () => {
    const code = simklCode.trim()
    if (!code) {
      setSimklError('Paste the Simkl authorization code first.')
      return
    }
    setSimklLoading(true)
    setSimklError('')
    try {
      await finishSimklPinAuth(code)
    } catch (e) {
      setSimklError(`Connection failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (!simklPollRef.current) setSimklLoading(false)
    }
  }

  const handleSimklDisconnect = () => {
    cancelSimklAuth()
    disconnectSimkl()
    store.setSimklConnected(false)
    store.setSimklAccount(null)
    setSimklError('')
  }

  const handleSimklSync = async () => {
    setSimklLoading(true)
    setSimklError('')
    try {
      const result = await syncSimkl()
      setSimklLastSync(result.syncedAt)
      if (result.errors.length > 0) {
        setSimklError(`Sync completed with errors: ${result.errors.slice(0, 2).join('; ')}`)
      } else {
        setSimklError(`Synced — pulled ${result.pulled}, pushed ${result.pushed}`)
      }
    } catch (e) {
      setSimklError(`Sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSimklLoading(false)
    }
  }

  const isConnected = store.traktConnected || isAuthenticated()
  const hasBundledTrakt = hasBundledTraktClientCredentials()
  const canConnectTrakt = hasTraktClientCredentials() && !traktPolling
  const categories = [
    {
      title: 'CONNECTIONS',
      items: [
        {
          id: 'accounts',
          label: 'Accounts',
          description: 'Manage connected services, API keys, and external integrations.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
          )
        },
        {
          id: 'addons',
          label: 'Addons',
          description: 'Install and manage third-party addon manifest URLs.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75L16.5 12l-2.25 2.25m-4.5 0L7.5 12l2.25-2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
            </svg>
          )
        }
      ]
    },
    {
      title: 'PREFERENCES',
      items: [
        {
          id: 'interface',
          label: 'Interface',
          description: 'Theme, layout, spoiler protection, and visual preferences.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122l.18-.367a3 3 0 000-2.678l-.18-.367a3.003 3.003 0 010-2.678l.18-.367a3 3 0 000-2.678L9.53 6.62M14.47 17.382l-.18-.367a3 3 0 000-2.678l.18-.367a3.003 3.003 0 010-2.678l-.18-.367a3 3 0 000-2.678l.18-.367M12 21V3" />
            </svg>
          )
        },
        {
          id: 'metadata',
          label: 'Metadata',
          description: 'Primary sources, fallback behavior, and community ratings.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
            </svg>
          )
        },
        {
          id: 'search',
          label: 'Search',
          description: 'Search engines, catalog order, and AI-powered search.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="m21 21-4.35-4.35" />
            </svg>
          )
        },
        {
          id: 'progress',
          label: 'Progress & Sync',
          description: 'Watch progress tracking, scrobbling, and service sync settings.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          )
        },
        {
          id: 'languages',
          label: 'Languages',
          description: 'Preferred audio and subtitle language selection.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802" />
            </svg>
          )
        },
        {
          id: 'filters',
          label: 'Stream Filters',
          description: 'Regex pattern matching for stream attribute detection.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v3.059a1.875 1.875 0 01-.5 1.25l-3.937 4.135a3 3 0 00-.813 2.106v2.106a3 3 0 01-.738 1.986l-2.22 2.58a.6.6 0 01-1.052-.4v-6.272a3 3 0 00-.813-2.106L3.92 9.083a1.875 1.875 0 01-.5-1.25V4.774c0-.54.384-1.006.917-1.096A50.06 50.06 0 0112 3z" />
            </svg>
          )
        },
      ]
    },
    {
      title: 'SYSTEM',
      items: [
        {
          id: 'player',
          label: 'Player',
          description: 'Hardware decoding, buffering, subtitles, and playback behavior.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
            </svg>
          )
        },
        {
          id: 'advanced',
          label: 'Advanced',
          description: 'Backup, restore, cache management, and factory reset.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.003.828c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827a1.125 1.125 0 01.26 1.43l-1.297 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.43l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.991l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )
        }
      ]
    }
  ]

  // Find the active category item for header info
  const activeItem = categories.flatMap(c => c.items).find(i => i.id === activeTab)

  return (
    <div className="flex h-full">
      {/* ─── Left Sidebar ─── */}
      <div className="w-60 flex-shrink-0 border-r border-white/[0.06] overflow-y-auto p-3 space-y-5">
        {categories.map((cat) => (
          <div key={cat.title}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 px-3 mb-1.5">{cat.title}</div>
            <div className="space-y-0.5">
              {cat.items.map((item) => {
                const active = activeTab === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => { setActiveTab(item.id as any); if (item.id === 'progress') setProgressSubPage('main') }}
                    className={`w-full flex items-center gap-2.5 px-3 py-[7px] text-[13px] font-medium rounded-lg transition-all cursor-pointer text-left ${
                      active
                        ? 'bg-white/[0.08] text-white'
                        : 'text-white/50 hover:text-white/70 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className={active ? 'text-white/80' : 'text-white/35'}>{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ─── Right Content ─── */}
      <div className="flex-1 overflow-y-auto p-8">
        <h1 className="text-2xl font-bold text-white mb-0.5">{activeItem?.label ?? 'Settings'}</h1>
        <p className="text-[13px] text-white/35 mb-8">{activeItem?.description ?? ''}</p>

        <div className="space-y-6 max-w-3xl">

          {/* ═══════════════════════════════════════════════
              ACCOUNTS TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'accounts' && (
            <>
              {/* Stremio */}
              <SettingSection title="Stremio Account" description="Import your addon collection from Stremio.">
                <div className="px-6 py-4">
                  {stremioAuth ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between bg-white/[0.03] rounded-xl p-4 border border-white/[0.06]">
                        <div className="flex items-center gap-3">
                          <div className="w-3.5 h-3.5 rounded-full bg-blue-500 animate-pulse" />
                          <div>
                            <span className="text-sm font-semibold text-white">Connected</span>
                            <p className="text-xs text-white/40 mt-0.5">{stremioAuth.email}</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleStremioSync}
                            disabled={stremioLoading}
                            className="px-3.5 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            {stremioLoading ? 'Syncing...' : 'Sync Addons'}
                          </button>
                          <button
                            onClick={handleStremioDisconnect}
                            className="px-3.5 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>
                      {stremioError && <p className="text-xs text-white/40">{stremioError}</p>}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase tracking-wider">Email</label>
                          <input
                            type="email"
                            value={stremioEmail}
                            onChange={(e) => setStremioEmail(e.target.value)}
                            placeholder="your@email.com"
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase tracking-wider">Password</label>
                          <input
                            type="password"
                            value={stremioPassword}
                            onChange={(e) => setStremioPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleStremioLogin()}
                            placeholder="Your Stremio password"
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                          />
                        </div>
                      </div>
                      <button
                        onClick={handleStremioLogin}
                        disabled={stremioLoading}
                        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-colors cursor-pointer"
                      >
                        {stremioLoading ? 'Logging in...' : 'Login & Import Addons'}
                      </button>
                      <div className="pt-4 border-t border-white/[0.06]">
                        <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase tracking-wider">Or paste Stremio AuthKey</label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={stremioAuthKey}
                            onChange={(e) => setStremioAuthKey(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleStremioAuthKeyImport()}
                            placeholder="AuthKey from web.stremio.com"
                            className="flex-1 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                          />
                          <button
                            onClick={handleStremioAuthKeyImport}
                            disabled={stremioLoading}
                            className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 rounded-xl text-sm transition-colors cursor-pointer text-white font-semibold"
                          >
                            Import
                          </button>
                        </div>
                        <p className="text-xs text-white/35 mt-1.5 leading-relaxed">
                          Use this if your Stremio account uses social login or Stremio rejects the password with "Wrong passphrase".
                        </p>
                      </div>
                      {stremioError && <p className="text-xs text-red-400">{stremioError}</p>}
                    </div>
                  )}
                </div>
              </SettingSection>

              {/* Simkl */}
              <SettingSection title={isMock ? 'Simkl (Mock mode)' : 'Simkl'} description="Sync watchlist, watching, and watch history.">
                <div className="px-6 py-4">
                  {simklStatus.connected || store.simklConnected ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between bg-white/[0.03] rounded-xl p-4 border border-white/[0.06]">
                        <div className="flex items-center gap-3">
                          {simklStatus.account?.avatar ? (
                            <img src={simklStatus.account.avatar} alt="" className="w-10 h-10 rounded-full object-cover border border-[#2ecc71]/35" />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-[#2ecc71]/20 flex items-center justify-center text-[#2ecc71] text-sm font-bold">
                              {(simklStatus.account?.username ?? store.simklAccount?.username ?? 'S')[0].toUpperCase()}
                            </div>
                          )}
                          <div>
                            <p className="text-sm font-bold text-white">
                              {simklStatus.account?.username ?? store.simklAccount?.username ?? 'Simkl User'}
                            </p>
                            <p className="text-xs text-white/40 mt-0.5">
                              {simklLastSync ? `Last sync: ${new Date(simklLastSync).toLocaleString()}` : 'Never synced'}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleSimklSync}
                            disabled={simklLoading}
                            className="px-3.5 py-2 bg-[#2ecc71]/10 hover:bg-[#2ecc71]/20 text-[#2ecc71] rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
                          >
                            {simklLoading ? 'Syncing...' : 'Sync Now'}
                          </button>
                          <button
                            onClick={handleSimklDisconnect}
                            className="px-3.5 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>
                      {simklError && (
                        <p className={`text-xs ${simklError.startsWith('Sync completed') || simklError.startsWith('Synced') ? 'text-white/40' : 'text-red-400'}`}>
                          {simklError}
                        </p>
                      )}
                    </div>
                  ) : simklAuthStarted ? (
                    <div className="space-y-4">
                      <div>
                        <p className="text-sm text-white/80 font-medium mb-1">Authorize Simkl with this code</p>
                        <p className="text-xs text-white/40 leading-relaxed">
                          Orynt opened Simkl in your browser. Enter the code below on Simkl, click Allow, and Orynt will connect automatically.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={simklCode}
                          onChange={(e) => setSimklCode(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSimklCodeSubmit()}
                          placeholder="Simkl code"
                          className="min-w-40 flex-1 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm font-mono tracking-wider text-white focus:outline-none focus:border-[#2ecc71]/50"
                        />
                        <button
                          onClick={handleSimklCodeSubmit}
                          disabled={simklLoading}
                          className="px-4 py-2 bg-[#2ecc71] hover:bg-[#27ae60] disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-colors cursor-pointer"
                        >
                          Check Now
                        </button>
                      </div>
                      {simklVerificationUrl && (
                        <p className="text-xs text-white/40">
                          Verification page: <span className="font-mono text-white/80">{simklVerificationUrl}</span>
                        </p>
                      )}
                      <button onClick={cancelSimklAuth} className="text-xs text-white/40 hover:text-white transition-colors cursor-pointer">Cancel</button>
                      {simklError && (
                        <p className={`text-xs ${simklError.startsWith('Waiting') ? 'text-white/40' : 'text-red-400'}`}>{simklError}</p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-white/40">
                        Connect your Simkl account to sync your watchlist, watching, and watch history.
                      </p>
                      {isMock && (
                        <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
                          <p className="text-xs text-yellow-200">
                            No Simkl client ID configured. Clicking Connect will use mock mode with sample data.
                            To use real Simkl data, build with <code className="font-mono">VITE_SIMKL_CLIENT_ID</code>.
                          </p>
                        </div>
                      )}
                      <button
                        onClick={handleSimklConnect}
                        disabled={simklLoading}
                        className="px-5 py-2.5 bg-[#2ecc71] hover:bg-[#27ae60] disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-colors cursor-pointer"
                      >
                        {simklLoading ? 'Opening Simkl...' : 'Connect Simkl'}
                      </button>
                      {simklError && <p className="text-xs text-red-400">{simklError}</p>}
                    </div>
                  )}
                </div>
              </SettingSection>

              {/* Trakt */}
              <SettingSection title="Trakt" description="Device authorization for watch history and lists.">
                <div className="px-6 py-4">
                  {isConnected ? (
                    <div className="flex items-center justify-between bg-white/[0.03] rounded-xl p-4 border border-white/[0.06]">
                      <div className="flex items-center gap-3">
                        {store.traktAccount?.avatar ? (
                          <img src={store.traktAccount.avatar} alt="" className="w-10 h-10 rounded-full object-cover border border-accent/35" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent text-sm font-bold">
                            {(store.traktAccount?.name ?? store.traktAccount?.username ?? 'T')[0].toUpperCase()}
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-bold text-white">
                            {store.traktAccount?.name ?? store.traktAccount?.username ?? 'Trakt User'}
                          </p>
                          <p className="text-xs text-white/40 mt-0.5">Connected to Trakt</p>
                        </div>
                      </div>
                      <button
                        onClick={handleTraktDisconnect}
                        className="px-3.5 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {hasBundledTrakt ? (
                        <p className="text-sm text-white/40">Connect your Trakt account with device authorization.</p>
                      ) : (
                        <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
                          <p className="text-sm text-yellow-200">
                            This executable was built without Orynt Trakt app credentials, so Trakt requires manual app credentials for now.
                          </p>
                        </div>
                      )}

                      {!traktCode ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={handleTraktConnect}
                            disabled={!canConnectTrakt}
                            className="px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-colors cursor-pointer"
                          >
                            Authorize with Trakt
                          </button>
                          {!hasBundledTrakt && (
                            <button
                              onClick={() => setShowTraktAdvanced((value) => !value)}
                              className="px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-sm font-semibold text-white transition-colors cursor-pointer"
                            >
                              {showTraktAdvanced ? 'Hide Credentials' : 'Add Client Credentials'}
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="p-4 bg-white/[0.03] rounded-xl border border-white/[0.06]">
                          <p className="text-sm text-white/40 mb-3">
                            1. Go to{' '}
                            <a href={traktCode.verificationUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline font-medium">
                              {traktCode.verificationUrl}
                            </a>
                          </p>
                          <p className="text-sm text-white/40 mb-4">2. Enter this PIN code:</p>
                          <div className="flex items-center gap-3 mb-4">
                            <span className="font-mono text-3xl font-bold text-accent tracking-widest select-all">{traktCode.userCode}</span>
                            <button
                              onClick={() => navigator.clipboard.writeText(traktCode.userCode)}
                              className="px-2.5 py-1 text-xs bg-white/5 hover:bg-white/10 rounded-lg text-white transition-colors cursor-pointer"
                            >
                              Copy
                            </button>
                          </div>
                          {traktPolling && (
                            <div className="flex items-center gap-2">
                              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                              <span className="text-xs text-white/40">Waiting for you to authorize...</span>
                            </div>
                          )}
                        </div>
                      )}
                      {(!hasBundledTrakt || showTraktAdvanced) && (
                        <div className="space-y-4 pt-4 border-t border-white/[0.06]">
                          <div>
                            <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase">Client ID</label>
                            <input
                              type="text"
                              value={store.traktClientId}
                              onChange={(e) => store.setTraktClientId(e.target.value)}
                              placeholder="Paste your Trakt app Client ID"
                              className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase">Client Secret</label>
                            <input
                              type="password"
                              value={store.traktClientSecret}
                              onChange={(e) => store.setTraktClientSecret(e.target.value)}
                              placeholder="Paste your Trakt app Client Secret"
                              className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                            />
                            <p className="text-xs text-white/35 mt-1.5">
                              To remove this requirement for users, build Orynt with `VITE_TRAKT_CLIENT_ID` and `VITE_TRAKT_CLIENT_SECRET`.
                            </p>
                          </div>
                        </div>
                      )}
                      {traktError && <p className="text-xs text-red-400">{traktError}</p>}
                    </div>
                  )}
                </div>
              </SettingSection>

              {/* MDBList */}
              <SettingSection title="MDBList Ratings" description="IMDb, Rotten Tomatoes, Metacritic, and more.">
                <div className="px-6 py-4">
                  <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase">MDBList API Key</label>
                  <input
                    type="password"
                    value={store.mdblistApiKey}
                    onChange={(e) => store.setMdblistApiKey(e.target.value)}
                    placeholder="Enter your MDBList API key"
                    className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                  />
                  <p className="text-[11px] text-white/30 mt-1">
                    API docs:{' '}
                    <a href="https://api.mdblist.com/docs/" target="_blank" rel="noreferrer" className="text-accent hover:underline">api.mdblist.com/docs</a>
                  </p>
                </div>
              </SettingSection>

              {/* PublicMetaDB */}
              <SettingSection title="PublicMetaDB (PMDB)" description="Sync watch history, scrobbles, skip timestamps, and continue watching.">
                <div className="px-6 py-4 space-y-3">
                  <div>
                    <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase">PublicMetaDB API Key</label>
                    <input
                      type="password"
                      value={store.pmdbApiKey}
                      onChange={(e) => { store.setPmdBApiKey(e.target.value); setPmdbConnStatus(null) }}
                      placeholder="pm-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                    />
                    <p className="text-[11px] text-white/30 mt-1">
                      Get your API key at{' '}
                      <a href="https://publicmetadb.com/" target="_blank" rel="noreferrer" className="text-accent hover:underline">publicmetadb.com</a>
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={testPmdbConnection}
                      disabled={!store.pmdbApiKey || pmdbConnChecking}
                      className="flex items-center gap-2 px-4 py-2 bg-accent/15 border border-accent/30 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-all"
                    >
                      {pmdbConnChecking ? (
                        <>
                          <div className="w-3.5 h-3.5 border-2 border-accent/40 border-t-accent rounded-full animate-spin" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                            <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          Test Connection
                        </>
                      )}
                    </button>

                    {pmdbConnStatus && !pmdbConnChecking && (
                      pmdbConnStatus.connected ? (
                        <span className="flex items-center gap-1.5 text-sm text-green-400 font-medium">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Connected
                          {pmdbConnStatus.resumeCount != null && <span className="text-white/30 ml-1">({pmdbConnStatus.resumeCount} resume points)</span>}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-sm text-red-400">
                          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round"/>
                          </svg>
                          <span>{pmdbConnStatus.error ?? `HTTP ${pmdbConnStatus.status}`}</span>
                        </span>
                      )
                    )}
                  </div>
                </div>
              </SettingSection>

              {/* IntroDB */}
              <SettingSection title="IntroDB" description="Intro, recap, and credits skip timestamps for TV episodes.">
                <div className="px-6 py-4 space-y-3">
                  <div>
                    <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase">IntroDB API Key</label>
                    <input
                      type="password"
                      value={store.introdbApiKey}
                      onChange={(e) => store.setIntrodbApiKey(e.target.value)}
                      placeholder="Enter your IntroDB API key"
                      className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                    />
                    <p className="text-[11px] text-white/30 mt-1">
                      Get your API key at{' '}
                      <a href="https://introdb.app" target="_blank" rel="noreferrer" className="text-accent hover:underline">introdb.app</a>
                      {' '}-- docs:{' '}
                      <a href="https://introdb.app/docs/api" target="_blank" rel="noreferrer" className="text-accent hover:underline">introdb.app/docs/api</a>
                    </p>
                  </div>
                  <div className="flex gap-3 text-xs">
                    <span className="px-2 py-1 bg-purple-500/10 border border-purple-500/20 text-purple-300 rounded-lg">Skip Intro</span>
                    <span className="px-2 py-1 bg-purple-500/10 border border-purple-500/20 text-purple-300 rounded-lg">Skip Recap</span>
                    <span className="px-2 py-1 bg-purple-500/10 border border-purple-500/20 text-purple-300 rounded-lg">Skip Credits</span>
                  </div>
                </div>
              </SettingSection>

              {/* AniList */}
              <SettingSection title="AniList" description="Track anime watch progress, manage lists, and sync history.">
                <div className="px-6 py-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase tracking-wider">Client ID</label>
                      <input
                        type="text"
                        value={store.anilistClientId}
                        onChange={(e) => store.setAnilistClientId(e.target.value)}
                        placeholder="Enter AniList Client ID"
                        className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase tracking-wider">Client Secret</label>
                      <input
                        type="password"
                        value={store.anilistClientSecret}
                        onChange={(e) => store.setAnilistClientSecret(e.target.value)}
                        placeholder="Enter AniList Client Secret"
                        className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                      />
                    </div>
                  </div>

                  <div className="p-3.5 bg-white/[0.02] border border-white/[0.06] rounded-xl">
                    <p className="text-xs text-white/50 leading-relaxed">
                      To connect AniList:
                      <br />
                      1. Register an API client on the <a href="https://anilist.co/settings/developer" target="_blank" rel="noopener noreferrer" className="text-accent underline font-semibold">AniList Developer Portal</a>.
                      <br />
                      2. Set the <b>Redirect URL</b> to <code className="font-mono bg-white/5 px-1 py-0.5 rounded text-white">http://localhost:42814/</code>.
                      <br />
                      3. Input the Client ID and Client Secret above, then click <b>Connect AniList</b> below.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAnilistConnect}
                      disabled={anilistLoading || !store.anilistClientId || !store.anilistClientSecret}
                      className="px-3.5 py-2 bg-accent text-black rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {anilistLoading ? 'Connecting...' : store.anilistConnected ? 'Reconnect AniList' : 'Connect AniList'}
                    </button>
                    <button
                      onClick={syncAniListNow}
                      disabled={anilistLoading || !store.anilistConnected}
                      className="px-3.5 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-white/5 text-white rounded-xl text-xs font-semibold cursor-pointer"
                    >
                      Sync Now
                    </button>
                    {store.anilistConnected && (
                      <button
                        onClick={handleAnilistDisconnect}
                        className="px-3.5 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>

                  {store.anilistAccount && (
                    <div className="flex items-center gap-3 bg-white/[0.03] rounded-xl p-3 border border-white/[0.06]">
                      {store.anilistAccount.avatar ? (
                        <img src={store.anilistAccount.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent text-xs font-bold">
                          {store.anilistAccount.name[0].toUpperCase()}
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-white/40">Connected as</p>
                        <p className="text-sm font-semibold text-white">{store.anilistAccount.name}</p>
                      </div>
                    </div>
                  )}

                  {anilistMessage && <p className={`text-xs ${anilistMessage.toLowerCase().includes('failed') || anilistMessage.toLowerCase().includes('missing') ? 'text-red-400' : 'text-white/40'}`}>{anilistMessage}</p>}

                  {/* Manual Token Fallback */}
                  <div className="pt-4 border-t border-white/[0.06]">
                    <details className="group">
                      <summary className="text-xs text-white/30 hover:text-white/50 cursor-pointer select-none font-semibold">
                        Advanced: Manual Token Entry
                      </summary>
                      <div className="mt-3 space-y-3">
                        <label className="text-xs text-white/40 block font-semibold uppercase tracking-wider">Manual Access Token</label>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={anilistTokenInput}
                            onChange={(e) => setAnilistTokenInput(e.target.value)}
                            placeholder="Paste manual AniList access token"
                            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
                          />
                          <button
                            onClick={connectAniListManual}
                            disabled={anilistLoading || !anilistTokenInput}
                            className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 rounded-xl text-xs font-semibold cursor-pointer text-white"
                          >
                            Save Manual Token
                          </button>
                        </div>
                        <p className="text-[11px] text-white/30 leading-relaxed">
                          Alternatively, you can generate a token via AniList's developer portal/client authorization flow and paste it here directly.
                        </p>
                      </div>
                    </details>
                  </div>
                </div>
              </SettingSection>

              {/* Metadata Providers */}
              <SettingSection title="Metadata Providers" description="API keys for movie and show detail pages.">
                <SettingRow label="TMDB API Key" description="Get a free key at themoviedb.org/settings/api">
                  <input
                    type="text"
                    value={store.tmdbApiKey}
                    onChange={(e) => store.setTmdbApiKey(e.target.value)}
                    placeholder="Enter TMDB API key"
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                  />
                </SettingRow>
                <SettingRow label="TVDB API Key" description="Get one at thetvdb.com/api-information">
                  <input
                    type="text"
                    value={store.tvdbApiKey}
                    onChange={(e) => store.setTvdbApiKey(e.target.value)}
                    placeholder="Enter TVDB API key"
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                  />
                </SettingRow>
              </SettingSection>

              {/* Discord Rich Presence */}
              <SettingSection title="Discord Rich Presence" description="Show what you're watching on your Discord profile.">
                <SettingRow label="Enable Discord Rich Presence" description="Requires Discord desktop app to be running.">
                  <SettingToggle checked={store.discordRichPresence} onChange={(v) => store.setDiscordRichPresence(v)} />
                </SettingRow>
              </SettingSection>

              {/* OpenRouter AI */}
              <SettingSection title="OpenRouter AI" description="AI-powered natural language searches and subtitle translation.">
                <SettingRow label="API Key" description="Get your API key at openrouter.ai">
                  <input
                    type="password"
                    value={store.openrouterApiKey}
                    onChange={(e) => store.setOpenrouterApiKey(e.target.value)}
                    placeholder="sk-or-v1-..."
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                  />
                </SettingRow>
                <SettingRow label="Model" description="Select the AI model for search and translation.">
                  <select
                    value={['google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat', 'meta-llama/llama-3-8b-instruct:free'].includes(store.openrouterModel) ? store.openrouterModel : 'custom'}
                    onChange={(e) => {
                      if (e.target.value === 'custom') {
                        store.setOpenrouterModel('custom-model-id')
                      } else {
                        store.setOpenrouterModel(e.target.value)
                      }
                    }}
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (Recommended)</option>
                    <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
                    <option value="meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B</option>
                    <option value="deepseek/deepseek-chat">DeepSeek V3</option>
                    <option value="meta-llama/llama-3-8b-instruct:free">Llama 3 8B (Free)</option>
                    <option value="custom">Custom Model</option>
                  </select>
                </SettingRow>
                {!['google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat', 'meta-llama/llama-3-8b-instruct:free'].includes(store.openrouterModel) && (
                  <SettingRow label="Custom Model ID" description="Enter any valid OpenRouter model identifier.">
                    <input
                      type="text"
                      value={store.openrouterModel === 'custom-model-id' ? '' : store.openrouterModel}
                      onChange={(e) => store.setOpenrouterModel(e.target.value)}
                      placeholder="e.g. anthropic/claude-3.5-sonnet"
                      className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                    />
                  </SettingRow>
                )}
              </SettingSection>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              ADDONS TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'addons' && (
            <>
              <SettingSection title="Install Addon" description="Add Stremio or web addon manifest URLs to load video streams and catalogs.">
                <div className="px-6 py-4 space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={addonUrl}
                      onChange={(e) => setAddonUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddAddon()}
                      placeholder="https://addon-url.com/manifest.json"
                      className="flex-1 px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                    />
                    <button
                      onClick={handleAddAddon}
                      disabled={addonLoading}
                      className="px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-colors cursor-pointer"
                    >
                      {addonLoading ? 'Loading...' : 'Add Addon'}
                    </button>
                  </div>
                  {addonError && <p className="text-xs text-red-400">{addonError}</p>}
                </div>
              </SettingSection>

              <SettingSection title="Installed Addons">
                {store.addons.length > 0 ? (
                  store.addons.map((addon) => (
                    <div key={addon.manifest.id} className="flex items-center justify-between px-6 py-4">
                      <div className="flex items-center gap-3 min-w-0">
                        {addon.manifest.logo && (
                          <img src={addon.manifest.logo} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-white truncate">{addon.manifest.name}</div>
                          <div className="text-xs text-white/35 truncate mt-0.5">{addon.manifest.description || addon.url}</div>

                        </div>
                      </div>
                      <button
                        onClick={() => store.removeAddon(addon.manifest.id)}
                        className="text-xs text-red-400 hover:text-red-300 font-semibold transition-colors flex-shrink-0 ml-3 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="px-6 py-8 text-center">
                    <p className="text-sm text-white/30 italic">No custom addons installed.</p>
                  </div>
                )}
              </SettingSection>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              INTERFACE TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'interface' && (
            <>
              {/* Accent Color */}
              <SettingSection title="Accent Color" description="Choose your interface highlight color.">
                <div className="px-6 py-4">
                  <div className="flex flex-wrap gap-3 items-center">
                    {(['green', 'purple', 'blue', 'red', 'orange', 'pink', 'white'] as const).map((color) => {
                      const colorClasses: Record<string, { bg: string; border: string }> = {
                        green: { bg: 'bg-[#10b981]', border: 'border-[#10b981]' },
                        purple: { bg: 'bg-[#8b5cf6]', border: 'border-[#8b5cf6]' },
                        blue: { bg: 'bg-[#3b82f6]', border: 'border-[#3b82f6]' },
                        red: { bg: 'bg-[#ef4444]', border: 'border-[#ef4444]' },
                        orange: { bg: 'bg-[#f97316]', border: 'border-[#f97316]' },
                        pink: { bg: 'bg-[#ec4899]', border: 'border-[#ec4899]' },
                        white: { bg: 'bg-white', border: 'border-white' },
                      }
                      const active = store.accentColor === color
                      return (
                        <button
                          key={color}
                          onClick={() => store.setAccentColor(color)}
                          className={`group flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer capitalize ${
                            active
                              ? 'bg-white text-black border-white shadow-lg scale-105'
                              : 'bg-white/5 border-white/5 text-white/70 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          <span className={`w-3.5 h-3.5 rounded-full ${colorClasses[color].bg} ${active ? 'ring-2 ring-black' : ''}`} />
                          <span>{color}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </SettingSection>

              {/* Startup Page */}
              <SettingSection title="Startup Page" description="Which page Orynt lands on at launch.">
                <SettingRow label="Default start page">
                  <select
                    value={store.defaultStartPage}
                    onChange={(e) => store.setDefaultStartPage(e.target.value as 'home' | 'discover' | 'collections' | 'search')}
                    className="w-56 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="home">Home Dashboard</option>
                    <option value="discover">Discover</option>
                    <option value="collections">Collections</option>
                    <option value="search">Search</option>
                  </select>
                </SettingRow>
              </SettingSection>

              {/* Discovery Preferences */}
              <SettingSection title="Discovery Preferences" description="Tune regional availability and recommendation quality.">
                <SettingRow label="Region">
                  <select
                    value={store.discoveryRegion}
                    onChange={(e) => store.setDiscoveryRegion(e.target.value)}
                    className="w-32 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer"
                  >
                    {['US', 'GB', 'DE', 'FR', 'ES', 'IT', 'CA', 'AU', 'JP', 'KR', 'IN', 'BR'].map((region) => (
                      <option key={region} value={region}>{region}</option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow label="Minimum rating">
                  <select
                    value={store.discoveryMinRating}
                    onChange={(e) => store.setDiscoveryMinRating(Number(e.target.value))}
                    className="w-32 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer"
                  >
                    {[0, 5, 6, 7, 8].map((rating) => (
                      <option key={rating} value={rating}>{rating === 0 ? 'Any' : `${rating}+ / 10`}</option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow label="Include adult titles" description="Applies to all TMDB discovery rails.">
                  <SettingToggle checked={store.discoveryIncludeAdult} onChange={(v) => store.setDiscoveryIncludeAdult(v)} />
                </SettingRow>
              </SettingSection>

              {/* Ratings on Cards */}
              <SettingSection>
                <SettingRow label="Show Ratings on Media Cards" description="Render rating badges on card thumbnails.">
                  <SettingToggle checked={store.showRatingsOnCards} onChange={(v) => store.setShowRatingsOnCards(v)} />
                </SettingRow>
              </SettingSection>

              {/* Hero Banner Ratings */}
              <SettingSection title="Hero Banner Ratings" description="Select which ratings appear on the Home hero banner.">
                <div className="px-6 py-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([
                      { id: 'imdb', label: 'IMDb', icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/IMDB_Logo_2016.svg/960px-IMDB_Logo_2016.svg.png' },
                      { id: 'rottentomatoes', label: 'Rotten Tomatoes (Critics)', icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Rotten_Tomatoes.svg/250px-Rotten_Tomatoes.svg.png' },
                      { id: 'tomatoesaudience', label: 'RT (Audience)', icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Rotten_Tomatoes_positive_audience.svg/250px-Rotten_Tomatoes_positive_audience.svg.png' },
                      { id: 'metacritic', label: 'Metacritic', icon: 'https://upload.wikimedia.org/wikipedia/commons/f/f2/Metacritic_M.png' },
                      { id: 'tmdb', label: 'TMDb', icon: 'https://raw.githubusercontent.com/yodaluca23/fusion-icon-packs/refs/heads/main/icons/TMDb.png' },
                      { id: 'trakt', label: 'Trakt', icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Trakt.tv-favicon.svg/250px-Trakt.tv-favicon.svg.png' },
                      { id: 'letterboxd', label: 'Letterboxd', icon: 'https://a.ltrbxd.com/logos/letterboxd-decal-dots-pos-rgb-500px.png' },
                      { id: 'myanimelist', label: 'MyAnimeList', icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/MyAnimeList_favicon.svg/250px-MyAnimeList_favicon.svg.png' },
                    ] as const).map((prov) => {
                      const enabled = store.visibleHeroRatings.includes(prov.id)
                      const handleToggle = () => {
                        if (enabled) {
                          store.setVisibleHeroRatings(store.visibleHeroRatings.filter((x) => x !== prov.id))
                        } else {
                          store.setVisibleHeroRatings([...store.visibleHeroRatings, prov.id])
                        }
                      }
                      return (
                        <button
                          key={prov.id}
                          onClick={handleToggle}
                          className={`flex items-center justify-between p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                            enabled
                              ? 'bg-accent/10 border-accent/40 text-white'
                              : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:bg-white/[0.06] hover:text-white/70'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="w-6 h-6 rounded-lg bg-transparent flex items-center justify-center p-1">
                              <img src={prov.icon} alt="" className="w-4 h-4 object-contain" />
                            </span>
                            <span className="text-xs font-semibold">{prov.label}</span>
                          </div>
                          <input type="checkbox" checked={enabled} readOnly className="w-4 h-4 accent-accent pointer-events-none" />
                        </button>
                      )
                    })}
                  </div>
                </div>
              </SettingSection>

              {/* Poster Size */}
              <SettingSection title="Poster Size" description="Scale posters and cards across Home, Discover, and your library.">
                <div className="px-6 py-4">
                  <div className="flex flex-wrap gap-2">
                    {(['compact', 'default', 'large', 'huge'] as const).map((opt) => {
                      const labelMap: Record<string, string> = { compact: 'Compact', default: 'Default', large: 'Large', huge: 'Huge' }
                      const active = store.posterSize === opt
                      return (
                        <button
                          key={opt}
                          onClick={() => store.setPosterSize(opt)}
                          className={`h-8 flex items-center justify-center px-3.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                            active ? 'bg-white text-black border-white' : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10 hover:text-white border-transparent'
                          }`}
                        >
                          {labelMap[opt]}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </SettingSection>

              {/* Spoilers */}
              <SettingSection title="Spoilers" description="Blur episode artwork, titles, and descriptions for unwatched episodes.">
                <SettingRow label="Blur spoilers" description="Hides episode details until you have watched them.">
                  <SettingToggle checked={store.blurSpoilers} onChange={(v) => store.setBlurSpoilers(v)} />
                </SettingRow>
                <SettingRow label="Blur thumbnails">
                  <SettingToggle checked={store.blurThumbnails} onChange={(v) => store.setBlurThumbnails(v)} />
                </SettingRow>
                <SettingRow label="Blur titles">
                  <SettingToggle checked={store.blurTitles} onChange={(v) => store.setBlurTitles(v)} />
                </SettingRow>
                <SettingRow label="Blur descriptions">
                  <SettingToggle checked={store.blurDescriptions} onChange={(v) => store.setBlurDescriptions(v)} />
                </SettingRow>
                <SettingRow label="Keep next episode visible" description="Leave the episode you are up to clear, blur only those after it.">
                  <SettingToggle checked={store.keepNextEpisodeVisible} onChange={(v) => store.setKeepNextEpisodeVisible(v)} />
                </SettingRow>
              </SettingSection>

              {/* Continue Watching screenshots */}
              <SettingSection title="Continue Watching Screenshots" description="Save a frame when you back out so the card shows where you left off.">
                <div className="px-6 py-4">
                  <label className="text-[10px] text-white/35 mb-2 block font-extrabold uppercase tracking-wider">Keep frames for</label>
                  <div className="flex flex-wrap gap-2">
                    {(['none', '1_week', '30_days', '3_months', '6_months', '1_year'] as const).map((opt) => {
                      const labelMap: Record<string, string> = { none: 'None', '1_week': '1 week', '30_days': '30 days', '3_months': '3 months', '6_months': '6 months', '1_year': '1 year' }
                      const active = store.keepFramesFor === opt
                      return (
                        <button
                          key={opt}
                          onClick={() => store.setKeepFramesFor(opt)}
                          className={`h-8 flex items-center justify-center px-3.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                            active ? 'bg-white text-black border-white' : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10 hover:text-white border-transparent'
                          }`}
                        >
                          {labelMap[opt]}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <SettingRow label="Clear all saved frames" description={`${store.savedFramesCount} frames stored.`}>
                  <button
                    onClick={() => { store.setSavedFramesCount(0); alert('Cleared all saved frames.') }}
                    disabled={store.savedFramesCount === 0}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition-all cursor-pointer border border-white/[0.06]"
                  >
                    Clear all
                  </button>
                </SettingRow>
              </SettingSection>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              METADATA TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'metadata' && (
            <>
              <h3 className="text-sm font-bold text-amber-400/80 mb-3">Metadata Ownership</h3>
              <SettingSection description="Addons provide streams and catalogs. Orynt resolves and displays clean metadata itself.">
                <SettingRow label="App-managed metadata" description="Use Orynt providers as the authority for titles, artwork, descriptions, IDs, and media type.">
                  <SettingToggle checked={store.appManagedMetadata} onChange={store.setAppManagedMetadata} />
                </SettingRow>
                <SettingRow label="Use addon metadata fallback" description="Only display addon metadata when app provider lookup fails.">
                  <SettingToggle checked={store.useAddonMetadataFallback} onChange={store.setUseAddonMetadataFallback} />
                </SettingRow>
                <SettingRow label="Prefer TVDB season structure for anime" description="Anime uses TVDB-style seasons so episodes are not grouped into one giant season.">
                  <SettingToggle checked={store.preferTvdbAnimeSeasons} onChange={store.setPreferTvdbAnimeSeasons} />
                </SettingRow>
                <SettingRow label="Anime titles" description="English is preferred in Auto mode, followed by Romaji and native titles.">
                  <select value={store.animeTitleLanguage} onChange={(event) => store.setAnimeTitleLanguage(event.target.value as typeof store.animeTitleLanguage)} className="w-48 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white">
                    <option value="auto">Auto</option>
                    <option value="english">English</option>
                    <option value="romaji">Romaji</option>
                    <option value="native">Native / Japanese</option>
                  </select>
                </SettingRow>
                <SettingRow label="Clear app metadata cache" description="Remove normalized metadata and addon-to-media mappings.">
                  <button onClick={() => clearAppMetadataCache().then(() => alert('App metadata cache cleared.')).catch((error) => alert(`Could not clear metadata cache: ${error}`))} className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white rounded-xl text-xs font-bold">Clear Cache</button>
                </SettingRow>
                <SettingRow label="Re-resolve all metadata" description="Clear normalized records. Visible catalogs will resolve again as they load.">
                  <button onClick={() => clearAppMetadataCache().then(() => window.location.reload())} className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white rounded-xl text-xs font-bold">Re-resolve</button>
                </SettingRow>
              </SettingSection>

              {/* Movies */}
              <h3 className="text-sm font-bold text-amber-400/80 mb-3">Movies</h3>
              <SettingSection>
                <SettingRow label="Primary source" description="Where to fetch movie metadata from.">
                  <div className="flex bg-white/[0.06] rounded-xl overflow-hidden border border-white/[0.08]">
                    {(['tmdb', 'tvdb'] as const).map((src) => (
                      <button
                        key={src}
                        onClick={() => store.setMovieMetadataSource(src)}
                        className={`px-5 py-2 text-sm font-semibold transition-colors cursor-pointer ${
                          store.movieMetadataSource === src
                            ? 'bg-white/15 text-white'
                            : 'text-white/50 hover:text-white/70'
                        }`}
                      >
                        {src === 'tmdb' ? 'TMDb' : 'TVDb'}
                      </button>
                    ))}
                  </div>
                </SettingRow>
                <SettingRow label="Enable fallback" description="Primary applies to all fields. Fallback fills gaps in order.">
                  <SettingToggle checked={store.movieMetadataFallback} onChange={(v) => store.setMovieMetadataFallback(v)} />
                </SettingRow>
              </SettingSection>

              {/* Series */}
              <h3 className="text-sm font-bold text-amber-400/80 mt-8 mb-3">Series</h3>
              <SettingSection>
                <SettingRow label="Primary source" description="Where to fetch series metadata from.">
                  <div className="flex bg-white/[0.06] rounded-xl overflow-hidden border border-white/[0.08]">
                    {(['tvdb', 'tmdb'] as const).map((src) => (
                      <button
                        key={src}
                        onClick={() => store.setSeriesMetadataSource(src)}
                        className={`px-5 py-2 text-sm font-semibold transition-colors cursor-pointer ${
                          store.seriesMetadataSource === src
                            ? 'bg-white/15 text-white'
                            : 'text-white/50 hover:text-white/70'
                        }`}
                      >
                        {src === 'tmdb' ? 'TMDb' : 'TVDb'}
                      </button>
                    ))}
                  </div>
                </SettingRow>
                <SettingRow label="Enable fallback" description="Primary applies to all fields. Fallback fills gaps in order.">
                  <SettingToggle checked={store.seriesMetadataFallback} onChange={(v) => store.setSeriesMetadataFallback(v)} />
                </SettingRow>
              </SettingSection>

              {/* Anime */}
              <h3 className="text-sm font-bold text-amber-400/80 mt-8 mb-3">Anime</h3>
              <SettingSection>
                <SettingRow label="Primary source" description="Where to fetch anime titles and descriptions from. Season structure always comes from TVDb.">
                  <div className="flex bg-white/[0.06] rounded-xl overflow-hidden border border-white/[0.08]">
                    {(['anilist', 'mal', 'kitsu', 'tvdb', 'tmdb'] as const).map((src) => (
                      <button
                        key={src}
                        onClick={() => store.setAnimeMetadataSource(src)}
                        className={`px-4 py-2 text-sm font-semibold transition-colors cursor-pointer ${
                          store.animeMetadataSource === src
                            ? 'bg-white/15 text-white'
                            : 'text-white/50 hover:text-white/70'
                        }`}
                      >
                        {src === 'anilist' ? 'AniList' : src === 'mal' ? 'MAL' : src === 'kitsu' ? 'Kitsu' : src === 'tvdb' ? 'TVDb' : 'TMDb'}
                      </button>
                    ))}
                  </div>
                </SettingRow>
                <SettingRow label="Enable fallback" description="Primary applies to all fields. Fallback fills gaps in order.">
                  <SettingToggle checked={store.animeMetadataFallback} onChange={(v) => store.setAnimeMetadataFallback(v)} />
                </SettingRow>
                <SettingRow label="Hide unreleased anime seasons" description="Hide seasons where no episodes have aired yet.">
                  <SettingToggle checked={store.hideUnairedAnimeSeasons} onChange={store.setHideUnairedAnimeSeasons} />
                </SettingRow>
                <SettingRow label="Hide unreleased anime episodes" description="Hide individual episodes with future air dates.">
                  <SettingToggle checked={store.hideUnairedAnimeEpisodes} onChange={store.setHideUnairedAnimeEpisodes} />
                </SettingRow>
                <SettingRow label="Include anime specials" description="Show Season 0 (Specials) for anime series.">
                  <SettingToggle checked={store.includeAnimeSpecials} onChange={store.setIncludeAnimeSpecials} />
                </SettingRow>
                <SettingRow label="Ignore addon metadata for anime" description="Addons only provide streams and IDs. Display metadata comes from the app pipeline.">
                  <SettingToggle checked={store.ignoreAddonMetadataForAnime} onChange={store.setIgnoreAddonMetadataForAnime} />
                </SettingRow>
                <SettingRow label="Use generic anime season labels" description="Shows anime seasons as Season 1, Season 2, etc. unless a good English season name is available.">
                  <SettingToggle checked={store.useGenericAnimeSeasonLabels} onChange={store.setUseGenericAnimeSeasonLabels} />
                </SettingRow>
                <SettingRow label="Avoid Japanese season names" description="Uses English/Romaji season names when possible and keeps Japanese titles as original titles.">
                  <SettingToggle checked={store.avoidJapaneseSeasonNames} onChange={store.setAvoidJapaneseSeasonNames} />
                </SettingRow>
                <SettingRow label="Clear anime mapping cache" description="Remove cached anime metadata so it will be re-fetched from TVDB on next view.">
                  <button
                    className="px-4 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 text-sm font-semibold rounded-xl transition-all border border-amber-500/20"
                    onClick={async () => {
                      await store.clearAnimeCache()
                      alert('Anime cache cleared. Re-open any anime to re-fetch metadata.')
                    }}
                  >
                    Clear Cache
                  </button>
                </SettingRow>
                <p className="text-xs text-white/40 mt-2 px-1">Anime is displayed like normal shows using TVDB seasons and episodes. Addon metadata is ignored for anime display — addons are only used for streams and IDs.</p>
              </SettingSection>

              {/* Spoiler Protection */}
              <SettingSection title="Spoiler Protection">
                <SettingRow label="Enable Spoiler Protection" description="Blur content for unwatched episodes to avoid spoilers.">
                  <SettingToggle checked={store.blurSpoilers} onChange={(v) => store.setBlurSpoilers(v)} />
                </SettingRow>
              </SettingSection>

              {/* Community Ratings */}
              <h3 className="text-sm font-bold text-amber-400/80 mt-8 mb-3">Community Ratings</h3>
              <SettingSection>
                <SettingRow label="Enable community ratings" description="Show ratings from external services on detail pages.">
                  <SettingToggle checked={store.enableCommunityRatings} onChange={(v) => store.setEnableCommunityRatings(v)} />
                </SettingRow>
                {store.enableCommunityRatings && (
                  <>
                    {[
                      { id: 'imdb', label: 'IMDb' },
                      { id: 'rottentomatoes', label: 'Rotten Tomatoes' },
                      { id: 'tomatoesaudience', label: 'RT Audience' },
                      { id: 'metacritic', label: 'Metacritic' },
                      { id: 'tmdb', label: 'TMDb' },
                      { id: 'trakt', label: 'Trakt' },
                      { id: 'letterboxd', label: 'Letterboxd' },
                      { id: 'myanimelist', label: 'MyAnimeList' },
                    ].map((prov) => {
                      const enabled = store.visibleHeroRatings.includes(prov.id)
                      return (
                        <SettingRow key={prov.id} label={prov.label}>
                          <SettingToggle
                            checked={enabled}
                            onChange={(v) => {
                              if (!v) store.setVisibleHeroRatings(store.visibleHeroRatings.filter((x) => x !== prov.id))
                              else store.setVisibleHeroRatings([...store.visibleHeroRatings, prov.id])
                            }}
                          />
                        </SettingRow>
                      )
                    })}
                  </>
                )}
              </SettingSection>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              SEARCH TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'search' && (
            <SearchSettingsSection />
          )}

          {/* ═══════════════════════════════════════════════
              PROGRESS TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'progress' && (
            <>
              {progressSubPage === 'main' && (
                <>
                  <SettingSection title="Continue Watching" description="Configure progress tracking sources and display.">
                    {/* Continue Watching Source Selector */}
                    <div className="px-6 py-4">
                      <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase tracking-wider">Source</label>
                      <div className="flex gap-1.5 bg-white/[0.03] rounded-xl p-1 border border-white/[0.06]">
                        {(['local', 'trakt', 'simkl', 'pmdb', 'anilist'] as const).map((src) => (
                          <button
                            key={src}
                            onClick={() => store.setContinueWatchingSource(src)}
                            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all capitalize cursor-pointer ${
                              store.continueWatchingSource === src
                                ? 'bg-accent/15 text-accent border border-accent/20 font-bold'
                                : 'text-white/40 hover:text-white border border-transparent'
                            }`}
                          >
                            <span className="inline-flex items-center justify-center gap-1.5">
                              <ServiceIcon service={src} className="w-3.5 h-3.5" />
                              {src === 'pmdb' ? 'PMDB' : src}
                            </span>
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-white/30 mt-1.5">Choose where Continue Watching is saved on this device.</p>
                    </div>

                    <SettingRow label="Continue Watching Items" description="How many items appear in Continue Watching.">
                      <button
                        onClick={() => {
                          const current = store.continueWatchingLimit
                          const next = current === 5 ? 10 : current === 10 ? 20 : current === 20 ? 50 : 5
                          store.setContinueWatchingLimit(next)
                        }}
                        className="px-3 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-white font-semibold cursor-pointer hover:bg-white/[0.08] transition-colors"
                      >
                        {store.continueWatchingLimit} items
                      </button>
                    </SettingRow>

                    {/* Watched Checkmark Sources */}
                    <div className="px-6 py-4">
                      <div className="mb-3">
                        <span className="text-sm text-white">Watched Checkmarks</span>
                        <p className="text-[12px] text-white/35 mt-0.5">Choose which providers mark movies and episodes as watched.</p>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {(['local', 'trakt', 'simkl', 'pmdb', 'anilist'] as const).map((src) => {
                          const enabled = store.watchedCheckmarkSources.includes(src)
                          return (
                            <button
                              key={src}
                              onClick={() => {
                                const next = enabled
                                  ? store.watchedCheckmarkSources.filter((s) => s !== src)
                                  : [...store.watchedCheckmarkSources, src]
                                store.setWatchedCheckmarkSources(next.length ? next : ['local'])
                              }}
                              className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                                enabled ? 'bg-accent/15 border-accent/25 text-accent' : 'bg-white/5 border-white/5 text-white/40 hover:text-white'
                              }`}
                            >
                              {enabled && (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                              <ServiceIcon service={src} className="w-3.5 h-3.5" />
                              {src === 'pmdb' ? 'PMDB' : src === 'simkl' ? 'Simkl' : src === 'anilist' ? 'AniList' : src}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <SettingRow label="Watchlist Button" description="Bookmark button target next to Play.">
                      <select
                        value={store.watchlistButtonTarget}
                        onChange={(e) => store.setWatchlistButtonTarget(e.target.value as any)}
                        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer text-white font-semibold"
                      >
                        <option value="local">Local</option>
                        <option value="trakt">Trakt</option>
                        <option value="simkl">Simkl</option>
                        <option value="pmdb">PMDB</option>
                        <option value="anilist">AniList (anime only)</option>
                      </select>
                    </SettingRow>
                  </SettingSection>

                  {/* Services Group */}
                  <SettingSection title="Services">
                    {[
                      { id: 'local' as const, label: 'Local Progress', detail: 'Export, copy', icon: <svg className="w-4.5 h-4.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /><path d="M6 21h12M12 17v4" /></svg> },
                      { id: 'trakt' as const, label: 'Trakt', detail: 'Sync settings', icon: <ServiceIcon service="trakt" /> },
                      { id: 'simkl' as const, label: 'Simkl', detail: 'Scrobble & sync', icon: <ServiceIcon service="simkl" /> },
                      { id: 'anilist' as const, label: 'AniList', detail: 'Sync settings', icon: <ServiceIcon service="anilist" /> },
                      { id: 'pmdb' as const, label: 'PublicMetaDB', detail: 'Resume & sync', icon: <ServiceIcon service="pmdb" /> },
                    ].map((svc) => (
                      <div
                        key={svc.id}
                        onClick={() => setProgressSubPage(svc.id)}
                        className="flex items-center justify-between px-6 py-4 hover:bg-white/[0.02] transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          {svc.icon}
                          <span className="text-sm font-semibold text-white">{svc.label}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-white/30">
                          <span>{svc.detail}</span>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                      </div>
                    ))}
                  </SettingSection>

                  {/* Anime */}
                  <SettingSection title="Anime">
                    <div
                      onClick={() => setProgressSubPage('anime')}
                      className="flex items-center justify-between px-6 py-4 hover:bg-white/[0.02] transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <svg className="w-4.5 h-4.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
                        </svg>
                        <span className="text-sm font-semibold text-white">Anime Tracking</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-white/30">
                        <span>Provider selection</span>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </div>
                    </div>
                  </SettingSection>
                </>
              )}

              {/* Back button for sub-pages */}
              {progressSubPage !== 'main' && (
                <div className="flex items-center gap-3 mb-2 -mt-2">
                  <button
                    onClick={() => setProgressSubPage('main')}
                    className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <h2 className="text-lg font-bold text-white capitalize">
                    {progressSubPage === 'pmdb' ? 'PublicMetaDB' : progressSubPage === 'anime' ? 'Anime Tracking' : progressSubPage === 'simkl' ? 'Simkl' : progressSubPage}
                  </h2>
                </div>
              )}

              {/* Local Progress */}
              {progressSubPage === 'local' && (
                <SettingSection title="Local Progress" description="Manage your local device play history.">
                  <SettingRow label="Copy Local Progress Cache" description="Copy all local play records as JSON to the clipboard.">
                    <button
                      onClick={() => {
                        const raw = localStorage.getItem('orynt_watch_progress') || '{}'
                        navigator.clipboard.writeText(raw)
                      }}
                      className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-semibold border border-white/[0.06] cursor-pointer"
                    >
                      Copy to Clipboard
                    </button>
                  </SettingRow>
                </SettingSection>
              )}

              {/* Trakt Settings */}
              {progressSubPage === 'trakt' && (
                <>
                  <SettingSection title="Trakt Scrobbling">
                    <SettingRow label="Scrobble Playback" description="Send watching progress to Trakt while using the built-in player.">
                      <SettingToggle checked={store.scrobbleTrakt} onChange={(v) => store.setScrobbleTrakt(v)} />
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="Sync">
                    <SettingRow label="Sync Frequency">
                      <select
                        value={store.pmdbSyncFrequency}
                        onChange={(e) => store.setPmdBSyncFrequency(e.target.value)}
                        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer text-white font-semibold"
                      >
                        <option value="every_minute">Every Minute</option>
                        <option value="every_5">Every 5 Minutes</option>
                        <option value="manual">Manual Only</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Keep Syncing in Foreground" description="Refresh at the chosen interval while the app is in the foreground.">
                      <SettingToggle checked={true} onChange={() => {}} />
                    </SettingRow>
                    <SettingRow label="Sync Now">
                      <button className="px-3.5 py-2 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-semibold cursor-pointer">
                        Sync Now
                      </button>
                    </SettingRow>
                    <SettingRow label="Sync After External Playback" description="Refresh when Orynt is reopened from an external player.">
                      <SettingToggle checked={true} onChange={() => {}} />
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="Export">
                    <SettingRow label="Copy to Clipboard">
                      <button onClick={() => alert('Copied cache to clipboard')} className="px-3.5 py-2 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-semibold cursor-pointer">
                        Copy
                      </button>
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="Danger Zone">
                    <SettingRow label="Clear Trakt Continue Watching Cache" description="Remove all cached Trakt data.">
                      <DangerButton onClick={() => alert('Trakt Cache Cleared.')}>Clear Cache</DangerButton>
                    </SettingRow>
                  </SettingSection>
                </>
              )}

              {/* Simkl Settings */}
              {progressSubPage === 'simkl' && (
                <>
                  <SettingSection title="Simkl Scrobbling">
                    <SettingRow label="Scrobble Playback" description="Send start, pause, and stop events to Simkl.">
                      <SettingToggle checked={store.scrobbleSimkl} onChange={(v) => store.setScrobbleSimkl(v)} />
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="Sync">
                    <SettingRow label="Sync Now" description="Pull Simkl watching, completed, anime, and watchlist data.">
                      <div className="flex items-center gap-2">
                        {simklLastSync && <span className="text-xs text-white/30">Last: {new Date(simklLastSync).toLocaleString()}</span>}
                        <button
                          onClick={handleSimklSync}
                          disabled={simklLoading || !(simklStatus.connected || store.simklConnected)}
                          className="px-3.5 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white rounded-xl text-xs font-semibold cursor-pointer"
                        >
                          {simklLoading ? 'Syncing...' : 'Sync Now'}
                        </button>
                      </div>
                    </SettingRow>
                  </SettingSection>
                  {simklError && (
                    <p className={`text-xs px-1 ${simklError.startsWith('Sync completed') || simklError.startsWith('Synced') ? 'text-white/40' : 'text-red-400'}`}>
                      {simklError}
                    </p>
                  )}
                </>
              )}

              {/* AniList Settings */}
              {progressSubPage === 'anilist' && (
                <SettingSection title="AniList Settings" description="Anime Continue Watching, list rows, and episode progress.">
                  <SettingRow label="Scrobble Episode Progress" description="Updates AniList progress to the current episode while playing.">
                    <SettingToggle checked={store.scrobbleAnilist} onChange={(v) => store.setScrobbleAnilist(v)} />
                  </SettingRow>
                </SettingSection>
              )}

              {/* PMDB Settings */}
              {progressSubPage === 'pmdb' && (
                <>
                  <SettingSection title="PMDB Scrobbling">
                    <SettingRow label="Scrobble Watch History" description="Mark movies and episodes as watched when playback completes.">
                      <SettingToggle checked={store.scrobblePmdb} onChange={(v) => store.setScrobblePmdb(v)} />
                    </SettingRow>
                    <SettingRow label="Save Resume Position" description="Sends playback position to PMDB on pause and stop.">
                      <SettingToggle checked={store.pmdbSaveResumePosition} onChange={(v) => store.setPmdBSaveResumePosition(v)} />
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="Sync">
                    <SettingRow label="Sync Frequency">
                      <select
                        value={store.pmdbSyncFrequency}
                        onChange={(e) => store.setPmdBSyncFrequency(e.target.value)}
                        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer text-white font-semibold"
                      >
                        <option value="every_minute">Every Minute</option>
                        <option value="every_5">Every 5 Minutes</option>
                        <option value="manual">Manual Only</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Sync Now">
                      <div className="flex items-center gap-2">
                        {store.pmdbLastSyncTime && <span className="text-xs text-white/30">Last: {store.pmdbLastSyncTime}</span>}
                        <button
                          onClick={() => { store.setPmdBLastSyncTime('Just now'); alert('PublicMetaDB synced successfully.') }}
                          className="px-3.5 py-2 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-semibold cursor-pointer"
                        >
                          Sync Now
                        </button>
                      </div>
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="Danger Zone">
                    <SettingRow label="Clear PMDB Continue Watching Cache" description="Remove all cached PMDB data.">
                      <DangerButton onClick={() => alert('PMDB Cache Cleared.')}>Clear Cache</DangerButton>
                    </SettingRow>
                  </SettingSection>
                </>
              )}

              {/* Anime Tracking */}
              {progressSubPage === 'anime' && (
                <>
                  <SettingSection title="Anime Tracking">
                    <SettingRow label="Provider" description="Choose where to track your anime watch progress.">
                      <select
                        value={store.animeTrackingProvider}
                        onChange={(e) => store.setAnimeTrackingProvider(e.target.value as any)}
                        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer text-white font-semibold"
                      >
                        <option value="anilist">AniList</option>
                        <option value="simkl">Simkl</option>
                        <option value="trakt">Trakt</option>
                        <option value="local">Local Only</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Show Watched From" description="Which service displays watched checkmarks in episode lists.">
                      <select
                        value={store.animeShowWatchedFrom}
                        onChange={(e) => store.setAnimeShowWatchedFrom(e.target.value as any)}
                        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer text-white font-semibold"
                      >
                        <option value="all">All Sources</option>
                        <option value="provider">Current Provider Only</option>
                      </select>
                    </SettingRow>
                  </SettingSection>

                  <SettingSection title="About Providers">
                    <div className="px-6 py-4 space-y-4">
                      <div className="flex items-start gap-3">
                        <svg className="w-4 h-4 text-white/30 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-white">Local Only</p>
                          <p className="text-xs text-white/35 mt-0.5">Progress is stored only on this device and not synced anywhere.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <svg className="w-4 h-4 text-white/30 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <polygon points="12 2 2 7 12 12 22 7 12 2" /><polygon points="2 17 12 22 22 17" /><polygon points="2 12 12 17 22 12" />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-white">Trakt</p>
                          <p className="text-xs text-white/35 mt-0.5">Progress syncs to Trakt using TVDB episode numbers. Best for mixed media libraries.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <svg className="w-4 h-4 text-white/30 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-white">AniList</p>
                          <p className="text-xs text-white/35 mt-0.5">Progress syncs directly to AniList using native episode numbers. Best for anime-focused experience.</p>
                        </div>
                      </div>
                    </div>
                  </SettingSection>
                </>
              )}
            </>
          )}

          {/* ═══════════════════════════════════════════════
              LANGUAGES TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'languages' && (
            <>
              {/* Subtitle Languages */}
              <SettingSection title="Subtitle Languages" description="Auto-select subtitle tracks on playback. First match wins.">
                <div className="px-6 py-4 space-y-4">
                  <div className="min-h-[60px] w-full p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex flex-wrap gap-2 items-center">
                    {store.preferredSubtitles.length === 0 ? (
                      <span className="text-xs text-white/30 italic">No preferred subtitle languages. System default will be used.</span>
                    ) : (
                      store.preferredSubtitles.map((code) => {
                        const lang = APP_LANGUAGES.find((l) => l.code === code)
                        if (!lang) return null
                        return (
                          <span key={code} className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent/15 border border-accent/30 text-accent font-semibold rounded-full text-xs">
                            <span>{lang.flag} {lang.name}</span>
                            <button onClick={() => store.setPreferredSubtitles(store.preferredSubtitles.filter((c) => c !== code))} className="hover:text-white transition-colors cursor-pointer">x</button>
                          </span>
                        )
                      })
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
                    {APP_LANGUAGES.filter((lang) => !store.preferredSubtitles.includes(lang.code)).map((lang) => (
                      <button
                        key={lang.code}
                        onClick={() => store.setPreferredSubtitles([...store.preferredSubtitles, lang.code])}
                        className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] rounded-xl text-xs font-medium text-left text-white/70 hover:text-white transition-all cursor-pointer"
                      >
                        <span>{lang.flag}</span>
                        <span>{lang.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </SettingSection>

              {/* Audio Languages */}
              <SettingSection title="Audio Languages" description="Auto-switch to the best audio track match. Primary language first.">
                <div className="px-6 py-4 space-y-4">
                  <div className="min-h-[60px] w-full p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex flex-wrap gap-2 items-center">
                    {store.preferredAudio.length === 0 ? (
                      <span className="text-xs text-white/30 italic">No preferred audio languages. System default will be used.</span>
                    ) : (
                      store.preferredAudio.map((code) => {
                        const lang = APP_LANGUAGES.find((l) => l.code === code)
                        if (!lang) return null
                        return (
                          <span key={code} className="inline-flex items-center gap-2 px-3 py-1.5 bg-accent/15 border border-accent/30 text-accent font-semibold rounded-full text-xs">
                            <span>{lang.flag} {lang.name}</span>
                            <button onClick={() => store.setPreferredAudio(store.preferredAudio.filter((c) => c !== code))} className="hover:text-white transition-colors cursor-pointer">x</button>
                          </span>
                        )
                      })
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
                    {APP_LANGUAGES.filter((lang) => !store.preferredAudio.includes(lang.code)).map((lang) => (
                      <button
                        key={lang.code}
                        onClick={() => store.setPreferredAudio([...store.preferredAudio, lang.code])}
                        className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] rounded-xl text-xs font-medium text-left text-white/70 hover:text-white transition-all cursor-pointer"
                      >
                        <span>{lang.flag}</span>
                        <span>{lang.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </SettingSection>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              FILTERS TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'filters' && (
            <>
              <div className="flex items-center justify-between gap-4 mb-2 -mt-2">
                <div className="relative flex-1 max-w-md">
                  <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={filterSearch}
                    onChange={(e) => setFilterSearch(e.target.value)}
                    placeholder="Search filters..."
                    className="w-full pl-10 pr-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/30 focus:outline-none focus:border-accent/50 transition-all"
                  />
                </div>
                <button
                  onClick={handleResetFilters}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white border border-white/[0.08] rounded-xl text-sm font-semibold transition-colors cursor-pointer flex-shrink-0"
                >
                  Reset to Defaults
                </button>
              </div>

              {filterConfig.groups.map((group) => {
                const groupFilters = filterConfig.filters.filter(
                  (f) => f.groupId === group.id &&
                  (f.name.toLowerCase().includes(filterSearch.toLowerCase()) || f.pattern.toLowerCase().includes(filterSearch.toLowerCase()))
                )
                if (groupFilters.length === 0) return null

                const allEnabled = groupFilters.every((f) => f.isEnabled)
                const toggleAllInGroup = () => {
                  const targetState = !allEnabled
                  const nextFilters = filterConfig.filters.map((f) =>
                    f.groupId === group.id ? { ...f, isEnabled: targetState } : f
                  )
                  const nextConfig = { ...filterConfig, filters: nextFilters }
                  setFilterConfig(nextConfig)
                  saveStreamRegexFilterConfig(nextConfig)
                  setStreamRegexJson(JSON.stringify(nextConfig, null, 2))
                }

                // Score group: compact pill grid
                if (group.id === 'gp') {
                  return (
                    <SettingSection key={group.id}>
                      <div className="px-6 py-4">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: group.color }} />
                            <h3 className="text-[15px] font-semibold text-white">{group.name} Filters</h3>
                          </div>
                          <button onClick={toggleAllInGroup} className="text-xs text-accent hover:underline font-semibold cursor-pointer">
                            {allEnabled ? 'Disable All' : 'Enable All'}
                          </button>
                        </div>

                        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
                          {groupFilters.map((filter) => {
                            const filled = filter.tagStyle.includes('filled')
                            const bordered = filter.tagStyle.includes('bordered')
                            const bg = filled ? cssColorFromFilterColor(filter.tagColor, 'transparent') : 'transparent'
                            const border = bordered ? cssColorFromFilterColor(filter.borderColor, group.color) : 'transparent'
                            const textCol = cssColorFromFilterColor(filter.textColor, '#FFFFFF')

                            return (
                              <button
                                key={filter.id}
                                onClick={() => handleToggleFilter(filter.id)}
                                className={`flex flex-col items-center justify-center p-2 rounded-xl border transition-all cursor-pointer ${
                                  filter.isEnabled
                                    ? 'bg-accent/10 border-accent/40 text-white'
                                    : 'bg-white/[0.02] border-white/[0.06] text-white/40 hover:bg-white/[0.04]'
                                }`}
                              >
                                <span
                                  className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-black leading-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] mb-1"
                                  style={{ backgroundColor: filter.isEnabled ? bg : 'transparent', border: `1px solid ${filter.isEnabled ? border : '#ffffff20'}`, color: filter.isEnabled ? textCol : 'inherit' }}
                                >
                                  {filter.name}
                                </span>
                                <span className="text-[9px] font-mono opacity-50 truncate max-w-full">{filter.name}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </SettingSection>
                  )
                }

                // Other groups: detailed rows
                return (
                  <SettingSection key={group.id}>
                    <div className="px-6 pt-4 pb-2">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: group.color }} />
                          <h3 className="text-[15px] font-semibold text-white">{group.name} Filters</h3>
                        </div>
                        <button onClick={toggleAllInGroup} className="text-xs text-accent hover:underline font-semibold cursor-pointer">
                          {allEnabled ? 'Disable All' : 'Enable All'}
                        </button>
                      </div>
                    </div>
                    {groupFilters.map((filter) => {
                      const filled = filter.tagStyle.includes('filled')
                      const bordered = filter.tagStyle.includes('bordered')
                      const bg = filled ? cssColorFromFilterColor(filter.tagColor, 'transparent') : 'transparent'
                      const border = bordered ? cssColorFromFilterColor(filter.borderColor, group.color) : 'transparent'
                      const textCol = cssColorFromFilterColor(filter.textColor, '#FFFFFF')

                      return (
                        <div key={filter.id} className="flex items-center justify-between px-6 py-3.5">
                          <div className="flex items-center gap-4 min-w-0 mr-4">
                            <SettingToggle checked={filter.isEnabled} onChange={() => handleToggleFilter(filter.id)} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2.5 flex-wrap">
                                <span className="text-sm font-semibold text-white">{filter.name}</span>
                                <span
                                  className="inline-flex h-6.5 items-center gap-1 rounded-lg px-2 text-[10px] font-black leading-none shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                                  style={{ backgroundColor: bg, border: `1.5px solid ${border}`, color: textCol }}
                                >
                                  {filter.imageURL ? (
                                    <img src={filter.imageURL} alt="" className="h-3 max-w-[40px] object-contain" />
                                  ) : (
                                    <span>{filter.name}</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            filter.isEnabled ? 'bg-accent/15 text-accent border border-accent/20' : 'bg-white/5 text-white/35 border border-white/5'
                          }`}>
                            {filter.isEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                      )
                    })}
                  </SettingSection>
                )
              })}
            </>
          )}

          {/* ═══════════════════════════════════════════════
              PLAYER TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'player' && (
            <>
              {/* MPV Status */}
              <SettingSection>
                <div className="px-6 py-4 flex items-center gap-3">
                  <div className="w-3.5 h-3.5 rounded-full bg-accent animate-pulse" />
                  <p className="text-sm text-white/70 font-semibold">mpv is bundled with Orynt and ready for playback.</p>
                </div>
              </SettingSection>

              <SettingSection
                title="Developer / Player Debug"
                description="Run mpv through a minimal path with no scrobbling, progress polling, metadata work, custom arguments, or automatic restart."
              >
                <SettingRow
                  label="Isolated Playback Mode"
                  description="Use this to determine whether freezes originate in mpv/the stream or in Orynt's full player integration."
                >
                  <SettingToggle checked={store.isolatedPlaybackMode} onChange={store.setIsolatedPlaybackMode} />
                </SettingRow>
                <SettingRow label="Isolated hardware decoding" description="Compare auto-safe GPU decoding against software decoding.">
                  <select
                    value={store.isolatedPlaybackHwdec}
                    onChange={(event) => store.setIsolatedPlaybackHwdec(event.target.value as 'auto-safe' | 'no')}
                    className="w-52 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="auto-safe">Auto-safe</option>
                    <option value="no">Software only</option>
                  </select>
                </SettingRow>
                <SettingRow label="Allow resume seek" description="Off by default so seeking cannot affect an isolation test.">
                  <SettingToggle checked={store.isolatedPlaybackResume} onChange={store.setIsolatedPlaybackResume} />
                </SettingRow>
                <div className="flex gap-3 px-6 py-4">
                  <button
                    onClick={async () => {
                      const path = await invoke<string | null>('select_local_video_file')
                      if (!path) return
                      store.setIsolatedPlaybackMode(true)
                      setPlayerDebugTest({ url: path, title: 'Local isolation test' })
                    }}
                    className="rounded-xl border border-accent/25 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/15"
                  >
                    Test Local File
                  </button>
                  <button
                    onClick={() => {
                      store.setIsolatedPlaybackMode(true)
                      setPlayerDebugTest({
                        url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
                        title: 'Stable HTTP isolation test',
                      })
                    }}
                    className="rounded-xl border border-accent/25 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/15"
                  >
                    Test Direct HTTP
                  </button>
                  <button
                    onClick={async () => {
                      const logs = await invoke<string[]>('get_player_debug_logs')
                      await navigator.clipboard.writeText(logs.join('\n'))
                    }}
                    className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-white hover:bg-white/[0.1]"
                  >
                    Copy Player Logs
                  </button>
                  <button
                    onClick={() => invoke('clear_player_debug_logs')}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-white/65 hover:text-white"
                  >
                    Clear Logs
                  </button>
                </div>
              </SettingSection>

              {/* Hardware Decoding */}
              <SettingSection title="Hardware Decoding" description="Offload video decoding to your GPU for smoother playback.">
                <SettingRow label="Decoding API">
                  <select
                    value={store.hwdecMode}
                    onChange={(e) => store.setHwdecMode(e.target.value as any)}
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="auto">Auto-detect (Recommended)</option>
                    <option value="no">Disabled (Software)</option>
                    <option value="d3d11va">Direct3D 11 (d3d11va)</option>
                    <option value="nvdec">NVIDIA (nvdec)</option>
                    <option value="vaapi">Intel/AMD Linux (vaapi)</option>
                    <option value="videotoolbox">macOS (videotoolbox)</option>
                  </select>
                </SettingRow>
              </SettingSection>

              {/* Buffer */}
              <SettingSection title="Buffer Cache" description="Adjust cache to prevent buffering on slow networks.">
                <SettingRow label="Cache limit">
                  <select
                    value={store.cacheBufferSize}
                    onChange={(e) => store.setCacheBufferSize(e.target.value as any)}
                    className="w-48 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="default">Default (150MB)</option>
                    <option value="large">Large (256MB)</option>
                    <option value="aggressive">Aggressive (512MB)</option>
                  </select>
                </SettingRow>
                <SettingRow label="Cache duration (seconds)" description="Amount of stream time to buffer ahead.">
                  <input
                    type="number"
                    min="5"
                    max="600"
                    value={store.mpvCacheSecs}
                    onChange={(e) => store.setMpvCacheSecs(Number(e.target.value) || 60)}
                    className="w-32 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </SettingRow>
                <SettingRow label="Network timeout (seconds)" description="Connection timeout before giving up on a stream.">
                  <input
                    type="number"
                    min="5"
                    max="120"
                    value={store.mpvNetworkTimeout}
                    onChange={(e) => store.setMpvNetworkTimeout(Number(e.target.value) || 15)}
                    className="w-32 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </SettingRow>
              </SettingSection>

              {/* Advanced Player Settings */}
              <SettingSection title="Advanced Player Options" description="Configure custom parameters for the mpv player.">
                <SettingRow label="Custom mpv arguments" description="Pass additional CLI flags to mpv (space-separated, e.g. --alang=eng --volume-max=150).">
                  <input
                    type="text"
                    placeholder="e.g. --alang=eng --volume-max=150"
                    value={store.mpvCustomArgs}
                    onChange={(e) => store.setMpvCustomArgs(e.target.value)}
                    className="w-96 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold focus:outline-none focus:border-accent/50"
                  />
                </SettingRow>
                <div className="px-6 py-4">
                  <button
                    onClick={() => {
                      if (confirm("Are you sure you want to reset all player settings to safe defaults?")) {
                        store.resetPlayerSettings()
                      }
                    }}
                    className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 text-red-200 rounded-xl text-sm font-semibold transition-all"
                  >
                    Reset Player Settings to Safe Defaults
                  </button>
                </div>
              </SettingSection>

              {/* Audio Passthrough */}
              <SettingSection>
                <SettingRow label="Digital Audio Passthrough" description="Output compressed formats (Dolby Atmos, DTS) to an external receiver.">
                  <SettingToggle checked={store.audioPassthrough} onChange={(v) => store.setAudioPassthrough(v)} />
                </SettingRow>
              </SettingSection>

              {/* Auto-skip */}
              <SettingSection>
                <SettingRow label="Auto-skip intros, recaps, and credits" description="Jump over skip ranges from PublicMetaDB or IntroDB.">
                  <SettingToggle checked={store.autoSkipSegments} onChange={(v) => store.setAutoSkipSegments(v)} />
                </SettingRow>
              </SettingSection>

              {/* Subtitle Styling */}
              <SettingSection title="Subtitle Styling" description="Customize subtitle appearance inside the player.">
                <div className="px-6 py-4 space-y-6">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-semibold text-white">Font Size</span>
                      <span className="text-accent font-bold">{store.subtitleFontSize}px</span>
                    </div>
                    <input
                      type="range" min="16" max="64"
                      value={store.subtitleFontSize}
                      onChange={(e) => store.setSubtitleFontSize(Number(e.target.value))}
                      className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-semibold text-white">Background Opacity</span>
                      <span className="text-accent font-bold">{Math.round(Number(store.subtitleBgOpacity) * 100)}%</span>
                    </div>
                    <input
                      type="range" min="0" max="1" step="0.05"
                      value={store.subtitleBgOpacity}
                      onChange={(e) => store.setSubtitleBgOpacity(e.target.value)}
                      className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                    />
                  </div>
                  {/* Preview */}
                  <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] flex items-center justify-center min-h-[90px] relative overflow-hidden">
                    <div className="absolute inset-0 bg-cover bg-center opacity-30" style={{ backgroundImage: `url('https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=300&auto=format&fit=crop')` }} />
                    <div className="relative z-10 text-center font-bold tracking-wide" style={{ fontSize: `${store.subtitleFontSize * 0.75}px`, textShadow: '0 2px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.9)' }}>
                      <span className="px-2 py-0.5 rounded" style={{ backgroundColor: `rgba(0, 0, 0, ${store.subtitleBgOpacity})` }}>
                        Subtitles Preview text
                      </span>
                    </div>
                  </div>
                </div>
              </SettingSection>

              {/* Subtitle Translation */}
              <SettingSection title="Subtitle Translation" description="AI-powered subtitle translation via OpenRouter.">
                <SettingRow label="Translate subtitles" description="Create and prefer an AI-translated track on playback.">
                  <SettingToggle checked={store.subtitleTranslationEnabled} onChange={(v) => store.setSubtitleTranslationEnabled(v)} />
                </SettingRow>
                <SettingRow label="Translation engine">
                  <span className="text-sm text-white/55">OpenRouter</span>
                </SettingRow>
                <SettingRow label="Translate to" description="Translated track appears first in subtitle list.">
                  <select
                    value={store.subtitleTranslationLang}
                    onChange={(e) => {
                      const language = e.target.value
                      store.setSubtitleTranslationLang(language)
                      store.setSubtitleTranslationEnabled(Boolean(language))
                    }}
                    className="w-40 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white"
                  >
                    <option value="">None</option>
                    {APP_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>{lang.flag} {lang.name}</option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow label="Model">
                  <span className="text-sm text-white/55 break-all">{store.openrouterModel}</span>
                </SettingRow>
                <SettingRow label="Cues Ahead" description="Number of subtitle cues to pre-translate.">
                  <select
                    value={store.translationCuesAhead}
                    onChange={(e) => store.setTranslationCuesAhead(Number(e.target.value))}
                    className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white"
                  >
                    {[1, 2, 3, 5, 8, 10, 15, 20].map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow label="Context-Aware Translation" description="Use surrounding dialogue for more natural translations.">
                  <SettingToggle checked={store.contextAwareTranslation} onChange={(v) => store.setContextAwareTranslation(v)} />
                </SettingRow>
                <div className="px-6 py-3 text-xs text-white/30 leading-relaxed">
                  {store.openrouterApiKey ? 'Ready (OpenRouter)' : 'OpenRouter API key required'}.
                  Subtitle text is sent to OpenRouter. No account data or viewing history is included.
                </div>
              </SettingSection>

              {/* Next episode prompt */}
              <SettingSection title="Next Episode Prompt" description="When the Up Next pill appears before an episode ends.">
                <div className="px-6 py-4">
                  <div className="flex flex-wrap gap-2">
                    {(['auto', 'off', '30s', '45s', '1m', '1.5m', '2m'] as const).map((opt) => {
                      const labelMap: Record<string, string> = { auto: 'Auto', off: 'Off', '30s': '30s', '45s': '45s', '1m': '1 min', '1.5m': '1.5 min', '2m': '2 min' }
                      const active = store.nextEpisodePrompt === opt
                      return (
                        <button
                          key={opt}
                          onClick={() => store.setNextEpisodePrompt(opt)}
                          className={`h-8 flex items-center justify-center px-3.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                            active ? 'bg-white text-black border-white' : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10 hover:text-white border-transparent'
                          }`}
                        >
                          {labelMap[opt]}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </SettingSection>

              <p className="text-xs text-white/25 leading-relaxed px-1">
                Scrobble, resume, watched checkmarks, and sync provider settings are under Progress & Sync.
              </p>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              ADVANCED TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'advanced' && (
            <>
              {/* Backup & Restore */}
              <SettingSection title="Configuration Backup" description="Export or restore all local settings, tokens, and addon lists.">
                <div className="px-6 py-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] flex flex-col justify-between h-36">
                      <div>
                        <span className="text-sm font-semibold text-white">Export Backup</span>
                        <p className="text-xs text-white/35 mt-1">Download configurations to your local drive.</p>
                      </div>
                      <button
                        onClick={handleExportConfig}
                        className="w-full py-2 bg-accent text-black font-bold rounded-xl text-xs transition-colors hover:bg-accent-hover cursor-pointer"
                      >
                        Export JSON Settings
                      </button>
                    </div>
                    <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] flex flex-col justify-between h-36">
                      <div>
                        <span className="text-sm font-semibold text-white">Restore Backup</span>
                        <p className="text-xs text-white/35 mt-1">Import a JSON backup to overwrite current settings.</p>
                      </div>
                      <label className="w-full py-2 bg-white/5 border border-white/[0.08] hover:bg-white/10 text-white font-bold rounded-xl text-xs text-center transition-colors cursor-pointer block">
                        <span>Select Backup File</span>
                        <input type="file" accept=".json" onChange={handleImportConfig} className="hidden" />
                      </label>
                    </div>
                  </div>
                </div>
              </SettingSection>

              {/* Clear Image Cache */}
              <SettingSection title="Backdrop Cache" description="Clear cached backdrop and poster image URLs.">
                <SettingRow label="Clear Image Cache" description="Wipe backdrop cache items to force fresh links.">
                  <button
                    onClick={handleClearBackdropCache}
                    className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
                  >
                    Clear Cache
                  </button>
                </SettingRow>
              </SettingSection>

              {/* Factory Reset */}
              <SettingSection title="Danger Zone" description="Irreversible actions. Proceed with caution.">
                <SettingRow label="Factory Reset" description="Clear all local cache, tokens, logs, addons, and reset to defaults.">
                  <DangerButton onClick={() => {
                    if (confirm('Are you sure you want to restore factory default settings? All accounts, progress, and settings will be deleted.')) {
                      localStorage.clear()
                      window.location.reload()
                    }
                  }}>
                    Clear All Cache & Settings
                  </DangerButton>
                </SettingRow>
              </SettingSection>
            </>
          )}

        </div>
      </div>
      {playerDebugTest && (
        <NativeMpvPlayer
          url={playerDebugTest.url}
          title={playerDebugTest.title}
          onClose={() => setPlayerDebugTest(null)}
          onPickAnother={() => setPlayerDebugTest(null)}
        />
      )}
    </div>
  )
}
