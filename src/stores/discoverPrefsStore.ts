import { create } from 'zustand'
import type { SearchResult } from '../types'

// Canonical genres shown in the panel, each mapped to the TMDB genre ids that
// represent it across the movie AND tv namespaces (they differ — e.g. movie
// Action is 28, tv Action is the combined 10759). Excluding a canonical genre
// therefore filters both movies and shows.
export const CANONICAL_GENRES: { name: string; ids: number[] }[] = [
  { name: 'Action', ids: [28, 10759] },
  { name: 'Adventure', ids: [12, 10759] },
  { name: 'Animation', ids: [16] },
  { name: 'Comedy', ids: [35] },
  { name: 'Crime', ids: [80] },
  { name: 'Documentary', ids: [99] },
  { name: 'Drama', ids: [18] },
  { name: 'Family', ids: [10751] },
  { name: 'Fantasy', ids: [14, 10765] },
  { name: 'History', ids: [36] },
  { name: 'Horror', ids: [27] },
  { name: 'Music', ids: [10402] },
  { name: 'Mystery', ids: [9648] },
  { name: 'Romance', ids: [10749] },
  { name: 'Sci-Fi', ids: [878, 10765] },
  { name: 'Thriller', ids: [53] },
  { name: 'War', ids: [10752, 10768] },
  { name: 'Western', ids: [37] },
  { name: 'Kids', ids: [10762] },
  { name: 'Reality', ids: [10764] },
  { name: 'Soap', ids: [10766] },
  { name: 'Talk', ids: [10767] },
  { name: 'TV Movie', ids: [10770] },
]

export const DISCOVER_LANGUAGES: { name: string; code: string }[] = [
  { name: 'English', code: 'en' }, { name: 'Japanese', code: 'ja' }, { name: 'Korean', code: 'ko' },
  { name: 'French', code: 'fr' }, { name: 'Spanish', code: 'es' }, { name: 'German', code: 'de' },
  { name: 'Italian', code: 'it' }, { name: 'Chinese', code: 'zh' }, { name: 'Hindi', code: 'hi' },
  { name: 'Russian', code: 'ru' }, { name: 'Portuguese', code: 'pt' }, { name: 'Turkish', code: 'tr' },
  { name: 'Thai', code: 'th' }, { name: 'Swedish', code: 'sv' }, { name: 'Arabic', code: 'ar' },
  { name: 'Polish', code: 'pl' }, { name: 'Danish', code: 'da' }, { name: 'Norwegian', code: 'no' },
  { name: 'Dutch', code: 'nl' }, { name: 'Finnish', code: 'fi' }, { name: 'Indonesian', code: 'id' },
  { name: 'Filipino', code: 'tl' }, { name: 'Romanian', code: 'ro' }, { name: 'Hungarian', code: 'hu' },
  { name: 'Czech', code: 'cs' }, { name: 'Greek', code: 'el' }, { name: 'Hebrew', code: 'he' },
]

export interface DiscoverPrefs {
  audienceMode: 'auto' | 'grown-up' | 'kid-safe'
  onlyGenres: string[]        // canonical genre names
  excludeGenres: string[]
  onlyLanguages: string[]     // ISO codes
  excludeLanguages: string[]
  minVoteAverage: number | null
  minVoteCount: number | null
  yearFrom: number | null
  yearTo: number | null
  runtimeMin: number | null
  runtimeMax: number | null
  mustIncludeKeywords: { id: number; name: string }[]
  excludeKeywords: { id: number; name: string }[]
  includeCompanies: { id: number; name: string }[]
  selectedProviders: string[]
  contentRating: string | null
  sortOrder: 'taste-ranked' | 'popularity.desc' | 'vote_average.desc' | 'release_date.desc'
  // Ranking weight nudges, each -1..1 (0 = recipe preset / no change)
  weightGenre: number
  weightKeyword: number
  weightPeople: number
  weightQuality: number
  weightPopularity: number
  weightNovelty: number
  weightRecency: number
  weightEra: number
  weightLanguage: number
}

export const DEFAULT_DISCOVER_PREFS: DiscoverPrefs = {
  audienceMode: 'auto',
  onlyGenres: [], excludeGenres: [], onlyLanguages: [], excludeLanguages: [],
  minVoteAverage: null, minVoteCount: null, yearFrom: null, yearTo: null,
  runtimeMin: null, runtimeMax: null,
  mustIncludeKeywords: [], excludeKeywords: [], includeCompanies: [],
  selectedProviders: [], contentRating: null, sortOrder: 'taste-ranked',
  weightGenre: 0, weightKeyword: 0, weightPeople: 0, weightQuality: 0,
  weightPopularity: 0, weightNovelty: 0, weightRecency: 0, weightEra: 0,
  weightLanguage: 0,
}

