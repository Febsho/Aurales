import type { EpisodeDetails, MovieDetails, SearchResult, ShowDetails } from '../types'

export function applySearchResultArt<T extends SearchResult>(item: T): T {
  return item
}

export function applyMovieArt<T extends MovieDetails>(movie: T): T {
  return movie
}

export function applyShowArt<T extends ShowDetails>(show: T): T {
  return show
}

export function applyEpisodeArt<T extends EpisodeDetails>(episode: T, _parent?: Record<string, unknown>): T {
  return episode
}
