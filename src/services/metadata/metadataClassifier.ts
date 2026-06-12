import { lookupByTvdbId, lookupByImdbId } from '../animeLists'
import { tmdbFindByExternalId } from '../metadataEnrich'
import type { AddonMediaInput, MediaKind } from './types'

export async function classifyMediaItem(input: AddonMediaInput): Promise<MediaKind> {
  const explicit = (input.addonType || '').toLowerCase()
  if (explicit === 'anime' || input.anilistId || input.malId) return 'anime'
  if (input.tvdbId) {
    const animeMatches = await lookupByTvdbId(input.tvdbId).catch(() => [])
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
