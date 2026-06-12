import { tvdbProvider } from '../tvdb'
import { tmdbProvider } from '../tmdb'
import { normalizeShow, selectAnimeTitle } from './metadataNormalizer'
import { useAppStore } from '../../stores/appStore'
import { mapTvdbSeasons } from './tvdbSeasonMapper'
import { validateAnimeTvdbStructure, scoreAnimeStructure, debugAnimeMapping } from './animeStructureValidator'
import { resolveSeasonTitles } from './animeTitleResolver'
import type { AddonMediaInput, AnimeTitleLanguage, AnimeTitlePreference, AppMediaItem, AppSeason, ResolvedExternalIds } from './types'

async function getAniListTitles(ids: ResolvedExternalIds): Promise<{ english?: string; romaji?: string; native?: string } | null> {
  if (!ids.anilistId && !ids.malId) return null
  const query = `query ($id: Int, $malId: Int) { Media(id: $id, idMal: $malId, type: ANIME) { title { english romaji native } relations { edges { relationType node { id type format title { english romaji native } } } } } }`
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { id: ids.anilistId, malId: ids.malId } }),
  }).catch(() => null)
  if (!response?.ok) return null
  const payload = await response.json() as { data?: { Media?: { title?: { english?: string; romaji?: string; native?: string }; relations?: { edges?: Array<{ relationType: string; node: { id: number; type: string; format: string } }> } } } }
  return payload.data?.Media?.title || null
}

async function getAniListRelations(ids: ResolvedExternalIds): Promise<{ hasSequels: boolean; relatedCount: number }> {
  if (!ids.anilistId && !ids.malId) return { hasSequels: false, relatedCount: 0 }
  const query = `query ($id: Int, $malId: Int) { Media(id: $id, idMal: $malId, type: ANIME) { relations { edges { relationType node { id type format } } } } }`
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { id: ids.anilistId, malId: ids.malId } }),
  }).catch(() => null)
  if (!response?.ok) return { hasSequels: false, relatedCount: 0 }
  const payload = await response.json() as { data?: { Media?: { relations?: { edges?: Array<{ relationType: string; node: { id: number; type: string; format: string } }> } } } }
  const edges = payload.data?.Media?.relations?.edges || []
  const animeRelations = edges.filter((e) => e.node.type === 'ANIME' && (e.node.format === 'TV' || e.node.format === 'TV_SHORT'))
  const hasSequels = animeRelations.some((e) => e.relationType === 'SEQUEL' || e.relationType === 'PREQUEL')
  return { hasSequels, relatedCount: animeRelations.length }
}

export interface AnimeResolverOptions {
  titleLanguage: AnimeTitleLanguage
  titlePreference: AnimeTitlePreference
  preferTvdbSeasons: boolean
  hideUnairedSeasons: boolean
  hideUnairedEpisodes: boolean
  includeSpecials: boolean
  useGenericSeasonLabels: boolean
  avoidJapaneseSeasonNames: boolean
}

const DEFAULT_OPTIONS: AnimeResolverOptions = {
  titleLanguage: 'auto',
  titlePreference: 'auto',
  preferTvdbSeasons: true,
  hideUnairedSeasons: true,
  hideUnairedEpisodes: true,
  includeSpecials: true,
  useGenericSeasonLabels: true,
  avoidJapaneseSeasonNames: true,
}

