import type { HTMLAttributes, ReactNode } from 'react'

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  intensity?: 'subtle' | 'medium' | 'strong'
  border?: boolean
  children: ReactNode
}

const intensityStyles = {
  subtle: 'bg-white/[0.03] backdrop-blur-xl',
  medium: 'bg-white/[0.06] backdrop-blur-2xl',
  strong: 'bg-black/50 backdrop-blur-3xl saturate-150',
}

export default function GlassPanel({
  intensity = 'medium',
  border = true,
  children,
  className = '',
  ...props
}: GlassPanelProps) {
  return (
    <div
      className={[
        intensityStyles[intensity],
        border && 'border border-white/8',
        'rounded-2xl',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}
