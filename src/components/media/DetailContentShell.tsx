import { useEffect, useRef, useState, type ReactNode } from 'react'

interface DetailContentShellProps {
  title: string
  logo?: string
  imdbId?: string
  backdrop?: string
  children: ReactNode
  className?: string
}

export default function DetailContentShell({
  title,
  logo,
  imdbId,
  backdrop,
  children,
  className = '',
}: DetailContentShellProps) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const [logoError, setLogoError] = useState(false)
  const [contentActive, setContentActive] = useState(false)
  const contentActiveRef = useRef(false)
  const logoUrl = logo || (imdbId ? `https://images.metahub.space/logo/medium/${imdbId}/img` : undefined)

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    const scrollContainer = section.closest('main')
    if (!scrollContainer) return

    scrollContainer.classList.add('detail-snap-scroll')

    let locked = false
    let sectionTop = section.offsetTop
    let scrollFrame = 0
    let transitionFrame = 0
    const updateActive = () => {
      // Scroll events can arrive once per display frame (240 times/sec on a
      // 240 Hz panel). Keep this path layout-free; the section offset is
      // refreshed only when layout can actually change.
      const nextActive = scrollContainer.scrollTop >= sectionTop * 0.72
      if (nextActive === contentActiveRef.current) return
      contentActiveRef.current = nextActive
      setContentActive(nextActive)
    }
    const onScroll = () => {
      if (scrollFrame) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0
        updateActive()
      })
    }
    const refreshSectionTop = () => {
      sectionTop = section.offsetTop
      updateActive()
    }
    const transitionTo = (top: number) => {
      if (locked) return
      locked = true
      const startTop = scrollContainer.scrollTop
      const distance = top - startTop
      const duration = 720
      const startTime = performance.now()
      const previousBehavior = scrollContainer.style.scrollBehavior
      scrollContainer.style.scrollBehavior = 'auto'

      const animate = (now: number) => {
        const progress = Math.min(1, (now - startTime) / duration)
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2
        scrollContainer.scrollTop = startTop + distance * eased
        updateActive()
        if (progress < 1) transitionFrame = window.requestAnimationFrame(animate)
        else {
          transitionFrame = 0
          scrollContainer.style.scrollBehavior = previousBehavior
          locked = false
        }
      }
      transitionFrame = window.requestAnimationFrame(animate)
    }
    let consecutiveUpDelta = 0
    const handleWheel = (event: WheelEvent) => {
      if (event.shiftKey) return
      const currentTop = scrollContainer.scrollTop
      const isOverHorizontalScroller = (event.target as HTMLElement | null)?.closest('.episode-scroll, .season-scroll')
      if (locked) {
        event.preventDefault()
        return
      }
      if (event.deltaY > 20 && currentTop <= 4) {
        event.preventDefault()
        consecutiveUpDelta = 0
        transitionTo(sectionTop)
        return
      }
      if (event.deltaY > 0) {
        consecutiveUpDelta = 0
        return
      }
      if (event.deltaY < -5 && currentTop > 0 && currentTop <= sectionTop + 200) {
        consecutiveUpDelta += Math.abs(event.deltaY)
        if (consecutiveUpDelta >= 60) {
          if (!isOverHorizontalScroller) event.preventDefault()
          consecutiveUpDelta = 0
          transitionTo(0)
        }
      }
    }
    refreshSectionTop()
    const resize = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(refreshSectionTop)
      : null
    resize?.observe(section)
    scrollContainer.addEventListener('scroll', onScroll, { passive: true })
    scrollContainer.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      scrollContainer.classList.remove('detail-snap-scroll')
      scrollContainer.removeEventListener('scroll', onScroll)
      scrollContainer.removeEventListener('wheel', handleWheel)
      resize?.disconnect()
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
      if (transitionFrame) window.cancelAnimationFrame(transitionFrame)
    }
  }, [])

  return (
    <section
      ref={sectionRef}
      className={`detail-content-shell ${contentActive ? 'is-active' : ''} ${className}`}
    >
      <div className="detail-content-shell__ambient" aria-hidden="true">
        {backdrop && <img src={backdrop} alt="" draggable={false} />}
      </div>
      <div className="detail-content-shell__fade" aria-hidden="true" />

      <div className="detail-content-shell__inner">
        <div className="detail-content-shell__brand">
          {logoUrl && !logoError ? (
            <img
              src={logoUrl}
              alt={title}
              onError={() => setLogoError(true)}
              draggable={false}
            />
          ) : (
            <h2>{title}</h2>
          )}
        </div>
        {children}
      </div>
    </section>
  )
}
