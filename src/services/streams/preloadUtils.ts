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

export type SeasonLoader = (tmdbId: string | number, season: number) => Promise<Array<{ seasonNumber: number; episodeNumber: number }>>

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
