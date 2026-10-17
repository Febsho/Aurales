import type { ReactNode } from 'react'

interface DetailContentShellProps {
  title: string
  logo?: string
  imdbId?: string
  backdrop?: string
  children: ReactNode
  className?: string
}

export default function DetailContentShell({
  title: _title,
  logo: _logo,
  imdbId: _imdbId,
  backdrop,
  children,
  className = '',
}: DetailContentShellProps) {
  return (
    <section
      className={`detail-content-shell ${className}`}
    >
      <div className="detail-content-shell__ambient" aria-hidden="true">
        {backdrop && <img src={backdrop} alt="" draggable={false} />}
      </div>
      <div className="detail-content-shell__fade" aria-hidden="true" />

      <div className="detail-content-shell__inner">
        {children}
      </div>
    </section>
  )
}
