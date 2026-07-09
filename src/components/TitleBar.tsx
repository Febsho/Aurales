import { useState, useEffect, useCallback, useMemo } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

// getCurrentWindow() throws outside the Tauri runtime (plain-browser preview),
// which would take the whole app down with it — render no chrome instead.
function useAppWindow() {
  return useMemo(() => {
    try {
      return getCurrentWindow()
    } catch (_) {
      return null
    }
  }, [])
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const appWindow = useAppWindow()

  useEffect(() => {
    if (!appWindow) return
    appWindow.isMaximized().then(setMaximized).catch(() => {})
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized).catch(() => {})
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [appWindow])

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (!appWindow) return
    if ((e.target as HTMLElement).closest('button')) return
    if ((e.target as HTMLElement).closest('input')) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    if (e.detail === 2) {
      appWindow.toggleMaximize()
    } else {
      appWindow.startDragging()
    }
  }, [appWindow])

  if (!appWindow) return null

  return (
    <div
      onMouseDown={handleDragStart}
      className="fixed top-0 left-0 right-0 h-8 z-[9999] select-none"
    >
      <div className="absolute top-0 right-0 h-8 flex items-center">
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => appWindow.minimize()}
          className="title-bar-btn group"
          aria-label="Minimize"
        >
          <svg className="w-[10px] h-[10px] text-white/50 group-hover:text-white" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => appWindow.toggleMaximize()}
          className="title-bar-btn group"
          aria-label={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? (
            <svg className="w-[10px] h-[10px] text-white/50 group-hover:text-white" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="0" width="8" height="8" rx="1" />
              <rect x="0" y="2" width="8" height="8" rx="1" />
            </svg>
          ) : (
            <svg className="w-[10px] h-[10px] text-white/50 group-hover:text-white" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => appWindow.close()}
          className="title-bar-btn title-bar-close group"
          aria-label="Close"
        >
          <svg className="w-[10px] h-[10px] text-white/50 group-hover:text-white" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
            <line x1="1" y1="1" x2="9" y2="9" strokeLinecap="round" />
            <line x1="9" y1="1" x2="1" y2="9" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
