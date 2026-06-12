const ICON_BASE = 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/svg'

const ICON_SLUGS: Record<string, string> = {
  simkl: 'simkl',
  stremio: 'stremio',
  trakt: 'trakt',
  tmdb: 'tmdb',
  tvdb: 'tvdb',
}

export function getSelfhstIconUrl(service: string): string | null {
  const slug = ICON_SLUGS[normalizeService(service)]
  return slug ? `${ICON_BASE}/${slug}.svg` : null
}

export function normalizeService(service: string): string {
  return String(service || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}
