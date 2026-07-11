import type { SearchResult, WatchProgress } from '../../types'

export type DiscoveryMode = 'for-you' | 'new' | 'hidden-gems' | 'critically-acclaimed' | 'recently-released' | 'quick-watch'
export type RecommendationFeedbackKind = 'not-interested' | 'already-seen' | 'hide' | 'less-like-this' | 'more-like-this'

export interface TasteSignal {
  kind: 'genre' | 'language' | 'decade' | 'format' | 'anime'
  value: string
  weight: number
  evidenceCount: number
}

export interface TasteProfile {
  signals: TasteSignal[]
  genreWeights: Record<number, number>
  decadeWeights: Record<string, number>
  languageWeights: Record<string, number>
  countryWeights: Record<string, number>
  movieWeight: number
  seriesWeight: number
  animeWeight: number
  activityCount: number
  confidence: 'low' | 'medium' | 'high'
  generatedAt: number
}

export interface RecommendationFeedback {
  mediaKey: string
  kind: RecommendationFeedbackKind
  item: Pick<SearchResult, 'id' | 'title' | 'type' | 'tmdbId' | 'genreIds'>
  createdAt: number
}

export interface RecommendationReason {
  code: 'genre-affinity' | 'recent-interest' | 'quality' | 'new-release' | 'hidden-gem' | 'quick-watch' | 'exploration' | 'rewatch'
  label: string
  strength: number
}

export interface RecommendationScore {
  total: number
  contentSimilarity: number
  preference: number
  recency: number
  quality: number
  popularityConfidence: number
  availability: number
  novelty: number
  exploration: number
  feedbackPenalty: number
  watchedPenalty: number
}

export interface RecommendationCandidate {
  item: SearchResult
  source: 'tmdb-discover' | 'tmdb-trending' | 'tmdb-similar' | 'tmdb-cast' | 'tmdb-director' | 'catalog' | 'fallback'
  runtimeMinutes?: number
  voteCount?: number
  popularity?: number
  releaseDate?: string
  fetchedAt?: number
  seedTitle?: string
}

export interface RankedRecommendation extends RecommendationCandidate {
  score: RecommendationScore
  matchPercent: number
  reasons: RecommendationReason[]
}

export interface DiscoverySection {
  id: string
  title: string
  reason?: string
  items: RankedRecommendation[]
}

export interface RecommendationCacheEntry {
  candidates: RecommendationCandidate[]
  fetchedAt: number
  sourceErrors: string[]
}

export interface DiscoveryActivity {
  progress: WatchProgress[]
  recent: SearchResult[]
  ratings?: Array<{ item: SearchResult; rating: number }>
  watchlist?: SearchResult[]
  rewatches?: SearchResult[]
  bingeItems?: SearchResult[]
}
