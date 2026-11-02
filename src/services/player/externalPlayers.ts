export type ExternalPlayer = 'infuse' | 'aether'

const PREFERRED_PLAYER_KEY = 'aurales.externalPlayer'

export function getPreferredExternalPlayer(): ExternalPlayer | null {
  try {
    const value = window.localStorage.getItem(PREFERRED_PLAYER_KEY)
    return value === 'infuse' || value === 'aether' ? value : null
  } catch {
    return null
  }
}

export function setPreferredExternalPlayer(player: ExternalPlayer): void {
  try {
    window.localStorage.setItem(PREFERRED_PLAYER_KEY, player)
  } catch {
    // Private browsing settings can disable storage; launching still works.
  }
}

export function clearPreferredExternalPlayer(): void {
  try {
    window.localStorage.removeItem(PREFERRED_PLAYER_KEY)
  } catch {
    // Storage can be disabled in private browsing.
  }
}

export function buildExternalPlayerUrl(
  player: ExternalPlayer,
  videoUrl: string,
  options: { filename?: string; title?: string; subtitleUrl?: string; position?: number; successUrl?: string } = {},
): string | null {
  let parsed: URL
  try {
    parsed = new URL(videoUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const params = new URLSearchParams({ url: videoUrl })
  if (player === 'infuse') {
    if (options.filename) params.set('filename', options.filename)
    if (options.subtitleUrl) params.set('sub', options.subtitleUrl)
    if (options.position != null && Number.isFinite(options.position) && options.position > 0) params.set('position', String(Math.floor(options.position)))
  } else {
    if (options.title) params.set('title', options.title)
    if (options.position != null && Number.isFinite(options.position) && options.position > 0) params.set('position', String(Math.floor(options.position)))
  }
  if (options.successUrl && /^https?:\/\//i.test(options.successUrl)) params.set('x-success', options.successUrl)
  return `${player}://x-callback-url/play?${params.toString()}`
}
