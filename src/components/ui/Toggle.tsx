interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export default function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  size = 'md',
}: ToggleProps) {
  const trackSize = size === 'sm' ? 'w-9 h-5' : 'w-11 h-6'
  const thumbSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5'
  const thumbTranslate = size === 'sm' ? 'translate-x-4' : 'translate-x-5'

  return (
    <label
      className={[
        'flex items-center justify-between gap-3 group',
        disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {(label || description) && (
        <div className="flex flex-col gap-0.5 min-w-0">
          {label && <span className="text-sm font-medium text-white/85">{label}</span>}
          {description && <span className="text-xs text-white/40 leading-relaxed">{description}</span>}
        </div>
      )}
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={[
          'relative inline-flex flex-shrink-0 rounded-full',
          'transition-colors duration-200 ease-in-out',
          'focus-ring cursor-pointer',
          trackSize,
          checked ? 'bg-accent' : 'bg-white/15',
        ].join(' ')}
      >
        <span
          className={[
            // Drop shadow + 1px dark outline keep the white thumb visible on any
            // track color, including a white accent (bg-accent) where a plain
            // white-on-white thumb would vanish.
            'inline-block rounded-full bg-white',
            'shadow-[0_1px_2px_rgba(0,0,0,0.4),0_0_0_1px_rgba(0,0,0,0.12)]',
            'transition-transform duration-200 ease-in-out',
            'absolute top-1/2 -translate-y-1/2 left-[3px]',
            thumbSize,
            checked ? thumbTranslate : 'translate-x-0',
          ].join(' ')}
        />
      </button>
    </label>
  )
}
