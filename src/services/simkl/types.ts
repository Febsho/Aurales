// ─────────────────────────────────────────────────────────────
// Simkl data types
// ─────────────────────────────────────────────────────────────

export interface SimklConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface SimklToken {
  accessToken: string
  tokenType: string
  scope: string
}

export interface SimklPinAuth {
  userCode: string
  verificationUrl: string
  interval: number
  expiresIn: number
}

export interface SimklAccount {
  id: string
  username: string
  avatar?: string
}

export interface SimklConnectionStatus {
  connected: boolean
  account?: SimklAccount
  lastSyncAt?: string
  mockMode: boolean
}

export type SimklMediaType = 'movie' | 'show' | 'anime'

export type SimklWatchStatus =
  | 'plantowatch'   // Watchlist / Plan to Watch
  | 'watching'      // Currently Watching
  | 'completed'     // Completed / Watched
  | 'hold'          // On Hold
  | 'dropped'       // Dropped
  | 'notinteresting' // Not Interesting

export interface SimklSyncItem {
  type: SimklMediaType
  simklId?: number
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  malId?: number
  title: string
  year?: number
  status?: SimklWatchStatus
  watchedAt?: string
  progress?: number
}

export interface SimklWatchlistItem {
  id: string
  type: SimklMediaType
  title: string
  year?: number
  simklId?: number
  tmdbId?: number
  tvdbId?: number
  imdbId?: string
  malId?: number
  poster?: string
  backdrop?: string
  status: SimklWatchStatus
  addedAt?: string
  watchedAt?: string
  watchedEpisodes?: SimklEpisode[]
  userRating?: number
  watchedEpisodesCount?: number
  totalEpisodesCount?: number
}

export interface SimklMapping {
  simklId?: number
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  malId?: number
  type: SimklMediaType
  title: string
  year?: number
}

export interface SimklSyncResult {
  success: boolean
  pulled: number
  pushed: number
  errors: string[]
  syncedAt: string
}

export interface SimklEpisode {
  season: number
  episode: number
  watchedAt?: string
}

export interface SimklShow {
  simklId: number
  title: string
  year?: number
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  totalEpisodesCount?: number
  watchedEpisodesCount?: number
  status: SimklWatchStatus
  nextToWatch?: SimklEpisode
  lastWatched?: SimklEpisode
}

// Raw API response shapes
export interface SimklApiItem {
  movie?: SimklApiMediaItem
  show?: SimklApiMediaItem
  tv?: SimklApiMediaItem
  anime?: SimklApiMediaItem
  last_watched_at?: string
  watched_episodes_count?: number
  total_episodes_count?: number
  status?: string
  user_rating?: number
}

export interface SimklApiMediaItem {
  title: string
  year?: number
  ids: {
    simkl?: number
    simkl_id?: number
    imdb?: string
    tmdb?: number
    tvdb?: number
    mal?: number
    slug?: string
  }
  poster?: string
  fanart?: string
}

// ─── Scrobble types ────────────────────────────────────────────────────────────

export interface SimklScrobbleIds {
  simkl?: number
  imdb?: string
  tmdb?: number
  tvdb?: number
  mal?: number
  anidb?: number
}

export interface SimklScrobblePayload {
  movie?: { title?: string; year?: number; ids: SimklScrobbleIds }
  show?: { title?: string; year?: number; ids: SimklScrobbleIds }
  anime?: { title?: string; year?: number; ids: SimklScrobbleIds }
  episode?: { season?: number; number: number }
  progress: number
}

export interface SimklScrobbleResponse {
  result: string
  action?: string
}

// ─── Playback sync types ──────────────────────────────────────────────────────

export interface SimklPlaybackProgressItem {
  id: number
  progress: number
  paused_at?: string
  type: SimklMediaType
  movie?: SimklApiMediaItem
  show?: SimklApiMediaItem
  anime?: SimklApiMediaItem
  episode?: { season?: number; number: number }
}
