import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import SearchPage from './pages/SearchPage'
import MovieDetailPage from './pages/MovieDetailPage'
import SeriesDetailPage from './pages/SeriesDetailPage'
import SettingsPage from './pages/SettingsPage'
import HomeEditorPage from './pages/HomeEditorPage'
import CatalogPage from './pages/CatalogPage'
import { useAppStore } from './stores/appStore'
import { syncAddonsFromStore } from './services/addons'

export default function App() {
  const addons = useAppStore((s) => s.addons)
  useEffect(() => { syncAddonsFromStore(addons) }, [addons])
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/movie/:id" element={<MovieDetailPage />} />
        <Route path="/series/:id" element={<SeriesDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/home-editor" element={<HomeEditorPage />} />
        <Route path="/catalog/:rowId" element={<CatalogPage />} />
      </Route>
    </Routes>
  )
}
