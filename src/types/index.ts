export interface SearchResult {
  id: string
  title: string
  type: 'movie' | 'series'
  year?: number
  poster?: string
  backdrop?: string
  overview?: string
  rating?: number
  provider: string
  imdbId?: string
  addonUrl?: string
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
  cast: CastMember[]
  crew: CrewMember[]
  recommendations: SearchResult[]
  trailers: Video[]
  imdbId?: string
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
  seasons: SeasonSummary[]
  cast: CastMember[]
  crew: CrewMember[]
  recommendations: SearchResult[]
  trailers: Video[]
  imdbId?: string
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
  rating?: number
  voteCount?: number
}

export interface CastMember {
  id: string
  name: string
  character: string
  profilePath?: string
}

export interface CrewMember {
  id: string
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
  getMovie(id: string): Promise<MovieDetails>
  getShow(id: string): Promise<ShowDetails>
  getSeason(showId: string, season: number): Promise<SeasonDetails>
  getEpisode(showId: string, season: number, episode: number): Promise<EpisodeDetails>
}

export interface StremioAddonResource {
  name: string
  types?: string[]
  idPrefixes?: string[]
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
  type: 'movie' | 'series' | 'channel' | 'tv'
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
  url?: string
  infoHash?: string
  fileIdx?: number
  behaviorHints?: Record<string, unknown>
}

export interface SubtitleResult {
  id: string
  url: string
  lang: string
  label?: string
}

export interface HomeRowConfig {
  id: string
  title: string
  addonId?: string
  catalogType?: string
  catalogId?: string
  layout: 'poster' | 'landscape' | 'list' | 'continue' | 'hero'
  enabled: boolean
  order: number
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
