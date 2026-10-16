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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`https://api.themoviedb.org/3/search/${mediaType}?${params}`, { signal: controller.signal })
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const data = await res.json() as { results?: { id: number; title?: string; name?: string; release_date?: string; first_air_date?: string }[] }
    const results = data.results || []
    if (results.length === 0) return null
    const best = results[0]
    return { tmdbId: best.id }
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveExternalIds(input: AddonMediaInput, kind: MediaKind): Promise<ResolvedExternalIds> {
  const isMovie = kind === 'movie' || (kind === 'anime' && input.addonType?.toLowerCase() === 'movie')
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
  if (!isMovie && !ids.tvdbId && ids.tmdbId) {
    ids.tvdbId = await getTvdbIdFromTmdb(ids.tmdbId).catch(() => undefined)
  }
  // Movie metadata is resolved through TMDB only; looking the same IMDb ID up
  // on TVDB adds a network round trip whose result cannot be used downstream.
  if (!isMovie && !ids.tvdbId && ids.imdbId) {
    const { getTvdbIdByRemoteId } = await import('../tvdb')
    const result = await getTvdbIdByRemoteId(ids.imdbId).catch(() => undefined)
    ids.tvdbId = result !== undefined && result !== null ? Number(result) : undefined
  }
  if (!isMovie && !ids.tvdbId && ids.tmdbId) {
    const { getTvdbIdByRemoteId } = await import('../tvdb')
    const result = await getTvdbIdByRemoteId(String(ids.tmdbId)).catch(() => undefined)
    ids.tvdbId = result !== undefined && result !== null ? Number(result) : undefined
  }
  if (!ids.imdbId && (ids.tmdbId || ids.tvdbId)) {
    ids.imdbId = await resolveImdbId({ tmdbId: ids.tmdbId, tvdbId: ids.tvdbId, anilistId: ids.anilistId, malId: ids.malId }, isMovie ? 'movie' : 'series').catch(() => null) || undefined
  }
  if (ids.imdbId && !ids.tmdbId) {
    const found = await tmdbFindByExternalId(ids.imdbId, 'imdb_id').catch(() => ({ tmdbId: undefined, imdbId: undefined, mediaType: undefined }))
    if (found.mediaType === (isMovie ? 'movie' : 'tv')) ids.tmdbId = found.tmdbId
  }
  return ids
}
