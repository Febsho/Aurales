import { useEffect, useState } from 'react'
import { ArrowLeft, Play } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

interface DetailStickyHeaderProps {
  title: string
  actionLabel?: string
  onAction?: () => void
  actionLoading?: boolean
}

export default function DetailStickyHeader({
  title,
  actionLabel,
  onAction,
  actionLoading = false,
}: DetailStickyHeaderProps) {
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const hero = document.querySelector<HTMLElement>('.detail-page .detail-hero-panel')
    if (!hero || typeof IntersectionObserver === 'undefined') return
    const root = hero.closest('main')
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.boundingClientRect.top < 0 && entry.intersectionRatio <= 0.08)
    }, { root, threshold: [0, 0.08, 0.12] })
    observer.observe(hero)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="detail-sticky-anchor">
      <div className={`detail-sticky-header ${visible ? 'is-visible' : ''}`} aria-label="Detail navigation" aria-hidden={!visible}>
        <button type="button" tabIndex={visible ? 0 : -1} className="detail-sticky-header__back focus-ring" onClick={() => navigate(-1)} aria-label="Go back">
          <ArrowLeft aria-hidden="true" />
        </button>
        <strong title={title}>{title}</strong>
        {actionLabel && onAction && (
          <button
            type="button"
            tabIndex={visible ? 0 : -1}
            className="detail-sticky-header__action focus-ring"
            onClick={onAction}
            disabled={actionLoading}
          >
            <Play aria-hidden="true" />
            <span>{actionLabel}</span>
          </button>
        )}
      </div>
    </div>
  )
}
