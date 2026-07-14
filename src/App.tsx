import { useEffect, lazy, Suspense } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import ErrorBoundary from './components/ui/ErrorBoundary'
import { useAppStore } from './stores/appStore'
import { syncAddonsFromStore } from './services/addons'
import { setDiscordActivity, clearDiscordActivity } from './services/discord'
import { startWatchedCacheSync, stopWatchedCacheSync } from './services/watchedCacheSync'

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

export default function App() {
  const addons = useAppStore((s) => s.addons)
  const accentColor = useAppStore((s) => s.accentColor)
  const defaultStartPage = useAppStore((s) => s.defaultStartPage)
  const subtitleFontSize = useAppStore((s) => s.subtitleFontSize)
  const subtitleBgOpacity = useAppStore((s) => s.subtitleBgOpacity)
  const subtitleColor = useAppStore((s) => s.subtitleColor)

  const discordRichPresence = useAppStore((s) => s.discordRichPresence)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)

  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    syncAddonsFromStore(addons)
  }, [addons])

  useEffect(() => {
    startWatchedCacheSync(watchedCheckmarkSources)
    return () => stopWatchedCacheSync()
  }, [watchedCheckmarkSources])

  // Discord idle presence — set "Browsing" when no player is active
  useEffect(() => {
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
    return () => { clearDiscordActivity().catch(() => {}) }
  }, [discordRichPresence])

  useEffect(() => {
    const { imageCacheSizeMb, imageKeepDays } = useAppStore.getState()
    void import('./services/imageCache').then(({ configureImageCache }) => configureImageCache(imageCacheSizeMb, imageKeepDays))
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme-accent', accentColor)
  }, [accentColor])

  useEffect(() => {
    document.documentElement.style.setProperty('--sub-font-size', `${subtitleFontSize}px`)
    document.documentElement.style.setProperty('--sub-bg-opacity', subtitleBgOpacity)
    document.documentElement.style.setProperty('--sub-color', subtitleColor)
  }, [subtitleFontSize, subtitleBgOpacity, subtitleColor])

  useEffect(() => {
    if (location.pathname === '/' && defaultStartPage !== 'home') {
      if (defaultStartPage === 'collections') {
        navigate('/collections', { replace: true })
      } else if (defaultStartPage === 'discover') {
        navigate('/discover', { replace: true })
      } else if (defaultStartPage === 'search') {
        navigate('/search', { replace: true })
      }
    }
  }, [location.pathname, defaultStartPage, navigate])

  return (
    <ErrorBoundary label="App">
      <Suspense fallback={<div className="flex items-center justify-center h-screen bg-black" />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
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
      </Suspense>
    </ErrorBoundary>
  )
}
