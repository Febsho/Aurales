import { resolveAnimeIds } from '../animeLists'
import { resolveImdbId, tmdbFindByExternalId } from '../metadataEnrich'
import { getTmdbApiKey } from '../apiKeys'
import { getTvdbIdFromTmdb } from '../tmdb'
import type { AddonMediaInput, MediaKind, ResolvedExternalIds } from './types'

async function searchTmdbByTitle(title: string, year: number | undefined, kind: MediaKind): Promise<{ tmdbId?: number; imdbId?: string } | null> {
  const apiKey = getTmdbApiKey()
  if (!apiKey) return null
  const mediaType = kind === 'movie' ? 'movie' : 'tv'
  const params = new URLSearchParams({ api_key: apiKey, query: title, language: 'en-US' })
  if (year) params.set(kind === 'movie' ? 'year' : 'first_air_date_year', String(year))
  const res = await fetch(`https://api.themoviedb.org/3/search/${mediaType}?${params}`)
  if (!res.ok) return null
  const data = await res.json() as { results?: { id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }[] }
  const results = data.results || []
  if (results.length === 0) return null
  const best = results[0]
  return { tmdbId: best.id }
}

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
  if (!ids.imdbId && !ids.tmdbId && !ids.tvdbId && input.title) {
    const found = await searchTmdbByTitle(input.title, input.year, kind).catch(() => null)
    if (found?.tmdbId) ids.tmdbId = found.tmdbId
  }
  if (kind !== 'movie' && !ids.tvdbId && ids.tmdbId) {
    ids.tvdbId = await getTvdbIdFromTmdb(ids.tmdbId).catch(() => undefined)
  }
  if (!ids.tvdbId && ids.imdbId) {
    const { getTvdbIdByRemoteId } = await import('../tvdb')
    const result = await getTvdbIdByRemoteId(ids.imdbId).catch(() => undefined)
    ids.tvdbId = result !== undefined && result !== null ? Number(result) : undefined
  }
  if (!ids.tvdbId && ids.tmdbId) {
    const { getTvdbIdByRemoteId } = await import('../tvdb')
    const result = await getTvdbIdByRemoteId(String(ids.tmdbId)).catch(() => undefined)
    ids.tvdbId = result !== undefined && result !== null ? Number(result) : undefined
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
