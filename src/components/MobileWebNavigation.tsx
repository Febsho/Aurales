import { NavLink } from 'react-router-dom'
import { Compass, Home, Library, Search, Settings, UsersRound } from 'lucide-react'

const destinations = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/discover', label: 'Discover', icon: Compass },
  { to: '/watch-together', label: 'Together', icon: UsersRound },
  { to: '/collections', label: 'Library', icon: Library },
  { to: '/settings', label: 'Settings', icon: Settings },
]

/** Fixed browser-phone navigation. Desktop web and every Tauri window keep
 * their independently selectable existing sidebar/topbar. */
export default function MobileWebNavigation() {
  return (
    <nav className="mobile-web-nav" aria-label="Mobile navigation">
      {destinations.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={label}
          className={({ isActive }) => `mobile-web-nav__item${isActive ? ' is-active' : ''}`}
        >
          <Icon aria-hidden="true" strokeWidth={2} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
