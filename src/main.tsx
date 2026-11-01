import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ui/Toast'
import './index.css'
import { markPerformance, performanceSnapshot } from './services/performanceMetrics'
import { useAppStore } from './stores/appStore'
import { configureImageCache } from './services/imageCache'

markPerformance('bootstrap-start')

if (import.meta.env.VITE_WEB_BUILD === 'true' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('[PWA] Service worker registration failed:', error)
    })
  }, { once: true })
}

const App = lazy(() => import('./App'))
const ContextMenu = lazy(() => import('./components/ContextMenu'))
const ArtworkDebugOverlay = lazy(() => import('./components/ArtworkDebugOverlay'))
const SimklCallbackPage = lazy(() => import('./pages/SimklCallbackPage'))
const MdblistCallbackPage = lazy(() => import('./pages/MdblistCallbackPage'))

// WebKitGTK has to use its non-DMA-BUF renderer on GPU/driver combinations
// where GBM allocation fails. Mark Linux early so CSS can avoid effects that
// are disproportionately expensive on that reliable fallback path.
if (navigator.userAgent.includes('Linux')) {
  document.documentElement.dataset.platform = 'linux'
}

// The Rust image cache starts with defaults on every process launch. Apply the
// persisted device settings before React mounts any artwork components, or a
// fresh session silently uses the default size/retention until Settings opens.
const imageCacheSettings = useAppStore.getState()
const configureImageCacheBeforeMount = configureImageCache(imageCacheSettings.imageCacheSizeMb, imageCacheSettings.imageKeepDays)

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', async () => {
    const { cacheClearAll } = await import('./services/cache/sqliteCache')
    const cleared = await cacheClearAll()
    if (cleared > 0) console.log(`[DEV] HMR cleared ${cleared} cache entries`)
  })
}

if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => e.preventDefault())
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') e.preventDefault()
    if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) e.preventDefault()
  })
}

const isProviderCallback = window.location.pathname === '/auth/simkl/callback'
  || window.location.pathname === '/auth/mdblist/callback'

function AppRoutes() {
  if (isProviderCallback) {
    return (
      <Suspense fallback={<div className="grid min-h-screen place-items-center bg-black text-white">Finishing sign-in…</div>}>
        <Routes>
          <Route path="/auth/simkl/callback" element={<SimklCallbackPage />} />
          <Route path="/auth/mdblist/callback" element={<MdblistCallbackPage />} />
        </Routes>
      </Suspense>
    )
  }
  return (
    <>
      <Suspense fallback={null}><App /></Suspense>
      <Suspense fallback={null}>
        <ContextMenu />
        {import.meta.env.DEV && <ArtworkDebugOverlay />}
      </Suspense>
    </>
  )
}

function mountApp(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}

// Keep the first native artwork request behind the cache configuration IPC,
// but never leave the entire window blank if native IPC stalls during startup.
const IMAGE_CACHE_STARTUP_DEADLINE_MS = 1500
const imageCacheStartupDeadline = new Promise<void>((resolve) => {
  window.setTimeout(resolve, IMAGE_CACHE_STARTUP_DEADLINE_MS)
})
void Promise.race([configureImageCacheBeforeMount, imageCacheStartupDeadline]).then(mountApp, mountApp)

if (import.meta.env.DEV) {
  Object.assign(window, { auralesPerformance: performanceSnapshot })
}
