import type { ReactNode } from 'react'
import Button from './Button'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
  className?: string
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-16 px-6 ${className}`}>
      {icon && (
        <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/8 flex items-center justify-center mb-5 text-white/25 [&>svg]:w-7 [&>svg]:h-7">
          {icon}
        </div>
      )}
      <h3 className="text-base font-bold text-white/70 mb-1.5">{title}</h3>
      {description && (
        <p className="text-sm text-white/35 max-w-sm leading-relaxed">{description}</p>
      )}
      {action && (
        <div className="mt-5">
          <Button variant="secondary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  )
}