async function tryTmdbSeasonsFallback(tmdbId: number, options: AnimeResolverOptions): Promise<AppSeason[] | null> {
  try {
    const tmdbShow = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
    if (!tmdbShow.seasons || tmdbShow.seasons.length <= 1) return null

    const nonSpecial = tmdbShow.seasons.filter((s) => s.seasonNumber > 0)
    if (nonSpecial.length <= 1) return null

    const seasons: AppSeason[] = tmdbShow.seasons
      .filter((s) => options.includeSpecials || s.seasonNumber !== 0)
      .map((s) => ({
        id: `tmdb_${tmdbId}_s${s.seasonNumber}`,
        seasonNumber: s.seasonNumber,
        title: s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`,
        overview: s.overview,
        poster: s.poster,
        episodeCount: s.episodeCount || 0,
        episodes: [],
        airDate: s.airDate,
        debugSource: 'tmdb_fallback',
        debugResolverStep: 'tryTmdbSeasonsFallback',
      }))

    console.log('[animeResolver] TMDB fallback seasons:', seasons.map((s) => ({ num: s.seasonNumber, eps: s.episodeCount })))
    return seasons
  } catch {
    return null
  }
}

function applySeasonTitleResolution(seasons: AppSeason[], options: AnimeResolverOptions): AppSeason[] {
  return seasons.map((s) => {
    const resolved = resolveSeasonTitles(
      s.title,
      s.seasonNumber,
      options.titlePreference,
      options.useGenericSeasonLabels,
      options.avoidJapaneseSeasonNames,
    )
    return {
      ...s,
      title: resolved.displayTitle,
      originalTitle: resolved.originalTitle || s.originalTitle,
      nativeTitle: resolved.nativeTitle || s.nativeTitle,
    }
  })
}

export async function resolveAnimeMetadata(
  input: AddonMediaInput,
  ids: ResolvedExternalIds,
  titleLanguage: AnimeTitleLanguage,
  preferTvdbSeasons = true,
  opts?: Partial<AnimeResolverOptions>,
): Promise<AppMediaItem | null> {
  const options = { ...DEFAULT_OPTIONS, ...opts, titleLanguage, preferTvdbSeasons }
  const settings = useAppStore.getState()
  const source = settings.animeMetadataSource ?? 'tvdb'
  const fallback = settings.animeMetadataFallback ?? true

  let details: any = null
  let usedSource: 'tvdb' | 'tmdb' = 'tvdb'

  if (source === 'tmdb') {
    if (ids.tmdbId) {
      details = await tmdbProvider.getShow(`tmdb-${ids.tmdbId}`).catch(() => null)
      if (details) usedSource = 'tmdb'
    }
    if (!details && fallback && ids.tvdbId) {
      details = await tvdbProvider.getShow(`tvdb-${ids.tvdbId}`).catch(() => null)
      if (details) usedSource = 'tvdb'
    }
  } else { // default to 'tvdb' (or anilist/mal/kitsu which fall back to tvdb)
    if (ids.tvdbId) {
      details = await tvdbProvider.getShow(`tvdb-${ids.tvdbId}`).catch(() => null)
      if (details) usedSource = 'tvdb'
    }
    if (!details && fallback && ids.tmdbId) {
      details = await tmdbProvider.getShow(`tmdb-${ids.tmdbId}`).catch(() => null)
      if (details) usedSource = 'tmdb'
    }
  }

  if (!details) return null

  const normalized = normalizeShow(details, { ...input, ...ids }, 'anime')

  const anilistTitles = await getAniListTitles(ids)
  const selected = selectAnimeTitle(
    {
      english: anilistTitles?.english || details.title,
      romaji: anilistTitles?.romaji || input.title,
      native: anilistTitles?.native || details.originalTitle,
    },
    options.titleLanguage,
  )
  normalized.title = selected.title
  normalized.localizedTitle = selected.localizedTitle
  normalized.originalTitle = selected.originalTitle
  normalized.sourceMetadataProvider = 'tvdb'

  if (options.preferTvdbSeasons && ids.tvdbId) {
    let mappedSeasons = await mapTvdbSeasons(ids.tvdbId, normalized.seasons || [], {
      hideUnairedSeasons: options.hideUnairedSeasons,
      hideUnairedEpisodes: options.hideUnairedEpisodes,
      includeSpecials: options.includeSpecials,
    })

    // Check AniList relations for expected multi-season
    const relations = await getAniListRelations(ids)
    const validation = validateAnimeTvdbStructure(mappedSeasons, relations.hasSequels)

    debugAnimeMapping({
      localMediaId: normalized.id,
      title: normalized.title,
      originalTitle: normalized.originalTitle,
      year: normalized.year,
      anilistId: ids.anilistId,
      malId: ids.malId,
      tvdbId: ids.tvdbId,
      tmdbId: ids.tmdbId,
      imdbId: ids.imdbId,
      matchedTvdbSeriesId: ids.tvdbId,
      matchedTvdbSeriesName: details.title,
      tvdbOrderType: 'official/aired',
      seasons: mappedSeasons,
    })

    if (validation.suspiciousSingleSeasonFlattening) {
      console.warn('[animeResolver] Suspicious single-season flattening detected:', validation.reason)

      // Try TMDB seasons as fallback structure
      if (ids.tmdbId) {
        const tmdbSeasons = await tryTmdbSeasonsFallback(ids.tmdbId, options)
        if (tmdbSeasons) {
          const tmdbValidation = validateAnimeTvdbStructure(tmdbSeasons, relations.hasSequels)
          const tmdbScore = tmdbValidation.score
          const tvdbScore = validation.score
          console.log('[animeResolver] Score comparison — TVDB:', tvdbScore, 'TMDB:', tmdbScore)

          if (tmdbScore > tvdbScore) {
            console.log('[animeResolver] Using TMDB season structure (better score)')
            mappedSeasons = tmdbSeasons
          }
        }
      }
    }

    // Apply season title resolution
    mappedSeasons = applySeasonTitleResolution(mappedSeasons, options)
    normalized.seasons = mappedSeasons
  }

  if (ids.tmdbId) {
    const tmdb = await tmdbProvider.getShow(`tmdb-${ids.tmdbId}`).catch(() => null)
    if (tmdb) {
      normalized.poster = tmdb.poster || normalized.poster
      normalized.backdrop = tmdb.backdrop || normalized.backdrop
      normalized.logo = tmdb.logo || normalized.logo
      normalized.overview = normalized.overview || tmdb.overview
    }
  }

  return normalized
}
