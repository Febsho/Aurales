export interface SearchResult {
  id: string
  title: string
  type: 'movie' | 'series'
  year?: number
  poster?: string
  backdrop?: string
  /** Transparent logo/wordmark image for hero display */
  logo?: string
  overview?: string
  rating?: number
  provider: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  isAnime?: boolean
  traktId?: number
  simklId?: number
  season?: number
  episode?: number
  addonUrl?: string
  sourceAddonId?: string
  sourceAddonItemId?: string
  metadataFallback?: boolean
  genreIds?: number[]
  genres?: string[]
  voteCount?: number
  popularity?: number
  runtime?: number
  releaseDate?: string
  originalLanguage?: string
  originCountry?: string[]
}

export interface MovieDetails {
  id: string
  title: string
  originalTitle?: string
  year?: number
  releaseDate?: string
  overview?: string
  tagline?: string
  runtime?: number
  rating?: number
  voteCount?: number
  genres: string[]
  poster?: string
  backdrop?: string
  logo?: string
  certification?: string
  originalLanguage?: string
  cast: CastMember[]
  crew: CrewMember[]
  recommendations: SearchResult[]
  trailers: Video[]
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  isAnime?: boolean
  provider?: string
}

export interface ShowDetails {
  id: string
  title: string
  originalTitle?: string
  year?: number
  firstAirDate?: string
  overview?: string
  tagline?: string
  rating?: number
  voteCount?: number
  genres: string[]
  poster?: string
  backdrop?: string
  logo?: string
  certification?: string
  status?: string
  numberOfSeasons?: number
  numberOfEpisodes?: number
  originalLanguage?: string
  seasons: SeasonSummary[]
  cast: CastMember[]
  crew: CrewMember[]
  recommendations: SearchResult[]
  trailers: Video[]
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  isAnime?: boolean
  provider?: string
}

export interface SeasonSummary {
  seasonNumber: number
  name: string
  episodeCount: number
  poster?: string
  overview?: string
  airDate?: string
}

export interface SeasonDetails {
  seasonNumber: number
  name: string
  overview?: string
  poster?: string
  episodes: EpisodeDetails[]
  debugSource?: string
  debugResolverStep?: string
}

export interface EpisodeDetails {
  id: string
  episodeNumber: number
  seasonNumber: number
  name: string
  overview?: string
  airDate?: string
  runtime?: number
  still?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  rating?: number
  voteCount?: number
  imdbRating?: string
  debugSource?: string
  debugResolverStep?: string
  debugOriginalSeasonNumber?: number
  debugOriginalEpisodeNumber?: number
  debugOriginalAbsoluteNumber?: number
  absoluteEpisodeNumber?: number
}

export interface CastMember {
  id: string
  /** Provider that owns this person's ID. Only TMDB IDs can open the TMDB person page. */
  personProvider?: 'tmdb' | 'tvdb' | 'addon'
  name: string
  character: string
  profilePath?: string
}

export interface CrewMember {
  id: string
  /** Provider that owns this person's ID. Only TMDB IDs can open the TMDB person page. */
  personProvider?: 'tmdb' | 'tvdb' | 'addon'
  name: string
  job: string
  department: string
  profilePath?: string
}

export interface Video {
  id: string
  name: string
  key: string
  site: string
  type: string
  thumbnail?: string
}

export interface MetadataProvider {
  id: string
  name: string
  search(query: string): Promise<SearchResult[]>
  recommendationsForText?: (query: string, type: 'movie' | 'series') => Promise<SearchResult[]>
  getMovie(id: string): Promise<MovieDetails>
  getShow(id: string): Promise<ShowDetails>
  getSeason(showId: string, season: number): Promise<SeasonDetails>
  getEpisode(showId: string, season: number, episode: number): Promise<EpisodeDetails>
}

export interface StremioAddonResource {
  name: string
  types?: string[]
  idPrefixes?: string[]
  behaviorHints?: {
    configurable?: boolean
    configurationRequired?: boolean
  }
}

