import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { prefetchRoute } from '../services/routePrefetch'

const links = [
  { to: '/', label: 'Home', exact: true },
  { to: '/discover', label: 'Discover' },
  { to: '/watch-together', label: 'Together' },
  { to: '/collections', label: 'Library' },
  { to: '/settings', label: 'Settings' },
]

interface IndicatorRect {
  left: number
  width: number
}

export default function CinematicTopNav({ hidden = false }: { hidden?: boolean }) {
  const location = useLocation()
  const navRef = useRef<HTMLElement>(null)
  const [indicator, setIndicator] = useState<IndicatorRect | null>(null)
  // The indicator slides between destinations, but must not animate into
  // position on first paint -- that reads as the nav assembling itself.
  const hasPositioned = useRef(false)

  const activeIndex = links.findIndex((link) =>
    link.exact ? location.pathname === link.to : location.pathname.startsWith(link.to),
  )

  const measure = useCallback(() => {
    const nav = navRef.current
    if (!nav) return
    const active = nav.querySelector<HTMLElement>('[data-nav-active="true"]')
    if (!active) {
      setIndicator(null)
      return
    }
    const navBox = nav.getBoundingClientRect()
    const activeBox = active.getBoundingClientRect()
    setIndicator({ left: activeBox.left - navBox.left, width: activeBox.width })
  }, [])

  useLayoutEffect(() => {
    measure()
    const id = requestAnimationFrame(() => {
      measure()
      hasPositioned.current = true
    })
    return () => cancelAnimationFrame(id)
  }, [measure, activeIndex])

  // Fluid type means the pill widths change with the viewport, so the
  // indicator has to be re-measured on resize rather than only on navigation.
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [measure])

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
    <header
      onKeyDown={handleKeyDown}
      data-nav-hidden={hidden || undefined}
      className="cinematic-top-nav"
    >
      <nav ref={navRef} className="cinematic-nav-capsule" aria-label="Primary navigation">
        {/* Sits behind the labels and slides between them. transform-only, so
            it never triggers layout while moving. */}
        {indicator && (
          <span
            aria-hidden="true"
            className="cinematic-nav-indicator"
            data-instant={hasPositioned.current ? undefined : true}
            style={{
              transform: `translateX(${indicator.left}px)`,
              width: `${indicator.width}px`,
            }}
          />
        )}
        <NavLink to="/search" onMouseEnter={() => prefetchRoute('/search')} onFocus={() => prefetchRoute('/search')} aria-label="Search" title="Search" className="cinematic-nav-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
        </NavLink>
        {links.map((link, index) => {
          const active = index === activeIndex
          return (
            <NavLink
              key={link.to}
              to={link.to}
              onMouseEnter={() => prefetchRoute(link.to)}
              onFocus={() => prefetchRoute(link.to)}
              data-nav-active={active}
              aria-current={active ? 'page' : undefined}
              className="cinematic-nav-link"
            >
              {link.label}
            </NavLink>
          )
        })}
      </nav>
    </header>
  )
}
