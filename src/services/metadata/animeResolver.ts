import { tvdbProvider } from '../tvdb'
import { tmdbProvider } from '../tmdb'
import { normalizeMovie, normalizeShow, selectAnimeTitle } from './metadataNormalizer'
import { useAppStore } from '../../stores/appStore'
import { mapTvdbSeasons } from './tvdbSeasonMapper'
import { validateAnimeTvdbStructure, scoreAnimeStructure, debugAnimeMapping } from './animeStructureValidator'
import { resolveSeasonTitles } from './animeTitleResolver'
import type { AddonMediaInput, AnimeTitleLanguage, AnimeTitlePreference, AppMediaItem, AppSeason, ResolvedExternalIds } from './types'
import { anilistRequest } from '../anilist'

interface AnimeSourceMetadata {
  titles?: { english?: string; romaji?: string; native?: string }
  overview?: string
  poster?: string
  backdrop?: string
  genres?: string[]
  rating?: number
  year?: number
}

const cleanOverview = (value: unknown): string | undefined => typeof value === 'string'
  ? value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() || undefined
  : undefined

async function fetchSelectedAnimeMetadata(source: string, ids: ResolvedExternalIds): Promise<AnimeSourceMetadata | null> {
  if (source === 'anilist' && (ids.anilistId || ids.malId)) {
    const query = `query ($id: Int, $malId: Int) { Media(id: $id, idMal: $malId, type: ANIME) { title { english romaji native } description bannerImage coverImage { extraLarge large } genres averageScore seasonYear } }`
    const media = (await anilistRequest<{ Media?: any }>(query, { id: ids.anilistId, malId: ids.malId }, false).catch(() => null))?.Media
    if (!media) return null
    return { titles: media.title, overview: cleanOverview(media.description), poster: media.coverImage?.extraLarge || media.coverImage?.large, backdrop: media.bannerImage, genres: media.genres, rating: media.averageScore ? Number(media.averageScore) / 10 : undefined, year: media.seasonYear }
  }
  if (source === 'mal' && ids.malId) {
    const response = await fetch(`https://api.jikan.moe/v4/anime/${ids.malId}/full`).catch(() => null)
    if (!response?.ok) return null
    const media = ((await response.json()) as any)?.data
    if (!media) return null
    const titles = Array.isArray(media.titles) ? media.titles : []
    return { titles: { english: titles.find((t: any) => t.type === 'English')?.title, romaji: titles.find((t: any) => t.type === 'Default')?.title || media.title, native: titles.find((t: any) => t.type === 'Japanese')?.title }, overview: cleanOverview(media.synopsis), poster: media.images?.jpg?.large_image_url || media.images?.webp?.large_image_url, genres: [...(media.genres || []), ...(media.themes || [])].map((g: any) => g.name).filter(Boolean), rating: media.score, year: media.year }
  }
  if (source === 'kitsu') {
    const { resolveViaIdsMoe } = await import('../idsMoe')
    const mapped = await resolveViaIdsMoe(ids).catch(() => null)
    if (!mapped?.kitsuId) return null
    const response = await fetch(`https://kitsu.io/api/edge/anime/${mapped.kitsuId}`).catch(() => null)
    if (!response?.ok) return null
    const attrs = ((await response.json()) as any)?.data?.attributes
    if (!attrs) return null
    return { titles: { english: attrs.titles?.en || attrs.titles?.en_us, romaji: attrs.titles?.en_jp || attrs.canonicalTitle, native: attrs.titles?.ja_jp }, overview: cleanOverview(attrs.synopsis || attrs.description), poster: attrs.posterImage?.original || attrs.posterImage?.large, backdrop: attrs.coverImage?.original || attrs.coverImage?.large, rating: attrs.averageRating ? Number(attrs.averageRating) / 10 : undefined, year: attrs.startDate ? Number(String(attrs.startDate).slice(0, 4)) : undefined }
  }
  return null
}

function applyAnimeSourceMetadata(item: AppMediaItem, metadata: AnimeSourceMetadata | null, source: string): void {
  if (!metadata) return
  item.overview = metadata.overview || item.overview
  item.poster = metadata.poster || item.poster
  item.backdrop = metadata.backdrop || item.backdrop
  item.genres = metadata.genres?.length ? metadata.genres : item.genres
  item.rating = metadata.rating ?? item.rating
  item.year = metadata.year || item.year
  if (source === 'anilist' || source === 'mal' || source === 'kitsu') item.sourceMetadataProvider = source
}

async function getAniListTitles(ids: ResolvedExternalIds): Promise<{ english?: string; romaji?: string; native?: string } | null> {
  if (!ids.anilistId && !ids.malId) return null
  const query = `query ($id: Int, $malId: Int) { Media(id: $id, idMal: $malId, type: ANIME) { title { english romaji native } relations { edges { relationType node { id type format title { english romaji native } } } } } }`
  const payload = await anilistRequest<{ Media?: { title?: { english?: string; romaji?: string; native?: string }; relations?: { edges?: Array<{ relationType: string; node: { id: number; type: string; format: string } }> } } }>(query, { id: ids.anilistId, malId: ids.malId }, false).catch(() => null)
  return payload?.Media?.title || null
}

