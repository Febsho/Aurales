export interface AnimeMappingInput {
  localMediaId: string
  title: string
  year?: number
  tvdbId?: number
  tmdbId?: number
  imdbId?: string
  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  seasonNumber?: number
  episodeNumber?: number
  absoluteEpisodeNumber?: number
}

export interface TvdbEpisodeMappingInput {
  localMediaId: string
  tvdbSeriesId: number
  tvdbSeasonNumber: number
  tvdbEpisodeNumber: number
  tvdbEpisodeId?: number
  absoluteEpisodeNumber?: number
}

export interface ProviderProgressMappingInput {
  provider: 'anilist' | 'mal' | 'simkl' | 'trakt'
  providerId: number | string
  providerEpisode: number
  providerSeason?: number
}

export interface ProviderEpisodeMapping {
  tvdbSeriesId: number
  tvdbSeasonNumber: number
  tvdbEpisodeNumber: number
  tvdbEpisodeId?: number

  anilist?: {
    mediaId: number
    episodeNumber?: number
    seasonMediaId?: number
  }

  mal?: {
    id: number
    episodeNumber?: number
  }

  simkl?: {
    id: number
    episodeNumber?: number
    seasonNumber?: number
  }

  trakt?: {
    id?: number
    slug?: string
    seasonNumber?: number
    episodeNumber?: number
  }

  tmdb?: {
    id?: number
    seasonNumber?: number
    episodeNumber?: number
  }

  kitsu?: {
    id?: string
    episodeNumber?: number
  }

  anidb?: {
    id?: number
    episodeNumber?: number
  }

  confidence: number
  source: 'animeApi' | 'animeLists' | 'override'
  updatedAt: string
}

export interface AnimeMappingResult {
  localMediaId: string
  tvdbId?: number
  tmdbId?: number
  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  kitsuId?: string
  anidbId?: number
  animePlanetId?: string

  seasons: AnimeSeasonMapping[]
  confidence: number
  source: 'animeApi' | 'animeLists' | 'override'
  raw?: unknown
  updatedAt: string
}

export interface AnimeSeasonMapping {
  localMediaId: string
  seasonNumber: number
  tvdbSeasonId?: number
  tvdbSeriesId?: number
  tvdbSeasonNumber?: number

  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  tmdbId?: number

  title?: string
  year?: number
  episodeOffset?: number
  episodeCount?: number
}

export interface AnimeMappingCacheKey {
  tvdbId?: number
  anilistId?: number
  malId?: number
  localMediaId?: string
}

export interface AnimeMappingOverride {
  id: string
  localMediaId: string
  seasonNumber?: number
  episodeNumber?: number
  provider: string
  providerId: string
  providerSeasonNumber?: number
  providerEpisodeNumber?: number
  episodeOffset?: number
  note?: string
  createdAt: string
  updatedAt: string
}

export interface AnimeApiEntry {
  title?: string
  anidb?: number
  anilist?: number
  animeplanet?: string
  anisearch?: number
  kitsu?: number
  livechart?: number
  myanimelist?: number
  notify_moe?: string
  themoviedb?: number
  themoviedb_type?: 'tv' | 'movie'
  themoviedb_season_id?: number
  thetvdb?: number
  thetvdb_season_id?: number
  trakt?: number
  trakt_type?: 'shows' | 'movies'
  trakt_season?: number
  trakt_season_id?: number
  simkl?: number
  [key: string]: unknown
}
