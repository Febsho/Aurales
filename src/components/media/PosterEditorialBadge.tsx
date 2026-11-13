interface PosterEditorialBadgeProps {
  label: string
  hasRightRail?: boolean
  className?: string
}

/** Compact top-corner poster label shared by live cards and settings previews. */
export function PosterEditorialBadge({ label, hasRightRail = false, className = '' }: PosterEditorialBadgeProps) {
  const tone = label === 'In Cinema'
    ? 'border-amber-100/30 bg-amber-100/90 text-black'
    : /new|nolan/i.test(label)
      ? 'border-sky-100/30 bg-sky-100/90 text-slate-950'
      : 'border-slate-100/30 bg-slate-100/90 text-slate-950'

  return (
    <span style={hasRightRail ? { maxWidth: '40%' } : undefined} className={`absolute left-2 top-2 z-20 max-w-[calc(100%-1rem)] truncate rounded-md border px-1.5 py-1 text-[8px] font-semibold leading-none shadow ${tone} ${className}`}>
      {label}
    </span>
  )
}
