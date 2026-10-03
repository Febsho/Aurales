import type { SearchResult, WatchProgress } from '../../types'

export type DiscoveryMode = 'for-you' | 'new' | 'hidden-gems' | 'critically-acclaimed' | 'recently-released' | 'quick-watch'
export type RecommendationFeedbackKind = 'not-interested' | 'already-seen' | 'hide' | 'hide-genre' | 'less-like-this' | 'more-like-this'

export interface TasteSignal {
  kind: 'genre' | 'language' | 'decade' | 'format' | 'anime' | 'person' | 'runtime'
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
  /** Display names from resolved title details. IDs stay with the provider layer. */
  personWeights: Record<string, number>
  /** Weighted mean duration of titles the viewer chose to finish or revisit. */
  preferredRuntimeMinutes?: number
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
  item: Pick<SearchResult, 'id' | 'title' | 'type' | 'tmdbId' | 'genreIds'> & Partial<Pick<SearchResult, 'year' | 'runtime' | 'originalLanguage' | 'isAnime'>>
  createdAt: number
  /** The selected genre for a hide-genre action. Older records use item.genreIds. */
  genreId?: number
}

export interface RecommendationReason {
  code: 'genre-affinity' | 'recent-interest' | 'person-affinity' | 'runtime-affinity' | 'quality' | 'new-release' | 'hidden-gem' | 'quick-watch' | 'exploration' | 'rewatch'
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
  /** Optional enrichment from title details; catalog-only candidates can omit it. */
  cast?: string[]
  directors?: string[]
}

/**
 * Detail metadata that callers may attach to activity without changing the
 * provider-neutral SearchResult contract. Match entries by `item` identity.
 */
export interface TasteItemMetadata {
  item: SearchResult
  runtimeMinutes?: number
  cast?: string[]
  directors?: string[]
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
  /** Resolved history permits completed/abandoned titles to teach metadata affinity. */
  completedItems?: SearchResult[]
  abandonedItems?: SearchResult[]
  watchlist?: SearchResult[]
  rewatches?: SearchResult[]
  bingeItems?: SearchResult[]
  tasteMetadata?: TasteItemMetadata[]
}
