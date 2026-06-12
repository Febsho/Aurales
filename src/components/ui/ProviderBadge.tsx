import { getSelfhstIconUrl } from '../../services/serviceIcons'

interface ProviderBadgeProps {
  provider: string
  showLabel?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const PROVIDER_LABELS: Record<string, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  anilist: 'AniList',
  tmdb: 'TMDB',
  tvdb: 'TVDB',
  imdb: 'IMDb',
  mal: 'MAL',
  local: 'Local',
  pmdb: 'PMDB',
}

export default function ProviderBadge({
  provider,
  showLabel = true,
  size = 'sm',
  className = '',
}: ProviderBadgeProps) {
  const iconUrl = getSelfhstIconUrl(provider)
  const label = PROVIDER_LABELS[provider.toLowerCase()] || provider
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5'

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/5',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs',
        'font-semibold text-white/60',
        className,
      ].join(' ')}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className={`${iconSize} object-contain`} loading="lazy" />
      ) : (
        <span className={`${iconSize} inline-flex items-center justify-center rounded bg-white/10 text-[8px] font-black`}>
          {provider.slice(0, 2).toUpperCase()}
        </span>
      )}
      {showLabel && label}
    </span>
  )
}
