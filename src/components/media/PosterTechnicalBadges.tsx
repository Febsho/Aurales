interface PosterTechnicalBadgesProps {
  labels: string[]
  className?: string
}

/** Source-supplied video capabilities shown opposite the editorial badge. */
export function PosterTechnicalBadges({ labels, className = '' }: PosterTechnicalBadgesProps) {
  if (!labels.length) return null
  return (
    <div className={`absolute right-2 top-2 z-20 flex max-w-[50%] flex-wrap justify-end gap-1 ${className}`} aria-label={labels.join(', ')}>
      {labels.map((label) => <span key={label} className="whitespace-nowrap rounded-md border border-white/60 bg-white/90 px-1 py-1 text-[8px] font-bold leading-none text-slate-950 shadow">{label}</span>)}
    </div>
  )
}
