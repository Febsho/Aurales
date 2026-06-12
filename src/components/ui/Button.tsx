import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type ButtonVariant = 'primary' | 'white' | 'secondary' | 'ghost' | 'glass' | 'danger' | 'success'
type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  iconRight?: ReactNode
  loading?: boolean
  fullWidth?: boolean
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent hover:bg-accent-hover text-black font-bold shadow-lg shadow-accent/20 hover:shadow-accent/30',
  white:
    'bg-white hover:bg-white/90 text-black font-bold shadow-lg',
  secondary:
    'bg-white/10 hover:bg-white/15 text-white border border-white/10 hover:border-white/20',
  ghost:
    'bg-transparent hover:bg-white/8 text-white/80 hover:text-white',
  glass:
    'bg-white/5 hover:bg-white/10 backdrop-blur-xl text-white border border-white/8 hover:border-white/15',
  danger:
    'bg-danger/15 hover:bg-danger/25 text-danger border border-danger/20 hover:border-danger/30',
  success:
    'bg-success/15 hover:bg-success/25 text-success border border-success/20 hover:border-success/30',
}

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5 rounded-lg',
  md: 'px-4 py-2.5 text-sm gap-2 rounded-xl',
  lg: 'px-6 py-3 text-sm gap-2.5 rounded-xl',
  xl: 'px-8 py-3.5 text-base gap-3 rounded-2xl',
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      icon,
      iconRight,
      loading,
      fullWidth,
      disabled,
      className = '',
      children,
      ...props
    },
    ref,
  ) => {
    const isDisabled = disabled || loading

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={[
          'inline-flex items-center justify-center font-semibold',
          'transition-all duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
          'focus-ring cursor-pointer select-none',
          'active:scale-[0.97]',
          variantStyles[variant],
          sizeStyles[size],
          isDisabled && 'opacity-50 pointer-events-none',
          fullWidth && 'w-full',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...props}
      >
        {loading ? (
          <svg
            className="w-4 h-4 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        ) : (
          icon
        )}
        {children}
        {iconRight}
      </button>
    )
  },
)

Button.displayName = 'Button'
export default Button
