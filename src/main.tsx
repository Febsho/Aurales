import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ToastProvider } from './components/ui/Toast'
import './index.css'

const ContextMenu = lazy(() => import('./components/ContextMenu'))

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
        <Suspense fallback={null}>
          <ContextMenu />
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
