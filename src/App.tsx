import { useEffect, lazy, Suspense, useState, useRef } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import ErrorBoundary from './components/ui/ErrorBoundary'
import { connectedProgressSources, useAppStore } from './stores/appStore'
import { prefetchLikelyRoutes } from './services/routePrefetch'
import { markPerformance, measurePerformance } from './services/performanceMetrics'
import WhoWatching from './components/WhoWatching'
import ProfileSwitchTransition from './components/ProfileSwitchTransition'
import { getProfileSetting } from './services/profiles'
import { disconnectDisabledServerIntegrations } from './services/serverIntegrations'
import { syncAddonsFromStore } from './services/addons'
import { getPlatformCapabilities } from './platform/capabilities'

const HomePage = lazy(() => import('./pages/HomePage'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const MovieDetailPage = lazy(() => import('./pages/MovieDetailPage'))
const SeriesDetailPage = lazy(() => import('./pages/SeriesDetailPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const DeveloperPage = lazy(() => import('./pages/DeveloperPage'))
const CatalogPage = lazy(() => import('./pages/CatalogPage'))
const CollectionsPage = lazy(() => import('./pages/CollectionsPage'))
const DiscoverPage = lazy(() => import('./pages/DiscoverPage'))
const PersonPage = lazy(() => import('./pages/PersonPage'))
const WatchTogetherPage = lazy(() => import('./pages/WatchTogetherPage'))
const UpcomingPage = lazy(() => import('./pages/UpcomingPage'))
const UpdatePrompt = lazy(() => import('./components/UpdatePrompt'))
const SimklCallbackPage = lazy(() => import('./pages/SimklCallbackPage'))
const MdblistCallbackPage = lazy(() => import('./pages/MdblistCallbackPage'))

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

function scheduleIdleWork(callback: () => void, timeout = 1500) {
  let cancelled = false
  const idleWindow = window as IdleWindow

  const run = () => {
    if (!cancelled) callback()
  }

  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const idleId = idleWindow.requestIdleCallback(run, { timeout })
    return () => {
      cancelled = true
      idleWindow.cancelIdleCallback?.(idleId)
    }
  }

  const timeoutId = window.setTimeout(run, timeout)
  return () => {
    cancelled = true
    window.clearTimeout(timeoutId)
  }
}

function hasConfiguredAuralesSync(): boolean {
  try {
    const config = JSON.parse(localStorage.getItem('aurales_sync_config_v1') || '{}') as { accessToken?: string; autoSync?: boolean }
    return Boolean(config.accessToken && config.autoSync !== false)
  } catch {
    return false
  }
}

export default function App() {
  const isAuthCallback = window.location.pathname === '/auth/simkl/callback' || window.location.pathname === '/auth/mdblist/callback'
  const [chooseProfile, setChooseProfile] = useState(() => {
    if (isAuthCallback) return false
    const switched = sessionStorage.getItem('aurales_profile_switched_v1')
    if (switched) sessionStorage.removeItem('aurales_profile_switched_v1')
    // A profile can opt into direct launch. Profile switching still uses its
    // dedicated transition, so this only removes the startup picker.
    return !switched && getProfileSetting('aurales_skip_profile_picker') !== 'true'
  })
  // The startup sync timing depends on the chooser state at mount. Keep that
  // initial choice explicit without making the sync/event-listener effect
  // restart after the chooser is dismissed.
  const chooseProfileAtLaunchRef = useRef(chooseProfile)
  const [updatePromptReady, setUpdatePromptReady] = useState(false)

  useEffect(() => {
    if (isAuthCallback) return
    void disconnectDisabledServerIntegrations()
  }, [isAuthCallback])
  const addons = useAppStore((s) => s.addons)
  const accentColor = useAppStore((s) => s.accentColor)
  const interfaceTheme = useAppStore((s) => s.interfaceTheme)
  const themeBackground = useAppStore((s) => s.themeBackground)
  const navigationStyle = useAppStore((s) => s.navigationStyle)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const defaultStartPage = useAppStore((s) => s.defaultStartPage)
  const subtitleFontSize = useAppStore((s) => s.subtitleFontSize)
  const subtitleBgOpacity = useAppStore((s) => s.subtitleBgOpacity)
  const subtitleColor = useAppStore((s) => s.subtitleColor)
  const subtitleScale = useAppStore((s) => s.subtitleScale)
  const subtitleBold = useAppStore((s) => s.subtitleBold)
  const subtitleItalic = useAppStore((s) => s.subtitleItalic)
  const subtitleOutlineColor = useAppStore((s) => s.subtitleOutlineColor)
  const subtitleBgColor = useAppStore((s) => s.subtitleBgColor)
  const subtitleOutlineThickness = useAppStore((s) => s.subtitleOutlineThickness)
  const subtitleShadowOffset = useAppStore((s) => s.subtitleShadowOffset)
  const subtitleShadowOpacity = useAppStore((s) => s.subtitleShadowOpacity)
  const subtitleVerticalPosition = useAppStore((s) => s.subtitleVerticalPosition)
  const subtitleAlignment = useAppStore((s) => s.subtitleAlignment)
  const subtitleHorizontalMargin = useAppStore((s) => s.subtitleHorizontalMargin)
  const subtitleTextBlur = useAppStore((s) => s.subtitleTextBlur)
  const subtitleBorderStyle = useAppStore((s) => s.subtitleBorderStyle)

  const discordRichPresence = useAppStore((s) => s.discordRichPresence)
  const primaryProgressProvider = useAppStore((s) => s.primaryProgressProvider)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)
  const setWatchedCheckmarkSources = useAppStore((s) => s.setWatchedCheckmarkSources)
  const progressConnections = useAppStore((s) => [s.traktConnected, s.simklConnected, s.anilistConnected, Boolean(s.pmdbApiKey), Boolean(s.mdblistApiKey)].map(Number).join(''))

  useEffect(() => {
    if (isAuthCallback) return
    markPerformance('app-shell-visible')
    measurePerformance('bootstrap-to-shell', 'bootstrap-start', 'app-shell-visible')
  }, [isAuthCallback])

  // Pull durable account state soon after startup, then make a best-effort
  // checkpoint when the window is hidden or closed. Local state remains the
  // source of truth if the network is unavailable.
  useEffect(() => {
    if (isAuthCallback) return
    const runSync = () => {
      if (!hasConfiguredAuralesSync()) return
      void import('./services/sync/auralesSync').then(({ syncIfConfigured }) => {
        return import('./services/sync/secureLogin').then(async ({ loadSyncPassword }) => {
          const { getSyncConfig } = await import('./services/sync/auralesSync')
          const email = getSyncConfig().email
          if (email) {
            const password = await loadSyncPassword(email).catch(() => null)
            if (password) {
              const { unlockSyncVault } = await import('./services/sync/encryptedVault')
              unlockSyncVault(password)
            }
          }
          return syncIfConfigured()
        }).catch(() => {})
      }).catch(() => {})
    }
    // Profiles need an immediate pull only while the startup chooser is being
    // shown. Returning sessions can sync after the shell has had an idle turn;
    // previously both paths ran on every launch and could overlap.
    const cancelIdle = chooseProfileAtLaunchRef.current
      ? (() => { runSync(); return () => {} })()
      : scheduleIdleWork(runSync, 3000)
    const onPageHide = () => runSync()
    const onVisibility = () => { if (document.visibilityState === 'hidden') runSync() }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelIdle()
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      runSync()
    }
  }, [isAuthCallback])

  // Most settings and provider clients are intentionally local-first and
  // write directly to storage. Observe the active profile's durable state so
  // every small setting/account change is backed up without a manual button.
  useEffect(() => {
    if (chooseProfile || isAuthCallback) return
    let fingerprint = ''
    let stopped = false
    const checkForChanges = () => {
      if (document.visibilityState === 'hidden') return
      if (!hasConfiguredAuralesSync()) return
      void Promise.all([import('./services/sync/encryptedVault'), import('./services/sync/auralesSync')]).then(([vault, sync]) => {
        if (stopped) return
        const next = vault.profileSyncFingerprint()
        if (!fingerprint) { fingerprint = next; return }
        if (next !== fingerprint) { fingerprint = next; sync.scheduleAutomaticSync(700) }
      }).catch(() => {})
    }
    checkForChanges()
    // Fingerprinting walks the profile's durable localStorage state. Fifteen
    // seconds keeps automatic-sync detection responsive without repeatedly
    // hashing a potentially multi-megabyte profile while the app is idle.
    const interval = window.setInterval(checkForChanges, 15000)
    return () => { stopped = true; window.clearInterval(interval) }
  }, [chooseProfile, isAuthCallback])

  // Route chunks stay off the critical path, but likely first destinations are
  // ready by the time people reach the navigation after the Home shell paints.
  useEffect(() => {
    if (chooseProfile || isAuthCallback) return
    return prefetchLikelyRoutes()
  }, [chooseProfile, isAuthCallback])

  // The updater and its markdown UI are irrelevant to first paint. Mount it
  // after startup settles; UpdatePrompt keeps its own delayed network check.
  useEffect(() => {
    if (chooseProfile || isAuthCallback) return
    const timer = window.setTimeout(() => setUpdatePromptReady(true), 1800)
    return () => window.clearTimeout(timer)
  }, [chooseProfile, isAuthCallback])

  useEffect(() => {
    const syncSources = () => {
      const desired = primaryProgressProvider === 'all'
        ? connectedProgressSources(useAppStore.getState())
        : [primaryProgressProvider]
      const current = useAppStore.getState().watchedCheckmarkSources
      if (desired.length === current.length && desired.every((source, index) => source === current[index])) return
      setWatchedCheckmarkSources(desired)
    }
    syncSources()
    window.addEventListener('aurales:mdblist-auth-changed', syncSources)
    return () => window.removeEventListener('aurales:mdblist-auth-changed', syncSources)
  }, [primaryProgressProvider, progressConnections, setWatchedCheckmarkSources, watchedCheckmarkSources])

  useEffect(() => {
    if (isAuthCallback) return
    const refreshWatchedSources = () => {
      const current = useAppStore.getState()
      const sources = current.primaryProgressProvider === 'all'
        ? connectedProgressSources(current)
        : [current.primaryProgressProvider]
      void import('./services/watchedCacheSync')
        .then(({ refreshWatchedCache }) => refreshWatchedCache(sources))
        .catch((error) => console.warn('[WatchedCache] account-change refresh failed:', error))
    }
    window.addEventListener('aurales:provider-account-changed', refreshWatchedSources)
    return () => window.removeEventListener('aurales:provider-account-changed', refreshWatchedSources)
  }, [isAuthCallback])

  useEffect(() => {
    if (chooseProfile || isAuthCallback) return
    return scheduleIdleWork(() => syncAddonsFromStore(addons), 500)
  }, [addons, chooseProfile, isAuthCallback])

  useEffect(() => {
    if (chooseProfile || isAuthCallback) return
    let cancelled = false
    let stopSync: (() => void) | undefined

    let stopProviderSync: (() => void) | undefined

    const cancelIdle = scheduleIdleWork(() => {
      import('./services/watchedCacheSync')
        .then((watchedCacheSync) => {
          if (cancelled) return
          watchedCacheSync.startWatchedCacheSync(watchedCheckmarkSources)
          stopSync = watchedCacheSync.stopWatchedCacheSync
        })
        .catch(() => {})
      // Per-provider background sync driven by the Sync Frequency settings.
      import('./services/providerSync')
        .then((providerSync) => {
          if (cancelled) return
          providerSync.startProviderSyncScheduler()
          stopProviderSync = providerSync.stopProviderSyncScheduler
        })
        .catch(() => {})
    }, 2500)

    return () => {
      cancelled = true
      cancelIdle()
      stopSync?.()
      stopProviderSync?.()
    }
  }, [watchedCheckmarkSources, chooseProfile, isAuthCallback])

  // Discord idle presence — set "Browsing" when no player is active
  useEffect(() => {
    if (chooseProfile || isAuthCallback || getPlatformCapabilities().platform !== 'tauri') return
    let cancelled = false
    let clearActivity: (() => Promise<void>) | undefined

    const cancelIdle = scheduleIdleWork(() => {
      import('./services/discord')
        .then(({ clearDiscordActivity, setDiscordBrowsingActivity }) => {
          clearActivity = clearDiscordActivity
          if (cancelled) return
          if (!discordRichPresence) {
            clearDiscordActivity().catch(() => {})
            return
          }
          setDiscordBrowsingActivity().catch(() => {})
        })
        .catch(() => {})
    }, 2500)

    return () => {
      cancelled = true
      cancelIdle()
      clearActivity?.().catch(() => {})
    }
  }, [discordRichPresence, chooseProfile, isAuthCallback])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme-accent', accentColor)
  }, [accentColor])

  useEffect(() => {
    document.documentElement.setAttribute('data-interface-theme', interfaceTheme)
  }, [interfaceTheme])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme-background', themeBackground)
  }, [themeBackground])

  // Expose the nav layout so the fixed hero (position: fixed, spans the whole
  // viewport) can offset itself past a pinned sidebar.
  useEffect(() => {
    const pinnedSidebar = navigationStyle !== 'topbar' && !sidebarCollapsed
    document.documentElement.setAttribute('data-nav', pinnedSidebar ? 'sidebar-pinned' : navigationStyle === 'topbar' ? 'topbar' : 'sidebar-overlay')
  }, [navigationStyle, sidebarCollapsed])

  useEffect(() => {
    const cleanBgHex = subtitleBgColor.replace('#', '')
    const bgR = parseInt(cleanBgHex.substring(0, 2), 16) || 0
    const bgG = parseInt(cleanBgHex.substring(2, 4), 16) || 0
    const bgB = parseInt(cleanBgHex.substring(4, 6), 16) || 0
    const bgRgb = `rgba(${bgR}, ${bgG}, ${bgB}, ${subtitleBgOpacity})`

    let textShadow = 'none'
    if (subtitleBorderStyle === 'outline') {
      textShadow = `0 0 ${subtitleOutlineThickness}px ${subtitleOutlineColor}, 0 0 1px ${subtitleOutlineColor}, 1px 1px 0 ${subtitleOutlineColor}, -1px -1px 0 ${subtitleOutlineColor}`
    } else if (subtitleBorderStyle === 'shadow') {
      textShadow = `${subtitleShadowOffset}px ${subtitleShadowOffset}px ${subtitleShadowOffset * 2}px rgba(0,0,0,${subtitleShadowOpacity})`
    }

    document.documentElement.style.setProperty('--sub-font-size', `${subtitleFontSize}px`)
    document.documentElement.style.setProperty('--sub-bg-opacity', subtitleBgOpacity)
    document.documentElement.style.setProperty('--sub-color', subtitleColor)
    document.documentElement.style.setProperty('--sub-scale', String(subtitleScale))
    document.documentElement.style.setProperty('--sub-bold', subtitleBold ? 'bold' : 'normal')
    document.documentElement.style.setProperty('--sub-italic', subtitleItalic ? 'italic' : 'normal')
    document.documentElement.style.setProperty('--sub-outline-color', subtitleOutlineColor)
    document.documentElement.style.setProperty('--sub-bg-color', subtitleBgColor)
    document.documentElement.style.setProperty('--sub-bg-rgba', bgRgb)
    document.documentElement.style.setProperty('--sub-outline-thickness', `${subtitleOutlineThickness}px`)
    document.documentElement.style.setProperty('--sub-shadow-offset', `${subtitleShadowOffset}px`)
    document.documentElement.style.setProperty('--sub-shadow-opacity', String(subtitleShadowOpacity))
    document.documentElement.style.setProperty('--sub-vertical-position', String(subtitleVerticalPosition))
    document.documentElement.style.setProperty('--sub-alignment', subtitleAlignment)
    document.documentElement.style.setProperty('--sub-horizontal-margin', `${subtitleHorizontalMargin}px`)
    document.documentElement.style.setProperty('--sub-text-blur', `${subtitleTextBlur}px`)
    document.documentElement.style.setProperty('--sub-blur-filter', subtitleTextBlur > 0 ? `blur(${subtitleTextBlur}px)` : 'none')
    document.documentElement.style.setProperty('--sub-text-shadow', textShadow)
    document.documentElement.style.setProperty('--sub-border-style', subtitleBorderStyle)
  }, [
    subtitleFontSize, subtitleBgOpacity, subtitleColor, subtitleScale, subtitleBold,
    subtitleItalic, subtitleOutlineColor, subtitleBgColor, subtitleOutlineThickness,
    subtitleShadowOffset, subtitleShadowOpacity, subtitleVerticalPosition, subtitleAlignment,
    subtitleHorizontalMargin, subtitleTextBlur, subtitleBorderStyle
  ])

  const startPagePath =
    defaultStartPage === 'collections'
      ? '/collections'
      : defaultStartPage === 'discover'
        ? '/discover'
        : defaultStartPage === 'search'
          ? '/search'
          : '/'

  return (
    <ErrorBoundary label="App">
      {chooseProfile ? (
        <WhoWatching onComplete={() => setChooseProfile(false)} />
      ) : (
        <>
          <ProfileSwitchTransition />
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-screen bg-black">
                <div className="w-12 h-12 rounded-2xl bg-accent/20 flex items-center justify-center animate-pulse">
                  <span className="text-accent font-black text-xl">A</span>
                </div>
              </div>
            }
          >
            <Routes>
              <Route path="/auth/simkl/callback" element={<SimklCallbackPage />} />
              <Route path="/auth/mdblist/callback" element={<MdblistCallbackPage />} />
              <Route element={<Layout />}>
                <Route path="/" element={startPagePath === '/' ? <HomePage /> : <Navigate to={startPagePath} replace />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/movie/:id" element={<MovieDetailPage />} />
                <Route path="/series/:id" element={<SeriesDetailPage />} />
                <Route path="/person/:id" element={<PersonPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/developer" element={<DeveloperPage />} />
                <Route path="/discover" element={<DiscoverPage />} />
                <Route path="/upcoming" element={<UpcomingPage />} />
                <Route path="/watch-together" element={<WatchTogetherPage />} />
                <Route path="/catalog/:rowId" element={<CatalogPage />} />
                <Route path="/home-editor" element={<Navigate to="/collections?tab=shelves" replace />} />
                <Route path="/collections" element={<CollectionsPage />} />
              </Route>
            </Routes>
            {updatePromptReady && <UpdatePrompt />}
          </Suspense>
        </>
      )}
    </ErrorBoundary>
  )
}
