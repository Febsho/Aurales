interface SliderProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  label?: string
  description?: string
  showValue?: boolean
  formatValue?: (value: number) => string
  disabled?: boolean
}

export default function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  description,
  showValue = true,
  formatValue,
  disabled,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100
  const displayValue = formatValue ? formatValue(value) : String(value)

  return (
    <div className={`flex flex-col gap-2 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {(label || showValue) && (
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            {label && <span className="text-sm font-medium text-white/80">{label}</span>}
            {description && <span className="text-xs text-white/40">{description}</span>}
          </div>
          {showValue && (
            <span className="text-sm font-semibold text-accent tabular-nums">{displayValue}</span>
          )}
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-white/10
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer
          [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150
          [&::-webkit-slider-thumb]:hover:scale-110"
        style={{
          background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${pct}%, rgba(255,255,255,0.1) ${pct}%, rgba(255,255,255,0.1) 100%)`,
        }}
      />
    </div>
  )
}
