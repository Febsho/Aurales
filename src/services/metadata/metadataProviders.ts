import { tmdbProvider } from '../tmdb'
import { tvdbProvider } from '../tvdb'
import { normalizeMovie, normalizeShow } from './metadataNormalizer'
import type { AddonMediaInput, AppMediaItem, MediaKind, ResolvedExternalIds } from './types'

export async function fetchAppProviderMetadata(input: AddonMediaInput, ids: ResolvedExternalIds, kind: MediaKind): Promise<AppMediaItem | null> {
  if (kind === 'movie') {
    if (!ids.tmdbId) return null
    const details = await tmdbProvider.getMovie(`tmdb-${ids.tmdbId}`).catch(() => null)
    return details ? normalizeMovie(details, { ...input, ...ids }) : null
  }
  if (ids.tvdbId) {
    const tvdb = await tvdbProvider.getShow(`tvdb-${ids.tvdbId}`).catch(() => null)
    if (tvdb) {
      const normalized = normalizeShow(tvdb, { ...input, ...ids }, kind)
      if (ids.tmdbId) {
        const tmdb = await tmdbProvider.getShow(`tmdb-${ids.tmdbId}`).catch(() => null)
        if (tmdb) {
          normalized.poster = tmdb.poster || normalized.poster
          normalized.backdrop = tmdb.backdrop || normalized.backdrop
          normalized.logo = tmdb.logo || normalized.logo
          normalized.overview = normalized.overview || tmdb.overview
          normalized.rating = tmdb.rating || normalized.rating
        }
      }
      return normalized
    }
  }
  if (ids.tmdbId) {
    const tmdb = await tmdbProvider.getShow(`tmdb-${ids.tmdbId}`).catch(() => null)
    if (tmdb) return normalizeShow(tmdb, { ...input, ...ids }, kind)
  }
  return null
}