async function getAniListRelations(ids: ResolvedExternalIds): Promise<{ hasSequels: boolean; relatedCount: number }> {
  if (!ids.anilistId && !ids.malId) return { hasSequels: false, relatedCount: 0 }
  const query = `query ($id: Int, $malId: Int) { Media(id: $id, idMal: $malId, type: ANIME) { relations { edges { relationType node { id type format } } } } }`
  const payload = await anilistRequest<{ Media?: { relations?: { edges?: Array<{ relationType: string; node: { id: number; type: string; format: string } }> } } }>(query, { id: ids.anilistId, malId: ids.malId }, false).catch(() => null)
  const edges = payload?.Media?.relations?.edges || []
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
  } catch (_) {
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

  // Anime movies remain movies for routing/playback, but use the anime title
  // and ID pipeline. TVDB's anime season structure only applies to shows.
  if ((input.addonType || '').toLowerCase() === 'movie') {
    if (!ids.tmdbId) return null
    const [movie, selectedSource, fallbackTitles] = await Promise.all([
      tmdbProvider.getMovie(`tmdb-${ids.tmdbId}`).catch(() => null),
      fetchSelectedAnimeMetadata(source, ids).catch(() => null),
      source === 'anilist' ? Promise.resolve(null) : getAniListTitles(ids),
    ])
    if (!movie) return null
    const normalized = normalizeMovie(movie, { ...input, ...ids })
    const anilistTitles = selectedSource?.titles || fallbackTitles
    const selected = selectAnimeTitle({
      english: anilistTitles?.english || movie.title,
      romaji: anilistTitles?.romaji || input.title,
      native: anilistTitles?.native || movie.originalTitle,
    }, options.titleLanguage)
    normalized.title = selected.title
    normalized.localizedTitle = selected.localizedTitle
    normalized.originalTitle = selected.originalTitle
    normalized.isAnime = true
    normalized.anilistId = ids.anilistId
    normalized.malId = ids.malId
    applyAnimeSourceMetadata(normalized, selectedSource, source)
    return normalized
  }

  let details: any = null
  let usedSource: 'tvdb' | 'tmdb' = 'tvdb'

  // Provider details, source metadata, and title data are independent. Start
  // them together; the old waterfall made anime details wait for each service
  // in turn and fetched TMDB a second time for artwork at the end.
  const tmdbDetailsRequest = ids.tmdbId
    ? tmdbProvider.getShow(`tmdb-${ids.tmdbId}`).catch(() => null)
    : Promise.resolve(null)
  const tvdbDetailsRequest = ids.tvdbId
    ? tvdbProvider.getShow(`tvdb-${ids.tvdbId}`).catch(() => null)
    : Promise.resolve(null)
  const selectedSourceRequest = fetchSelectedAnimeMetadata(source, ids).catch(() => null)
  const fallbackTitlesRequest = source === 'anilist'
    ? Promise.resolve(null)
    : getAniListTitles(ids)
  const [tmdbDetails, tvdbDetails, selectedSource, fallbackTitles] = await Promise.all([
    tmdbDetailsRequest,
    tvdbDetailsRequest,
    selectedSourceRequest,
    fallbackTitlesRequest,
  ])

  if (source === 'tmdb') {
    details = tmdbDetails
    if (details) usedSource = 'tmdb'
    else if (fallback) {
      details = tvdbDetails
      if (details) usedSource = 'tvdb'
    }
  } else { // default to TVDB (including AniList/MAL/Kitsu metadata sources)
    details = tvdbDetails
    if (details) usedSource = 'tvdb'
    else if (fallback) {
      details = tmdbDetails
      if (details) usedSource = 'tmdb'
    }
  }

  if (!details) return null

  const normalized = normalizeShow(details, { ...input, ...ids }, 'anime')

  const anilistTitles = selectedSource?.titles || fallbackTitles
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
  normalized.sourceMetadataProvider = usedSource
  applyAnimeSourceMetadata(normalized, selectedSource, source)

  if (options.preferTvdbSeasons && ids.tvdbId) {
    const [initialMappedSeasons, relations] = await Promise.all([
      mapTvdbSeasons(ids.tvdbId, normalized.seasons || [], {
        hideUnairedSeasons: options.hideUnairedSeasons,
        hideUnairedEpisodes: options.hideUnairedEpisodes,
        includeSpecials: options.includeSpecials,
      }),
      getAniListRelations(ids),
    ])
    let mappedSeasons = initialMappedSeasons
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

  if (tmdbDetails) {
      normalized.poster = normalized.poster || tmdbDetails.poster
      normalized.backdrop = normalized.backdrop || tmdbDetails.backdrop
      normalized.logo = tmdbDetails.logo || normalized.logo
      normalized.overview = normalized.overview || tmdbDetails.overview
  }

  return normalized
}
