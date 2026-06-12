export type MediaKind = 'movie' | 'show' | 'anime'
export type AnimeTitleLanguage = 'english' | 'romaji' | 'native' | 'auto'
export type AnimeTitlePreference = 'auto' | 'english' | 'localized' | 'romaji' | 'native'

export interface AnimeTitleInput {
  english?: string
  localized?: string
  romaji?: string
  native?: string
  providerTitle?: string
}

export interface AnimeSeasonTitleInput {
  seasonNumber: number
  english?: string
  localized?: string
  romaji?: string
  native?: string
  providerTitle?: string
  year?: number
  cour?: number
}

export interface AnimeStructureValidation {
  valid: boolean
  reason?: string
  suspiciousSingleSeasonFlattening: boolean
  hasMultipleRealSeasons: boolean
  seasonCount: number
  totalEpisodeCount: number
  score: number
}

export interface AnimeMappingOverride {
  id: string
  localMediaId: string
  overrideType: string
  tvdbSeriesId?: number
  tvdbOrderType?: string
  anilistId?: number
  malId?: number
  seasonNumber?: number
  note?: string
  createdAt: string
  updatedAt: string
}

export interface AppEpisode {
  id: string
  seasonNumber: number
  episodeNumber: number
  absoluteEpisodeNumber?: number
  title: string
  overview?: string
  still?: string
  airDate?: string
  runtime?: number
  tvdbId?: number
  tmdbId?: number
  anilistId?: number
  isReleased?: boolean
  debugSource?: string
  debugResolverStep?: string
  debugOriginalSeasonNumber?: number
  debugOriginalEpisodeNumber?: number
  debugOriginalAbsoluteNumber?: number
}

export interface AppSeason {
  id: string
  seasonNumber: number
  title?: string
  originalTitle?: string
  nativeTitle?: string
  localizedTitle?: string
  overview?: string
  poster?: string
  airDate?: string
  episodeCount: number
  episodes: AppEpisode[]
  isReleased?: boolean
  debugSource?: string
  debugResolverStep?: string
}

export interface AppMediaItem {
  id: string
  type: MediaKind
  title: string
  originalTitle?: string
  localizedTitle?: string
  year?: number
  overview?: string
  poster?: string
  backdrop?: string
  logo?: string
  genres: string[]
  runtime?: number
  rating?: number
  ageRating?: string
  language?: string
  country?: string
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  traktId?: number
  simklId?: number
  anilistId?: number
  malId?: number
  seasons?: AppSeason[]
  sourceMetadataProvider: 'tmdb' | 'tvdb' | 'anilist' | 'fallback_addon'
  sourceAddonId?: string
  sourceAddonItemId?: string
  updatedAt: string
}

export interface AddonMediaInput {
  addonId: string
  addonUrl?: string
  addonType?: string
  id?: string
  title?: string
  year?: number
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  traktId?: number
  simklId?: number
  anilistId?: number
  malId?: number
  rawAddonMeta?: unknown
}

export interface AddonToAppMediaMapping {
  addonId: string
  addonItemId: string
  localMediaId: string
  mediaType: MediaKind
  createdAt: string
  updatedAt: string
}

export interface ResolvedExternalIds {
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  traktId?: number
  simklId?: number
  anilistId?: number
  malId?: number
}
