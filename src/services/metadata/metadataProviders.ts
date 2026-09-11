import { loadDetailPage, loadMovieDetailPage } from './detailPageLoader'
import { normalizeMovieWithNativeFallback, normalizeShowWithNativeFallback } from './metadataNormalizer'
import type { AddonMediaInput, AppMediaItem, MediaKind, ResolvedExternalIds } from './types'
import { useAppStore } from '../../stores/appStore'

/**
 * Metadata enrichment may resolve several visible cards at once.  Keep each
 * card in its own cancellation group: sharing the detail-page default group
 * would incorrectly supersede unrelated cards, while the Rust coordinator
 * still coalesces identical provider/detail keys.
 */
function metadataCancelGroup(input: AddonMediaInput, provider: 'tmdb' | 'tvdb'): string {
  return `metadata:${provider}:${input.addonId}:${input.id || input.imdbId || input.tmdbId || input.tvdbId || input.title || 'unknown'}`
}

function loadMetadataShow(input: AddonMediaInput, provider: 'tmdb' | 'tvdb', id: number) {
  return loadDetailPage(provider, `${provider}-${id}`, {
    cancelGroup: metadataCancelGroup(input, provider),
    priority: 'background',
  })
}

function loadMetadataMovie(input: AddonMediaInput, tmdbId: number) {
  return loadMovieDetailPage(`tmdb-${tmdbId}`, {
    cancelGroup: metadataCancelGroup(input, 'tmdb'),
    priority: 'background',
  })
}

export async function fetchAppProviderMetadata(input: AddonMediaInput, ids: ResolvedExternalIds, kind: MediaKind): Promise<AppMediaItem | null> {
  const settings = useAppStore.getState()

  if (kind === 'movie') {
    if (!ids.tmdbId) return null
    const details = await loadMetadataMovie(input, ids.tmdbId).catch(() => null)
    return details ? normalizeMovieWithNativeFallback(details, { ...input, ...ids }) : null
  }

  const source = settings.seriesMetadataSource ?? 'tmdb'
  const fallback = settings.seriesMetadataFallback ?? true

  if (source === 'tmdb') {
    if (ids.tmdbId) {
      const tmdb = await loadMetadataShow(input, 'tmdb', ids.tmdbId).catch(() => null)
      if (tmdb) {
        const normalized = await normalizeShowWithNativeFallback(tmdb, { ...input, ...ids }, kind)
        return normalized
      }
    }
    if (fallback && ids.tvdbId) {
      const tvdb = await loadMetadataShow(input, 'tvdb', ids.tvdbId).catch(() => null)
      if (tvdb) {
        const normalized = await normalizeShowWithNativeFallback(tvdb, { ...input, ...ids }, kind)
        if (ids.tmdbId) {
          const tmdb = await loadMetadataShow(input, 'tmdb', ids.tmdbId).catch(() => null)
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
  } else { // source === 'tvdb'
    if (ids.tvdbId) {
      const tvdb = await loadMetadataShow(input, 'tvdb', ids.tvdbId).catch(() => null)
      if (tvdb) {
        const normalized = await normalizeShowWithNativeFallback(tvdb, { ...input, ...ids }, kind)
        if (ids.tmdbId) {
          const tmdb = await loadMetadataShow(input, 'tmdb', ids.tmdbId).catch(() => null)
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
    if (fallback && ids.tmdbId) {
      const tmdb = await loadMetadataShow(input, 'tmdb', ids.tmdbId).catch(() => null)
      if (tmdb) return normalizeShowWithNativeFallback(tmdb, { ...input, ...ids }, kind)
    }
  }

  return null
}
