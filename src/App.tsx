import { useEffect, lazy, Suspense } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import UpdatePrompt from './components/UpdatePrompt'
import ErrorBoundary from './components/ui/ErrorBoundary'
import { useAppStore } from './stores/appStore'

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

export default function App() {
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
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)

  useEffect(() => {
    let cancelled = false
    const cancelIdle = scheduleIdleWork(() => {
      import('./services/addons')
        .then(({ syncAddonsFromStore }) => {
          if (!cancelled) syncAddonsFromStore(addons)
        })
        .catch(() => {})
    }, 500)

    return () => {
      cancelled = true
      cancelIdle()
    }
  }, [addons])

  useEffect(() => {
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
  }, [watchedCheckmarkSources])

  // Discord idle presence — set "Browsing" when no player is active
  useEffect(() => {
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
  }, [discordRichPresence])

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
          <Route element={<Layout />}>
            <Route path="/" element={startPagePath === '/' ? <HomePage /> : <Navigate to={startPagePath} replace />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/movie/:id" element={<MovieDetailPage />} />
            <Route path="/series/:id" element={<SeriesDetailPage />} />
            <Route path="/person/:id" element={<PersonPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/developer" element={<DeveloperPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/catalog/:rowId" element={<CatalogPage />} />
            <Route path="/home-editor" element={<Navigate to="/collections?tab=shelves" replace />} />
            <Route path="/collections" element={<CollectionsPage />} />
          </Route>
        </Routes>
        <UpdatePrompt />
      </Suspense>
    </ErrorBoundary>
  )
}
