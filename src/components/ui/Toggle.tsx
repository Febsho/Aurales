import Switch from './Switch'

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
  return (
    <label
      className={[
        'flex items-center justify-between gap-3 group',
        // The switch itself carries the disabled affordance, so the row only
        // dims its text rather than stacking two opacity reductions.
        disabled ? 'pointer-events-none' : 'cursor-pointer',
      ].join(' ')}
    >
      {(label || description) && (
        <div className={`flex flex-col gap-0.5 min-w-0 ${disabled ? 'opacity-60' : ''}`}>
          {label && <span className="text-sm font-medium text-white/85">{label}</span>}
          {description && <span className="text-xs text-white/60 leading-relaxed">{description}</span>}
        </div>
      )}
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} size={size} />
    </label>
  )
}
