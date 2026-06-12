import type { MovieDetails, SearchResult, ShowDetails } from '../../types'
import type { AddonMediaInput, AnimeTitleLanguage, AppMediaItem, AppSeason, MediaKind } from './types'

const numberId = (value: unknown): number | undefined => {
  const parsed = Number(String(value ?? '').replace(/^[a-z]+-/i, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function selectAnimeTitle(
  titles: { english?: string; romaji?: string; native?: string },
  preference: AnimeTitleLanguage,
): { title: string; originalTitle?: string; localizedTitle?: string } {
  const auto = titles.english || titles.romaji || titles.native || 'Unknown'
  const title = preference === 'english' ? titles.english || titles.romaji || titles.native
    : preference === 'romaji' ? titles.romaji || titles.english || titles.native
    : preference === 'native' ? titles.native || titles.romaji || titles.english
    : auto
  return { title: title || 'Unknown', originalTitle: titles.native, localizedTitle: titles.english || titles.romaji }
}

export function normalizeMovie(details: MovieDetails, input: AddonMediaInput): AppMediaItem {
  const tmdbId = numberId(details.tmdbId || input.tmdbId)
  const imdbId = details.imdbId || input.imdbId
  return {
    id: tmdbId ? `app_tmdb_movie_${tmdbId}` : `app_movie_${imdbId || input.id}`,
    type: 'movie', title: details.title, originalTitle: details.originalTitle, year: details.year,
    overview: details.overview, poster: details.poster, backdrop: details.backdrop, logo: details.logo,
    genres: details.genres || [], runtime: details.runtime, rating: details.rating, ageRating: details.certification,
    tmdbId, tvdbId: numberId(details.tvdbId || input.tvdbId), imdbId,
    traktId: input.traktId, simklId: input.simklId, anilistId: input.anilistId, malId: input.malId,
    sourceMetadataProvider: details.provider === 'tvdb' ? 'tvdb' : 'tmdb', sourceAddonId: input.addonId,
    sourceAddonItemId: input.id, updatedAt: new Date().toISOString(),
  }
}

export function normalizeShow(details: ShowDetails, input: AddonMediaInput, kind: MediaKind): AppMediaItem {
  const tvdbId = numberId(details.tvdbId ?? input.tvdbId)
  const tmdbId = numberId(details.tmdbId ?? input.tmdbId)
  const seasons: AppSeason[] = (details.seasons || []).map((season) => ({
    id: `${tvdbId ? `tvdb_${tvdbId}` : `media_${details.id}`}_s${season.seasonNumber}`,
    seasonNumber: season.seasonNumber, title: season.name, overview: season.overview, poster: season.poster,
    episodeCount: season.episodeCount || 0, episodes: [], airDate: season.airDate,
  }))
  return {
    id: tvdbId ? `app_tvdb_${tvdbId}` : tmdbId ? `app_tmdb_tv_${tmdbId}` : `app_show_${details.imdbId || input.id}`,
    type: kind, title: details.title, originalTitle: details.originalTitle, year: details.year,
    overview: details.overview, poster: details.poster, backdrop: details.backdrop, logo: details.logo,
    genres: details.genres || [], rating: details.rating, ageRating: details.certification,
    tmdbId, tvdbId, imdbId: details.imdbId || input.imdbId, traktId: input.traktId, simklId: input.simklId,
    anilistId: numberId(details.anilistId || input.anilistId), malId: numberId(details.malId || input.malId), seasons,
    sourceMetadataProvider: details.provider === 'tvdb' ? 'tvdb' : 'tmdb', sourceAddonId: input.addonId,
    sourceAddonItemId: input.id, updatedAt: new Date().toISOString(),
  }
}

export function addonFallback(input: AddonMediaInput, kind: MediaKind): AppMediaItem {
  const raw = input.rawAddonMeta && typeof input.rawAddonMeta === 'object' ? input.rawAddonMeta as Record<string, unknown> : {}
  const genres = Array.isArray(raw.genres) ? raw.genres.filter((g): g is string => typeof g === 'string') : []
  return {
    id: `app_fallback_${input.addonId}_${input.id || input.title || 'unknown'}`, type: kind,
    title: input.title || String(raw.name || raw.title || 'Unknown'), year: input.year,
    overview: typeof raw.description === 'string' ? raw.description : undefined,
    poster: typeof raw.poster === 'string' ? raw.poster : undefined,
    backdrop: typeof raw.background === 'string' ? raw.background : undefined,
    genres, tmdbId: input.tmdbId, tvdbId: input.tvdbId, imdbId: input.imdbId,
    traktId: input.traktId, simklId: input.simklId, anilistId: input.anilistId, malId: input.malId,
    sourceMetadataProvider: 'fallback_addon', sourceAddonId: input.addonId, sourceAddonItemId: input.id,
    updatedAt: new Date().toISOString(),
  }
}

export function appMediaToSearchResult(item: AppMediaItem, addonUrl?: string): SearchResult {
  return {
    id: item.id, title: item.title, type: item.type === 'movie' ? 'movie' : 'series', year: item.year,
    poster: item.poster, backdrop: item.backdrop, logo: item.logo, overview: item.overview, rating: item.rating,
    genres: item.genres, imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId,
    malId: item.malId, anilistId: item.anilistId, provider: item.sourceMetadataProvider, addonUrl,
    sourceAddonId: item.sourceAddonId, sourceAddonItemId: item.sourceAddonItemId,
    metadataFallback: item.sourceMetadataProvider === 'fallback_addon',
  }
}
