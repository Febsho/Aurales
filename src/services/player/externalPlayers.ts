export type ExternalPlayer = 'infuse' | 'aether' | 'nextplayer' | 'mxplayer' | 'justplayer' | 'vlc'
export type ExternalPlayerPlatform = 'ios' | 'android'

const PREFERRED_PLAYER_KEY = 'aurales.externalPlayer'
const SETTINGS_PLATFORM_KEY = 'aurales.externalPlayer.settingsPlatform'
const AUTO_OPEN_KEY = 'aurales.externalPlayer.autoOpen'

export function getExternalPlayerPlatform(): ExternalPlayerPlatform {
  return /Android/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent) ? 'android' : 'ios'
}

export function getExternalPlayerSettingsPlatform(): ExternalPlayerPlatform {
  try {
    const value = window.localStorage.getItem(SETTINGS_PLATFORM_KEY)
    if (value === 'ios' || value === 'android') return value
  } catch { /* Storage can be disabled. */ }
  return getExternalPlayerPlatform()
}

export function setExternalPlayerSettingsPlatform(platform: ExternalPlayerPlatform): void {
  try { window.localStorage.setItem(SETTINGS_PLATFORM_KEY, platform) } catch { /* Storage can be disabled. */ }
}

function isExternalPlayer(value: string | null): value is ExternalPlayer {
  return value === 'infuse' || value === 'aether' || value === 'nextplayer' || value === 'mxplayer' || value === 'justplayer' || value === 'vlc'
}

function playerPlatform(player: ExternalPlayer): ExternalPlayerPlatform {
  return player === 'infuse' || player === 'aether' ? 'ios' : 'android'
}

export function getPreferredExternalPlayer(platform = getExternalPlayerPlatform()): ExternalPlayer | null {
  try {
    const stored = window.localStorage.getItem(`${PREFERRED_PLAYER_KEY}.${platform}`)
    if (isExternalPlayer(stored) && playerPlatform(stored) === platform) return stored
    // Migrate the old single preference only for the platform it belongs to.
    const legacy = window.localStorage.getItem(PREFERRED_PLAYER_KEY)
    if (isExternalPlayer(legacy) && playerPlatform(legacy) === platform) {
      window.localStorage.setItem(`${PREFERRED_PLAYER_KEY}.${platform}`, legacy)
      return legacy
    }
    return null
  } catch {
    return null
  }
}

export function setPreferredExternalPlayer(player: ExternalPlayer, platform = playerPlatform(player)): void {
  if (playerPlatform(player) !== platform) return
  try {
    window.localStorage.setItem(`${PREFERRED_PLAYER_KEY}.${platform}`, player)
  } catch {
    // Private browsing settings can disable storage; launching still works.
  }
}

export function clearPreferredExternalPlayer(platform = getExternalPlayerPlatform()): void {
  try {
    window.localStorage.removeItem(`${PREFERRED_PLAYER_KEY}.${platform}`)
    const legacy = window.localStorage.getItem(PREFERRED_PLAYER_KEY)
    if (isExternalPlayer(legacy) && playerPlatform(legacy) === platform) window.localStorage.removeItem(PREFERRED_PLAYER_KEY)
  } catch {
    // Storage can be disabled in private browsing.
  }
}

export function getAutoOpenExternalPlayer(platform = getExternalPlayerPlatform()): boolean {
  try { return window.localStorage.getItem(`${AUTO_OPEN_KEY}.${platform}`) === 'true' } catch { return false }
}

export function setAutoOpenExternalPlayer(enabled: boolean, platform = getExternalPlayerPlatform()): void {
  try { window.localStorage.setItem(`${AUTO_OPEN_KEY}.${platform}`, String(enabled)) } catch { /* Storage can be disabled. */ }
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

  const androidPackages: Partial<Record<ExternalPlayer, string>> = {
    nextplayer: 'dev.anilbeesetti.nextplayer',
    mxplayer: 'com.mxtech.videoplayer.ad',
    justplayer: 'com.brouken.player',
    vlc: 'org.videolan.vlc',
  }
  const androidPackage = androidPackages[player]
  if (androidPackage) {
    const intent = new URL(videoUrl)
    const title = options.title || options.filename
    const intentParams = [
      `scheme=${intent.protocol.slice(0, -1)}`,
      'type=video/*',
      `package=${androidPackage}`,
      ...(title ? [`S.title=${encodeURIComponent(title)}`] : []),
      'end',
    ]
    return `intent://${intent.host}${intent.pathname}${intent.search}#Intent;${intentParams.join(';')}`
  }

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
