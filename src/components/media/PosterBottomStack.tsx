import type { ReactNode } from 'react'

interface PosterBottomStackProps {
  logo?: ReactNode
  footer?: ReactNode
  underDetailsProgress?: ReactNode
  bottomProgress?: ReactNode
  className?: string
}

/** Keep the title logo, caption, and progress in one flow so absent rows collapse naturally. */
export function PosterBottomStack({ logo, footer, underDetailsProgress, bottomProgress, className = '' }: PosterBottomStackProps) {
  if (!logo && !footer && !underDetailsProgress && !bottomProgress) return null

  return (
    <div className={`poster-bottom-stack ${footer ? 'poster-bottom-stack--with-footer' : ''} ${className}`}>
      {logo && <div className="poster-bottom-stack__logo">{logo}</div>}
      {footer && <div className="poster-bottom-stack__footer">{footer}</div>}
      {underDetailsProgress}
      {bottomProgress && <div className="poster-bottom-stack__progress">{bottomProgress}</div>}
    </div>
  )
}
