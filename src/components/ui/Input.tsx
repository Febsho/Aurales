import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  description?: string
  error?: string
  icon?: ReactNode
  iconRight?: ReactNode
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, description, error, icon, iconRight, className = '', id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-white/80">
            {label}
          </label>
        )}
        {description && (
          <p className="text-xs text-white/40">{description}</p>
        )}
        <div className="relative">
          {icon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 [&>svg]:w-4 [&>svg]:h-4">
              {icon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={[
              'w-full bg-white/5 hover:bg-white/8 border rounded-xl text-sm text-white placeholder-white/30',
              'transition-all duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
              'focus:outline-none focus:bg-white/10 focus:border-white/20',
              'focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]',
              error ? 'border-danger/40' : 'border-white/8',
              icon ? 'pl-10' : 'pl-4',
              iconRight ? 'pr-10' : 'pr-4',
              'py-2.5',
              props.disabled && 'opacity-50 pointer-events-none',
              className,
            ]
              .filter(Boolean)
              .join(' ')}
            {...props}
          />
          {iconRight && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 [&>svg]:w-4 [&>svg]:h-4">
              {iconRight}
            </div>
          )}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    )
  },
)

Input.displayName = 'Input'
export default Input
