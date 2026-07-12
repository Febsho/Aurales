import { lookupByTvdbId, lookupByTmdbId, lookupByImdbId } from '../animeLists'
import { tmdbFindByExternalId } from '../metadataEnrich'
import type { AddonMediaInput, MediaKind } from './types'

export async function classifyMediaItem(input: AddonMediaInput): Promise<MediaKind> {
  const explicit = (input.addonType || '').toLowerCase()
  const raw = input.rawAddonMeta && typeof input.rawAddonMeta === 'object' ? input.rawAddonMeta as Record<string, unknown> : {}
  const genreIds = Array.isArray(raw.genreIds) ? raw.genreIds.map(Number) : []
  const genres = Array.isArray(raw.genres) ? raw.genres.map((genre) => typeof genre === 'string' ? genre.toLowerCase() : '') : []
  const language = String(raw.originalLanguage || raw.original_language || '').toLowerCase()
  if ((genreIds.includes(16) || genres.includes('animation') || genres.includes('anime')) && ['ja', 'zh', 'ko'].includes(language)) return 'anime'
  if (explicit === 'anime' || input.anilistId || input.malId) return 'anime'
  if (input.tvdbId) {
    const animeMatches = await lookupByTvdbId(input.tvdbId).catch(() => [])
    if (animeMatches.length > 0) return 'anime'
  }
  if (input.tmdbId) {
    const animeMatches = await lookupByTmdbId(input.tmdbId).catch(() => [])
    if (animeMatches.length > 0) return 'anime'
  }
  if (input.imdbId) {
    const animeMatch = await lookupByImdbId(input.imdbId).catch(() => null)
    if (animeMatch) return 'anime'
    const found = await tmdbFindByExternalId(input.imdbId, 'imdb_id').catch(() => ({ tmdbId: undefined, imdbId: undefined, mediaType: undefined }))
    if (found.mediaType === 'movie') return 'movie'
    if (found.mediaType === 'tv') return 'show'
  }
  if (input.tmdbId) return explicit === 'movie' ? 'movie' : 'show'
  if (explicit === 'movie') return 'movie'
  return 'show'
}
