import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { useState, useEffect, useLayoutEffect, useRef, useCallback, lazy, Suspense } from 'react'
import Sidebar from './Sidebar'
import { useAppStore } from '../stores/appStore'
import { useWatchTogetherStore } from '../stores/watchTogetherStore'
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp'
import TitleBar from './TitleBar'
import CinematicTopNav from './CinematicTopNav'
import { isEditableKeyboardTarget, isWatchTogetherShortcut } from '../services/keyboardShortcuts'

// Statically importing this pulls NativeMpvPlayer (and its scrobbler/discord
// dependency tree) into the eager startup bundle. Lazy keeps it off the
// critical path; the chunk still loads right after first paint.
const WatchTogetherAutoPlayer = lazy(() => import('./watch-together/WatchTogetherAutoPlayer'))
const WatchTogetherPanel = lazy(() => import('./watch-together/WatchTogetherPanel'))

export default function Layout() {
  const sidebarPinned = !useAppStore((s) => s.sidebarCollapsed)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const usesTopNav = useAppStore((s) => s.navigationStyle) === 'topbar'
  const roomPanelOpen = useWatchTogetherStore((s) => s.roomPanelOpen)
  const setRoomPanelOpen = useWatchTogetherStore((s) => s.setRoomPanelOpen)
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [sidebarOverlayVisible, setSidebarOverlayVisible] = useState(false)
  const [searchBarVisible, setSearchBarVisible] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [cinematicNavHidden, setCinematicNavHidden] = useState(false)
  const [cinematicAtTop, setCinematicAtTop] = useState(true)
  const isSearchPage = location.pathname === '/search'
  const inputRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const searchHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastMainScrollTop = useRef(0)
  const linuxNavFrame = useRef(0)
  const linuxReducedEffects = document.documentElement.dataset.platform === 'linux'

  const showSearchBar = useCallback(() => {
    if (searchHideTimer.current) { clearTimeout(searchHideTimer.current); searchHideTimer.current = null }
    setSearchBarVisible(true)
  }, [])

  const scheduleHideSearchBar = useCallback(() => {
    if (searchFocused || isSearchPage) return
    if (searchHideTimer.current) clearTimeout(searchHideTimer.current)
    searchHideTimer.current = setTimeout(() => setSearchBarVisible(false), 1500)
  }, [searchFocused, isSearchPage])

  useEffect(() => {
    return () => { if (searchHideTimer.current) clearTimeout(searchHideTimer.current) }
  }, [])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const onScroll = () => { if (searchBarVisible && !searchFocused && !isSearchPage) scheduleHideSearchBar() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [searchBarVisible, searchFocused, isSearchPage, scheduleHideSearchBar])

  useEffect(() => {
    if (!usesTopNav) {
      setCinematicNavHidden(false)
      setCinematicAtTop(true)
      return
    }
    const el = mainRef.current
    if (!el) return
    lastMainScrollTop.current = el.scrollTop
    setCinematicAtTop(el.scrollTop <= 24)
    const updateNavForScroll = () => {
      const current = el.scrollTop
      const delta = current - lastMainScrollTop.current
      if (current <= 24) setCinematicNavHidden(false)
      else if (delta > 6) setCinematicNavHidden(true)
      else if (delta < -6) setCinematicNavHidden(false)
      setCinematicAtTop(current <= 24)
      lastMainScrollTop.current = current
    }
    const onScroll = () => {
      if (!linuxReducedEffects) {
        updateNavForScroll()
        return
      }
      if (linuxNavFrame.current) return
      linuxNavFrame.current = window.requestAnimationFrame(() => {
        linuxNavFrame.current = 0
        updateNavForScroll()
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (linuxNavFrame.current) {
        window.cancelAnimationFrame(linuxNavFrame.current)
        linuxNavFrame.current = 0
      }
    }
  }, [usesTopNav, location.pathname, linuxReducedEffects])

  useLayoutEffect(() => {
    // Home must also reset: returning from a scrolled detail page would leave
    // the shared <main> offset in place and displace the fixed hero.
    if (location.pathname !== '/' && !location.pathname.startsWith('/movie/') && !location.pathname.startsWith('/series/')) return
    const resetScroll = () => mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    resetScroll()
    const frame = requestAnimationFrame(resetScroll)
    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.key])

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

  // Cinematic has no persistent search bar elsewhere, so focus the input as
  // soon as the search page opens (e.g. via the top-nav search icon).
  useEffect(() => {
    if (!usesTopNav || !isSearchPage) return
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [usesTopNav, isSearchPage])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableKeyboardTarget(document.activeElement)) return

      if (isWatchTogetherShortcut(e)) {
        e.preventDefault()
        setRoomPanelOpen(!useWatchTogetherStore.getState().roomPanelOpen)
      } else if (e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        // In cinematic the search input only exists on the search page.
        if (usesTopNav && location.pathname !== '/search') {
          navigate('/search')
          return
        }
        setSearchBarVisible(true)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goBack, usesTopNav, location.pathname, navigate, setRoomPanelOpen])

  useEffect(() => {
    if (!cinematic) return
    const handleTvNavigation = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const active = document.activeElement as HTMLElement | null
      const currentRow = active?.closest('.cinematic-row-track')
      if (!currentRow) return
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.cinematic-row-track'))
      const rowIndex = rows.indexOf(currentRow as HTMLElement)
      const targetRow = rows[rowIndex + (event.key === 'ArrowDown' ? 1 : -1)]
      const target = targetRow?.querySelector<HTMLElement>(':scope > button')
      if (!target) return
      event.preventDefault()
      target.focus({ preventScroll: true })
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'start' })
    }
    window.addEventListener('keydown', handleTvNavigation)
    return () => window.removeEventListener('keydown', handleTvNavigation)
  }, [cinematic])

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
      const text = query.trim()
      navigate(text ? `/search?q=${encodeURIComponent(text)}` : '/search')
    }
  }

  const handleSearchFocus = () => {
    setSearchFocused(true)
    setSearchBarVisible(true)
    if (location.pathname === '/search') return
    const text = query.trim()
    navigate(text ? `/search?q=${encodeURIComponent(text)}` : '/search')
  }

  const handleSearchBlur = () => {
    setSearchFocused(false)
    window.setTimeout(() => {
      if (document.activeElement !== inputRef.current) scheduleHideSearchBar()
    }, 120)
  }

  const topControlLeft = !sidebarPinned && sidebarOverlayVisible ? 'left-[14.75rem]' : 'left-4'
  const searchInput = (
    <div className="global-search relative mx-auto w-full">
      <div className="absolute left-3.5 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
        <svg className="w-4 h-4 text-white/60" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
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
        onFocus={handleSearchFocus}
        onBlur={handleSearchBlur}
        placeholder="Search movies, shows, people..."
        className={[
          'global-search__input w-full pl-10 pr-12 py-2.5',
          'border',
          'rounded-xl text-sm font-medium tracking-wide',
          'text-white placeholder-white/30',
          'focus:outline-none',
          'transition-all duration-300 ease-expo',
          'shadow-[0_4px_16px_rgba(0,0,0,0.3)]',
        ].join(' ')}
      />
      {query ? (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            handleInputChange('')
            inputRef.current?.focus()
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center text-white/50 hover:text-white/70 hover:bg-white/[0.08] transition-colors cursor-pointer"
          aria-label="Clear search"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <div className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
          <kbd className="text-meta font-bold text-white/25 px-1.5 py-0.5 bg-white/[0.06] rounded border border-white/[0.06]">/</kbd>
        </div>
      )}
    </div>
  )

  return (
    <div className={`app-theme-shell h-screen overflow-hidden bg-black hero-bg-transparent ${!usesTopNav && sidebarPinned ? 'flex' : 'relative'} ${cinematic ? 'cinematic-tv-shell' : ''}`} data-nav-mode={usesTopNav ? 'topbar' : sidebarPinned ? 'sidebar-pinned' : 'sidebar-overlay'}>
      <TitleBar />
      {usesTopNav
        ? <CinematicTopNav hidden={cinematicNavHidden} />
        : <Sidebar onOverlayVisibleChange={setSidebarOverlayVisible} />}
      {/* Cinematic brand: fixed top-left, independent of the top nav. Shown on
          Home (until scrolled) and Settings; hidden on Discover/Library/etc. */}
      {usesTopNav && cinematic && (location.pathname === '/' ? cinematicAtTop : location.pathname.startsWith('/settings')) && (
        <div className="cinematic-nav-brand">
          <img src="/app-logo.png?v=3" alt="" className="h-10 w-10 object-contain" />
          <span className="text-xl font-black tracking-tight text-white">Aurales</span>
        </div>
      )}

      {/* Content area — shifts right when pinned, full-bleed when auto-hide */}
      <div className={`relative flex flex-col min-h-0 h-full ${!usesTopNav && sidebarPinned ? 'flex-1 min-w-0' : 'absolute inset-0'}`}>
        {!usesTopNav && location.pathname !== '/' && location.pathname !== '/discover' && (
          <button
            type="button"
            onClick={goBack}
            className={[
              'absolute top-4 z-50',
              topControlLeft,
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
        {/* Narrow center proximity zone — triggers search bar near the indicator */}
        {!usesTopNav && <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-10 z-[9997]"
          onMouseEnter={showSearchBar}
        />}
        {/* Glowing indicator pill — visible when search bar is hidden */}
        {!usesTopNav && !searchBarVisible && !searchFocused && !isSearchPage && (
          <div
            className="absolute top-0 left-1/2 -translate-x-1/2 z-[9998] w-28 h-1 rounded-b-full bg-white/70 shadow-[0_0_18px_rgba(255,255,255,0.55)] pointer-events-none"
            aria-hidden="true"
          />
        )}
        {/* Search bar — slides down from top; in cinematic it only exists on
            the search page, sitting below the floating top nav */}
        {(!usesTopNav || isSearchPage) && <header
          onMouseEnter={usesTopNav ? undefined : showSearchBar}
          onMouseLeave={usesTopNav ? undefined : scheduleHideSearchBar}
          className={[
            // A top-bar search belongs beneath the navigation capsule and its
            // profile menu. Sidebar search remains above its own content.
            `${usesTopNav ? 'fixed z-[60]' : 'absolute z-[9998]'} left-1/2`,
            'w-[min(38rem,calc(100vw-2rem))]',
            'transition-all duration-300 ease-expo',
            usesTopNav || searchBarVisible || searchFocused || isSearchPage
              ? `-translate-x-1/2 ${usesTopNav ? 'top-[7.25rem]' : 'top-9'} opacity-100 pointer-events-auto`
              : '-translate-x-1/2 -top-8 opacity-0 pointer-events-none',
          ].join(' ')}
        >
          {searchInput}
        </header>}

        <main ref={mainRef} className={`app-scroll-root flex-1 min-h-0 overflow-y-auto overflow-x-hidden ${roomPanelOpen ? 'app-scroll-root--panel-open mr-[380px]' : ''} ${cinematic ? 'cinematic-main' : ''} transition-[margin] duration-300 ease-expo`}>
          <Outlet />
        </main>
      </div>

      {roomPanelOpen && (
        <Suspense fallback={null}>
          <WatchTogetherPanel open={roomPanelOpen} onClose={() => setRoomPanelOpen(false)} />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <WatchTogetherAutoPlayer />
      </Suspense>
      <KeyboardShortcutsHelp />
    </div>
  )
}