const STORAGE_KEY = 'aurales_discover_prefs_v1'

function loadPrefs(): DiscoverPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    return raw && typeof raw === 'object' ? { ...DEFAULT_DISCOVER_PREFS, ...raw } : DEFAULT_DISCOVER_PREFS
  } catch { return DEFAULT_DISCOVER_PREFS }
}

interface DiscoverPrefsStore {
  prefs: DiscoverPrefs
  setPrefs: (patch: Partial<DiscoverPrefs>) => void
  resetPrefs: () => void
}

export const useDiscoverPrefsStore = create<DiscoverPrefsStore>((set) => ({
  prefs: loadPrefs(),
  setPrefs: (patch) => set((state) => {
    const prefs = { ...state.prefs, ...patch }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    return { prefs }
  }),
  resetPrefs: () => { localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_DISCOVER_PREFS)); set({ prefs: DEFAULT_DISCOVER_PREFS }) },
}))

/** Read prefs outside React (e.g. inside makeConfig during render). */
export const getDiscoverPrefs = (): DiscoverPrefs => useDiscoverPrefsStore.getState().prefs

const namesToGenreIds = (names: string[]): number[] =>
  [...new Set(names.flatMap((name) => CANONICAL_GENRES.find((g) => g.name === name)?.ids ?? []))]

export const excludeGenreIds = (prefs: DiscoverPrefs): number[] => namesToGenreIds(prefs.excludeGenres)
export const onlyGenreIds = (prefs: DiscoverPrefs): number[] => namesToGenreIds(prefs.onlyGenres)

/** Compact signature so cache keys / snapshots invalidate when prefs change. */
export function prefsSignature(prefs: DiscoverPrefs): string {
  return JSON.stringify([
    prefs.audienceMode,
    prefs.onlyGenres, prefs.excludeGenres, prefs.onlyLanguages, prefs.excludeLanguages,
    prefs.minVoteAverage, prefs.minVoteCount, prefs.yearFrom, prefs.yearTo,
    prefs.runtimeMin, prefs.runtimeMax,
    prefs.mustIncludeKeywords, prefs.excludeKeywords, prefs.includeCompanies,
    prefs.selectedProviders, prefs.contentRating, prefs.sortOrder,
    prefs.weightGenre, prefs.weightKeyword, prefs.weightPeople, prefs.weightQuality,
    prefs.weightPopularity, prefs.weightNovelty, prefs.weightRecency, prefs.weightEra,
    prefs.weightLanguage,
  ])
}

export const prefsWeights = (prefs: DiscoverPrefs) => ({
  genre: prefs.weightGenre,
  keyword: prefs.weightKeyword,
  people: prefs.weightPeople,
  quality: prefs.weightQuality,
  popularity: prefs.weightPopularity,
  novelty: prefs.weightNovelty,
  recency: prefs.weightRecency,
  era: prefs.weightEra,
  language: prefs.weightLanguage,
})

/** True if a candidate item survives the user's include/exclude filters. */
export function candidatePassesPrefs(item: SearchResult, prefs: DiscoverPrefs): boolean {
  const genreIds = item.genreIds || []

  // Audience Mode Filter
  if (prefs.audienceMode === 'grown-up') {
    // Exclude Kids (10762) and Family (10751)
    if (genreIds.includes(10762) || genreIds.includes(10751)) return false
  } else if (prefs.audienceMode === 'kid-safe') {
    // Exclude mature/heavy genres: Horror (27), Thriller (53), Crime (80)
    const matureGenres = [27, 53, 80]
    if (genreIds.some((id) => matureGenres.includes(id))) return false
  }

  const excludeIds = excludeGenreIds(prefs)
  if (excludeIds.length && genreIds.some((id) => excludeIds.includes(id))) return false
  const onlyIds = onlyGenreIds(prefs)
  if (onlyIds.length && (genreIds.length === 0 || !genreIds.some((id) => onlyIds.includes(id)))) return false

  const lang = item.originalLanguage
  if (prefs.excludeLanguages.length && lang && prefs.excludeLanguages.includes(lang)) return false
  if (prefs.onlyLanguages.length && (!lang || !prefs.onlyLanguages.includes(lang))) return false

  if (prefs.minVoteAverage != null && item.rating != null && item.rating < prefs.minVoteAverage) return false
  if (prefs.minVoteCount != null && item.voteCount != null && item.voteCount < prefs.minVoteCount) return false
  if (item.year != null) {
    if (prefs.yearFrom != null && item.year < prefs.yearFrom) return false
    if (prefs.yearTo != null && item.year > prefs.yearTo) return false
  }
  if (item.runtime != null) {
    if (prefs.runtimeMin != null && item.runtime < prefs.runtimeMin) return false
    if (prefs.runtimeMax != null && item.runtime > prefs.runtimeMax) return false
  }
  return true
}
