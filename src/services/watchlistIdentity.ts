export interface WatchlistIdentityItem {
  id: string
  type: string
  provider?: string
  watchlistIdentityProvider?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  anilistId?: string | number
  malId?: string | number
  sourceAddonId?: string
  sourceAddonItemId?: string
  addonUrl?: string
  sourceConnectionId?: string
  sourceItemId?: string
}

function addonScope(item: WatchlistIdentityItem): string | undefined {
  const source = item.addonUrl || item.sourceAddonId
  if (!source) return undefined
  let normalized = source.trim().replace(/\/manifest\.json$/i, '').replace(/\/$/, '')
  try {
    const url = new URL(normalized)
    url.hash = ''
    url.search = ''
    normalized = url.toString().replace(/\/$/, '')
  } catch { /* manifest ID is still a useful namespace */ }
  return normalized.toLowerCase()
}

export function watchlistIdentityAliases(item: WatchlistIdentityItem): Set<string> {
  if (!item.type || !item.id) return new Set()
  const prefix = `${item.type}:`
  const identities = new Set<string>()
  if (item.tmdbId != null && item.tmdbId !== '') identities.add(`${prefix}tmdb:${String(item.tmdbId).replace(/^tmdb[-:]/i, '')}`)
  if (item.imdbId) identities.add(`${prefix}imdb:${item.imdbId.toLowerCase()}`)
  if (item.tvdbId != null && item.tvdbId !== '') identities.add(`${prefix}tvdb:${String(item.tvdbId).replace(/^tvdb[-:]/i, '')}`)
  if (item.anilistId != null && item.anilistId !== '') identities.add(`${prefix}anilist:${String(item.anilistId).replace(/^anilist[-:]/i, '')}`)
  if (item.malId != null && item.malId !== '') identities.add(`${prefix}mal:${String(item.malId).replace(/^mal[-:]/i, '')}`)

  if (/^tt\d+$/i.test(item.id)) identities.add(`${prefix}imdb:${item.id.toLowerCase()}`)
  else if (/^tmdb[-:]?\d+$/i.test(item.id)) identities.add(`${prefix}tmdb:${item.id.replace(/^tmdb[-:]?/i, '')}`)

  if (item.sourceConnectionId && item.sourceItemId) {
    identities.add(`${prefix}server:${item.sourceConnectionId}:${item.sourceItemId}`)
  }
  const scope = addonScope(item)
  if (scope) identities.add(`${prefix}addon:${scope}:${item.sourceAddonItemId || item.id}`)

  if (identities.size === 0) {
    const provider = (item.watchlistIdentityProvider || item.provider)?.trim().toLowerCase()
    identities.add(`${prefix}${provider && provider !== 'local' && provider !== 'progress' ? `provider:${provider}` : 'local'}:${item.id}`)
  }
  return identities
}

export function watchlistIdentity(item: WatchlistIdentityItem): string | undefined {
  return watchlistIdentityAliases(item).values().next().value
}

export function sameWatchlistItem(left: WatchlistIdentityItem, right: WatchlistIdentityItem): boolean {
  if (left.type !== right.type) return false
  const rightAliases = watchlistIdentityAliases(right)
  return [...watchlistIdentityAliases(left)].some((identity) => rightAliases.has(identity))
}
