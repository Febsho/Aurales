/**
 * The single on/off switch used across Aurales.
 *
 * Settings and the Watch Together panel previously carried two independent
 * implementations that had drifted apart in size, disabled treatment and focus
 * ring. Both now render this component, so a switch behaves and reads the same
 * everywhere. `ui/Toggle` wraps it with a label/description row; contexts that
 * already supply their own row (SettingRow) use this directly.
 */

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export default function Switch({ checked, onChange, label, disabled, size = 'md' }: SwitchProps) {
  const track = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11'
  const thumb = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4.5 w-4.5'
  const travel = size === 'sm' ? 'translate-x-4' : 'translate-x-5'

  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex flex-shrink-0 rounded-full border',
        'transition-[background-color,border-color,opacity] duration-200 ease-out',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-black',
        // The visible track stays 24px tall so the control keeps its weight,
        // while a transparent outset brings the pressable area up to the 44px
        // guideline.
        'after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[""]',
        track,
        // A hairline border keeps the off state perceivable: an unchecked
        // track alone is only ~1.3:1 against the surrounding surface.
        checked ? 'border-accent bg-accent' : 'border-white/20 bg-white/10',
        disabled
          // 35% opacity rendered disabled rows illegible. Section 18 asks for
          // readable disabled states, so the control desaturates rather than
          // disappearing.
          ? 'cursor-not-allowed opacity-55'
          : `cursor-pointer ${checked ? '' : 'hover:bg-white/15'}`,
      ].join(' ')}
    >
      <span
        className={[
          // Drop shadow plus a 1px dark outline keep the white thumb visible on
          // any track colour, including a white accent where white-on-white
          // would otherwise vanish.
          'pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 rounded-full bg-white',
          'shadow-[0_1px_2px_rgba(0,0,0,0.4),0_0_0_1px_rgba(0,0,0,0.12)]',
          'transition-transform duration-200 ease-out',
          thumb,
          checked ? travel : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  )
}
