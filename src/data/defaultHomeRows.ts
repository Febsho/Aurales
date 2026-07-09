import type { DiscoverConfig, HomeRowConfig } from '../types'

// Default shelves for users who haven't configured a home layout yet. Driven by
// TMDB discover so the app feels useful before any addons or accounts are set
// up. Row ids are stable ('default-*') so cache keys stay consistent between
// sessions.

function discoverPreset(
  contentType: 'movie' | 'series',
  sortBy: string,
  overrides: Partial<DiscoverConfig> = {},
): DiscoverConfig {
  return {
    source: 'TMDB',
    contentType,
    sortBy,
    cacheTtl: 43200,
    releasedOnly: true,
    includeAdult: false,
    includeGenres: [],
    excludeGenres: [],
    genreMatchMode: 'OR',
    originalLanguage: '',
    people: [],
    peopleMatchMode: 'OR',
    includeCompanies: [],
    excludeCompanies: [],
    companyMatchMode: 'OR',
    includeKeywords: [],
    excludeKeywords: [],
    keywordMatchMode: 'OR',
    watchRegion: 'US',
    providerMatchMode: 'OR',
    selectedProviders: [],
    voteAverageMin: 0,
    voteAverageMax: 10,
    voteCountMin: 100,
    ...overrides,
  }
}

export function buildDefaultHomeRows(): HomeRowConfig[] {
  return [
    {
      id: 'default-hero',
      title: 'Spotlight',
      layout: 'hero',
      enabled: true,
      order: 0,
      sourceType: 'discover',
      discoverConfig: discoverPreset('movie', 'popularity.desc', { voteCountMin: 300 }),
    },
    { id: 'continue-watching', title: 'Continue Watching', layout: 'continue', enabled: true, order: 1, sourceType: 'local' },
    {
      id: 'default-trending-movies',
      title: 'Trending Movies',
      layout: 'poster',
      enabled: true,
      order: 2,
      sourceType: 'discover',
      showRank: true,
      discoverConfig: discoverPreset('movie', 'popularity.desc', { voteCountMin: 200 }),
    },
    {
      id: 'default-trending-series',
      title: 'Trending Series',
      layout: 'poster',
      enabled: true,
      order: 3,
      sourceType: 'discover',
      showRank: true,
      discoverConfig: discoverPreset('series', 'popularity.desc', { voteCountMin: 200 }),
    },
    {
      id: 'default-new-releases',
      title: 'New Releases',
      layout: 'landscape',
      enabled: true,
      order: 4,
      sourceType: 'discover',
      discoverConfig: discoverPreset('movie', 'primary_release_date.desc', { voteCountMin: 30 }),
    },
    {
      id: 'default-top-movies',
      title: 'Top Rated Movies',
      layout: 'poster',
      enabled: true,
      order: 5,
      sourceType: 'discover',
      discoverConfig: discoverPreset('movie', 'vote_average.desc', { voteCountMin: 1000 }),
    },
    {
      id: 'default-top-series',
      title: 'Top Rated Series',
      layout: 'poster',
      enabled: true,
      order: 6,
      sourceType: 'discover',
      discoverConfig: discoverPreset('series', 'vote_average.desc', { voteCountMin: 500 }),
    },
  ]
}
