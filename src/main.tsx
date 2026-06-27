import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ToastProvider } from './components/ui/Toast'
import ContextMenu from './components/ContextMenu'
import './index.css'

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', async () => {
    const { cacheClearAll } = await import('./services/cache/sqliteCache')
    const cleared = await cacheClearAll()
    if (cleared > 0) console.log(`[DEV] HMR cleared ${cleared} cache entries`)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
        <ContextMenu />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
