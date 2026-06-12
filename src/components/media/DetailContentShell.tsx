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
  const logoUrl = logo || (imdbId ? `https://images.metahub.space/logo/medium/${imdbId}/img` : undefined)

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    const scrollContainer = section.closest('main')
    if (!scrollContainer) return

    scrollContainer.classList.add('detail-snap-scroll')

    let locked = false
    const updateActive = () => {
      setContentActive(scrollContainer.scrollTop >= section.offsetTop * 0.72)
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

        if (progress < 1) {
          window.requestAnimationFrame(animate)
        } else {
          scrollContainer.style.scrollBehavior = previousBehavior
          locked = false
        }
      }

      window.requestAnimationFrame(animate)
    }
    const handleWheel = (event: WheelEvent) => {
      if (event.shiftKey || (event.target as HTMLElement | null)?.closest('.episode-scroll')) return
      const sectionTop = section.offsetTop
      const currentTop = scrollContainer.scrollTop

      if (locked) {
        event.preventDefault()
        return
      }
      if (event.deltaY > 20 && currentTop <= 4) {
        event.preventDefault()
        transitionTo(sectionTop)
      } else if (event.deltaY < -20 && Math.abs(currentTop - sectionTop) <= 6) {
        event.preventDefault()
        transitionTo(0)
      }
    }

    updateActive()
    scrollContainer.addEventListener('scroll', updateActive, { passive: true })
    scrollContainer.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      scrollContainer.classList.remove('detail-snap-scroll')
      scrollContainer.removeEventListener('scroll', updateActive)
      scrollContainer.removeEventListener('wheel', handleWheel)
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
