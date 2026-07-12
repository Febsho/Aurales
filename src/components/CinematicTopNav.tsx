import { NavLink, useLocation } from 'react-router-dom'

const links = [
  { to: '/', label: 'Home', exact: true },
  { to: '/discover', label: 'Discover' },
  { to: '/collections', label: 'Library' },
  { to: '/settings', label: 'Settings' },
]

export default function CinematicTopNav({ hidden = false }: { hidden?: boolean }) {
  const location = useLocation()
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a, button'))
    const index = controls.indexOf(document.activeElement as HTMLElement)
    const next = controls[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus()
  }
  return (
    <header onKeyDown={handleKeyDown} className={`cinematic-top-nav group pointer-events-none absolute inset-x-0 top-1 z-[70] flex h-20 items-center justify-center px-8 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${hidden ? '-translate-y-[140%] opacity-0' : 'translate-y-0 opacity-100'}`}>
      <nav className="cinematic-nav-capsule pointer-events-auto flex items-center justify-center gap-2 rounded-[1.35rem] border border-white/10 px-4 py-3 shadow-2xl backdrop-blur-xl" aria-label="Primary navigation">
        <NavLink to="/search" aria-label="Search" title="Search" className="focus-ring flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" /></svg>
        </NavLink>
        {links.map((link) => {
          const active = link.exact ? location.pathname === link.to : location.pathname.startsWith(link.to)
          return (
            <NavLink key={link.to} to={link.to} className={`focus-ring rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200 ${active ? 'bg-white/[0.12] text-white shadow-inner ring-1 ring-white/10' : 'text-white/55 hover:bg-white/[0.08] hover:text-white focus-visible:bg-white/15'}`}>
              {link.label}
            </NavLink>
          )
        })}
      </nav>
    </header>
  )
}
