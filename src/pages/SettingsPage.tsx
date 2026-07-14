import { lazy, Suspense, useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore, APP_LANGUAGES } from '../stores/appStore'
import { tmdbProvider } from '../services/tmdb'
import type { SearchResult } from '../types'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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
} from '../services/simkl/auth'
import { syncSimkl, getLastSimklSyncTime } from '../services/simkl/sync'
import { syncProviderNow } from '../services/providerSync'
import { getAddonConfigureUrl, loadAddonManifest, installAddon } from '../services/addons'
import { clearAppMetadataCache } from '../services/metadata'
import { stremioLogin, getStremioAddons, saveStremioAuth, getStremioAuth, clearStremioAuth } from '../services/stremio'
import { checkPMDBConnection } from '../services/pmdb'
import type { PMDBConnectionStatus } from '../services/pmdb'
import { checkMdblistConnection, clearMdblistOAuth, exchangeMdblistPKCEToken, getMdblistClientId, getStoredMdblistTokens, hasMdblistOAuth, setMdblistClientId, startMdblistPKCELogin, waitForMdblistCallback, type MdblistPKCESession, type MdblistUser } from '../services/mdblist'
import { fetchAniListViewer, getAniListContinueWatching, getAniListToken, setAniListToken, syncAniListWatchedHistory } from '../services/anilist'
import { getSelfhstIconUrl } from '../services/serviceIcons'
import type { TraktDeviceCode } from '../types'
// Lazy: debug player only loads when the test player is opened
const NativeMpvPlayer = lazy(() => import('../components/NativeMpvPlayer'))
import { cacheStats, cacheRuntimeStats, cacheClearCategory, cacheClearExpired, cacheClearAll } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { checkForUpdate, downloadAndInstall, getAppVersion } from '../services/updater'
import type { UpdateInfo, UpdateProgress } from '../services/updater'
import { useDiscoverPrefsStore, DEFAULT_DISCOVER_PREFS, type DiscoverPrefs } from '../stores/discoverPrefsStore'
import DiscoverPrefsPanel from '../components/DiscoverPrefsPanel'

