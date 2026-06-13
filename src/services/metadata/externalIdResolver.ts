import { resolveAnimeIds } from '../animeLists'
import { resolveImdbId, tmdbFindByExternalId } from '../metadataEnrich'
import { getTvdbIdFromTmdb } from '../tmdb'
import type { AddonMediaInput, MediaKind, ResolvedExternalIds } from './types'

export async function resolveExternalIds(input: AddonMediaInput, kind: MediaKind): Promise<ResolvedExternalIds> {
  const ids: ResolvedExternalIds = { imdbId: input.imdbId, tmdbId: input.tmdbId, tvdbId: input.tvdbId,
    traktId: input.traktId, simklId: input.simklId, anilistId: input.anilistId, malId: input.malId }
  if (kind === 'anime' && (!ids.tvdbId || !ids.anilistId || !ids.malId)) {
    const anime = await resolveAnimeIds(ids).catch(() => null)
    if (anime) {
      ids.tvdbId ||= anime.tvdbId
      ids.tmdbId ||= anime.tmdbId
      ids.imdbId ||= anime.imdbId
      ids.anilistId ||= anime.anilistId
      ids.malId ||= anime.malId
    }
  }
  if (kind !== 'movie' && !ids.tvdbId && ids.tmdbId) {
    ids.tvdbId = await getTvdbIdFromTmdb(ids.tmdbId).catch(() => undefined)
  }
  if (!ids.imdbId && (ids.tmdbId || ids.tvdbId)) {
    ids.imdbId = await resolveImdbId({ tmdbId: ids.tmdbId, tvdbId: ids.tvdbId, anilistId: ids.anilistId, malId: ids.malId }, kind === 'movie' ? 'movie' : 'series').catch(() => null) || undefined
  }
  if (ids.imdbId && !ids.tmdbId) {
    const found = await tmdbFindByExternalId(ids.imdbId, 'imdb_id').catch(() => ({ tmdbId: undefined, imdbId: undefined, mediaType: undefined }))
    ids.tmdbId = found.tmdbId
  }
  return ids
}
