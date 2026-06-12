import type { ReactNode } from 'react'

type BadgeVariant = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'outline'
type BadgeSize = 'sm' | 'md'

interface BadgeProps {
  variant?: BadgeVariant
  size?: BadgeSize
  icon?: ReactNode
  children: ReactNode
  className?: string
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-white/10 text-white/80 border-white/8',
  accent: 'bg-accent/15 text-accent border-accent/20',
  success: 'bg-success/15 text-success border-success/20',
  warning: 'bg-warning/15 text-warning border-warning/20',
  danger: 'bg-danger/15 text-danger border-danger/20',
  info: 'bg-info/15 text-info border-info/20',
  outline: 'bg-transparent text-white/60 border-white/15',
}

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-[10px] gap-1 rounded-md',
  md: 'px-2.5 py-1 text-xs gap-1.5 rounded-lg',
}

export default function Badge({
  variant = 'default',
  size = 'sm',
  icon,
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center font-semibold border uppercase tracking-wider',
        variantStyles[variant],
        sizeStyles[size],
        className,
      ].join(' ')}
    >
      {icon}
      {children}
    </span>
  )
}
