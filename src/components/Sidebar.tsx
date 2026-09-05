import { NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../stores/appStore'
import { getAppVersion } from '../services/updater'
import { prefetchRoute } from '../services/routePrefetch'
import { getActiveProfile, getProfiles, PROFILE_CHANGED_EVENT, setActiveProfile } from '../services/profiles'
import ProfileAvatar from './profiles/ProfileAvatar'

const navItems = [
  { path: '/', label: 'Home', icon: HomeIcon, exact: true },
  { path: '/search', label: 'Search', icon: SearchIcon },
  { path: '/discover', label: 'Discover', icon: CompassIcon },
  { path: '/watch-together', label: 'Watch Together', icon: TogetherIcon },
  { path: '/collections', label: 'Library', icon: LibraryIcon },
  { path: '/settings', label: 'Settings', icon: SettingsIcon },
  ...(import.meta.env.DEV ? [{ path: '/developer', label: 'Developer', icon: ToolIcon }] : []),
]

export default function Sidebar() {
  const autoHide = useAppStore((s) => s.sidebarCollapsed)
  const toggle = useAppStore((s) => s.toggleSidebar)
  const [hovered, setHovered] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null)
  const [profileMenuPosition, setProfileMenuPosition] = useState({ left: 0, bottom: 0 })
  const [, setProfileVersion] = useState(0)
  const location = useLocation()
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const profileTriggerRef = useRef<HTMLButtonElement>(null)
  const profileMenuRef = useRef<HTMLDivElement>(null)

  const handleMouseEnter = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
    setHovered(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (profileMenuOpen) return
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHovered(false), 400)
  }, [profileMenuOpen])

  useEffect(() => {
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [])
  useEffect(() => { const refresh = () => setProfileVersion((value) => value + 1); window.addEventListener(PROFILE_CHANGED_EVENT, refresh); return () => window.removeEventListener(PROFILE_CHANGED_EVENT, refresh) }, [])

  const updateProfileMenuPosition = useCallback(() => {
    const rect = profileTriggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const menuWidth = 272
    setProfileMenuPosition({
      left: Math.min(rect.right + 12, window.innerWidth - menuWidth - 12),
      bottom: Math.max(12, window.innerHeight - rect.bottom),
    })
  }, [])

  useEffect(() => {
    if (!profileMenuOpen) return
    setHovered(true)
    updateProfileMenuPosition()
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      if (profileTriggerRef.current?.contains(target) || profileMenuRef.current?.contains(target)) return
      setProfileMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setProfileMenuOpen(false)
      profileTriggerRef.current?.focus()
    }
    window.addEventListener('resize', updateProfileMenuPosition)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', updateProfileMenuPosition)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [profileMenuOpen, updateProfileMenuPosition])

  const switchProfile = useCallback(async (profileId: string) => {
    setSwitchingProfileId(profileId)
    const switched = await setActiveProfile(profileId)
    if (!switched) setSwitchingProfileId(null)
  }, [])
  const activeProfile = getActiveProfile()

  // Pinned = always visible, shifts content. Auto-hide keeps an active-page
  // pill on screen, then opens a floating menu over the page.
  const pinned = !autoHide
  const visible = pinned || hovered
  const activeNavItem = navItems.find((item) => item.exact
    ? location.pathname === item.path
    : location.pathname.startsWith(item.path)) || navItems[0]
  const ActiveNavIcon = activeNavItem.icon

  return (
    <>
      <aside
        onMouseEnter={() => !pinned && handleMouseEnter()}
        onMouseLeave={() => !pinned && handleMouseLeave()}
        className={[
          'app-sidebar app-sidebar--glass flex flex-col',
          pinned
            ? 'relative z-30 w-52 flex-shrink-0 border-r border-white/[0.18] shadow-[8px_0_40px_rgba(0,0,0,0.32)]'
            : [
                // Apple TV-style navigation: a compact active-page pill at the
                // top left opens into an overlay menu without shifting content.
                'app-sidebar--floating absolute top-5 left-5 z-40 rounded-2xl overflow-hidden',
                visible
                  ? 'app-sidebar--liquid w-52 border border-white/[0.36] shadow-[0_18px_52px_rgba(0,0,0,0.30)]'
                  : 'app-sidebar--liquid h-11 w-auto rounded-full border border-white/[0.36] shadow-[0_12px_34px_rgba(0,0,0,0.24)]',
              ].join(' '),
        ].join(' ')}
      >
      {/* Logo + pin toggle */}
      {!pinned && !visible ? (
        <button
          type="button"
          onClick={handleMouseEnter}
          onFocus={handleMouseEnter}
          className="flex h-11 items-center gap-2.5 px-3.5 text-sm font-bold tracking-wide text-white/95 transition-all duration-200 hover:bg-white/[0.14] hover:text-white focus:outline-none"
          aria-label={`Open navigation; current page ${activeNavItem.label}`}
          aria-expanded={false}
        >
          <svg className="h-4 w-4 text-white/65" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <ActiveNavIcon className="h-[18px] w-[18px]" filled />
          <span>{activeNavItem.label}</span>
        </button>
      ) : pinned ? <div className="app-sidebar__header flex items-center justify-between h-14 border-b border-white/[0.06] px-4">
        <div className={`app-sidebar__brand flex items-center ${!pinned && !visible ? 'gap-0' : 'gap-2.5'}`}>
          <img
            src="/app-logo.png?v=3"
            alt=""
            className="w-8 h-8 object-contain flex-shrink-0"
            draggable={false}
          />
          <span className="app-sidebar__label text-sm font-bold tracking-tight text-white whitespace-nowrap">Aurales</span>
        </div>
        <button
          onClick={toggle}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
          title={pinned ? 'Auto-hide sidebar' : 'Pin sidebar'}
        >
          {pinned ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
            </svg>
          )}
        </button>
      </div> : null}

      {/* Nav items */}
      <nav className={`app-sidebar__nav flex-1 flex flex-col gap-0.5 p-2 ${!pinned && !visible ? 'hidden' : pinned ? 'mt-1' : 'my-2'}`}>
        {navItems.map((item) => {
          const isActive = item.exact
            ? location.pathname === item.path
            : location.pathname.startsWith(item.path)

          return (
            <NavLink
              key={item.path}
              to={item.path}
              onMouseEnter={() => prefetchRoute(item.path)}
              onFocus={() => { prefetchRoute(item.path); if (!pinned) setHovered(true) }}
              onClick={() => { if (!pinned) setHovered(false) }}
              className={[
                'flex items-center gap-3 rounded-xl transition-all duration-200 group cursor-pointer px-3 py-2.5',
                isActive
                  ? pinned ? 'bg-white/[0.12] text-white' : 'bg-white/[0.24] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.30),0_5px_16px_rgba(0,0,0,0.16)]'
                  : 'text-white/75 hover:text-white hover:bg-white/[0.12]',
              ].join(' ')}
            >
              <item.icon
                className={[
                  'w-[18px] h-[18px] flex-shrink-0 transition-colors duration-200',
                  isActive ? 'text-white' : 'text-white/65 group-hover:text-white',
                ].join(' ')}
                filled={isActive}
              />
              <span className={`app-sidebar__label text-sm tracking-wide whitespace-nowrap ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {item.label}
              </span>
            </NavLink>
          )
        })}
      </nav>

      {/* Footer */}
      {visible && <div className={`app-sidebar__footer p-3 border-t border-white/[0.10] ${!pinned ? 'bg-black/[0.08]' : 'border-white/[0.04]'}`}>
        <div className="sidebar-profile-switcher mb-3" data-open={profileMenuOpen || undefined}>
          <button ref={profileTriggerRef} onClick={() => setProfileMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={profileMenuOpen} aria-label={`Switch profile (currently ${activeProfile.name})`} className="sidebar-profile-trigger">
            <ProfileAvatar {...activeProfile} size="sm" className="!h-9 !w-9 !rounded-xl" />
            <span className="sidebar-profile-trigger__copy"><span>{activeProfile.name}</span><small>Switch profile</small></span>
            <svg className="sidebar-profile-chevron h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {profileMenuOpen && createPortal(
            <div ref={profileMenuRef} role="menu" aria-label="Profiles" className="sidebar-profile-menu" style={{ left: profileMenuPosition.left, bottom: profileMenuPosition.bottom }}>
              <div className="sidebar-profile-menu__label">Profiles</div>
              {getProfiles().map((profile) => {
                const current = profile.id === activeProfile.id
                const switching = profile.id === switchingProfileId
                return <button role="menuitem" key={profile.id} disabled={switchingProfileId !== null} onClick={() => { if (current) { setProfileMenuOpen(false); return }; void switchProfile(profile.id) }} className="sidebar-profile-menu-item">
                  <ProfileAvatar {...profile} size="sm" className="!h-9 !w-9 !rounded-xl" />
                  <span className="sidebar-profile-menu-item__copy"><span>{profile.name}</span><small>{switching ? 'Switching…' : current ? 'Current profile' : 'Switch profile'}</small></span>
                  {current ? <span className="sidebar-profile-menu-item__check">✓</span> : <span className="sidebar-profile-menu-item__chevron">›</span>}
                </button>
              })}
              <NavLink role="menuitem" to="/settings?tab=profiles" onClick={() => setProfileMenuOpen(false)} className="sidebar-profile-manage">
                <span className="sidebar-profile-manage__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg></span>
                <span className="sidebar-profile-menu-item__copy"><span>Manage Profiles</span><small>Add, edit, or remove profiles</small></span>
                <span className="sidebar-profile-menu-item__chevron">›</span>
              </NavLink>
            </div>,
            document.body,
          )}
        </div>
        <div className="text-meta text-white/20 text-center font-medium tracking-wide">Aurales v{getAppVersion()}</div>
      </div>}

    </aside>
    </>
  )
}

function TogetherIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3Z" fill={filled ? 'var(--color-surface, #111)' : 'none'} />
      <path d="M7 21h10" />
    </svg>
  )
}

function HomeIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.71 2.29a1 1 0 00-1.42 0l-9 9a1 1 0 001.42 1.42L4 12.41V21a1 1 0 001 1h5a1 1 0 001-1v-5h2v5a1 1 0 001 1h5a1 1 0 001-1v-8.59l.29.3a1 1 0 001.42-1.42l-9-9z" />
    </svg>
  )
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function SearchIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={filled ? 2.5 : 2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function CompassIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.36 5.64l-2.05 5.47-5.47 2.05 2.05-5.47 5.47-2.05z" />
    </svg>
  )
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}

function LibraryIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 4h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zm10 0h6a1 1 0 011 1v6a1 1 0 01-1 1h-6a1 1 0 01-1-1V5a1 1 0 011-1zM4 14h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6a1 1 0 011-1zm10 0h6a1 1 0 011 1v6a1 1 0 01-1 1h-6a1 1 0 01-1-1v-6a1 1 0 011-1z" />
    </svg>
  )
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function SettingsIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z" />
    </svg>
  )
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function ToolIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.7 4.3C.6 6.7 1 9.7 3 11.7c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.4-.4.4-1.1 0-1.5z" />
    </svg>
  )
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}
