import { NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { getAppVersion } from '../services/updater'
import CreateRoomButton from './watch-together/CreateRoomButton'
import JoinRoomModal from './watch-together/JoinRoomModal'

const navItems = [
  { path: '/', label: 'Home', icon: HomeIcon, exact: true },
  { path: '/search', label: 'Search', icon: SearchIcon },
  { path: '/discover', label: 'Discover', icon: CompassIcon },
  { path: '/collections', label: 'Library', icon: LibraryIcon },
  { path: '/settings', label: 'Settings', icon: SettingsIcon },
  ...(import.meta.env.DEV ? [{ path: '/developer', label: 'Developer', icon: ToolIcon }] : []),
]

interface SidebarProps {
  onOverlayVisibleChange?: (visible: boolean) => void
}

export default function Sidebar({ onOverlayVisibleChange }: SidebarProps) {
  const autoHide = useAppStore((s) => s.sidebarCollapsed)
  const toggle = useAppStore((s) => s.toggleSidebar)
  const [hovered, setHovered] = useState(false)
  const [joinModalOpen, setJoinModalOpen] = useState(false)
  const location = useLocation()

  // Pinned = always visible, shifts content. Auto-hide = slides in on hover.
  const pinned = !autoHide
  const visible = pinned || hovered

  useEffect(() => {
    onOverlayVisibleChange?.(!pinned && visible)
  }, [onOverlayVisibleChange, pinned, visible])

  return (
    <>
      {/* Invisible hit zone on left edge — only needed in auto-hide mode */}
      {autoHide && (
        <>
          <div
            className="absolute top-0 left-0 bottom-0 w-5 z-40"
            onMouseEnter={() => setHovered(true)}
            onMouseMove={() => setHovered(true)}
          />
          {!visible && (
            <div
              className="absolute left-0 top-1/2 z-30 h-44 w-1.5 -translate-y-1/2 rounded-r-full bg-white/70 shadow-[0_0_18px_rgba(255,255,255,0.55)] pointer-events-none"
              aria-hidden="true"
            />
          )}
        </>
      )}
      <aside
        onMouseEnter={() => !pinned && setHovered(true)}
        onMouseLeave={() => !pinned && setHovered(false)}
        className={[
          'flex flex-col z-30',
          'transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
          pinned
            ? 'relative w-52 flex-shrink-0 bg-white/[0.08] backdrop-blur-2xl saturate-150 border-r border-white/[0.1] shadow-[8px_0_40px_rgba(0,0,0,0.35)]'
            : [
                'absolute top-3 bottom-3 rounded-2xl overflow-hidden',
                visible
                  ? 'left-3 w-52 bg-white/[0.08] backdrop-blur-2xl saturate-150 border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] opacity-100'
                  : '-left-56 w-52 opacity-0 pointer-events-none',
              ].join(' '),
        ].join(' ')}
      >
      {/* Logo + pin toggle */}
      <div className="flex items-center justify-between h-14 border-b border-white/[0.06] px-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-accent/20 flex items-center justify-center flex-shrink-0">
            <span className="text-accent font-black text-sm">A</span>
          </div>
          <span className="text-[15px] font-bold tracking-tight text-white whitespace-nowrap">Aurales</span>
        </div>
        <button
          onClick={toggle}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
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
      </div>

      {/* Nav items */}
      <nav className="flex-1 flex flex-col gap-0.5 p-2 mt-1">
        {navItems.map((item) => {
          const isActive = item.exact
            ? location.pathname === item.path
            : location.pathname.startsWith(item.path)

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={[
                'flex items-center gap-3 rounded-xl transition-all duration-200 group cursor-pointer px-3 py-2.5',
                isActive
                  ? 'bg-white/[0.12] text-white'
                  : 'text-white/50 hover:text-white hover:bg-white/[0.06]',
              ].join(' ')}
            >
              <item.icon
                className={[
                  'w-[18px] h-[18px] flex-shrink-0 transition-colors duration-200',
                  isActive ? 'text-white' : 'text-white/50 group-hover:text-white',
                ].join(' ')}
                filled={isActive}
              />
              <span className={`text-[13px] tracking-wide whitespace-nowrap ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {item.label}
              </span>
            </NavLink>
          )
        })}
      </nav>

      {/* Watch Together */}
      <div className="px-2 pb-1 flex flex-col gap-0.5">
        <CreateRoomButton />
        <button
          onClick={() => setJoinModalOpen(true)}
          className="flex items-center gap-3 rounded-xl transition-all duration-200 group cursor-pointer px-3 py-2.5 w-full text-white/50 hover:text-white hover:bg-white/[0.06]"
        >
          <svg
            className="w-[18px] h-[18px] flex-shrink-0 text-white/50 group-hover:text-white transition-colors duration-200"
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
          </svg>
          <span className="text-[13px] font-medium tracking-wide whitespace-nowrap">Join Room</span>
        </button>
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-white/[0.04]">
        <div className="text-[10px] text-white/20 text-center font-medium tracking-wide">Aurales v{getAppVersion()}</div>
      </div>

      <JoinRoomModal open={joinModalOpen} onClose={() => setJoinModalOpen(false)} />
    </aside>
    </>
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
