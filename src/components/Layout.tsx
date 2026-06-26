import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import Sidebar from './Sidebar'
import { useAppStore } from '../stores/appStore'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import WatchTogetherPanel from './watch-together/WatchTogetherPanel'
import WatchTogetherAutoPlayer from './watch-together/WatchTogetherAutoPlayer'

export default function Layout() {
  const sidebarPinned = !useAppStore((s) => s.sidebarCollapsed)
  const roomPanelOpen = useWatchTogetherStore((s) => s.roomPanelOpen)
  const setRoomPanelOpen = useWatchTogetherStore((s) => s.setRoomPanelOpen)
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    if (!location.pathname.startsWith('/movie/') && !location.pathname.startsWith('/series/')) return
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [location.pathname])

  const goBack = useCallback(() => {
    const historyIndex = typeof window.history.state?.idx === 'number'
      ? window.history.state.idx
      : window.history.length - 1

    if (historyIndex > 0) {
      navigate(-1)
    } else {
      navigate('/')
    }
  }, [navigate])

  useEffect(() => {
    const q = searchParams.get('q') || ''
    setQuery(q)
  }, [searchParams])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return
      }

      if (e.key === '/') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goBack])

  useEffect(() => {
    const handleMouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return
      event.preventDefault()
      goBack()
    }

    window.addEventListener('mouseup', handleMouseBack)
    return () => window.removeEventListener('mouseup', handleMouseBack)
  }, [goBack])

  const handleInputChange = (val: string) => {
    setQuery(val)
    if (val.trim()) {
      navigate(`/search?q=${encodeURIComponent(val)}`, { replace: location.pathname === '/search' })
    } else {
      navigate('/search', { replace: location.pathname === '/search' })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      navigate(`/search?q=${encodeURIComponent(query)}`)
    }
  }

  const isHeroPage = location.pathname === '/' || location.pathname.startsWith('/movie/') || location.pathname.startsWith('/series/')

  return (
    <div className={`h-screen overflow-hidden bg-black ${sidebarPinned ? 'flex' : 'relative'}`}>
      <Sidebar />

      {/* Content area — shifts right when pinned, full-bleed when auto-hide */}
      <div className={`relative flex flex-col min-h-0 h-full ${sidebarPinned ? 'flex-1 min-w-0' : 'absolute inset-0'}`}>
        {location.pathname !== '/' && (
          <button
            type="button"
            onClick={goBack}
            className={[
              'absolute top-4 left-4 z-50',
              'w-11 h-11 rounded-full flex items-center justify-center',
              'bg-black/45 hover:bg-black/70 backdrop-blur-xl',
              'border border-white/15 hover:border-white/30',
              'text-white/75 hover:text-white shadow-lg',
              'transition-all duration-200 cursor-pointer focus-ring',
            ].join(' ')}
            title="Go back (Alt+Left)"
            aria-label="Go back"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {/* Search bar — top-right on hero pages */}
        {!isHeroPage && (
          <header className="relative h-14 flex items-center justify-center px-6 z-20 flex-shrink-0">
            <div className="relative w-full max-w-lg">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
                <svg className="w-4 h-4 text-white/35" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search movies, shows, people..."
                className={[
                  'w-full pl-10 pr-12 py-2.5',
                  'bg-white/[0.06] hover:bg-white/[0.09] focus:bg-white/[0.12]',
                  'border border-white/[0.06] focus:border-white/[0.15]',
                  'rounded-xl text-sm font-medium tracking-wide',
                  'text-white placeholder-white/30',
                  'focus:outline-none',
                  'transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
                  'shadow-[0_4px_16px_rgba(0,0,0,0.3)]',
                  'backdrop-blur-xl',
                ].join(' ')}
              />
              <div className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
                <kbd className="text-[10px] font-bold text-white/25 px-1.5 py-0.5 bg-white/[0.06] rounded border border-white/[0.06]">/</kbd>
              </div>
            </div>
          </header>
        )}

        <main ref={mainRef} className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden ${isHeroPage ? '' : ''} ${roomPanelOpen ? 'mr-[380px]' : ''} transition-[margin] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]`}>
          <Outlet />
        </main>
      </div>

      <WatchTogetherPanel open={roomPanelOpen} onClose={() => setRoomPanelOpen(false)} />
      <WatchTogetherAutoPlayer />
    </div>
  )
}
