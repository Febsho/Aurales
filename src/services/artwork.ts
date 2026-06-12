import type { EpisodeDetails, MovieDetails, SearchResult, ShowDetails, Video } from '../types'

export const ART_PROVIDER_CUSTOM = 'custom'
export const ART_PROVIDER_BTTTR = 'btttr'

export interface ArtUrlOverrides {
  provider: string
  proxyEnabled: boolean
  posterPattern: string
  backgroundPattern: string
  logoPattern: string
  episodeThumbnailPattern: string
}

export interface ArtContext {
  id?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  kitsuId?: string | number
  anilistId?: string | number
  anidbId?: string | number
  type?: string
  season?: string | number
  episode?: string | number
  language?: string
  languageShort?: string
  thumbnail?: string
}

const STORAGE_KEY = 'orynt_art_url_overrides'

export const DEFAULT_ART_OVERRIDES: ArtUrlOverrides = {
  provider: ART_PROVIDER_CUSTOM,
  proxyEnabled: false,
  posterPattern: '',
  backgroundPattern: '',
  logoPattern: '',
  episodeThumbnailPattern: '',
}

export const BTTTR_POSTER_PATTERN = 'https://btttr.cc/poster/auto/{imdb_id}/auto.png'

export function getStoredArtOverrides(): ArtUrlOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_ART_OVERRIDES
    return { ...DEFAULT_ART_OVERRIDES, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_ART_OVERRIDES
  }
}

export function saveArtOverrides(overrides: ArtUrlOverrides): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

export function presetForProvider(provider: string, current: ArtUrlOverrides): ArtUrlOverrides {
  if (provider === ART_PROVIDER_BTTTR) {
    return {
      ...current,
      provider,
      posterPattern: BTTTR_POSTER_PATTERN,
    }
  }
  return { ...current, provider }
}

export function getImdbId(value: { id?: string; imdbId?: string }): string | undefined {
  if (value.imdbId?.startsWith('tt')) return value.imdbId
  if (value.id?.startsWith('tt')) return value.id
  return value.imdbId
}

export function buildArtContext(value: Partial<SearchResult & MovieDetails & ShowDetails & EpisodeDetails & Video> & ArtContext): ArtContext {
  return {
    id: value.id,
    imdbId: getImdbId(value),
    tmdbId: value.tmdbId,
    tvdbId: value.tvdbId,
    malId: value.malId,
    anilistId: value.anilistId,
    type: value.type,
    season: value.season ?? value.seasonNumber,
    episode: value.episode ?? value.episodeNumber,
    thumbnail: value.thumbnail,
  }
}

export function resolveArtPattern(pattern: string, context: ArtContext): string | undefined {
  const trimmed = pattern.trim()
  if (!trimmed) return undefined

  const values: Record<string, string | undefined> = {
    id: context.id,
    imdb_id: context.imdbId,
    tmdb_id: context.tmdbId == null ? undefined : String(context.tmdbId),
    tvdb_id: context.tvdbId == null ? undefined : String(context.tvdbId),
    mal_id: context.malId == null ? undefined : String(context.malId),
    kitsu_id: context.kitsuId == null ? undefined : String(context.kitsuId),
    anilist_id: context.anilistId == null ? undefined : String(context.anilistId),
    anidb_id: context.anidbId == null ? undefined : String(context.anidbId),
    type: context.type,
    season: context.season == null ? undefined : String(context.season),
    episode: context.episode == null ? undefined : String(context.episode),
    language: context.language,
    language_short: context.languageShort,
    thumbnail: context.thumbnail,
  }

  let missing = false
  const url = trimmed.replace(/\{([a-z0-9_]+)\}/gi, (_, key: string) => {
    const value = values[key]
    if (!value) {
      missing = true
      return ''
    }
    return encodeURIComponent(value)
  })

  return missing ? undefined : url
}

export function getPosterOverride(context: ArtContext): string | undefined {
  return resolveArtPattern(getStoredArtOverrides().posterPattern, context)
}

export function getBackgroundOverride(context: ArtContext): string | undefined {
  return resolveArtPattern(getStoredArtOverrides().backgroundPattern, context)
}

export function getLogoOverride(context: ArtContext): string | undefined {
  return resolveArtPattern(getStoredArtOverrides().logoPattern, context)
}

export function getEpisodeThumbnailOverride(context: ArtContext): string | undefined {
  return resolveArtPattern(getStoredArtOverrides().episodeThumbnailPattern, context)
}

function getNonAddonPoster(context: ArtContext, originalPoster?: string, _provider?: string, _addonUrl?: string): string | undefined {
  const customPoster = getPosterOverride(context)
  if (customPoster) return customPoster

  if (context.imdbId && /^tt\d+$/.test(context.imdbId)) {
    return `https://btttr.cc/poster/imdb/poster-default/${context.imdbId}.jpg`
  }

  return originalPoster
}

export function applySearchResultArt<T extends SearchResult>(item: T): T {
  const context = buildArtContext(item)
  return {
    ...item,
    poster: getNonAddonPoster(context, item.poster, item.provider, item.addonUrl),
    backdrop: getBackgroundOverride(context) || item.backdrop,
    logo: getLogoOverride(context) || item.logo,
  }
}

export function applyMovieArt<T extends MovieDetails>(movie: T): T {
  const context = buildArtContext(movie)
  return {
    ...movie,
    poster: getNonAddonPoster(context, movie.poster, movie.provider),
    backdrop: getBackgroundOverride(context) || movie.backdrop,
    logo: getLogoOverride(context) || movie.logo,
    recommendations: movie.recommendations.map(applySearchResultArt),
  }
}

export function applyShowArt<T extends ShowDetails>(show: T): T {
  const context = buildArtContext(show)
  return {
    ...show,
    poster: getNonAddonPoster(context, show.poster, show.provider),
    backdrop: getBackgroundOverride(context) || show.backdrop,
    logo: getLogoOverride(context) || show.logo,
    recommendations: show.recommendations.map(applySearchResultArt),
  }
}

export function applyEpisodeArt<T extends EpisodeDetails>(episode: T, parent?: ArtContext): T {
  const context: ArtContext = {
    ...parent,
    id: episode.id,
    imdbId: episode.imdbId || parent?.imdbId,
    tmdbId: episode.tmdbId || parent?.tmdbId,
    tvdbId: episode.tvdbId || parent?.tvdbId,
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
    thumbnail: episode.still,
  }
  return {
    ...episode,
    still: getEpisodeThumbnailOverride(context) || episode.still,
  }
}
