export type BetterPostersRatingSource = 'avg' | 'IM' | 'TM' | 'RT' | 'MC' | 'TR' | 'LB' | 'RE'

export interface BetterPostersSettings {
  enabled: boolean
  trendTags: boolean
  qualityTags: boolean
  showGenre: boolean
  showRating: boolean
  ratingSource: BetterPostersRatingSource
  ageRating: boolean
  language: string
}

export const DEFAULT_BETTER_POSTERS_SETTINGS: BetterPostersSettings = {
  enabled: false,
  trendTags: true,
  qualityTags: false,
  showGenre: true,
  showRating: true,
  ratingSource: 'avg',
  ageRating: false,
  language: 'en',
}

/**
 * Produces BetterPosters' AIOMetadata-compatible URL pattern. BetterPosters
 * uses an IMDb ID, which Aurales resolves before applying custom artwork.
 */
export function getBetterPostersUrl(settings: BetterPostersSettings): string {
  // This path format intentionally mirrors BetterPosters' own configurator.
  // Genre + rating is its default `poster` route; optional quality and age
  // markers are appended after that base route.
  let route = 'poster'
  if (settings.showGenre && !settings.showRating) route = 'poster-g'
  else if (!settings.showGenre && settings.showRating) route = 'poster-r'
  else if (!settings.showGenre && !settings.showRating) route = 'poster-n'
  const suffix = `${settings.qualityTags ? 'q' : ''}${settings.ageRating ? 'a' : ''}`
  if (suffix) route += route.includes('-') ? suffix : `-${suffix}`
  const path = `https://btttr.cc/${route}/imdb/poster-default/{imdb_id}.jpg`
  const params = new URLSearchParams()
  if (!settings.trendTags) params.set('tag', 'none')
  if (settings.language !== 'en') params.set('lang', settings.language)
  if (settings.showRating && settings.ratingSource !== 'avg') params.set('rs', settings.ratingSource)
  const query = params.toString()
  return query ? `${path}?${query}` : path
}
