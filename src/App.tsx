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
const HomeEditorPage = lazy(() => import('./pages/HomeEditorPage'))
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
  const defaultStartPage = useAppStore((s) => s.defaultStartPage)
  const subtitleFontSize = useAppStore((s) => s.subtitleFontSize)
  const subtitleBgOpacity = useAppStore((s) => s.subtitleBgOpacity)
  const subtitleColor = useAppStore((s) => s.subtitleColor)

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
        .then(({ clearDiscordActivity, setDiscordActivity }) => {
          clearActivity = clearDiscordActivity
          if (cancelled) return
          if (!discordRichPresence) {
            clearDiscordActivity().catch(() => {})
            return
          }
          setDiscordActivity({
            details: 'Browsing',
            largeImage: 'aurales_logo',
            largeText: 'Aurales',
            activityType: 3,
          }).catch(() => {})
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
    document.documentElement.style.setProperty('--sub-font-size', `${subtitleFontSize}px`)
    document.documentElement.style.setProperty('--sub-bg-opacity', subtitleBgOpacity)
    document.documentElement.style.setProperty('--sub-color', subtitleColor)
  }, [subtitleFontSize, subtitleBgOpacity, subtitleColor])

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
            <Route path="/home-editor" element={<HomeEditorPage />} />
            <Route path="/collections" element={<CollectionsPage />} />
          </Route>
        </Routes>
        <UpdatePrompt />
      </Suspense>
    </ErrorBoundary>
  )
}
