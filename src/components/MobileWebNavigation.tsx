import { useEffect, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Compass, Home, Library, Search, Settings, UsersRound } from 'lucide-react'
import { getActiveProfile, getProfiles, PROFILE_CHANGED_EVENT, setActiveProfile } from '../services/profiles'
import ProfileAvatar from './profiles/ProfileAvatar'

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
  const navigate = useNavigate()
  const location = useLocation()
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [, setProfileVersion] = useState(0)
  useEffect(() => {
    const refresh = () => setProfileVersion((version) => version + 1)
    window.addEventListener(PROFILE_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, refresh)
  }, [])
  const activeProfile = getActiveProfile()

  return (
    <>
    {location.pathname === '/' && <div className="mobile-web-profile" data-open={profileMenuOpen || undefined}>
      <button type="button" className="mobile-web-profile__trigger" aria-label={`Switch profile (currently ${activeProfile.name})`} aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}>
        <ProfileAvatar {...activeProfile} size="sm" className="!h-10 !w-10 !rounded-full" />
      </button>
      {profileMenuOpen && <div role="menu" className="mobile-web-profile__menu">
        {getProfiles().map((profile) => <button type="button" role="menuitem" key={profile.id} onClick={() => { void setActiveProfile(profile.id); setProfileMenuOpen(false) }} className="mobile-web-profile__item">
          <ProfileAvatar {...profile} size="sm" />
          <span>{profile.name}</span>
          {profile.id === activeProfile.id && <span className="mobile-web-profile__check">✓</span>}
        </button>)}
        <button type="button" role="menuitem" className="mobile-web-profile__manage" onClick={() => { setProfileMenuOpen(false); navigate('/settings?tab=profiles') }}>Manage profiles</button>
      </div>}
    </div>}
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
    </>
  )
}