export interface StremioAddonManifest {
  id: string
  name: string
  version: string
  description?: string
  resources: (string | StremioAddonResource)[]
  types: string[]
  catalogs: AddonCatalog[]
  logo?: string
  background?: string
  idPrefixes?: string[]
}

export interface AddonCatalog {
  type: string
  id: string
  name: string
  extra?: AddonCatalogExtra[]
}

export interface AddonCatalogExtra {
  name: string
  isRequired?: boolean
  options?: string[]
}

export interface StreamResult {
  name?: string
  title?: string
  description?: string
  filename?: string
  subtitles?: SubtitleResult[]
  url?: string
  externalUrl?: string
  ytId?: string
  infoHash?: string
  fileIdx?: number
  behaviorHints?: Record<string, unknown>
}

export interface SubtitleResult {
  id: string
  url: string
  lang: string
  label?: string
  source?: 'stream' | 'addon'
  addonName?: string
}

export interface DiscoverConfig {
  source: 'TMDB' | 'TVDB' | 'Simkl' | 'AniList'
  contentType: 'movie' | 'series'
  sortBy: string
  cacheTtl: number
  releasedOnly: boolean
  includeAdult: boolean
  
  // Reference Filters
  includeGenres: string[]
  excludeGenres: string[]
  genreMatchMode: 'AND' | 'OR'
  originalLanguage?: string
  originCountry?: string
  releaseRegion?: string
  certificationCountry?: string
  certification?: string
  certificationLte?: string
  filterMode?: 'Exact' | 'Loose'
  
  // People, Companies, and Keywords
  people: { id: string | number; name: string }[]
  peopleMatchMode: 'AND' | 'OR'
  includeCompanies: { id: string | number; name: string }[]
  excludeCompanies: { id: string | number; name: string }[]
  companyMatchMode: 'AND' | 'OR'
  includeKeywords: { id: string | number; name: string }[]
  excludeKeywords: { id: string | number; name: string }[]
  keywordMatchMode: 'AND' | 'OR'
  
  // Streaming and Region
  watchRegion: string
  providerMatchMode: 'AND' | 'OR'
  selectedProviders: { id: string | number; name: string; logo?: string }[]
  
  // Numeric and Date Ranges
  voteAverageMin: number
  voteAverageMax: number
  voteCountMin?: number
  runtimeMin?: number
  runtimeMax?: number
  releaseDateFrom?: string
  releaseDateTo?: string
  /** Optional catalog cap. Omit for no result limit. */
  maxResults?: number
  presetName?: string
}

export interface HomeRowConfig {
  id: string
  title: string
  addonId?: string
  addonUrl?: string
  catalogType?: string
  catalogId?: string
  catalogExtra?: Record<string, string>
  layout: 'poster' | 'landscape' | 'list' | 'continue' | 'hero'
  enabled: boolean
  order: number
  /** Determines which data source drives this row */
  sourceType?: 'addon' | 'simkl' | 'trakt' | 'local' | 'discover' | 'pmdb' | 'pmdb-picks' | 'mdblist' | 'anilist'
  /** Provider-specific list key, for example Simkl/Trakt/PMDB/MDBList/AniList status or list id */
  providerListId?: string
  sortBy?: 'default' | 'alphabetical'
  showRank?: boolean
  discoverConfig?: DiscoverConfig
}

export interface WatchProgress {
  id: string
  mediaType: string
  mediaId: string
  season?: number
  episode?: number
  progressSeconds: number
  durationSeconds: number
  completed: boolean
  title?: string
  poster?: string
  backdrop?: string
  updatedAt?: string
  imdbId?: string
  tmdbId?: string | number
  malId?: string | number
  anilistId?: string | number
}

export interface TraktTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  createdAt: number
}

export interface TraktDeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

export interface TraktAccount {
  username: string
  name: string
  avatar?: string
}
