import type { ReactNode, HTMLAttributes } from 'react'

interface FocusRingProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  as?: 'div' | 'span'
}

export default function FocusRing({ children, as: Tag = 'div', className = '', ...props }: FocusRingProps) {
  return (
    <Tag
      tabIndex={0}
      className={[
        'outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        'rounded-xl transition-shadow duration-200',
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </Tag>
  )
}
