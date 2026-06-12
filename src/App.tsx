import { useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import SearchPage from './pages/SearchPage'
import MovieDetailPage from './pages/MovieDetailPage'
import SeriesDetailPage from './pages/SeriesDetailPage'
import SettingsPage from './pages/SettingsPage'
import DeveloperPage from './pages/DeveloperPage'
import CatalogPage from './pages/CatalogPage'
import HomeEditorPage from './pages/HomeEditorPage'
import CollectionsPage from './pages/CollectionsPage'
import DiscoverPage from './pages/DiscoverPage'
import { useAppStore } from './stores/appStore'
import { syncAddonsFromStore } from './services/addons'
import { setDiscordActivity, clearDiscordActivity } from './services/discord'

export default function App() {
  const addons = useAppStore((s) => s.addons)
  const accentColor = useAppStore((s) => s.accentColor)
  const defaultStartPage = useAppStore((s) => s.defaultStartPage)
  const subtitleFontSize = useAppStore((s) => s.subtitleFontSize)
  const subtitleBgOpacity = useAppStore((s) => s.subtitleBgOpacity)

  const discordRichPresence = useAppStore((s) => s.discordRichPresence)

  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    syncAddonsFromStore(addons)
  }, [addons])

  // Discord idle presence — set "Browsing" when no player is active
  useEffect(() => {
    if (!discordRichPresence) {
      clearDiscordActivity().catch(() => {})
      return
    }
    setDiscordActivity({
      details: 'Browsing',
      largeImage: 'orynt_logo',
      largeText: 'Orynt',
      activityType: 3,
    }).catch(() => {})
    return () => { clearDiscordActivity().catch(() => {}) }
  }, [discordRichPresence])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme-accent', accentColor)
  }, [accentColor])

  useEffect(() => {
    document.documentElement.style.setProperty('--sub-font-size', `${subtitleFontSize}px`)
    document.documentElement.style.setProperty('--sub-bg-opacity', subtitleBgOpacity)
  }, [subtitleFontSize, subtitleBgOpacity])

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
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/movie/:id" element={<MovieDetailPage />} />
        <Route path="/series/:id" element={<SeriesDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/developer" element={<DeveloperPage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/catalog/:rowId" element={<CatalogPage />} />
        <Route path="/home-editor" element={<HomeEditorPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
      </Route>
    </Routes>
  )
}