const BACKUP_KEYS = [
  'tmdb_api_key',
  'tvdb_api_key',
  'trakt_client_id',
  'trakt_client_secret',
  'trakt_tokens',
  'trakt_account',
  'mdblist_api_key',
  'fanart_api_key',
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
  'aurales_hero_trailer_delay',
  'aurales_poster_trailer_previews',
  'aurales_poster_trailer_hover_delay_ms',
  'aurales_poster_trailer_sound',
  'aurales_trailer_volume',
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
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl">
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
    <div
      role="switch"
      tabIndex={0}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[26px] w-[46px] flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 select-none ${checked ? 'bg-green-500' : 'bg-white/15'}`}
    >
      <span className={`pointer-events-none inline-block h-[22px] w-[22px] mt-[2px] ml-[2px] transform rounded-full bg-white shadow ring-0 transition-transform duration-200 ${checked ? 'translate-x-[20px]' : 'translate-x-0'}`} />
    </div>
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
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.id === value)

  const pick = (id: string) => {
    onChange(id)
    setOpen(false)
  }

  return (
    <>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      <div className="relative w-48" style={{ zIndex: open ? 50 : undefined }}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-xl text-sm text-white cursor-pointer transition-colors select-none"
        >
          <span className="truncate">{selected?.name ?? value}</span>
          <svg className={`w-4 h-4 text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
        {open && (
          <div className="absolute z-50 mt-1 w-full bg-[#1a1a1f] border border-white/[0.12] rounded-xl shadow-2xl overflow-hidden">
            {options.map((opt) => (
              <div
                key={opt.id}
                role="button"
                tabIndex={0}
                onClick={() => pick(opt.id)}
                className={`w-full text-left px-3 py-2 text-sm cursor-pointer transition-colors select-none ${
                  opt.id === value
                    ? 'bg-green-500/15 text-green-400'
                    : 'text-white/70 hover:bg-white/[0.08] hover:text-white'
                }`}
              >
                {opt.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function AppUpdateSection() {
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [noUpdate, setNoUpdate] = useState(false)

  const appVersion = getAppVersion()

  const handleCheck = async () => {
    setChecking(true)
    setUpdateError(null)
    setUpdateInfo(null)
    setNoUpdate(false)
    try {
      const info = await checkForUpdate()
      if (info) {
        setUpdateInfo(info)
      } else {
        setNoUpdate(true)
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : 'Failed to check for updates')
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    setInstalling(true)
    setProgress(null)
    try {
      await downloadAndInstall((p) => setProgress(p))
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : 'Update failed')
      setInstalling(false)
    }
  }

  const progressPct = progress && progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null

  return (
    <SettingSection title="App Update" description={`Aurales v${appVersion}`}>
      <div className="px-6 py-4 space-y-4">
        {/* Check / Status row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={[
              'w-9 h-9 rounded-xl flex items-center justify-center border',
              updateInfo ? 'bg-accent/15 border-accent/30 text-accent' : 'bg-white/[0.04] border-white/[0.08] text-white/50',
            ].join(' ')}>
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <div>
              <span className="text-sm font-semibold text-white">
                {updateInfo ? `v${updateInfo.version} available` : noUpdate ? 'Up to date' : `v${appVersion}`}
              </span>
              <p className="text-[11px] text-white/35">
                {checking ? 'Checking for updates...'
                  : installing ? 'Downloading and installing...'
                  : updateInfo ? 'A new version is ready to install'
                  : noUpdate ? 'You are running the latest version'
                  : 'Check for the latest version'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {updateInfo && !installing ? (
              <button
                onClick={handleInstall}
                className="px-4 py-2 bg-accent text-black font-bold rounded-xl text-xs transition-colors hover:bg-accent-hover cursor-pointer"
              >
                Install & Restart
              </button>
            ) : (
              <button
                onClick={handleCheck}
                disabled={checking || installing}
                className={[
                  'px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer',
                  checking || installing
                    ? 'bg-white/[0.04] text-white/30 cursor-not-allowed'
                    : 'bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white',
                ].join(' ')}
              >
                {checking ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3 h-3 border border-white/30 border-t-transparent rounded-full animate-spin" />
                    Checking...
                  </span>
                ) : 'Check for Updates'}
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {installing && (
          <div className="space-y-1.5">
            <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
              {progressPct != null ? (
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              ) : (
                <div className="h-full bg-accent/60 rounded-full animate-pulse" style={{ width: '100%' }} />
              )}
            </div>
            <p className="text-[10px] text-white/30 text-right">
              {progressPct != null ? `${progressPct}%` : progress ? `${(progress.downloaded / 1024 / 1024).toFixed(1)} MB` : 'Preparing...'}
            </p>
          </div>
        )}

        {/* Release notes */}
        {updateInfo?.body && (
          <div className="bg-white/[0.03] rounded-xl p-4 border border-white/[0.06]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-white/30 block mb-2">Release Notes</span>
            <p className="text-xs text-white/60 leading-relaxed whitespace-pre-wrap">{updateInfo.body}</p>
          </div>
        )}

        {/* Error */}
        {updateError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            <p className="text-xs text-red-400">{updateError}</p>
          </div>
        )}
      </div>
    </SettingSection>
  )
}

function CacheManagementSection() {
  const [stats, setStats] = useState<{ totalEntries: number; expiredEntries: number; byCategory: Record<string, number> } | null>(null)
  const [cacheMessage, setCacheMessage] = useState('')
  const [runtimeStats, setRuntimeStats] = useState(cacheRuntimeStats())

  useEffect(() => {
    cacheStats().then(setStats)
    const timer = window.setInterval(() => setRuntimeStats(cacheRuntimeStats()), 2000)
    return () => window.clearInterval(timer)
  }, [])

  const handleClearCategory = async (category: string) => {
    const cleared = await cacheClearCategory(category)
    setCacheMessage(`Cleared ${cleared} entries from ${categoryLabels[category] || category}`)
    cacheStats().then(setStats)
    setTimeout(() => setCacheMessage(''), 3000)
  }

  const handleClearExpired = async () => {
    const cleared = await cacheClearExpired()
    setCacheMessage(`Cleared ${cleared} expired entries`)
    cacheStats().then(setStats)
    setTimeout(() => setCacheMessage(''), 3000)
  }

  const handleClearAll = async () => {
    const cleared = await cacheClearAll()
    setCacheMessage(`Cleared ${cleared} total entries`)
    cacheStats().then(setStats)
    setTimeout(() => setCacheMessage(''), 3000)
  }

  const handleRefreshCatalogs = () => window.location.reload()

  const categoryLabels: Record<string, string> = {
    [CACHE_CATEGORIES.ADDON_CATALOG]: 'Addon Catalogs',
    [CACHE_CATEGORIES.PROVIDER_LIST]: 'Provider Lists',
    [CACHE_CATEGORIES.DISCOVER]: 'Discover',
    [CACHE_CATEGORIES.TMDB_CARD]: 'TMDB Cards',
    [CACHE_CATEGORIES.TVDB_CARD]: 'TVDB Cards',
    [CACHE_CATEGORIES.TMDB_TVDB_ID]: 'TMDB→TVDB IDs',
    [CACHE_CATEGORIES.WATCHED_STATUS]: 'Watch Status',
    [CACHE_CATEGORIES.SIMKL_LIST]: 'Simkl Lists',
    [CACHE_CATEGORIES.ARTWORK]: 'Artwork',
    [CACHE_CATEGORIES.HOME_ROW]: 'Home Rows',
    [CACHE_CATEGORIES.DETAIL_PAGE]: 'Detail Pages',
    [CACHE_CATEGORIES.TVDB_SEASON]: 'Season Data',
    [CACHE_CATEGORIES.ANIME_MAPPING]: 'Anime ID Mappings',
  }

  return (
    <SettingSection title="Performance & Cache" description="SQLite-backed cache for instant page loads.">
      {cacheMessage && (
        <div className="mx-6 mt-4 px-4 py-2 bg-accent/10 border border-accent/20 rounded-xl">
          <p className="text-xs text-accent font-semibold">{cacheMessage}</p>
        </div>
      )}
      {stats && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 px-1 sm:grid-cols-4">
            <div className="rounded-lg bg-white/[0.04] p-2"><div className="text-[10px] uppercase text-white/30">Session</div><div className="text-sm font-bold">{runtimeStats.memoryEntries} entries</div></div>
            <div className="rounded-lg bg-white/[0.04] p-2"><div className="text-[10px] uppercase text-white/30">Memory size</div><div className="text-sm font-bold">{(runtimeStats.approximateBytes / 1024 / 1024).toFixed(1)} MB</div></div>
            <div className="rounded-lg bg-white/[0.04] p-2"><div className="text-[10px] uppercase text-white/30">Refreshing</div><div className="text-sm font-bold">{runtimeStats.pendingRequests}</div></div>
            <div className="rounded-lg bg-white/[0.04] p-2"><div className="text-[10px] uppercase text-white/30">Errors</div><div className="text-sm font-bold">{runtimeStats.errorEntries}</div></div>
          </div>
          <div className="px-1 text-[11px] text-white/35">Last refresh: {runtimeStats.lastRefreshTime ? new Date(runtimeStats.lastRefreshTime).toLocaleString() : 'Not this session'}</div>
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-muted">{stats.totalEntries} cached entries ({stats.expiredEntries} expired)</span>
            <div className="flex gap-2">
              <button onClick={handleRefreshCatalogs} className="px-3 py-1.5 bg-accent/10 hover:bg-accent/20 border border-accent/20 text-accent rounded-lg text-xs font-bold cursor-pointer">
                Refresh Catalogs
              </button>
              <button onClick={handleClearAll} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 hover:text-red-300 rounded-lg text-xs font-bold cursor-pointer">
                Clear All
              </button>
              <button onClick={handleClearExpired} className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white rounded-lg text-xs font-bold cursor-pointer">
                Clear Expired
              </button>
            </div>
          </div>
          {Object.entries(stats.byCategory).filter(([, count]) => count > 0).map(([cat, count]) => (
            <div key={cat} className="flex items-center justify-between px-1 py-1">
              <span className="text-xs text-white/70">{categoryLabels[cat] || cat} ({count})</span>
              <button onClick={() => handleClearCategory(cat)} className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white/60 hover:text-white rounded-lg text-[10px] font-bold cursor-pointer">
                Clear
              </button>
            </div>
          ))}
        </div>
      )}
    </SettingSection>
  )
}

function AnimeIdMappingsSection() {
  const [lookupCacheCount, setLookupCacheCount] = useState<number | null>(null)
  const [animeListCount, setAnimeListCount] = useState<number | null>(null)
  const [aniBridgeCount, setAniBridgeCount] = useState<number | null>(null)

  const refresh = () => {
    cacheStats().then((stats) => {
      setLookupCacheCount(stats.byCategory[CACHE_CATEGORIES.ANIME_MAPPING] || 0)
    })
    import('../services/animeLists')
      .then(({ getStoredAnimeListEntryCount }) => getStoredAnimeListEntryCount())
      .then(setAnimeListCount)
      .catch(() => setAnimeListCount(0))
    import('../services/anime-mapping/anibridgeMappings')
      .then(({ getStoredAniBridgeEntryCount }) => getStoredAniBridgeEntryCount())
      .then(setAniBridgeCount)
      .catch(() => setAniBridgeCount(0))
  }

  useEffect(() => { refresh() }, [])

  return (
    <SettingSection>
      <SettingRow label="Anime-list index entries" description="Fribb anime-list mapping entries stored in browser cache.">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white tabular-nums">
            {animeListCount == null ? 'Loading...' : animeListCount.toLocaleString()}
          </span>
          <button
            onClick={refresh}
            className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white/70 hover:text-white rounded-lg text-xs font-bold cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </SettingRow>
      <SettingRow label="AniBridge episode mappings" description="Episode-level mappings across AniList, MAL, TMDB, TVDB, IMDB, and AniDB stored in browser cache.">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white tabular-nums">
            {aniBridgeCount == null ? 'Loading...' : aniBridgeCount.toLocaleString()}
          </span>
          <button
            onClick={refresh}
            className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white/70 hover:text-white rounded-lg text-xs font-bold cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </SettingRow>
      <SettingRow label="Anime lookup cache" description="Cached results from anime ID lookup services.">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white tabular-nums">
            {lookupCacheCount == null ? 'Loading...' : lookupCacheCount.toLocaleString()}
          </span>
          <button
            onClick={refresh}
            className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white/70 hover:text-white rounded-lg text-xs font-bold cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </SettingRow>
    </SettingSection>
  )
}

function ImageCacheSection({ onClearBackdropCache }: { onClearBackdropCache: () => void }) {
  const store = useAppStore()
  const [cacheInUseMb, setCacheInUseMb] = useState<number | null>(null)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  // Estimate localStorage image cache size
  useEffect(() => {
    let bytes = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (
        key.startsWith('tmdb_backdrop_') ||
        key.startsWith('tmdb_card_metadata_') ||
        key.startsWith('tmdb_tvdb_id_') ||
        key.startsWith('tvdb_card_metadata_') ||
        key.startsWith('orynt_provider_list:') ||
        key.includes('backdrop') ||
        key.includes('poster')
      ) {
        bytes += (localStorage.getItem(key)?.length || 0) * 2
      }
    }
    setCacheInUseMb(Math.max(0, Math.round(bytes / 1024 / 1024 * 10) / 10))
  }, [clearing])

  const handleClear = async () => {
    setClearing(true)
    setCleared(false)
    onClearBackdropCache()
    setTimeout(() => {
      setClearing(false)
      setCleared(true)
      setTimeout(() => setCleared(false), 2500)
    }, 600)
  }

  // Quality option config
  const qualityOptions: { value: 'data-saver' | 'balanced' | 'high'; label: string; desc: string }[] = [
    { value: 'data-saver', label: 'Data Saver', desc: 'Smaller, lower-res images. Best for slow or metered connections.' },
    { value: 'balanced', label: 'Balanced', desc: "Balanced picks the best size for this screen. Most people can't tell the difference from High. Data Saver reduces download sizes further." },
    { value: 'high', label: 'High', desc: 'Full-resolution posters and backdrops. Uses more data and storage.' },
  ]

  // Cache size options
  const sizeOptions: { value: number; label: string }[] = [
    { value: 100, label: '100 MB' },
    { value: 250, label: '250 MB' },
    { value: 500, label: '500 MB' },
    { value: 1000, label: '1 GB' },
    { value: 2000, label: '2 GB' },
  ]

  // Keep duration options
  const keepOptions: { value: number; label: string }[] = [
    { value: 1, label: '1 Day' },
    { value: 3, label: '3 Days' },
    { value: 7, label: '1 Week' },
    { value: 14, label: '2 Weeks' },
    { value: 30, label: '1 Month' },
  ]

  const currentQuality = qualityOptions.find(o => o.value === store.imageQuality) ?? qualityOptions[1]

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-1">
        <h3 className="text-[15px] font-semibold text-white">Image Cache</h3>
        <p className="text-[13px] text-white/40 mt-0.5">Control how posters and backdrops are stored on this device.</p>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {/* Image Quality */}
        <div>
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <p className="text-[14px] text-white font-medium">Image Quality</p>
            <div className="relative">
              <select
                value={store.imageQuality}
                onChange={(e) => store.setImageQuality(e.target.value as 'data-saver' | 'balanced' | 'high')}
                className="appearance-none pl-3 pr-8 py-2 bg-white/[0.06] hover:bg-white/[0.09] border border-white/[0.08] rounded-xl text-[13px] text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50 transition-colors"
              >
                {qualityOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
            </div>
          </div>
          <p className="px-6 pb-4 text-[12px] text-white/35 leading-relaxed -mt-1">{currentQuality.desc}</p>
        </div>

        {/* Disk Cache Size */}
        <div>
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <p className="text-[14px] text-white font-medium">Disk Cache Size</p>
            <div className="relative">
              <select
                value={store.imageCacheSizeMb}
                onChange={(e) => store.setImageCacheSizeMb(Number(e.target.value))}
                className="appearance-none pl-3 pr-8 py-2 bg-white/[0.06] hover:bg-white/[0.09] border border-white/[0.08] rounded-xl text-[13px] text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50 transition-colors"
              >
                {sizeOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
            </div>
          </div>
          <p className="px-6 pb-4 text-[12px] text-white/35 leading-relaxed -mt-1">How much disk space cached posters and backdrops may use. Older images are removed automatically when the limit is reached.</p>
        </div>

        {/* Keep Images For */}
        <div>
          <div className="flex items-center justify-between gap-4 px-6 py-4">
            <p className="text-[14px] text-white font-medium">Keep Images For</p>
            <div className="relative">
              <select
                value={store.imageKeepDays}
                onChange={(e) => store.setImageKeepDays(Number(e.target.value))}
                className="appearance-none pl-3 pr-8 py-2 bg-white/[0.06] hover:bg-white/[0.09] border border-white/[0.08] rounded-xl text-[13px] text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50 transition-colors"
              >
                {keepOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
            </div>
          </div>
          <p className="px-6 pb-4 text-[12px] text-white/35 leading-relaxed -mt-1">How long images stay cached before they are re-downloaded. Longer keeps the app fast on slow connections; shorter picks up artwork changes sooner.</p>
        </div>

        {/* Cache in Use + Clear */}
        <div className="px-6 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[14px] text-white font-medium">Cache in Use</p>
            <span className="text-[14px] text-white/50 font-semibold tabular-nums">
              {cacheInUseMb == null ? '—' : `${cacheInUseMb} MB`}
            </span>
          </div>
          <div className="border-t border-white/[0.04] pt-3">
            <button
              onClick={handleClear}
              disabled={clearing}
              className="text-[14px] font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              style={{ color: cleared ? 'rgb(134 239 172)' : 'rgb(239 68 68)' }}
            >
              {clearing ? 'Clearing…' : cleared ? '✓ Cache Cleared' : 'Clear Image Cache'}
            </button>
            <p className="text-[12px] text-white/35 mt-1.5 leading-relaxed">Images re-download as needed after clearing.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ArtProviderSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value === 'default' ? 'tmdb' : value}
      onChange={(e) => onChange(e.target.value)}
      className="w-36 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
    >
      <option value="tmdb">TMDb</option>
      <option value="tvdb">TVDb</option>
      <option value="fanart">Fanart.tv</option>
    </select>
  )
}

function ArtworkSettingsSection() {
  const artProviders = useAppStore((s) => s.artProviders)
  const setArtProviders = useAppStore((s) => s.setArtProviders)
  const customArtUrls = useAppStore((s) => s.customArtUrls)
  const setCustomArtUrls = useAppStore((s) => s.setCustomArtUrls)
  const btttrPosterUrl = 'https://btttr.cc/poster/auto/{imdb_id}/auto.png'

  const updateProvider = (key: string, value: string) => {
    setArtProviders({ ...artProviders, [key]: value })
  }

  const updateCustomUrl = (key: string, value: string) => {
    setCustomArtUrls({ ...customArtUrls, [key]: value })
  }

  const sections = [
    { title: 'Movies', color: 'text-amber-400/80', prefix: 'movie' },
    { title: 'Series', color: 'text-blue-400/80', prefix: 'series' },
    { title: 'Anime', color: 'text-pink-400/80', prefix: 'anime' },
  ] as const

  return (
    <>
      {sections.map(({ title, color, prefix }) => (
        <div key={prefix}>
          <h3 className={`text-sm font-bold ${color} ${prefix !== 'movie' ? 'mt-8' : ''} mb-3`}>{title}</h3>
          <SettingSection>
            <SettingRow label="Poster provider" description={`Source for ${title.toLowerCase()} poster artwork.`}>
              <ArtProviderSelect
                value={(artProviders as any)[`${prefix}Poster`]}
                onChange={(v) => updateProvider(`${prefix}Poster`, v)}
              />
            </SettingRow>
            <SettingRow label="Background provider" description={`Source for ${title.toLowerCase()} backdrop/background artwork.`}>
              <ArtProviderSelect
                value={(artProviders as any)[`${prefix}Backdrop`]}
                onChange={(v) => updateProvider(`${prefix}Backdrop`, v)}
              />
            </SettingRow>
            <SettingRow label="Logo provider" description={`Source for ${title.toLowerCase()} title logo artwork.`}>
              <ArtProviderSelect
                value={(artProviders as any)[`${prefix}Logo`]}
                onChange={(v) => updateProvider(`${prefix}Logo`, v)}
              />
            </SettingRow>
          </SettingSection>
        </div>
      ))}

      <h3 className="text-sm font-bold text-emerald-400/80 mt-8 mb-3">Custom Art URL Overrides</h3>
      <SettingSection description="Custom URL patterns replace the default artwork everywhere. Use placeholders: {imdb_id}, {tmdb_id}, {tvdb_id}, {mal_id}, {anilist_id}, {type}, {season}, {episode}">
        <SettingRow label="Poster URL pattern" description="e.g. https://example.com/poster/{imdb_id}.jpg">
          <div className="flex items-center gap-2">
            <select
              value={customArtUrls.posterUrl === btttrPosterUrl ? btttrPosterUrl : customArtUrls.posterUrl ? 'custom' : ''}
              onChange={(e) => {
                if (e.target.value === 'custom') updateCustomUrl('posterUrl', 'https://example.com/poster/{imdb_id}.jpg')
                else updateCustomUrl('posterUrl', e.target.value)
              }}
              className="w-36 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
            >
              <option value="">None</option>
              <option value={btttrPosterUrl}>btttr.cc</option>
              <option value="custom">Custom</option>
            </select>
            <input
              type="text"
              value={customArtUrls.posterUrl}
              onChange={(e) => updateCustomUrl('posterUrl', e.target.value)}
              placeholder="Leave empty to use provider"
              className="w-80 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/25 focus:outline-none focus:border-accent/50"
            />
          </div>
        </SettingRow>
        <SettingRow label="Background URL pattern" description="e.g. https://example.com/backdrop/{tmdb_id}.jpg">
          <input
            type="text"
            value={customArtUrls.backdropUrl}
            onChange={(e) => updateCustomUrl('backdropUrl', e.target.value)}
            placeholder="Leave empty to use provider"
            className="w-80 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/25 focus:outline-none focus:border-accent/50"
          />
        </SettingRow>
        <SettingRow label="Logo URL pattern" description="e.g. https://example.com/logo/{tmdb_id}.png">
          <input
            type="text"
            value={customArtUrls.logoUrl}
            onChange={(e) => updateCustomUrl('logoUrl', e.target.value)}
            placeholder="Leave empty to use provider"
            className="w-80 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/25 focus:outline-none focus:border-accent/50"
          />
        </SettingRow>
        <SettingRow label="Episode thumbnail URL pattern" description="e.g. https://example.com/ep/{tmdb_id}/S{season}E{episode}.jpg">
          <input
            type="text"
            value={customArtUrls.episodeThumbnailUrl}
            onChange={(e) => updateCustomUrl('episodeThumbnailUrl', e.target.value)}
            placeholder="Leave empty to use provider"
            className="w-80 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-white/25 focus:outline-none focus:border-accent/50"
          />
        </SettingRow>
      </SettingSection>

      <div className="mt-4 px-1">
        <p className="text-xs text-white/30">Custom URL patterns take priority over all providers. If a pattern is set and resolves successfully (all placeholders filled, valid URL), it replaces the default art everywhere — home, discover, detail pages, and cards.</p>
        <div className="mt-3 bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
          <p className="text-xs font-semibold text-white/50 mb-2">Available placeholders</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-white/40">
            <span><code className="text-accent/70">{'{imdb_id}'}</code> — IMDb ID (tt1234567)</span>
            <span><code className="text-accent/70">{'{tmdb_id}'}</code> — TMDb numeric ID</span>
            <span><code className="text-accent/70">{'{tvdb_id}'}</code> — TVDb numeric ID</span>
            <span><code className="text-accent/70">{'{mal_id}'}</code> — MyAnimeList ID</span>
            <span><code className="text-accent/70">{'{anilist_id}'}</code> — AniList ID</span>
            <span><code className="text-accent/70">{'{type}'}</code> — movie or series</span>
            <span><code className="text-accent/70">{'{season}'}</code> — Season number</span>
            <span><code className="text-accent/70">{'{episode}'}</code> — Episode number</span>
          </div>
        </div>
      </div>
    </>
  )
}

function SearchSettingsSection() {
  const movieSearchEngine = useAppStore((s) => s.movieSearchEngine)
  const seriesSearchEngine = useAppStore((s) => s.seriesSearchEngine)
  const animeSeriesSearchEngine = useAppStore((s) => s.animeSeriesSearchEngine)
  const animeMovieSearchEngine = useAppStore((s) => s.animeMovieSearchEngine)
  const movieSearchEnabled = useAppStore((s) => s.movieSearchEnabled)
  const seriesSearchEnabled = useAppStore((s) => s.seriesSearchEnabled)
  const animeSeriesSearchEnabled = useAppStore((s) => s.animeSeriesSearchEnabled)
  const animeMovieSearchEnabled = useAppStore((s) => s.animeMovieSearchEnabled)
  const setMovieSearchEngine = useAppStore((s) => s.setMovieSearchEngine)
  const setSeriesSearchEngine = useAppStore((s) => s.setSeriesSearchEngine)
  const setAnimeSeriesSearchEngine = useAppStore((s) => s.setAnimeSeriesSearchEngine)
  const setAnimeMovieSearchEngine = useAppStore((s) => s.setAnimeMovieSearchEngine)
  const setMovieSearchEnabled = useAppStore((s) => s.setMovieSearchEnabled)
  const setSeriesSearchEnabled = useAppStore((s) => s.setSeriesSearchEnabled)
  const setAnimeSeriesSearchEnabled = useAppStore((s) => s.setAnimeSeriesSearchEnabled)
  const setAnimeMovieSearchEnabled = useAppStore((s) => s.setAnimeMovieSearchEnabled)
  const openrouterApiKey = useAppStore((s) => s.openrouterApiKey)
  const openrouterModel = useAppStore((s) => s.openrouterModel)

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
            <SearchEngineSelect value={movieSearchEngine} onChange={setMovieSearchEngine} options={movieOptions} />
            <SettingToggle checked={movieSearchEnabled} onChange={setMovieSearchEnabled} />
          </div>
        </SettingRow>
        <SettingRow label="Series Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={seriesSearchEngine} onChange={setSeriesSearchEngine} options={seriesOptions} />
            <SettingToggle checked={seriesSearchEnabled} onChange={setSeriesSearchEnabled} />
          </div>
        </SettingRow>
        <SettingRow label="Anime (Series) Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={animeSeriesSearchEngine} onChange={setAnimeSeriesSearchEngine} options={animeSeriesOptions} />
            <SettingToggle checked={animeSeriesSearchEnabled} onChange={setAnimeSeriesSearchEnabled} />
          </div>
        </SettingRow>
        <SettingRow label="Anime (Movies) Search Engine:">
          <div className="flex items-center gap-2">
            <SearchEngineSelect value={animeMovieSearchEngine} onChange={setAnimeMovieSearchEngine} options={animeMovieOptions} />
            <SettingToggle checked={animeMovieSearchEnabled} onChange={setAnimeMovieSearchEnabled} />
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title="AI-Powered Search" description="Configure the AI model in the Accounts tab under OpenRouter.">
        <SettingRow label="Status" description="AI search uses your OpenRouter API key to interpret natural language queries.">
          <span className={`text-xs font-semibold ${openrouterApiKey ? 'text-green-400' : 'text-white/30'}`}>
            {openrouterApiKey ? `Active — ${openrouterModel || 'default model'}` : 'Not configured'}
          </span>
        </SettingRow>
      </SettingSection>
    </>
  )
}

interface PriorityItemProps {
  id: string
  label: string
  connected: boolean
}

function SortablePriorityItem({ id, label, connected }: PriorityItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center justify-between p-3 bg-white/[0.02] border border-white/[0.06] rounded-xl"
    >
      <div className="flex items-center gap-3">
        <button
          {...attributes}
          {...listeners}
          className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 cursor-grab text-white/40 hover:text-white transition-colors"
          type="button"
          aria-label={`Drag ${label}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
            <path d="M4 8h16M4 16h16" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-white">{label}</span>
      </div>
      <div>
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider ${
          connected ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-white/5 text-white/30 border border-white/5'
        }`}>
          {connected ? 'Connected' : 'Not Connected'}
        </span>
      </div>
    </div>
  )
}

function ResumePriorityList() {
  const store = useAppStore()
  
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = store.resumePriorityOrder.indexOf(active.id as any)
    const newIndex = store.resumePriorityOrder.indexOf(over.id as any)
    const nextOrder = arrayMove(store.resumePriorityOrder, oldIndex, newIndex)
    store.setResumePriorityOrder(nextOrder)
  }

  const serviceLabels: Record<string, string> = {
    local: 'Local Database',
    simkl: 'Simkl',
    trakt: 'Trakt',
    pmdb: 'PMDB',
    mdblist: 'MDBList',
  }

  const isServiceConnected = (id: string) => {
    if (id === 'local') return true
    if (id === 'simkl') return store.simklConnected
    if (id === 'trakt') return store.traktConnected
    if (id === 'pmdb') return !!store.pmdbApiKey
    if (id === 'mdblist') return !!store.mdblistApiKey || hasMdblistOAuth()
    return false
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={store.resumePriorityOrder} strategy={verticalListSortingStrategy}>
        <div className="space-y-2 max-w-md">
          {store.resumePriorityOrder.map((id) => (
            <SortablePriorityItem
              key={id}
              id={id}
              label={serviceLabels[id] || id}
              connected={isServiceConnected(id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

const AUDIENCE_OPTIONS = [
  { mode: 'auto', title: 'AUTO', subtitle: 'Infer from taste' },
  { mode: 'grown-up', title: 'GROWN-UP', subtitle: 'Block kids networks' },
  { mode: 'kid-safe', title: 'KID-SAFE', subtitle: 'Family-friendly only' },
] as const

function ManualHeroPicker() {
  const selected = useAppStore((s) => s.fixedHeroManualItem)
  const setSelected = useAppStore((s) => s.setFixedHeroManualItem)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      tmdbProvider.search(query.trim()).then((items) => {
        if (!cancelled) setResults(items.filter((item) => Boolean(item.backdrop)).slice(0, 6))
      }).catch(() => { if (!cancelled) setResults([]) }).finally(() => { if (!cancelled) setLoading(false) })
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query])

  return <div className="w-80">
    {selected && <div className="mb-2 flex items-center justify-between rounded-xl bg-white/[.05] px-3 py-2 text-xs"><span className="truncate">{selected.title}{selected.year ? ` (${selected.year})` : ''}</span><button onClick={() => setSelected(null)} className="ml-2 text-white/45 hover:text-white">Remove</button></div>}
    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and shows…" className="w-full rounded-xl border border-white/[.08] bg-white/[.04] px-3 py-2 text-sm outline-none focus:border-accent/50" />
    {(loading || results.length > 0) && <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-white/[.08] bg-[#151515] p-1 shadow-2xl">
      {loading ? <p className="px-3 py-2 text-xs text-white/40">Searching…</p> : results.map((item) => <button key={`${item.type}:${item.id}`} onClick={() => { setSelected(item); setQuery(''); setResults([]) }} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/[.08]">
        {item.poster && <img src={item.poster} alt="" className="h-12 w-8 rounded object-cover" />}
        <span className="min-w-0"><span className="block truncate text-sm font-semibold">{item.title}</span><span className="text-xs text-white/40">{item.year || 'Unknown year'} · {item.type === 'series' ? 'Show' : 'Movie'}</span></span>
      </button>)}
    </div>}
  </div>
}

export default function SettingsPage() {
  const store = useAppStore()
  const wtStore = useWatchTogetherStore()
  const [activeTab, setActiveTab] = useState<'accounts' | 'addons' | 'metadata' | 'artwork' | 'search' | 'progress' | 'subtitles' | 'player' | 'advanced' | 'interface' | 'watch-together' | 'discovery'>('accounts')
  
  const prefs = useDiscoverPrefsStore((s) => s.prefs)
  const setPrefs = useDiscoverPrefsStore((s) => s.setPrefs)
  const [localPrefs, setLocalPrefs] = useState<DiscoverPrefs>(prefs)

  useEffect(() => {
    setLocalPrefs(prefs)
  }, [prefs])

  const handlePrefsChange = (patch: Partial<DiscoverPrefs>) => {
    setLocalPrefs((prev) => ({ ...prev, ...patch }))
  }

  const handleReset = () => {
    setLocalPrefs(DEFAULT_DISCOVER_PREFS)
  }

  const handleCancel = () => {
    setLocalPrefs(prefs)
  }

  const handleSave = () => {
    setPrefs(localPrefs)
  }
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

  const [stremioEmail, setStremioEmail] = useState('')
  const [stremioPassword, setStremioPassword] = useState('')
  const [stremioAuthKey, setStremioAuthKey] = useState('')
  const [stremioLoading, setStremioLoading] = useState(false)
  const [stremioError, setStremioError] = useState('')
  const [stremioAuth, setStremioAuth] = useState(getStremioAuth)
  const [backdropCacheMessage, setBackdropCacheMessage] = useState('')

  const [pmdbConnStatus, setPmdbConnStatus] = useState<PMDBConnectionStatus | null>(null)
  const [pmdbConnChecking, setPmdbConnChecking] = useState(false)
  const [mdblistConnStatus, setMdblistConnStatus] = useState<{ connected: boolean; user?: MdblistUser; error?: string } | null>(null)
  const [mdblistConnChecking, setMdblistConnChecking] = useState(false)
  const [mdblistClientIdInput, setMdblistClientIdInput] = useState(getMdblistClientId)
  const [mdblistOAuthPolling, setMdblistOAuthPolling] = useState(false)
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

  const testMdblistConnection = async () => {
    setMdblistConnChecking(true)
    setMdblistConnStatus(null)
    const status = await checkMdblistConnection()
    setMdblistConnStatus(status)
    setMdblistConnChecking(false)
  }

  const handleMdblistOAuthConnect = async () => {
    setMdblistConnChecking(true)
    setMdblistConnStatus(null)
    try {
      setMdblistClientId(mdblistClientIdInput)
      const { authUrl, session } = await startMdblistPKCELogin()
      setMdblistOAuthPolling(true)

      const callbackPromise = waitForMdblistCallback()
      await invoke('open_simkl_auth', { url: authUrl })

      const code = await callbackPromise
      if (!code) throw new Error('MDBList did not return an authorization code.')

      await exchangeMdblistPKCEToken(code, session)
      setMdblistOAuthPolling(false)
      const status = await checkMdblistConnection()
      setMdblistConnStatus(status)
    } catch (err: any) {
      setMdblistOAuthPolling(false)
      setMdblistConnStatus({ connected: false, error: err?.message || 'MDBList OAuth failed' })
    } finally {
      setMdblistConnChecking(false)
    }
  }

  const handleMdblistOAuthDisconnect = () => {
    clearMdblistOAuth()
    setMdblistOAuthPolling(false)
    setMdblistConnStatus(null)
  }

  const getAnilistClientId = () => localStorage.getItem('anilist_client_id') || import.meta.env.VITE_ANILIST_CLIENT_ID || '43411'
  const getAnilistClientSecret = () => localStorage.getItem('anilist_client_secret') || import.meta.env.VITE_ANILIST_CLIENT_SECRET || ''

  const handleAnilistConnect = async () => {
    setAnilistLoading(true)
    setAnilistMessage('')
    try {
      const clientId = getAnilistClientId()
      const clientSecret = getAnilistClientSecret()
      if (!clientId) {
        throw new Error('AniList client ID not configured.')
      }

      setAnilistMessage('Waiting for browser authorization callback...')
      const callbackServerPromise = invoke<string>('start_anilist_callback_server')

      const redirectUri = 'http://localhost:42814/'
      const responseType = clientSecret ? 'code' : 'token'
      const authUrl = `https://anilist.co/api/v2/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=${responseType}`
      await invoke('open_simkl_auth', { url: authUrl })

      setAnilistMessage('Waiting for AniList authorization...')
      const callbackResult = await callbackServerPromise
      if (!callbackResult) {
        throw new Error('AniList did not return a response.')
      }

      let token: string
      if (clientSecret) {
        const tokenJson = await invoke<string>('exchange_anilist_token', {
          code: callbackResult,
          clientId,
          clientSecret,
          redirectUri,
        })
        const tokenData = JSON.parse(tokenJson)
        token = tokenData.access_token
        if (!token) throw new Error('AniList token exchange did not return an access token.')
      } else {
        token = callbackResult
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
      const msg = typeof err === 'string' ? err : err?.message || 'AniList connection failed'
      setAnilistMessage(msg)
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
      const msg = typeof err === 'string' ? err : err?.message || 'AniList connection failed'
      setAnilistMessage(msg)
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
    setAnilistMessage('Syncing from AniList…')
    try {
      const report = await syncAniListWatchedHistory()
      // Warm the continue-watching cache too (best-effort).
      await getAniListContinueWatching().catch(() => undefined)
      // Refresh the watched snapshot so checkmarks update immediately.
      const { refreshWatchedCache } = await import('../services/watchedCacheSync')
      await refreshWatchedCache(store.watchedCheckmarkSources as any).catch(() => undefined)

      if (report.errors.length && report.found === 0) {
        setAnilistMessage(report.errors[0])
      } else {
        const parts = [
          `Found ${report.found} anime`,
          `matched ${report.matched}`,
          `${report.episodesImported} episodes imported`,
        ]
        if (report.unmatched.length) parts.push(`${report.unmatched.length} unmatched`)
        if (report.errors.length) parts.push(`${report.errors.length} error${report.errors.length === 1 ? '' : 's'}`)
        setAnilistMessage(parts.join(' · '))
      }
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
      (!store.simklAccount.avatar || !store.simklAccount.avatar.includes('wsrv.nl/?url=https://simkl.in'))

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
        byId.set(addon.manifest.id, { ...addon, enabled: existing.enabled, displayName: existing.displayName })
        updated++
      }
    }

    store.setAddons(Array.from(byId.values()))
    return { imported, updated }
  }

  const handleTraktConnect = async () => {
    if (!hasTraktClientCredentials()) {
      setTraktError('Trakt requires app credentials for device authorization. Add your Trakt Client ID and Client Secret below.')
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
        } catch (_) {
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
    a.download = `aurales_settings_backup_${new Date().toISOString().slice(0, 10)}.json`
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
          setBackdropCacheMessage('Invalid backup file format.')
          setTimeout(() => setBackdropCacheMessage(''), 3000)
          return
        }
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && typeof value === 'string') {
            localStorage.setItem(key, value)
          } else {
            localStorage.removeItem(key)
          }
        }
        window.location.reload()
      } catch (err) {
        setBackdropCacheMessage('Failed to import: ' + (err instanceof Error ? err.message : String(err)))
        setTimeout(() => setBackdropCacheMessage(''), 4000)
      }
    }
    reader.readAsText(file)
  }

  const handleClearBackdropCache = () => {
    let clearedCount = 0
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('tmdb_backdrop_') || key.startsWith('tmdb_card_metadata_') || key.startsWith('tmdb_tvdb_id_') || key.startsWith('tvdb_card_metadata_') || key.startsWith('orynt_provider_list:') || key.includes('backdrop'))) {
        localStorage.removeItem(key)
        clearedCount++
      }
    }
    setBackdropCacheMessage(`Cleared ${clearedCount} cached image entries.`)
    setTimeout(() => setBackdropCacheMessage(''), 3000)
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
          id: 'artwork',
          label: 'Artwork',
          description: 'Art providers, custom poster/backdrop/logo URLs, and overrides.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <rect x="3" y="3" width="18" height="18" rx="2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 15-5-5L5 21" />
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
          id: 'subtitles',
          label: 'Audio & Subtitles',
          description: 'Language preferences, subtitle styling, and live translation.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="16" rx="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 11h6M6 15h10" strokeLinecap="round" />
            </svg>
          )
        },
        {
          id: 'watch-together',
          label: 'Watch Together',
          description: 'Server URL, nickname, sync, and room control defaults.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
            </svg>
          )
        },
        {
          id: 'discovery',
          label: 'Discovery & Taste',
          description: 'Tune recommendation weights, language/genre filters, and content ratings.',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707M12 5a7 7 0 100 14 7 7 0 000-14z" />
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
          description: 'Hardware decoding, buffering, and playback behavior.',
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

  const cinematicTheme = store.interfaceTheme === 'cinematic'

  return (
    <div className="flex h-full">
      {/* ─── Left Sidebar ─── */}
      <div className="w-60 flex-shrink-0 border-r border-white/[0.06] overflow-y-auto p-3 space-y-5 pt-32">
        {categories.map((cat) => (
          <div key={cat.title}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 px-3 mb-1.5">{cat.title}</div>
            <div className="space-y-0.5">
              {cat.items.map((item) => {
                const active = activeTab === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => { setActiveTab(item.id as any) }}
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
      <div className="flex-1 overflow-y-auto p-8 pt-32">
        <h1 className="text-2xl font-bold text-white mb-0.5">{activeItem?.label ?? 'Settings'}</h1>
        <p className="text-[13px] text-white/35 mb-8">{activeItem?.description ?? ''}</p>

        <div className="space-y-6 max-w-3xl">

          {/* ═══════════════════════════════════════════════
              ACCOUNTS TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'accounts' && (
            <>
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
                            Trakt's device token flow requires a client secret. Aurales does not bundle that secret, so add your own Trakt app credentials to connect.
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
                              This is stored locally on this device. Bundling a shared Trakt client secret would expose it in the released app.
                            </p>
                          </div>
                        </div>
                      )}
                      {traktError && <p className="text-xs text-red-400">{traktError}</p>}
                    </div>
                  )}
                </div>
              </SettingSection>

              {/* Simkl */}
              <SettingSection title="Simkl" description="Sync watchlist, watching, and watch history.">
                <div className="px-6 py-4">
                  {simklStatus.connected || store.simklConnected ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between bg-white/[0.03] rounded-xl p-4 border border-white/[0.06]">
                        <div className="flex items-center gap-3">
                          {(simklStatus.account?.avatar || store.simklAccount?.avatar) ? (
                            <img src={simklStatus.account?.avatar || store.simklAccount?.avatar} alt="" className="w-10 h-10 rounded-full object-cover border border-[#2ecc71]/35" />
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
                          Aurales opened Simkl in your browser. Enter the code below on Simkl, click Allow, and Aurales will connect automatically.
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

              {/* AniList */}
              <SettingSection title="AniList" description="Track anime watch progress, manage lists, and sync history.">
                <div className="px-6 py-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAnilistConnect}
                      disabled={anilistLoading}
                      className="px-3.5 py-2 bg-accent text-black rounded-xl text-xs font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {anilistLoading ? 'Connecting...' : store.anilistConnected ? 'Reconnect AniList' : 'Connect AniList'}
                    </button>
                    <button
                      onClick={syncAniListNow}
                      disabled={anilistLoading || !store.anilistConnected}
                      className="px-3.5 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-white/5 text-white rounded-xl text-xs font-semibold cursor-pointer"
                    >
                      {anilistLoading ? 'Syncing…' : 'Sync from AniList'}
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

              {/* Stremio */}
              <SettingSection title="Stremio Account" description="Import your addon collection from Stremio.">
                <div className="px-6 py-4">
                  {stremioAuth ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between bg-white/[0.03] rounded-xl p-4 border border-white/[0.06]">
                        <div className="flex items-center gap-3">
                          <div className="w-3.5 h-3.5 rounded-full bg-accent animate-pulse" />
                          <div>
                            <span className="text-sm font-semibold text-white">Connected</span>
                            <p className="text-xs text-white/40 mt-0.5">{stremioAuth.email}</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleStremioSync}
                            disabled={stremioLoading}
                            className="px-3.5 py-2 bg-accent/10 hover:bg-accent/20 text-accent rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
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
                        className="px-5 py-2.5 bg-accent hover:bg-accent/80 disabled:opacity-50 text-black font-semibold rounded-xl text-sm transition-colors cursor-pointer"
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

              {/* Discord Rich Presence */}
              <SettingSection title="Discord Rich Presence" description="Show what you're watching on your Discord profile.">
                <SettingRow label="Enable Discord Rich Presence" description="Requires Discord desktop app to be running.">
                  <SettingToggle checked={store.discordRichPresence} onChange={(v) => store.setDiscordRichPresence(v)} />
                </SettingRow>
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

              {/* MDBList */}
              <SettingSection title="MDBList" description="Ratings, watchlist, lists, continue watching, watched history, and scrobbling.">
                <div className="px-6 py-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={handleMdblistOAuthConnect}
                      disabled={mdblistConnChecking || mdblistOAuthPolling || !mdblistClientIdInput}
                      className="px-4 py-2 bg-accent text-black hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-all"
                    >
                      {mdblistOAuthPolling ? 'Waiting for MDBList...' : getStoredMdblistTokens() ? 'Reconnect MDBList' : 'Connect MDBList'}
                    </button>
                    {getStoredMdblistTokens() && (
                      <button
                        onClick={handleMdblistOAuthDisconnect}
                        className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl text-sm font-semibold transition-colors"
                      >
                        Disconnect OAuth
                      </button>
                    )}
                  </div>

                  <div>
                    <label className="text-xs text-white/40 mb-1.5 block font-semibold uppercase">MDBList API Key</label>
                    <input
                      type="password"
                      value={store.mdblistApiKey}
                      onChange={(e) => { store.setMdblistApiKey(e.target.value); setMdblistConnStatus(null) }}
                      placeholder="Enter your MDBList API key"
                      className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                    />
                    <p className="text-[11px] text-white/30 mt-1">
                      Optional fallback. Empty key still uses Aurales' built-in MDBList key for ratings only. Account features use OAuth or your own key. API docs:{' '}
                      <a href="https://api.mdblist.com/docs/" target="_blank" rel="noreferrer" className="text-accent hover:underline">api.mdblist.com/docs</a>
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={testMdblistConnection}
                      disabled={(!store.mdblistApiKey && !getStoredMdblistTokens()) || mdblistConnChecking}
                      className="flex items-center gap-2 px-4 py-2 bg-accent/15 border border-accent/30 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-all"
                    >
                      {mdblistConnChecking ? (
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

                    {mdblistConnStatus && !mdblistConnChecking && (
                      mdblistConnStatus.connected ? (
                        <span className="flex items-center gap-1.5 text-sm text-green-400 font-medium">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Connected
                          {mdblistConnStatus.user?.username && <span className="text-white/30 ml-1">({mdblistConnStatus.user.username}{mdblistConnStatus.user.plan ? `, ${mdblistConnStatus.user.plan}` : ''})</span>}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-sm text-red-400">
                          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round"/>
                          </svg>
                          <span>{mdblistConnStatus.error}</span>
                        </span>
                      )
                    )}
                  </div>
                </div>
              </SettingSection>

              {/* Fanart.tv */}
              <SettingSection title="Fanart.tv" description="High-quality poster, backdrop, and logo artwork from the Fanart.tv community.">
                <SettingRow label="API Key" description="Get a free personal key at fanart.tv/get-an-api-key">
                  <input
                    type="password"
                    value={store.fanartApiKey}
                    onChange={(e) => store.setFanartApiKey(e.target.value)}
                    placeholder="Enter your Fanart.tv API key"
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-mono focus:outline-none focus:border-accent/50"
                  />
                </SettingRow>
              </SettingSection>

              {/* Metadata Providers */}
              <SettingSection title="Metadata Providers" description="API keys for movie and show detail pages.">
                <SettingRow label="TMDB API Key" description="Optional. Leave empty to use the app's built-in TMDB key.">
                  <input
                    type="text"
                    value={store.tmdbApiKey}
                    onChange={(e) => store.setTmdbApiKey(e.target.value)}
                    placeholder="Using built-in app key"
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                  />
                </SettingRow>
                <SettingRow label="TVDB API Key" description="Optional. Leave empty to use the app's built-in TVDB key.">
                  <input
                    type="text"
                    value={store.tvdbApiKey}
                    onChange={(e) => store.setTvdbApiKey(e.target.value)}
                    placeholder="Using built-in app key"
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white focus:outline-none focus:border-accent/50"
                  />
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
                          <input
                            defaultValue={addon.displayName ?? addon.manifest.name}
                            onBlur={(event) => store.renameAddon(addon.manifest.id, event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                            aria-label={`Rename ${addon.manifest.name}`}
                            className="w-full max-w-sm rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-bold text-white outline-none hover:border-white/10 hover:bg-white/[0.04] focus:border-accent/50 focus:bg-white/[0.06]"
                          />
                          <div className="text-xs text-white/35 truncate mt-0.5">{addon.manifest.description || addon.url}</div>

                        </div>
                      </div>
                      <div className="ml-3 flex flex-shrink-0 items-center gap-3">
                        <a
                          href={getAddonConfigureUrl(addon.url)}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg bg-white/[0.07] px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:bg-white/[0.12] hover:text-white"
                        >
                          Configure
                        </a>
                        <button
                          onClick={() => store.removeAddon(addon.manifest.id)}
                          className="text-xs text-red-400 hover:text-red-300 font-semibold transition-colors cursor-pointer"
                        >
                          Remove
                        </button>
                      </div>
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
              <SettingSection title="Interface Theme" description="Choose the classic Aurales layout or a cinematic TV-focused browsing experience.">
                <SettingRow label="Theme" description="Cinematic TV uses larger focus targets and unified horizontal rows. Navigation is configured separately below.">
                  <select
                    value={store.interfaceTheme}
                    onChange={(event) => store.setInterfaceTheme(event.target.value as 'default' | 'cinematic')}
                    className="w-52 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="default">Default Aurales</option>
                    <option value="cinematic">Cinematic TV</option>
                  </select>
                </SettingRow>
                <SettingRow label="Background" description="Choose between the default theme's OLED black or the Cinematic TV background color.">
                  <select
                    value={store.themeBackground}
                    onChange={(event) => store.setThemeBackground(event.target.value as 'theme' | 'oled')}
                    className="w-52 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="theme">Theme default</option>
                    <option value="oled">Pure Black (OLED)</option>
                  </select>
                </SettingRow>
                <SettingRow label="Navigation" description="Choose either navigation layout independently from the interface theme.">
                  <select
                    value={store.navigationStyle}
                    onChange={(event) => store.setNavigationStyle(event.target.value as 'sidebar' | 'topbar')}
                    className="w-52 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="sidebar">Sidebar</option>
                    <option value="topbar">Cinematic top bar</option>
                  </select>
                </SettingRow>
                <SettingRow label="Poster size" description="Scale posters and cards across Home, Discover, and your library.">
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
                </SettingRow>
              </SettingSection>

              <SettingSection title="Home Hero" description="Choose how the featured area behaves on the home page in both interface themes.">
                <SettingRow label="Hero mode" description="Dynamic Focus rotates the current hero; Fixed Featured Hero stays stable for the visit.">
                  <select value={store.homeHeroMode} onChange={(event) => store.setHomeHeroMode(event.target.value as typeof store.homeHeroMode)} className="w-56 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold">
                    <option value="dynamic">Dynamic Focus</option><option value="fixed">Fixed Featured Hero</option><option value="disabled">Disabled</option>
                  </select>
                </SettingRow>
              </SettingSection>

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
              <SettingSection title="Startup Page" description="Which page Aurales lands on at launch.">
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


              {/* Card overlays */}
              <SettingSection>
                <SettingRow label="Show Ratings on Media Cards" description="Render rating badges on card thumbnails.">
                  <SettingToggle checked={store.showRatingsOnCards} onChange={(v) => store.setShowRatingsOnCards(v)} />
                </SettingRow>
                <SettingRow label="Show Genre on Media Cards" description="Display genre label on poster cards. Disabling can speed up catalog loading.">
                  <SettingToggle checked={store.showGenreOnCards} onChange={(v) => store.setShowGenreOnCards(v)} />
                </SettingRow>
                <SettingRow label="Poster trailer previews" description="Play a trailer when hovering poster cards.">
                  <SettingToggle checked={store.posterTrailerPreviews} onChange={(v) => store.setPosterTrailerPreviews(v)} />
                </SettingRow>
                <SettingRow label="Poster trailer hover delay" description="Choose how long to hover before poster trailers start.">
                  <select
                    value={store.posterTrailerHoverDelayMs}
                    onChange={(e) => store.setPosterTrailerHoverDelayMs(Number(e.target.value))}
                    className="w-40 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer"
                  >
                    <option value={0}>No delay</option>
                    <option value={250}>0.25 seconds</option>
                    <option value={500}>0.5 seconds</option>
                    <option value={750}>0.75 seconds</option>
                    <option value={1000}>1 second</option>
                    <option value={1500}>1.5 seconds</option>
                    <option value={2000}>2 seconds</option>
                  </select>
                </SettingRow>
                <SettingRow label="Poster trailer sound" description="Play poster hover trailers with audio when available. Muted previews can use sharper visual-only streams.">
                  <SettingToggle checked={store.posterTrailerSound} onChange={(v) => store.setPosterTrailerSound(v)} />
                </SettingRow>
                <SettingRow label="Trailer volume" description="Controls audio volume for hero and poster trailers when they are unmuted.">
                  <div className="flex w-48 items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={store.trailerVolume}
                      onChange={(e) => store.setTrailerVolume(Number(e.target.value))}
                      className="w-full accent-white"
                    />
                    <span className="w-10 text-right text-[12px] font-semibold text-white/60">{store.trailerVolume}%</span>
                  </div>
                </SettingRow>
                <SettingRow label="Hero trailer delay" description="Automatically starts a muted trailer in the Hero banner after this delay.">
                  <select
                    value={store.heroTrailerDelay}
                    onChange={(e) => store.setHeroTrailerDelay(Number(e.target.value))}
                    className="w-40 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer"
                  >
                    <option value={0}>Off</option>
                    <option value={3}>3 seconds</option>
                    <option value={5}>5 seconds</option>
                    <option value={10}>10 seconds</option>
                    <option value={15}>15 seconds</option>
                    <option value={30}>30 seconds</option>
                  </select>
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

            </>
          )}

          {/* ═══════════════════════════════════════════════
              METADATA TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'metadata' && (
            <>
              <SettingSection title="Metadata Source" description="Aurales resolves titles, artwork, and descriptions from its own providers instead of using addon metadata.">
                <SettingRow label="Use Aurales metadata" description="Prefer Aurales providers over addon-supplied titles, artwork, and descriptions.">
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
                  <button onClick={() => clearAppMetadataCache().then(() => window.location.reload())} className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white rounded-xl text-xs font-bold">Clear Cache</button>
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
                    }}
                  >
                    Clear Cache
                  </button>
                </SettingRow>
                <p className="text-xs text-white/40 mt-2 px-1">Anime is displayed like normal shows using TVDB seasons and episodes. Addon metadata is ignored for anime display — addons are only used for streams and IDs.</p>
              </SettingSection>

            </>
          )}

          {/* ═══════════════════════════════════════════════
              ARTWORK TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'artwork' && (
            <ArtworkSettingsSection />
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
              {/* ─── Global Settings ─── */}
              <SettingSection title="Continue Watching" description="Every connected service has its own Continue Watching — switch between them directly on the Home row. Use each service's 'Save Resume Position' below to opt out.">
                <SettingRow label="Continue Watching Items" description="How many items appear in Continue Watching.">
                  <select
                    value={store.continueWatchingLimit}
                    onChange={(e) => store.setContinueWatchingLimit(Number(e.target.value))}
                    className="w-28 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value={5}>5 items</option>
                    <option value={10}>10 items</option>
                    <option value={20}>20 items</option>
                    <option value={50}>50 items</option>
                  </select>
                </SettingRow>

                <div className="px-6 py-4">
                  <div className="mb-3">
                    <span className="text-sm text-white">Watched Checkmarks</span>
                    <p className="text-[12px] text-white/35 mt-0.5">Choose which providers mark movies and episodes as watched.</p>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {(['local', 'trakt', 'simkl', 'pmdb', 'mdblist', 'anilist'] as const).map((src) => {
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
                          {src === 'pmdb' ? 'PMDB' : src === 'mdblist' ? 'MDBList' : src === 'simkl' ? 'Simkl' : src === 'anilist' ? 'AniList' : src}
                        </button>
                      )
                    })}
                  </div>
                </div>

              </SettingSection>

              {/* ─── Play Button Resume Priority ─── */}
              <SettingSection
                title="Play Button Resume Priority"
                description="Drag connected services to configure the priority order used to fetch your resume progress on the detail pages. The first active resume point found from top to bottom will be used."
              >
                <div className="px-6 py-4">
                  <ResumePriorityList />
                </div>
              </SettingSection>

              {/* ─── Anime Tracking ─── */}
              <SettingSection title="Anime Tracking" description="Choose your anime progress provider and watched source.">
                <SettingRow label="Provider" description="Where anime watch progress is tracked.">
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

              </SettingSection>

              {/* ─── Per-Service Settings ─── */}
              {([
                {
                  id: 'local' as const,
                  label: 'Local',
                  scrobbleKey: null,
                  scrobbleValue: false,
                  setScrobble: null,
                  saveResumeValue: false,
                  setSaveResume: null,
                  syncFreqValue: null,
                  setSyncFreq: null,
                  syncAction: null,
                  syncLoading: false,
                  lastSync: null,
                  exportAction: () => {
                    const raw = localStorage.getItem('orynt_watch_progress') || '{}'
                    navigator.clipboard.writeText(raw)
                  },
                  clearAction: null,
                },
                {
                  id: 'trakt' as const,
                  label: 'Trakt',
                  scrobbleKey: 'trakt',
                  scrobbleValue: store.scrobbleTrakt,
                  setScrobble: store.setScrobbleTrakt,
                  saveResumeValue: store.traktSaveResumePosition,
                  setSaveResume: store.setTraktSaveResumePosition,
                  syncFreqValue: store.traktSyncFrequency,
                  setSyncFreq: store.setTraktSyncFrequency,
                  syncAction: store.traktConnected ? () => { syncProviderNow('trakt') } : null,
                  syncLoading: false,
                  lastSync: null,
                  exportAction: null,
                  clearAction: () => { cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS) },
                },
                {
                  id: 'simkl' as const,
                  label: 'Simkl',
                  scrobbleKey: 'simkl',
                  scrobbleValue: store.scrobbleSimkl,
                  setScrobble: store.setScrobbleSimkl,
                  saveResumeValue: store.simklSaveResumePosition,
                  setSaveResume: store.setSimklSaveResumePosition,
                  syncFreqValue: store.simklSyncFrequency,
                  setSyncFreq: store.setSimklSyncFrequency,
                  syncAction: (simklStatus.connected || store.simklConnected) ? handleSimklSync : null,
                  syncLoading: simklLoading,
                  lastSync: simklLastSync ? new Date(simklLastSync).toLocaleString() : null,
                  exportAction: null,
                  clearAction: () => { cacheClearCategory(CACHE_CATEGORIES.SIMKL_LIST) },
                },
                {
                  id: 'anilist' as const,
                  label: 'AniList',
                  scrobbleKey: 'anilist',
                  scrobbleValue: store.scrobbleAnilist,
                  setScrobble: store.setScrobbleAnilist,
                  saveResumeValue: false,
                  setSaveResume: null,
                  syncFreqValue: store.anilistSyncFrequency,
                  setSyncFreq: store.setAnilistSyncFrequency,
                  syncAction: store.anilistConnected ? syncAniListNow : null,
                  syncLoading: anilistLoading,
                  lastSync: null,
                  exportAction: null,
                  clearAction: null,
                },
                {
                  id: 'pmdb' as const,
                  label: 'PublicMetaDB',
                  scrobbleKey: 'pmdb',
                  scrobbleValue: store.scrobblePmdb,
                  setScrobble: store.setScrobblePmdb,
                  saveResumeValue: store.pmdbSaveResumePosition,
                  setSaveResume: store.setPmdBSaveResumePosition,
                  syncFreqValue: store.pmdbSyncFrequency,
                  setSyncFreq: store.setPmdBSyncFrequency,
                  syncAction: () => { syncProviderNow('pmdb') },
                  syncLoading: false,
                  lastSync: store.pmdbLastSyncTime || null,
                  exportAction: null,
                  clearAction: () => { cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS) },
                },
                {
                  id: 'mdblist' as const,
                  label: 'MDBList',
                  scrobbleKey: 'mdblist',
                  scrobbleValue: store.scrobbleMdblist,
                  setScrobble: store.setScrobbleMdblist,
                  saveResumeValue: store.mdblistSaveResumePosition,
                  setSaveResume: store.setMdblistSaveResumePosition,
                  syncFreqValue: store.mdblistSyncFrequency,
                  setSyncFreq: store.setMdblistSyncFrequency,
                  syncAction: () => { syncProviderNow('mdblist') },
                  syncLoading: false,
                  lastSync: store.mdblistLastSyncTime || null,
                  exportAction: null,
                  clearAction: () => { cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS) },
                },
              ]).map((svc) => (
                <SettingSection key={svc.id} title={svc.label} description={svc.id === 'local' ? 'Progress stored on this device.' : undefined}>
                  <div className="flex items-center gap-3 px-6 pt-4 pb-2">
                    <ServiceIcon service={svc.id} className="w-5 h-5" />
                    <span className="text-sm font-bold text-white">{svc.label}</span>
                  </div>

                  {svc.setScrobble && (
                    <SettingRow label="Scrobble Playback" description="Send watching progress during playback.">
                      <SettingToggle checked={svc.scrobbleValue} onChange={svc.setScrobble} />
                    </SettingRow>
                  )}

                  {svc.setSaveResume && (
                    <SettingRow label="Save Resume Position" description="Save playback position on pause and stop.">
                      <SettingToggle checked={svc.saveResumeValue} onChange={svc.setSaveResume} />
                    </SettingRow>
                  )}

                  {svc.setSyncFreq && svc.syncFreqValue !== null && (
                    <SettingRow label="Sync Frequency" description="How often to pull data in the background.">
                      <select
                        value={svc.syncFreqValue}
                        onChange={(e) => svc.setSyncFreq!(e.target.value)}
                        className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer text-white font-semibold"
                      >
                        <option value="every_minute">Every Minute</option>
                        <option value="every_5">Every 5 Minutes</option>
                        <option value="every_15">Every 15 Minutes</option>
                        <option value="manual">Manual Only</option>
                      </select>
                    </SettingRow>
                  )}

                  {(svc.syncAction || svc.lastSync) && (
                    <SettingRow label="Sync Now" description={svc.lastSync ? `Last: ${svc.lastSync}` : undefined}>
                      <button
                        onClick={() => svc.syncAction?.()}
                        disabled={svc.syncLoading || !svc.syncAction}
                        className="px-3.5 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white rounded-xl text-xs font-semibold cursor-pointer"
                      >
                        {svc.syncLoading ? 'Syncing...' : 'Sync Now'}
                      </button>
                    </SettingRow>
                  )}

                  {svc.exportAction && (
                    <SettingRow label="Export Data" description="Copy cached data to clipboard.">
                      <button
                        onClick={svc.exportAction}
                        className="px-3.5 py-2 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-semibold cursor-pointer"
                      >
                        Copy to Clipboard
                      </button>
                    </SettingRow>
                  )}

                  {svc.clearAction && (
                    <SettingRow label="Clear Cache" description="Remove all cached data for this service.">
                      <DangerButton onClick={svc.clearAction}>Clear Cache</DangerButton>
                    </SettingRow>
                  )}
                </SettingSection>
              ))}

              {simklError && (
                <p className={`text-xs px-1 ${simklError.startsWith('Sync completed') || simklError.startsWith('Synced') ? 'text-white/40' : 'text-red-400'}`}>
                  {simklError}
                </p>
              )}
              {anilistMessage && (
                <p className={`text-xs px-1 ${anilistMessage.includes('failed') ? 'text-red-400' : 'text-white/40'}`}>
                  {anilistMessage}
                </p>
              )}
            </>
          )}

          {/* ═══════════════════════════════════════════════
              LANGUAGES TAB
              ═══════════════════════════════════════════════ */}
          {/* ═══════════════════════════════════════════════
              AUDIO & SUBTITLES TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'subtitles' && (
            <>
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

              {/* Subtitle Styling */}
              <SettingSection title="Appearance" description="Preset styles or individual customize settings for player subtitles.">
                <div className="px-6 py-5 space-y-6">
                  {/* Preset Styles */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Presets</span>
                    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl divide-y divide-white/[0.04] overflow-hidden">
                      {[
                        { id: 'standard', title: 'Standard', desc: 'White text with black outline' },
                        { id: 'boxed', title: 'Boxed', desc: 'White text with dark background' },
                        { id: 'classic', title: 'Classic', desc: 'Yellow text, cinema style' },
                        { id: 'minimal', title: 'Minimal', desc: 'Clean, subtle shadow only' },
                        { id: 'bold', title: 'Bold', desc: 'Large, high contrast' },
                      ].map((preset) => {
                        const active = store.subtitlePreset === preset.id
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => store.setSubtitlePreset(preset.id as any)}
                            className={`w-full flex items-center justify-between px-5 py-3.5 text-left transition-all hover:bg-white/[0.04] cursor-pointer ${
                              active ? 'bg-white/[0.02]' : ''
                            }`}
                          >
                            <div>
                              <p className={`text-sm font-semibold ${active ? 'text-accent' : 'text-white'}`}>{preset.title}</p>
                              <p className="text-xs text-white/35 mt-0.5">{preset.desc}</p>
                            </div>
                            <svg className={`w-4 h-4 transition-colors ${active ? 'text-accent' : 'text-white/20'}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                              <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[10px] text-white/30 italic">Apply a preset style or customize individual settings below</p>
                  </div>

                  {/* AA Font */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">AA Font</span>
                    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl p-5 space-y-4">
                      {/* Font Size */}
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Font Size</span>
                          <span className="text-accent font-bold">{store.subtitleFontSize}px</span>
                        </div>
                        <input
                          type="range" min="16" max="64" step="1"
                          value={store.subtitleFontSize}
                          onChange={(e) => store.setSubtitleFontSize(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                        <p className="text-[10px] text-white/30">Size at 720p reference - scales with screen</p>
                      </div>

                      {/* Scale */}
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Scale</span>
                          <span className="text-accent font-bold">{store.subtitleScale.toFixed(1)}x</span>
                        </div>
                        <input
                          type="range" min="0.5" max="2.5" step="0.1"
                          value={store.subtitleScale}
                          onChange={(e) => store.setSubtitleScale(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>

                      {/* Bold & Italic Toggles */}
                      <div className="flex items-center justify-between border-t border-white/[0.04] pt-4">
                        <span className="text-xs font-semibold text-white/70">Bold</span>
                        <SettingToggle checked={store.subtitleBold} onChange={(v) => store.setSubtitleBold(v)} />
                      </div>
                      <div className="flex items-center justify-between border-t border-white/[0.04] pt-4">
                        <span className="text-xs font-semibold text-white/70">Italic</span>
                        <SettingToggle checked={store.subtitleItalic} onChange={(v) => store.setSubtitleItalic(v)} />
                      </div>
                    </div>
                  </div>

                  {/* Colors */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Colors</span>
                    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl divide-y divide-white/[0.04]">
                      {/* Text Color */}
                      <div className="flex items-center justify-between px-5 py-3">
                        <span className="text-xs font-semibold text-white/70">Text Color</span>
                        <select
                          value={store.subtitleColor}
                          onChange={(e) => store.setSubtitleColor(e.target.value)}
                          className="w-36 px-3 py-1.5 bg-black/30 border border-white/[0.08] rounded-xl text-xs text-white focus:outline-none focus:border-accent/40"
                        >
                          <option value="#FFFFFF">White</option>
                          <option value="#FFFF00">Yellow (Classic)</option>
                          <option value="#000000">Black</option>
                          <option value="#00FFFF">Cyan</option>
                          <option value="#00FF00">Green</option>
                          <option value="#FF88CC">Pink</option>
                          <option value="#888888">Gray</option>
                        </select>
                      </div>

                      {/* Outline Color */}
                      <div className="flex items-center justify-between px-5 py-3">
                        <span className="text-xs font-semibold text-white/70">Outline Color</span>
                        <select
                          value={store.subtitleOutlineColor}
                          onChange={(e) => store.setSubtitleOutlineColor(e.target.value)}
                          className="w-36 px-3 py-1.5 bg-black/30 border border-white/[0.08] rounded-xl text-xs text-white focus:outline-none focus:border-accent/40"
                        >
                          <option value="#000000">Black</option>
                          <option value="#FFFFFF">White</option>
                          <option value="#FFFF00">Yellow</option>
                          <option value="#888888">Gray</option>
                        </select>
                      </div>

                      {/* Background Color */}
                      <div className="flex items-center justify-between px-5 py-3">
                        <span className="text-xs font-semibold text-white/70">Background Color</span>
                        <select
                          value={store.subtitleBgColor}
                          onChange={(e) => store.setSubtitleBgColor(e.target.value)}
                          className="w-36 px-3 py-1.5 bg-black/30 border border-white/[0.08] rounded-xl text-xs text-white focus:outline-none focus:border-accent/40"
                        >
                          <option value="#000000">Black</option>
                          <option value="#FFFFFF">White</option>
                          <option value="#888888">Gray</option>
                        </select>
                      </div>

                      {/* Background Opacity */}
                      <div className="px-5 py-4 space-y-2">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Background Opacity</span>
                          <span className="text-accent font-bold">{Math.round(Number(store.subtitleBgOpacity) * 100)}%</span>
                        </div>
                        <input
                          type="range" min="0" max="1" step="0.05"
                          value={store.subtitleBgOpacity}
                          onChange={(e) => store.setSubtitleBgOpacity(e.target.value)}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Outline & Shadow */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Outline & Shadow</span>
                    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl p-5 space-y-4">
                      {/* Style select */}
                      <div className="flex items-center justify-between pb-1">
                        <span className="text-xs font-semibold text-white/70">Style</span>
                        <select
                          value={store.subtitleBorderStyle}
                          onChange={(e) => store.setSubtitleBorderStyle(e.target.value as any)}
                          className="w-40 px-3 py-1.5 bg-black/30 border border-white/[0.08] rounded-xl text-xs text-white focus:outline-none focus:border-accent/40"
                        >
                          <option value="outline">Outline & Shadow</option>
                          <option value="shadow">Shadow Only</option>
                          <option value="none">None</option>
                        </select>
                      </div>

                      {/* Outline Thickness */}
                      <div className="space-y-2 border-t border-white/[0.04] pt-4">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Outline Thickness</span>
                          <span className="text-accent font-bold">{store.subtitleOutlineThickness.toFixed(1)}</span>
                        </div>
                        <input
                          type="range" min="0.0" max="4.0" step="0.1"
                          value={store.subtitleOutlineThickness}
                          onChange={(e) => store.setSubtitleOutlineThickness(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>

                      {/* Shadow Offset */}
                      <div className="space-y-2 border-t border-white/[0.04] pt-4">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Shadow Offset</span>
                          <span className="text-accent font-bold">{store.subtitleShadowOffset.toFixed(1)}</span>
                        </div>
                        <input
                          type="range" min="0.0" max="5.0" step="0.5"
                          value={store.subtitleShadowOffset}
                          onChange={(e) => store.setSubtitleShadowOffset(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>

                      {/* Shadow Opacity */}
                      <div className="space-y-2 border-t border-white/[0.04] pt-4">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Shadow Opacity</span>
                          <span className="text-accent font-bold">{Math.round(store.subtitleShadowOpacity * 100)}%</span>
                        </div>
                        <input
                          type="range" min="0.0" max="1.0" step="0.05"
                          value={store.subtitleShadowOpacity}
                          onChange={(e) => store.setSubtitleShadowOpacity(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Position */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Position</span>
                    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl p-5 space-y-4">
                      {/* Vertical Position */}
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Vertical Position</span>
                          <span className="text-accent font-bold">{store.subtitleVerticalPosition}</span>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <span className="text-[10px] text-white/30 w-10 text-left">Higher</span>
                          <input
                            type="range" min="50" max="150" step="1"
                            value={store.subtitleVerticalPosition}
                            onChange={(e) => store.setSubtitleVerticalPosition(Number(e.target.value))}
                            className="flex-grow h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                          />
                          <span className="text-[10px] text-white/30 w-10 text-right">Lower</span>
                        </div>
                        <p className="text-[10px] text-white/30">100 = Default. Lower values move up, higher values push down.</p>
                      </div>

                      {/* Alignment */}
                      <div className="flex items-center justify-between border-t border-white/[0.04] pt-4">
                        <span className="text-xs font-semibold text-white/70">Alignment</span>
                        <div className="flex bg-white/[0.06] rounded-xl overflow-hidden border border-white/[0.08] p-0.5">
                          {(['left', 'center', 'right'] as const).map((align) => (
                            <button
                              key={align}
                              type="button"
                              onClick={() => store.setSubtitleAlignment(align)}
                              className={`px-4 py-1.5 rounded-lg text-xs font-bold capitalize transition-all cursor-pointer ${
                                store.subtitleAlignment === align
                                  ? 'bg-white text-black shadow-md'
                                  : 'text-white/60 hover:text-white'
                              }`}
                            >
                              {align}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Horizontal Margin */}
                      <div className="space-y-2 border-t border-white/[0.04] pt-4">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Horizontal Margin</span>
                          <span className="text-accent font-bold">{store.subtitleHorizontalMargin}px</span>
                        </div>
                        <input
                          type="range" min="0" max="100" step="1"
                          value={store.subtitleHorizontalMargin}
                          onChange={(e) => store.setSubtitleHorizontalMargin(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Advanced */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Advanced</span>
                    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl p-5 space-y-4">
                      {/* Text Blur */}
                      <div className="space-y-2">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-white/70">Text Blur</span>
                          <span className="text-accent font-bold">{store.subtitleTextBlur.toFixed(1)}</span>
                        </div>
                        <input
                          type="range" min="0.0" max="5.0" step="0.1"
                          value={store.subtitleTextBlur}
                          onChange={(e) => store.setSubtitleTextBlur(Number(e.target.value))}
                          className="w-full h-1.5 bg-black/45 rounded-lg appearance-none cursor-pointer accent-accent"
                        />
                      </div>

                      {/* Scale with Window Size */}
                      <div className="flex items-center justify-between border-t border-white/[0.04] pt-4">
                        <span className="text-xs font-semibold text-white/70">Scale with Window Size</span>
                        <SettingToggle checked={store.subtitleScaleWithWindow} onChange={(v) => store.setSubtitleScaleWithWindow(v)} />
                      </div>

                      {/* ASS Style Override */}
                      <div className="space-y-2 border-t border-white/[0.04] pt-4">
                        <div className="flex items-center justify-between pb-1">
                          <span className="text-xs font-semibold text-white/70">ASS Style Override</span>
                          <select
                            value={store.subtitleAssOverride}
                            onChange={(e) => store.setSubtitleAssOverride(e.target.value as any)}
                            className="w-48 px-3 py-1.5 bg-black/30 border border-white/[0.08] rounded-xl text-xs text-white focus:outline-none focus:border-accent/40"
                          >
                            <option value="apply">Apply Style Overrides</option>
                            <option value="scale_only">Scale Only</option>
                            <option value="ignore">Ignore Styles</option>
                          </select>
                        </div>
                        <p className="text-[10px] text-white/30">ASS override controls how styled subtitle files are handled. 'Scale Only' is recommended.</p>
                      </div>
                    </div>
                  </div>

                  {/* Preview */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-white/50 uppercase tracking-wider">Preview</span>
                    <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.04] flex items-center min-h-[120px] relative overflow-hidden">
                      <div className="absolute inset-0 bg-cover bg-center opacity-30 pointer-events-none" style={{ backgroundImage: `url('https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=300&auto=format&fit=crop')` }} />
                      <div className="relative z-10 w-full" style={{
                        textAlign: store.subtitleAlignment as any,
                      }}>
                        <span
                          className="px-2.5 py-1 rounded select-none"
                          style={{
                            fontSize: `${Math.round(store.subtitleFontSize * store.subtitleScale * 0.75)}px`,
                            fontWeight: store.subtitleBold ? 'bold' : 'normal',
                            fontStyle: store.subtitleItalic ? 'italic' : 'normal',
                            color: store.subtitleColor,
                            backgroundColor: `rgba(${parseInt(store.subtitleBgColor.replace('#','').substring(0,2),16) || 0}, ${parseInt(store.subtitleBgColor.replace('#','').substring(2,4),16) || 0}, ${parseInt(store.subtitleBgColor.replace('#','').substring(4,6),16) || 0}, ${store.subtitleBgOpacity})`,
                            filter: store.subtitleTextBlur > 0 ? `blur(${store.subtitleTextBlur}px)` : 'none',
                            textShadow: store.subtitleBorderStyle === 'outline'
                              ? `0 0 ${store.subtitleOutlineThickness}px ${store.subtitleOutlineColor}, 0 0 1px ${store.subtitleOutlineColor}, 1px 1px 0 ${store.subtitleOutlineColor}, -1px -1px 0 ${store.subtitleOutlineColor}`
                              : store.subtitleBorderStyle === 'shadow'
                                ? `${store.subtitleShadowOffset}px ${store.subtitleShadowOffset}px ${store.subtitleShadowOffset * 2}px rgba(0,0,0,${store.subtitleShadowOpacity})`
                                : 'none'
                          }}
                        >
                          This is how your subtitles will look
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Reset to Defaults */}
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => store.resetSubtitleSettings()}
                      className="w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-2xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 text-red-400 text-sm font-semibold transition-all cursor-pointer active:scale-[0.99]"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H17" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Reset to Defaults
                    </button>
                  </div>
                </div>
              </SettingSection>


              {/* Subtitle Translation */}
              <SettingSection title="Live Translation" description="AI-powered subtitle translation via OpenRouter.">
                <SettingRow label="Translate subtitles" description="Create and prefer an AI-translated track on playback.">
                  <SettingToggle checked={store.subtitleTranslationEnabled} onChange={(v) => store.setSubtitleTranslationEnabled(v)} />
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
                <SettingRow label="Context-Aware Translation" description="Use surrounding dialogue for more natural translations.">
                  <SettingToggle checked={store.contextAwareTranslation} onChange={(v) => store.setContextAwareTranslation(v)} />
                </SettingRow>
                <div className="px-6 py-3 text-xs text-white/30 leading-relaxed">
                  {store.openrouterApiKey ? 'Ready (OpenRouter)' : 'OpenRouter API key required'}.
                  Subtitle text is sent to OpenRouter. No account data or viewing history is included.
                </div>
              </SettingSection>
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
                  <p className="text-sm text-white/70 font-semibold">mpv is bundled with Aurales and ready for playback.</p>
                </div>
              </SettingSection>

              <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl">
                <details className="group">
                  <summary className="px-6 py-4 cursor-pointer select-none list-none flex items-center justify-between">
                    <div>
                      <h3 className="text-[15px] font-semibold text-white">Troubleshooting</h3>
                      <p className="text-[13px] text-white/40 mt-0.5">Isolated playback mode for diagnosing player issues.</p>
                    </div>
                    <svg className="w-4 h-4 text-white/40 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>
                  </summary>
                  <div className="divide-y divide-white/[0.04]">
                    <SettingRow
                      label="Isolated Playback Mode"
                      description="Runs mpv without scrobbling, progress polling, or metadata to isolate player issues."
                    >
                      <SettingToggle checked={store.isolatedPlaybackMode} onChange={store.setIsolatedPlaybackMode} />
                    </SettingRow>
                    <SettingRow label="Isolated hardware decoding" description="Compare GPU decoding against software decoding.">
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
                    <div className="flex flex-wrap gap-3 px-6 py-4">
                      <button
                        onClick={async () => {
                          const path = await invoke<string | null>('select_local_video_file')
                          if (!path) return
                          store.setIsolatedPlaybackMode(true)
                          setPlayerDebugTest({ url: path, title: 'Local isolation test' })
                        }}
                        className="rounded-xl border border-accent/25 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/15 cursor-pointer"
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
                        className="rounded-xl border border-accent/25 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/15 cursor-pointer"
                      >
                        Test Direct HTTP
                      </button>
                      <button
                        onClick={async () => {
                          const logs = await invoke<string[]>('get_player_debug_logs')
                          await navigator.clipboard.writeText(logs.join('\n'))
                        }}
                        className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-white hover:bg-white/[0.1] cursor-pointer"
                      >
                        Copy Player Logs
                      </button>
                    </div>
                  </div>
                </details>
              </div>

              {/* Auto-skip */}
              <SettingSection>
                <SettingRow label="Smart Play" description="Skip stream selection and automatically play the best ranked stream. If it fails, Aurales tries the next best source.">
                  <SettingToggle checked={store.autoPlayFirstStream} onChange={(v) => store.setAutoPlayFirstStream(v)} />
                </SettingRow>
                <SettingRow label="Auto-skip intros, recaps, and credits" description="Jump over skip ranges from PublicMetaDB or IntroDB.">
                  <SettingToggle checked={store.autoSkipSegments} onChange={(v) => store.setAutoSkipSegments(v)} />
                </SettingRow>
              </SettingSection>

              {/* Seek step */}
              <SettingSection title="Seek Step" description="How far the arrow keys and the skip buttons jump.">
                <div className="px-6 py-4">
                  <div className="flex flex-wrap gap-2">
                    {[5, 10, 15, 30, 60].map((secs) => {
                      const active = store.seekStepSeconds === secs
                      return (
                        <button
                          key={secs}
                          onClick={() => store.setSeekStepSeconds(secs)}
                          className={`h-8 flex items-center justify-center px-3.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                            active ? 'bg-white text-black border-white' : 'bg-white/5 border-white/5 text-white/60 hover:bg-white/10 hover:text-white border-transparent'
                          }`}
                        >
                          {secs}s
                        </button>
                      )
                    })}
                  </div>
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

              {/* Audio Passthrough */}
              <SettingSection>
                <SettingRow label="Digital Audio Passthrough" description="Output compressed formats (Dolby Atmos, DTS) to an external receiver.">
                  <SettingToggle checked={store.audioPassthrough} onChange={(v) => store.setAudioPassthrough(v)} />
                </SettingRow>
              </SettingSection>

              {/* Hardware Decoding */}
              <SettingSection title="Hardware Decoding" description="Offload video decoding to your GPU for smoother playback.">
                <SettingRow label="Hardware decoding" description="Leave on Auto-detect unless video stutters or shows visual glitches.">
                  <select
                    value={store.hwdecMode}
                    onChange={(e) => store.setHwdecMode(e.target.value as any)}
                    className="w-64 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer focus:outline-none focus:border-accent/50"
                  >
                    <option value="auto">Auto-detect (Recommended)</option>
                    <option value="no">Disabled (Software)</option>
                    <option value="videotoolbox">macOS (VideoToolbox)</option>
                    <option value="nvdec">NVIDIA (nvdec)</option>
                    <option value="vaapi">Intel/AMD Linux (vaapi)</option>
                  </select>
                </SettingRow>
              </SettingSection>

              {/* Buffer */}
              <SettingSection title="Buffer Cache" description="Adjust cache to prevent buffering on slow networks.">
                <SettingRow label="Memory cache size" description="How much of the stream is kept in memory. Larger helps on unstable connections.">
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

              <p className="text-xs text-white/25 leading-relaxed px-1">
                Scrobble, resume, watched checkmarks, and sync provider settings are under Progress & Sync.
              </p>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              WATCH TOGETHER TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'watch-together' && (
            <>
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex gap-3.5 items-start mb-6">
                <span className="text-amber-500 text-lg leading-none mt-0.5 select-none">⚠️</span>
                <div>
                  <h4 className="text-sm font-bold text-amber-200">Experimental Feature</h4>
                  <p className="text-xs text-white/60 mt-1 leading-relaxed">
                    Watch Together is currently in experimental preview and may not function correctly. You may encounter synchronization issues, drift, or connection drops.
                  </p>
                </div>
              </div>

              <SettingSection title="Server" description="WebSocket server for Watch Together rooms.">
                <SettingRow label="Server URL" description="WebSocket URL of the Watch Together server.">
                  <input
                    type="text"
                    value={wtStore.serverUrl}
                    onChange={(e) => wtStore.setServerUrl(e.target.value)}
                    placeholder="ws://localhost:9876"
                    className="w-64 bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                  />
                </SettingRow>
              </SettingSection>

              <SettingSection title="Profile" description="Your default identity when joining rooms.">
                <SettingRow label="Default nickname" description="Pre-filled when creating or joining a room.">
                  <input
                    type="text"
                    value={wtStore.defaultNickname}
                    onChange={(e) => wtStore.setDefaultNickname(e.target.value)}
                    placeholder="Your name..."
                    className="w-48 bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                  />
                </SettingRow>
              </SettingSection>

              <SettingSection title="Room Defaults" description="Default settings for new rooms you create.">
                <SettingRow label="Default control mode" description="Who can control playback in rooms you host.">
                  <select
                    value={wtStore.defaultControlMode}
                    onChange={(e) => wtStore.setDefaultControlMode(e.target.value as 'host_only' | 'everyone')}
                    className="bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/20 cursor-pointer"
                  >
                    <option value="host_only">Host only</option>
                    <option value="everyone">Everyone can control</option>
                  </select>
                </SettingRow>
                <SettingRow label="Require ready check" description="Wait for all participants before starting playback.">
                  <SettingToggle checked={wtStore.requireReadyCheck} onChange={(v) => wtStore.setRequireReadyCheck(v)} />
                </SettingRow>
                <SettingRow label="Show chat" description="Display the chat panel in rooms.">
                  <SettingToggle checked={wtStore.showChat} onChange={(v) => wtStore.setShowChat(v)} />
                </SettingRow>
                <SettingRow label="Auto-copy invite link" description="Copy the room invite link when creating a room.">
                  <SettingToggle checked={wtStore.autoCopyInvite} onChange={(v) => wtStore.setAutoCopyInvite(v)} />
                </SettingRow>
                <SettingRow label="Allow different streams" description="Let guests use a different stream source than the host.">
                  <SettingToggle checked={wtStore.allowGuestDifferentStream} onChange={(v) => wtStore.setAllowGuestDifferentStream(v)} />
                </SettingRow>
              </SettingSection>

              <SettingSection title="Playback Sync" description="Fine-tune how playback synchronization works.">
                <SettingRow label="Drift correction threshold" description="Seconds of drift before forcing a seek correction.">
                  <select
                    value={wtStore.driftThreshold}
                    onChange={(e) => wtStore.setDriftThreshold(Number(e.target.value))}
                    className="bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/20 cursor-pointer"
                  >
                    <option value={1}>1 second</option>
                    <option value={2}>2 seconds</option>
                    <option value={3}>3 seconds</option>
                    <option value={5}>5 seconds</option>
                    <option value={10}>10 seconds</option>
                  </select>
                </SettingRow>
                <SettingRow label="Sync interval" description="How often the host broadcasts its playback position.">
                  <select
                    value={wtStore.syncInterval}
                    onChange={(e) => wtStore.setSyncInterval(Number(e.target.value))}
                    className="bg-white/5 border border-white/8 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-white/20 cursor-pointer"
                  >
                    <option value={3}>3 seconds</option>
                    <option value={5}>5 seconds</option>
                    <option value={10}>10 seconds</option>
                    <option value={15}>15 seconds</option>
                  </select>
                </SettingRow>
              </SettingSection>
            </>
          )}

          {/* ═══════════════════════════════════════════════
              DISCOVERY TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'discovery' && (
            <div className="space-y-6">
              {/* Discovery Preferences */}
              <SettingSection title="Discovery Preferences" description="Tune regional availability and recommendation quality.">
                <SettingRow label="Region">
                  <select
                    value={store.discoveryRegion}
                    onChange={(e) => store.setDiscoveryRegion(e.target.value)}
                    className="w-48 px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white font-semibold cursor-pointer"
                  >
                    {[
                      { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' }, { code: 'CA', name: 'Canada' },
                      { code: 'AU', name: 'Australia' }, { code: 'NZ', name: 'New Zealand' },
                      { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' }, { code: 'ES', name: 'Spain' },
                      { code: 'IT', name: 'Italy' }, { code: 'NL', name: 'Netherlands' }, { code: 'BE', name: 'Belgium' },
                      { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' }, { code: 'DK', name: 'Denmark' },
                      { code: 'FI', name: 'Finland' }, { code: 'PT', name: 'Portugal' }, { code: 'PL', name: 'Poland' },
                      { code: 'AT', name: 'Austria' }, { code: 'CH', name: 'Switzerland' },
                      { code: 'JP', name: 'Japan' }, { code: 'KR', name: 'South Korea' }, { code: 'IN', name: 'India' },
                      { code: 'BR', name: 'Brazil' }, { code: 'MX', name: 'Mexico' }, { code: 'AR', name: 'Argentina' },
                      { code: 'ZA', name: 'South Africa' }, { code: 'TR', name: 'Turkey' }, { code: 'RU', name: 'Russia' },
                      { code: 'PH', name: 'Philippines' }, { code: 'TH', name: 'Thailand' },
                    ].map((region) => (
                      <option key={region.code} value={region.code}>{region.name}</option>
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

              {/* AUDIENCE PRESET MODES */}
              <SettingSection title="Audience" description="Configure default age suitability rules and content filters.">
                <div className="px-6 py-5">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {AUDIENCE_OPTIONS.map(({ mode: m, title, subtitle }) => {
                      const active = localPrefs.audienceMode === m
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => handlePrefsChange({ audienceMode: m })}
                          className={`flex flex-col items-start p-4 rounded-xl text-left transition-all border cursor-pointer ${
                            active
                              ? 'bg-white text-black border-white shadow-xl scale-[1.01]'
                              : 'bg-white/[0.03] text-white hover:bg-white/[0.06] border-white/[0.06] hover:border-white/10'
                          }`}
                        >
                          <span className="text-sm font-black tracking-wide">{title}</span>
                          <span className={`text-xs mt-1 ${active ? 'text-black/60' : 'text-white/35'}`}>{subtitle}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </SettingSection>

              {/* ADVANCED WEIGHTS & FILTERS */}
              <SettingSection title="Advanced Weights & Filters" description="Fine-tune scoring weights, languages, year ranges, keywords, and sorting.">
                <div className="px-6 py-6">
                  <DiscoverPrefsPanel
                    localPrefs={localPrefs}
                    onChange={handlePrefsChange}
                    onReset={handleReset}
                  />
                </div>
              </SettingSection>
              
              {/* SAVE / CANCEL BAR */}
              <div className="flex items-center justify-between pt-4 mt-6">
                <span className="text-xs text-white/35">Ready to save</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-5 py-2 rounded-full text-xs font-semibold text-white/60 hover:text-white transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    className="px-6 py-2.5 rounded-full text-xs font-bold bg-white text-black hover:bg-white/90 active:scale-[0.97] transition-all cursor-pointer shadow-lg shadow-black/30"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════
              ADVANCED TAB
              ═══════════════════════════════════════════════ */}
          {activeTab === 'advanced' && (
            <>
              {/* App Update */}
              <AppUpdateSection />

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

              {/* Cache Management */}
              <CacheManagementSection />

              {backdropCacheMessage && (
                <div className="px-4 py-2 bg-accent/10 border border-accent/20 rounded-xl">
                  <p className="text-xs text-accent font-semibold">{backdropCacheMessage}</p>
                </div>
              )}

              <ImageCacheSection onClearBackdropCache={handleClearBackdropCache} />

              {/* Anime ID Mappings (collapsible) */}
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl">
                <details className="group">
                  <summary className="px-6 py-4 cursor-pointer select-none list-none flex items-center justify-between">
                    <div>
                      <h3 className="text-[15px] font-semibold text-white">Anime ID Mappings</h3>
                      <p className="text-[13px] text-white/40 mt-0.5">Local mapping data connecting anime across services.</p>
                    </div>
                    <svg className="w-4 h-4 text-white/40 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>
                  </summary>
                  <div className="divide-y divide-white/[0.04]">
                    <AnimeIdMappingsSection />
                  </div>
                </details>
              </div>

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
        <Suspense fallback={null}>
          <NativeMpvPlayer
            url={playerDebugTest.url}
            title={playerDebugTest.title}
            onClose={() => setPlayerDebugTest(null)}
            onPickAnother={() => setPlayerDebugTest(null)}
          />
        </Suspense>
      )}
    </div>
  )
}
