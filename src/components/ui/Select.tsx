import { forwardRef, type SelectHTMLAttributes } from 'react'

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string
  description?: string
  options: SelectOption[]
  error?: string
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, description, options, error, className = '', id, ...props }, ref) => {
    const selectId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-sm font-medium text-white/80">
            {label}
          </label>
        )}
        {description && (
          <p className="text-xs text-white/40">{description}</p>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            className={[
              'w-full appearance-none bg-white/5 hover:bg-white/8 border rounded-xl text-sm text-white',
              'transition-all duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
              'focus:outline-none focus:bg-white/10 focus:border-white/20',
              'focus:shadow-[0_0_0_3px_rgba(255,255,255,0.05)]',
              'px-4 py-2.5 pr-10',
              error ? 'border-danger/40' : 'border-white/8',
              props.disabled && 'opacity-50 pointer-events-none',
              'cursor-pointer',
              className,
            ]
              .filter(Boolean)
              .join(' ')}
            {...props}
          >
            {options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-white/40">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    )
  },
)

Select.displayName = 'Select'
export default Select
