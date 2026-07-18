export interface CanonicalStreamRequest {
  mediaType: 'movie' | 'series'
  mediaId: string
  imdbId?: string
  tmdbId?: string | number
  seasonEpisode?: { season: number; episode: number }
}

function cleanId(value: string | number | undefined): string {
  return String(value ?? '').trim().replace(/:(\d+):(\d+)$/, '')
}

function idNamespace(id: string): string {
  if (/^tt\d+$/i.test(id)) return `imdb:${id.toLowerCase()}`
  if (/^tmdb[-:]?\d+$/i.test(id)) return `tmdb:${id.replace(/^tmdb[-:]?/i, '')}`
  if (/^tvdb[-:]?\d+$/i.test(id)) return `tvdb:${id.replace(/^tvdb[-:]?/i, '')}`
  if (/^anilist[-:]?\d+$/i.test(id)) return `anilist:${id.replace(/^anilist[-:]?/i, '')}`
  if (/^mal[-:]?\d+$/i.test(id)) return `mal:${id.replace(/^mal[-:]?/i, '')}`
  return `id:${id}`
}

export function canonicalStreamKey(request: CanonicalStreamRequest): string {
  const stableId = cleanId(request.imdbId) || cleanId(request.tmdbId ? `tmdb-${request.tmdbId}` : '') || cleanId(request.mediaId)
  const namespace = idNamespace(stableId || 'unknown')
  if (request.mediaType === 'series' && request.seasonEpisode) {
    const { season, episode } = request.seasonEpisode
    return `episode:${namespace}:s${String(season).padStart(2, '0')}:e${String(episode).padStart(2, '0')}`
  }
  return `movie:${namespace}`
}

// Shrinks a TTL when the stream URL carries its own expiry (expires/exp/e unix
// params) or looks tokenized/signed. Returns defaultSeconds otherwise.
export function streamUrlTtlSeconds(url: string, defaultSeconds: number): number {
  try {
    const parsed = new URL(url)
    const expiry = Number(parsed.searchParams.get('expires') || parsed.searchParams.get('exp') || parsed.searchParams.get('e'))
    if (Number.isFinite(expiry) && expiry > 1_000_000_000 && expiry < 4_000_000_000) {
      return Math.min(defaultSeconds, Math.max(5 * 60, expiry - Math.floor(Date.now() / 1000) - 120))
    }
    if (/token|signature|sig|policy/i.test(parsed.search)) {
      return Math.min(defaultSeconds, 20 * 60)
    }
  } catch { /* non-URL streams are ranked later by the existing pipeline */ }
  return defaultSeconds
}

export type SeasonLoader =(tmdbId: string | number, season: number) => Promise<Array<{ seasonNumber: number; episodeNumber: number }>>

export async function resolveNextEpisodeWith(
  request: CanonicalStreamRequest,
  loadSeason: SeasonLoader,
): Promise<{ season: number; episode: number } | undefined> {
  if (!request.tmdbId || !request.seasonEpisode) return undefined
  const current = request.seasonEpisode
  try {
    const episodes = (await loadSeason(request.tmdbId, current.season))
      .filter((episode) => episode.seasonNumber === current.season)
      .sort((a, b) => a.episodeNumber - b.episodeNumber)
    const sameSeason = episodes.find((episode) => episode.episodeNumber > current.episode)
    if (sameSeason) return { season: sameSeason.seasonNumber, episode: sameSeason.episodeNumber }
    const nextSeason = (await loadSeason(request.tmdbId, current.season + 1))
      .filter((episode) => episode.seasonNumber === current.season + 1)
      .sort((a, b) => a.episodeNumber - b.episodeNumber)[0]
    return nextSeason ? { season: nextSeason.seasonNumber, episode: nextSeason.episodeNumber } : undefined
  } catch {
    return undefined
  }
}
