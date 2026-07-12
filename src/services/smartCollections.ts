import type { DiscoverConfig, HomeRowConfig } from '../types'

export interface SmartCollectionTemplate {
  id: string
  label: string
  description: string
  contentType: 'movie' | 'series'
  rules: Partial<DiscoverConfig>
}

const currentYear = new Date().getFullYear()

export const SMART_COLLECTION_TEMPLATES: SmartCollectionTemplate[] = [
  { id: 'hidden-gems', label: 'Hidden Gems', description: 'Great movies that flew under the radar.', contentType: 'movie', rules: { sortBy: 'vote_average.desc', voteAverageMin: 7, voteCountMin: 100, voteAverageMax: 10 } },
  { id: 'highly-rated', label: 'Highly Rated', description: 'Popular favorites rated 8 or better.', contentType: 'movie', rules: { sortBy: 'vote_average.desc', voteAverageMin: 8, voteCountMin: 1000, voteAverageMax: 10 } },
  { id: 'short-movies', label: '90-Minute Movies', description: 'Excellent films for a shorter movie night.', contentType: 'movie', rules: { sortBy: 'popularity.desc', runtimeMax: 95 } },
  { id: 'family-night', label: 'Family Night', description: 'Family-friendly animation and adventures.', contentType: 'movie', rules: { includeGenres: ['16', '10751', '12'], genreMatchMode: 'OR', certificationCountry: 'US', certification: 'PG' } },
  { id: 'new-this-year', label: 'New This Year', description: `Movies released in ${currentYear}.`, contentType: 'movie', rules: { sortBy: 'primary_release_date.desc', releaseDateFrom: `${currentYear}-01-01`, releaseDateTo: `${currentYear}-12-31` } },
  { id: 'bingeable-series', label: 'Bingeable Series', description: 'Top-rated series worth settling into.', contentType: 'series', rules: { sortBy: 'vote_average.desc', voteAverageMin: 7.5, voteCountMin: 250, voteAverageMax: 10 } },
]

export function getSmartCollections(rows: HomeRowConfig[]): HomeRowConfig[] {
  return rows.filter((row) => row.sourceType === 'discover')
}

export function getHomeShelfRows(rows: HomeRowConfig[]): HomeRowConfig[] {
  return rows.filter((row) => row.layout !== 'hero' && (row.sourceType !== 'discover' || row.enabled))
}

export function newSmartCollectionDefaults(): Pick<HomeRowConfig, 'enabled'> {
  return { enabled: false }
}
