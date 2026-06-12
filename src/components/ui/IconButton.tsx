import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type IconButtonVariant = 'ghost' | 'glass' | 'filled' | 'danger'
type IconButtonSize = 'sm' | 'md' | 'lg'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: IconButtonVariant
  size?: IconButtonSize
  icon: ReactNode
  label: string
}

const variantStyles: Record<IconButtonVariant, string> = {
  ghost: 'bg-transparent hover:bg-white/8 text-white/60 hover:text-white',
  glass: 'bg-white/5 hover:bg-white/10 backdrop-blur-xl text-white/70 hover:text-white border border-white/8 hover:border-white/15',
  filled: 'bg-white/10 hover:bg-white/15 text-white border border-white/5 hover:border-white/15',
  danger: 'bg-transparent hover:bg-danger/15 text-white/50 hover:text-danger',
}

const sizeStyles: Record<IconButtonSize, string> = {
  sm: 'w-8 h-8 rounded-lg',
  md: 'w-10 h-10 rounded-xl',
  lg: 'w-12 h-12 rounded-xl',
}

const iconSizeStyles: Record<IconButtonSize, string> = {
  sm: '[&>svg]:w-4 [&>svg]:h-4',
  md: '[&>svg]:w-5 [&>svg]:h-5',
  lg: '[&>svg]:w-6 [&>svg]:h-6',
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ variant = 'ghost', size = 'md', icon, label, disabled, className = '', ...props }, ref) => {
    return (
      <button
        ref={ref}
        aria-label={label}
        disabled={disabled}
        className={[
          'inline-flex items-center justify-center',
          'transition-all duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
          'focus-ring cursor-pointer select-none',
          'active:scale-[0.93]',
          variantStyles[variant],
          sizeStyles[size],
          iconSizeStyles[size],
          disabled && 'opacity-50 pointer-events-none',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...props}
      >
        {icon}
      </button>
    )
  },
)

IconButton.displayName = 'IconButton'
export default IconButton
