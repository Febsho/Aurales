import { create } from 'zustand'
import type { HomeRowConfig, WatchProgress, SearchResult, TraktAccount } from '../types'
import type { InstalledAddon } from '../services/addons'
import type { SimklAccount } from '../services/simkl/types'
import type { AniListAccount } from '../services/anilist'
import { v4 as uuid } from 'uuid'

interface AppState {
  sidebarCollapsed: boolean
  toggleSidebar: () => void

  // Settings
  tmdbApiKey: string
  tvdbApiKey: string
  traktClientId: string
  traktClientSecret: string
  traktConnected: boolean
  traktAccount: TraktAccount | null
  mdblistApiKey: string
  setTmdbApiKey: (key: string) => void
  setTvdbApiKey: (key: string) => void
  setTraktClientId: (key: string) => void
  setTraktClientSecret: (key: string) => void
  setTraktConnected: (connected: boolean) => void
  setTraktAccount: (account: TraktAccount | null) => void
  setMdblistApiKey: (key: string) => void

  scrobbleSimkl: boolean
  scrobbleTrakt: boolean
  scrobblePmdb: boolean
  scrobbleAnilist: boolean
  setScrobbleSimkl: (enabled: boolean) => void
  setScrobbleTrakt: (enabled: boolean) => void
  setScrobblePmdb: (enabled: boolean) => void
  setScrobbleAnilist: (enabled: boolean) => void

  // Simkl
  simklConnected: boolean
  simklAccount: SimklAccount | null
  setSimklConnected: (connected: boolean) => void
  setSimklAccount: (account: SimklAccount | null) => void

  // AniList
  anilistConnected: boolean
  anilistAccount: AniListAccount | null
  anilistClientId: string
  anilistClientSecret: string
  setAnilistConnected: (connected: boolean) => void
  setAnilistAccount: (account: AniListAccount | null) => void
  setAnilistClientId: (key: string) => void
  setAnilistClientSecret: (key: string) => void

  // Addons
  addons: InstalledAddon[]
  setAddons: (addons: InstalledAddon[]) => void
  addAddon: (addon: InstalledAddon) => void
  removeAddon: (addonId: string) => void

  // Home layout
  homeRows: HomeRowConfig[]
  setHomeRows: (rows: HomeRowConfig[]) => void
  addHomeRow: (row: Omit<HomeRowConfig, 'id' | 'order'>) => void
  removeHomeRow: (id: string) => void
  updateHomeRow: (id: string, updates: Partial<HomeRowConfig>) => void
  reorderHomeRows: (rows: HomeRowConfig[]) => void
  resetHomeRows: () => void

  // Watch progress
  watchProgress: Map<string, WatchProgress>
  setWatchProgress: (id: string, progress: WatchProgress) => void
  removeWatchProgress: (mediaIds: string[], season?: number, episode?: number) => void

  // Recently watched
  recentlyWatched: SearchResult[]
  addRecentlyWatched: (item: SearchResult) => void

  preferredSubtitles: string[]
  preferredAudio: string[]
  setPreferredSubtitles: (langs: string[]) => void
  setPreferredAudio: (langs: string[]) => void

  continueWatchingSource: 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist'
  continueWatchingLimit: number
  watchedCheckmarkSources: ('local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist')[]
  watchlistButtonTarget: 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist'
  pmdbApiKey: string
  pmdbSaveResumePosition: boolean
  pmdbSyncFrequency: string
  pmdbLastSyncTime: string
  traktSaveResumePosition: boolean
  traktSyncFrequency: string
  simklSaveResumePosition: boolean
  simklSyncFrequency: string
  anilistSyncFrequency: string
  introdbApiKey: string
  animeTrackingProvider: 'anilist' | 'simkl' | 'trakt' | 'local'
  animeShowWatchedFrom: 'all' | 'provider'

  setContinueWatchingSource: (src: 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist') => void
  setContinueWatchingLimit: (limit: number) => void
  setWatchedCheckmarkSources: (sources: ('local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist')[]) => void
  setWatchlistButtonTarget: (target: 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist') => void
  setPmdBApiKey: (key: string) => void
  setPmdBSaveResumePosition: (val: boolean) => void
  setPmdBSyncFrequency: (freq: string) => void
  setPmdBLastSyncTime: (time: string) => void
  setTraktSaveResumePosition: (val: boolean) => void
  setTraktSyncFrequency: (freq: string) => void
  setSimklSaveResumePosition: (val: boolean) => void
  setSimklSyncFrequency: (freq: string) => void
  setAnilistSyncFrequency: (freq: string) => void
  setIntrodbApiKey: (key: string) => void
  setAnimeTrackingProvider: (prov: 'anilist' | 'simkl' | 'trakt' | 'local') => void
  setAnimeShowWatchedFrom: (watchedFrom: 'all' | 'provider') => void

  // Library & Spoilers
  blurSpoilers: boolean
  blurThumbnails: boolean
  blurTitles: boolean
  blurDescriptions: boolean
  keepNextEpisodeVisible: boolean
  keepFramesFor: 'none' | '1_week' | '30_days' | '3_months' | '6_months' | '1_year'
  savedFramesCount: number

  setBlurSpoilers: (val: boolean) => void
  setBlurThumbnails: (val: boolean) => void
  setBlurTitles: (val: boolean) => void
  setBlurDescriptions: (val: boolean) => void
  setKeepNextEpisodeVisible: (val: boolean) => void
  setKeepFramesFor: (val: 'none' | '1_week' | '30_days' | '3_months' | '6_months' | '1_year') => void
  setSavedFramesCount: (count: number) => void

  posterSize: 'compact' | 'default' | 'large' | 'huge'
  nextEpisodePrompt: 'auto' | 'off' | '30s' | '45s' | '1m' | '1.5m' | '2m'
  setPosterSize: (size: 'compact' | 'default' | 'large' | 'huge') => void
  setNextEpisodePrompt: (prompt: 'auto' | 'off' | '30s' | '45s' | '1m' | '1.5m' | '2m') => void

  // New settings options
  accentColor: 'green' | 'purple' | 'blue' | 'red' | 'orange' | 'pink' | 'white'
  defaultStartPage: 'home' | 'discover' | 'collections' | 'search'
  showRatingsOnCards: boolean
  discoveryRegion: string
  discoveryMinRating: number
  discoveryIncludeAdult: boolean
  hwdecMode: 'auto' | 'no' | 'nvdec' | 'vaapi' | 'videotoolbox'
  isolatedPlaybackMode: boolean
  isolatedPlaybackHwdec: 'auto-safe' | 'no'
  isolatedPlaybackResume: boolean
  cacheBufferSize: 'default' | 'large' | 'aggressive'
  audioPassthrough: boolean
  autoSkipSegments: boolean
  subtitleFontSize: number
  subtitleBgOpacity: string
  visibleHeroRatings: string[]
  openrouterApiKey: string
  openrouterModel: string

  // Metadata sources
  movieMetadataSource: 'tmdb' | 'tvdb'
  seriesMetadataSource: 'tvdb' | 'tmdb'
  animeMetadataSource: 'anilist' | 'mal' | 'kitsu' | 'tvdb' | 'tmdb'
  movieMetadataFallback: boolean
  seriesMetadataFallback: boolean
  animeMetadataFallback: boolean
  enableCommunityRatings: boolean
  appManagedMetadata: boolean
  useAddonMetadataFallback: boolean
  preferTvdbAnimeSeasons: boolean
  animeTitleLanguage: 'english' | 'romaji' | 'native' | 'auto'
  hideUnairedAnimeSeasons: boolean
  hideUnairedAnimeEpisodes: boolean
  includeAnimeSpecials: boolean
  ignoreAddonMetadataForAnime: boolean
  useGenericAnimeSeasonLabels: boolean
  avoidJapaneseSeasonNames: boolean
  setUseGenericAnimeSeasonLabels: (val: boolean) => void
  setAvoidJapaneseSeasonNames: (val: boolean) => void
  setMovieMetadataSource: (src: 'tmdb' | 'tvdb') => void
  setSeriesMetadataSource: (src: 'tvdb' | 'tmdb') => void
  setAnimeMetadataSource: (src: 'anilist' | 'mal' | 'kitsu' | 'tvdb' | 'tmdb') => void
  setMovieMetadataFallback: (val: boolean) => void
  setSeriesMetadataFallback: (val: boolean) => void
  setAnimeMetadataFallback: (val: boolean) => void
  setEnableCommunityRatings: (val: boolean) => void
  setAppManagedMetadata: (val: boolean) => void
  setUseAddonMetadataFallback: (val: boolean) => void
  setPreferTvdbAnimeSeasons: (val: boolean) => void
  setAnimeTitleLanguage: (val: 'english' | 'romaji' | 'native' | 'auto') => void
  setHideUnairedAnimeSeasons: (val: boolean) => void
  setHideUnairedAnimeEpisodes: (val: boolean) => void
  setIncludeAnimeSpecials: (val: boolean) => void
  setIgnoreAddonMetadataForAnime: (val: boolean) => void
  clearAnimeCache: () => Promise<void>

  // Search engines
  movieSearchEngine: string
  seriesSearchEngine: string
  animeSeriesSearchEngine: string
  animeMovieSearchEngine: string
  movieSearchEnabled: boolean
  seriesSearchEnabled: boolean
  animeSeriesSearchEnabled: boolean
  animeMovieSearchEnabled: boolean
  setMovieSearchEngine: (engine: string) => void
  setSeriesSearchEngine: (engine: string) => void
  setAnimeSeriesSearchEngine: (engine: string) => void
  setAnimeMovieSearchEngine: (engine: string) => void
  setMovieSearchEnabled: (val: boolean) => void
  setSeriesSearchEnabled: (val: boolean) => void
  setAnimeSeriesSearchEnabled: (val: boolean) => void
  setAnimeMovieSearchEnabled: (val: boolean) => void

  // Discord Rich Presence
  discordRichPresence: boolean
  setDiscordRichPresence: (enabled: boolean) => void

  // Subtitle translation settings
  subtitleTranslationLang: string
  subtitleTranslationEnabled: boolean
  translationCuesAhead: number
  contextAwareTranslation: boolean
  setSubtitleTranslationLang: (lang: string) => void
  setSubtitleTranslationEnabled: (enabled: boolean) => void
  setTranslationCuesAhead: (n: number) => void
  setContextAwareTranslation: (val: boolean) => void

  setAccentColor: (color: 'green' | 'purple' | 'blue' | 'red' | 'orange' | 'pink' | 'white') => void
  setDefaultStartPage: (page: 'home' | 'discover' | 'collections' | 'search') => void
  setShowRatingsOnCards: (show: boolean) => void
  setDiscoveryRegion: (region: string) => void
  setDiscoveryMinRating: (rating: number) => void
  setDiscoveryIncludeAdult: (include: boolean) => void
  setHwdecMode: (mode: 'auto' | 'no' | 'nvdec' | 'vaapi' | 'videotoolbox') => void
  setIsolatedPlaybackMode: (value: boolean) => void
  setIsolatedPlaybackHwdec: (mode: 'auto-safe' | 'no') => void
  setIsolatedPlaybackResume: (value: boolean) => void
  setCacheBufferSize: (size: 'default' | 'large' | 'aggressive') => void
  setAudioPassthrough: (val: boolean) => void
  setAutoSkipSegments: (val: boolean) => void
  setSubtitleFontSize: (size: number) => void
  setSubtitleBgOpacity: (opacity: string) => void
  setVisibleHeroRatings: (ratings: string[]) => void
  setOpenrouterApiKey: (key: string) => void
  setOpenrouterModel: (model: string) => void

  mpvCacheSecs: number
  mpvNetworkTimeout: number
  mpvCustomArgs: string
  setMpvCacheSecs: (secs: number) => void
  setMpvNetworkTimeout: (secs: number) => void
  setMpvCustomArgs: (args: string) => void
  resetPlayerSettings: () => void
}

function loadPersistedAddons(): InstalledAddon[] {
  try {
    const raw = localStorage.getItem('orynt_addons')
    if (raw) return JSON.parse(raw)
  } catch (_) { /* ignore */ }
  return []
}

function persistAddons(addons: InstalledAddon[]): void {
  localStorage.setItem('orynt_addons', JSON.stringify(addons))
}

function loadPersistedHomeRows(): HomeRowConfig[] | null {
  try {
    const raw = localStorage.getItem('orynt_home_rows')
    if (raw) {
      const rows = JSON.parse(raw) as HomeRowConfig[]
      const sanitized = rows.filter((row) => row.addonId !== 'com.example.mockaddon' && !String(row.catalogId || '').startsWith('mock-'))
      if (sanitized.length !== rows.length) persistHomeRows(sanitized)
      return sanitized
    }
  } catch (_) { /* ignore */ }
  return null
}

function persistHomeRows(rows: HomeRowConfig[]): void {
  localStorage.setItem('orynt_home_rows', JSON.stringify(rows))
}

function loadPersistedWatchProgress(): Map<string, WatchProgress> {
  try {
    const raw = localStorage.getItem('orynt_watch_progress')
    if (raw) {
      const parsed = JSON.parse(raw)
      return new Map(Object.entries(parsed))
    }
  } catch (_) { /* ignore */ }
  return new Map()
}

function persistWatchProgress(map: Map<string, WatchProgress>): void {
  try {
    const obj = Object.fromEntries(map.entries())
    localStorage.setItem('orynt_watch_progress', JSON.stringify(obj))
  } catch (_) { /* ignore */ }
}

function loadPersistedPreferredSubtitles(): string[] {
  try {
    const raw = localStorage.getItem('orynt_preferred_subtitles')
    if (raw) return JSON.parse(raw)
  } catch (_) { /* ignore */ }
  return ['en']
}

function loadPersistedPreferredAudio(): string[] {
  try {
    const raw = localStorage.getItem('orynt_preferred_audio')
    if (raw) return JSON.parse(raw)
  } catch (_) { /* ignore */ }
  return ['en', 'ja']
}

function loadRecentlyViewed(): SearchResult[] {
  try {
    const raw = localStorage.getItem('orynt_recently_viewed')
    return raw ? JSON.parse(raw) as SearchResult[] : []
  } catch (_) {
    return []
  }
}

export interface LanguageItem {
  code: string
  name: string
  flag: string
  iso3: string[]
}

export const APP_LANGUAGES: LanguageItem[] = [
  { code: 'en', name: 'English', flag: '🇺🇸', iso3: ['eng'] },
  { code: 'es', name: 'Spanish', flag: '🇪🇸', iso3: ['spa'] },
  { code: 'fr', name: 'French', flag: '🇫🇷', iso3: ['fre', 'fra'] },
  { code: 'de', name: 'German', flag: '🇩🇪', iso3: ['ger', 'deu'] },
  { code: 'it', name: 'Italian', flag: '🇮🇹', iso3: ['ita'] },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹', iso3: ['por'] },
  { code: 'ru', name: 'Russian', flag: '🇷🇺', iso3: ['rus'] },
  { code: 'ja', name: 'Japanese', flag: '🇯🇵', iso3: ['jpn'] },
  { code: 'ko', name: 'Korean', flag: '🇰🇷', iso3: ['kor'] },
  { code: 'zh', name: 'Chinese', flag: '🇨🇳', iso3: ['zho', 'chi'] },
  { code: 'hi', name: 'Hindi', flag: '🇮🇳', iso3: ['hin'] },
  { code: 'ar', name: 'Arabic', flag: '🇸🇦', iso3: ['ara'] },
  { code: 'tr', name: 'Turkish', flag: '🇹🇷', iso3: ['tur'] },
  { code: 'nl', name: 'Dutch', flag: '🇳🇱', iso3: ['dut', 'nld'] },
  { code: 'pl', name: 'Polish', flag: '🇵🇱', iso3: ['pol'] },
  { code: 'uk', name: 'Ukrainian', flag: '🇺🇦', iso3: ['ukr'] },
  { code: 'cs', name: 'Czech', flag: '🇨🇿', iso3: ['cze', 'ces'] },
  { code: 'hu', name: 'Hungarian', flag: '🇭🇺', iso3: ['hun'] },
  { code: 'ro', name: 'Romanian', flag: '🇷🇴', iso3: ['rum', 'ron'] },
  { code: 'sv', name: 'Swedish', flag: '🇸🇪', iso3: ['swe'] },
  { code: 'no', name: 'Norwegian', flag: '🇳🇴', iso3: ['nor'] },
  { code: 'da', name: 'Danish', flag: '🇩🇰', iso3: ['dan'] },
  { code: 'fi', name: 'Finnish', flag: '🇫🇮', iso3: ['fin'] },
  { code: 'he', name: 'Hebrew', flag: '🇮🇱', iso3: ['heb'] },
  { code: 'th', name: 'Thai', flag: '🇹🇭', iso3: ['tha'] },
  { code: 'vi', name: 'Vietnamese', flag: '🇻🇳', iso3: ['vie'] }
]

export function getLanguageCodeFromTrack(langStr?: string): string | null {
  if (!langStr) return null
  const cleaned = langStr.toLowerCase().trim()
  const found = APP_LANGUAGES.find(
    (l) => l.code === cleaned || l.iso3.includes(cleaned) || l.name.toLowerCase() === cleaned
  )
  return found ? found.code : null
}

const DEFAULT_HOME_ROWS: HomeRowConfig[] = [
  { id: 'continue-watching', title: 'Continue Watching', layout: 'continue', enabled: true, order: 1, sourceType: 'local' },
]

export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: true,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  tmdbApiKey: localStorage.getItem('tmdb_api_key') || '',
  tvdbApiKey: localStorage.getItem('tvdb_api_key') || '',
  traktClientId: localStorage.getItem('trakt_client_id') || '',
  traktClientSecret: localStorage.getItem('trakt_client_secret') || '',
  traktConnected: !!localStorage.getItem('trakt_tokens'),
  mdblistApiKey: localStorage.getItem('mdblist_api_key') || '',
  traktAccount: (() => {
    try {
      const raw = localStorage.getItem('trakt_account')
      return raw ? JSON.parse(raw) as TraktAccount : null
    } catch (_) { return null }
  })(),
  setTmdbApiKey: (key) => { localStorage.setItem('tmdb_api_key', key); set({ tmdbApiKey: key }) },
  setTvdbApiKey: (key) => { localStorage.setItem('tvdb_api_key', key); set({ tvdbApiKey: key }) },
  setTraktClientId: (key) => { localStorage.setItem('trakt_client_id', key); set({ traktClientId: key }) },
  setTraktClientSecret: (key) => { localStorage.setItem('trakt_client_secret', key); set({ traktClientSecret: key }) },
  setTraktConnected: (connected) => set({ traktConnected: connected }),
  setTraktAccount: (account) => {
    if (account) localStorage.setItem('trakt_account', JSON.stringify(account))
    else localStorage.removeItem('trakt_account')
    set({ traktAccount: account })
  },
  setMdblistApiKey: (key) => { localStorage.setItem('mdblist_api_key', key); set({ mdblistApiKey: key }) },

  scrobbleSimkl: localStorage.getItem('scrobble_simkl') !== 'false',
  scrobbleTrakt: localStorage.getItem('scrobble_trakt') !== 'false',
  scrobblePmdb: localStorage.getItem('scrobble_pmdb') !== 'false',
  scrobbleAnilist: localStorage.getItem('scrobble_anilist') !== 'false',
  setScrobbleSimkl: (enabled) => { localStorage.setItem('scrobble_simkl', String(enabled)); set({ scrobbleSimkl: enabled }) },
  setScrobbleTrakt: (enabled) => { localStorage.setItem('scrobble_trakt', String(enabled)); set({ scrobbleTrakt: enabled }) },
  setScrobblePmdb: (enabled) => { localStorage.setItem('scrobble_pmdb', String(enabled)); set({ scrobblePmdb: enabled }) },
  setScrobbleAnilist: (enabled) => { localStorage.setItem('scrobble_anilist', String(enabled)); set({ scrobbleAnilist: enabled }) },

  simklConnected: !!localStorage.getItem('simkl_token'),
  simklAccount: (() => {
    try {
      const raw = localStorage.getItem('simkl_account')
      return raw ? JSON.parse(raw) as SimklAccount : null
    } catch (_) { return null }
  })(),
  setSimklConnected: (connected) => set({ simklConnected: connected }),
  setSimklAccount: (account) => {
    if (account) localStorage.setItem('simkl_account', JSON.stringify(account))
    else localStorage.removeItem('simkl_account')
    set({ simklAccount: account })
  },

  anilistConnected: !!localStorage.getItem('anilist_token'),
  anilistAccount: (() => {
    try {
      const raw = localStorage.getItem('anilist_account')
      return raw ? JSON.parse(raw) as AniListAccount : null
    } catch (_) { return null }
  })(),
  anilistClientId: localStorage.getItem('anilist_client_id') || '',
  anilistClientSecret: localStorage.getItem('anilist_client_secret') || '',
  setAnilistConnected: (connected) => set({ anilistConnected: connected }),
  setAnilistAccount: (account) => {
    if (account) localStorage.setItem('anilist_account', JSON.stringify(account))
    else localStorage.removeItem('anilist_account')
    set({ anilistAccount: account })
  },
  setAnilistClientId: (key) => { localStorage.setItem('anilist_client_id', key); set({ anilistClientId: key }) },
  setAnilistClientSecret: (key) => { localStorage.setItem('anilist_client_secret', key); set({ anilistClientSecret: key }) },

  addons: loadPersistedAddons(),
  setAddons: (addons) => { persistAddons(addons); set({ addons }) },
  addAddon: (addon) => set((s) => {
    const next = [...s.addons, addon]
    persistAddons(next)
    return { addons: next }
  }),
  removeAddon: (addonId) => set((s) => {
    const next = s.addons.filter((a) => a.manifest.id !== addonId)
    persistAddons(next)
    return { addons: next }
  }),

  homeRows: loadPersistedHomeRows() || DEFAULT_HOME_ROWS,
  setHomeRows: (rows) => { persistHomeRows(rows); set({ homeRows: rows }) },
  addHomeRow: (row) => set((s) => {
    const maxOrder = s.homeRows.reduce((max, r) => r.order > max ? r.order : max, 0)
    const next = [...s.homeRows, { ...row, id: uuid(), order: maxOrder + 1 }]
    persistHomeRows(next)
    return { homeRows: next }
  }),
  removeHomeRow: (id) => set((s) => {
    const next = s.homeRows.filter((r) => r.id !== id)
    persistHomeRows(next)
    return { homeRows: next }
  }),
  updateHomeRow: (id, updates) => set((s) => {
    const next = s.homeRows.map((r) => r.id === id ? { ...r, ...updates } : r)
    persistHomeRows(next)
    return { homeRows: next }
  }),
  reorderHomeRows: (rows) => {
    const next = rows.map((r, i) => ({ ...r, order: i }))
    persistHomeRows(next)
    set({ homeRows: next })
  },
  resetHomeRows: () => { persistHomeRows(DEFAULT_HOME_ROWS); set({ homeRows: DEFAULT_HOME_ROWS }) },

  watchProgress: loadPersistedWatchProgress(),
  setWatchProgress: (id, progress) => set((s) => {
    const map = new Map(s.watchProgress)
    map.set(id, progress)
    persistWatchProgress(map)
    return { watchProgress: map }
  }),
  removeWatchProgress: (mediaIds, season, episode) => set((s) => {
    const ids = new Set(mediaIds.filter(Boolean).map(String))
    const map = new Map(s.watchProgress)
    for (const [key, progress] of map) {
      const matchesMedia = ids.has(String(progress.mediaId))
        || (progress.imdbId != null && ids.has(String(progress.imdbId)))
        || (progress.tmdbId != null && (ids.has(String(progress.tmdbId)) || ids.has(`tmdb-${progress.tmdbId}`)))
        || Array.from(ids).some((id) => key === id || key.startsWith(`${id}:`))
      const matchesEpisode = season == null || episode == null
        || (progress.season === season && progress.episode === episode)
      if (matchesMedia && matchesEpisode) map.delete(key)
    }
    persistWatchProgress(map)
    return { watchProgress: map }
  }),

  recentlyWatched: loadRecentlyViewed(),
  addRecentlyWatched: (item) => set((s) => {
    const next = [item, ...s.recentlyWatched.filter((r) => r.id !== item.id)].slice(0, 30)
    localStorage.setItem('orynt_recently_viewed', JSON.stringify(next))
    return { recentlyWatched: next }
  }),

  preferredSubtitles: loadPersistedPreferredSubtitles(),
  preferredAudio: loadPersistedPreferredAudio(),
  setPreferredSubtitles: (langs) => {
    localStorage.setItem('orynt_preferred_subtitles', JSON.stringify(langs))
    set({ preferredSubtitles: langs })
  },
  setPreferredAudio: (langs) => {
    localStorage.setItem('orynt_preferred_audio', JSON.stringify(langs))
    set({ preferredAudio: langs })
  },

  continueWatchingSource: (localStorage.getItem('orynt_cw_source') || 'local') as 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist',
  continueWatchingLimit: Number(localStorage.getItem('orynt_cw_limit') || '10'),
  watchedCheckmarkSources: (() => {
    try {
      const raw = localStorage.getItem('orynt_watched_checkmark_sources')
      if (raw) return JSON.parse(raw) as ('local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist')[]
    } catch (_) { /* ignore */ }
    return ['local'] as ('local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist')[]
  })(),
  watchlistButtonTarget: (localStorage.getItem('orynt_watchlist_target') || 'local') as 'local' | 'trakt' | 'simkl' | 'pmdb' | 'anilist',
  pmdbApiKey: localStorage.getItem('pmdb_api_key') || '',
  pmdbSaveResumePosition: localStorage.getItem('pmdb_save_resume') !== 'false',
  pmdbSyncFrequency: localStorage.getItem('pmdb_sync_freq') || 'every_minute',
  pmdbLastSyncTime: localStorage.getItem('pmdb_last_sync') || '',
  traktSaveResumePosition: localStorage.getItem('trakt_save_resume') !== 'false',
  traktSyncFrequency: localStorage.getItem('trakt_sync_freq') || 'every_5',
  simklSaveResumePosition: localStorage.getItem('simkl_save_resume') !== 'false',
  simklSyncFrequency: localStorage.getItem('simkl_sync_freq') || 'every_5',
  anilistSyncFrequency: localStorage.getItem('anilist_sync_freq') || 'every_5',
  introdbApiKey: localStorage.getItem('introdb_api_key') || '',
  animeTrackingProvider: (localStorage.getItem('anime_tracking_provider') || 'anilist') as 'anilist' | 'simkl' | 'trakt' | 'local',
  animeShowWatchedFrom: (localStorage.getItem('anime_show_watched') || 'all') as 'all' | 'provider',

  blurSpoilers: localStorage.getItem('orynt_blur_spoilers') === 'true',
  blurThumbnails: localStorage.getItem('orynt_blur_thumbnails') !== 'false',
  blurTitles: localStorage.getItem('orynt_blur_titles') !== 'false',
  blurDescriptions: localStorage.getItem('orynt_blur_descriptions') !== 'false',
  keepNextEpisodeVisible: localStorage.getItem('orynt_keep_next_episode_visible') === 'true',
  keepFramesFor: (localStorage.getItem('orynt_keep_frames_for') || '30_days') as 'none' | '1_week' | '30_days' | '3_months' | '6_months' | '1_year',
  savedFramesCount: Number(localStorage.getItem('orynt_saved_frames_count') || '2'),
  posterSize: (localStorage.getItem('orynt_poster_size') || 'default') as 'compact' | 'default' | 'large' | 'huge',
  nextEpisodePrompt: (localStorage.getItem('orynt_next_episode_prompt') || 'auto') as 'auto' | 'off' | '30s' | '45s' | '1m' | '1.5m' | '2m',

  // New settings options initial values
  accentColor: (localStorage.getItem('orynt_accent_color') || 'white') as 'green' | 'purple' | 'blue' | 'red' | 'orange' | 'pink' | 'white',
  defaultStartPage: (localStorage.getItem('orynt_default_start_page') || 'home') as 'home' | 'discover' | 'collections' | 'search',
  showRatingsOnCards: localStorage.getItem('orynt_show_ratings_on_cards') !== 'false',
  discoveryRegion: localStorage.getItem('orynt_discovery_region') || 'US',
  discoveryMinRating: Number(localStorage.getItem('orynt_discovery_min_rating') || '6'),
  discoveryIncludeAdult: localStorage.getItem('orynt_discovery_include_adult') === 'true',
  hwdecMode: (localStorage.getItem('orynt_hwdec_mode') || 'auto') as 'auto' | 'no' | 'nvdec' | 'vaapi' | 'videotoolbox',
  isolatedPlaybackMode: false,
  isolatedPlaybackHwdec: (localStorage.getItem('orynt_isolated_hwdec') || 'auto-safe') as 'auto-safe' | 'no',
  isolatedPlaybackResume: localStorage.getItem('orynt_isolated_resume') === 'true',
  cacheBufferSize: (localStorage.getItem('orynt_cache_buffer_size') || 'default') as 'default' | 'large' | 'aggressive',
  audioPassthrough: localStorage.getItem('orynt_audio_passthrough') === 'true',
  autoSkipSegments: localStorage.getItem('orynt_auto_skip_segments') === 'true',
  subtitleFontSize: Number(localStorage.getItem('orynt_sub_font_size') || '24'),
  subtitleBgOpacity: localStorage.getItem('orynt_sub_bg_opacity') || '0',
  visibleHeroRatings: (() => {
    try {
      const raw = localStorage.getItem('orynt_visible_hero_ratings')
      if (raw) return JSON.parse(raw) as string[]
    } catch (_) { /* ignore */ }
    return ['imdb', 'rottentomatoes', 'tomatoesaudience', 'metacritic', 'tmdb', 'trakt', 'letterboxd', 'myanimelist']
  })(),

  setContinueWatchingSource: (src) => { localStorage.setItem('orynt_cw_source', src); set({ continueWatchingSource: src }) },
  setContinueWatchingLimit: (limit) => { localStorage.setItem('orynt_cw_limit', String(limit)); set({ continueWatchingLimit: limit }) },
  setWatchedCheckmarkSources: (sources) => {
    localStorage.setItem('orynt_watched_checkmark_sources', JSON.stringify(sources))
    set({ watchedCheckmarkSources: sources })
  },
  setWatchlistButtonTarget: (target) => { localStorage.setItem('orynt_watchlist_target', target); set({ watchlistButtonTarget: target }) },
  setPmdBApiKey: (key) => { localStorage.setItem('pmdb_api_key', key); set({ pmdbApiKey: key }) },
  setPmdBSaveResumePosition: (val) => { localStorage.setItem('pmdb_save_resume', String(val)); set({ pmdbSaveResumePosition: val }) },
  setPmdBSyncFrequency: (freq) => { localStorage.setItem('pmdb_sync_freq', freq); set({ pmdbSyncFrequency: freq }) },
  setPmdBLastSyncTime: (time) => { localStorage.setItem('pmdb_last_sync', time); set({ pmdbLastSyncTime: time }) },
  setTraktSaveResumePosition: (val) => { localStorage.setItem('trakt_save_resume', String(val)); set({ traktSaveResumePosition: val }) },
  setTraktSyncFrequency: (freq) => { localStorage.setItem('trakt_sync_freq', freq); set({ traktSyncFrequency: freq }) },
  setSimklSaveResumePosition: (val) => { localStorage.setItem('simkl_save_resume', String(val)); set({ simklSaveResumePosition: val }) },
  setSimklSyncFrequency: (freq) => { localStorage.setItem('simkl_sync_freq', freq); set({ simklSyncFrequency: freq }) },
  setAnilistSyncFrequency: (freq) => { localStorage.setItem('anilist_sync_freq', freq); set({ anilistSyncFrequency: freq }) },
  setIntrodbApiKey: (key) => { localStorage.setItem('introdb_api_key', key); set({ introdbApiKey: key }) },
  setAnimeTrackingProvider: (prov) => { localStorage.setItem('anime_tracking_provider', prov); set({ animeTrackingProvider: prov }) },
  setAnimeShowWatchedFrom: (watchedFrom) => { localStorage.setItem('anime_show_watched', watchedFrom); set({ animeShowWatchedFrom: watchedFrom }) },

  setBlurSpoilers: (val) => { localStorage.setItem('orynt_blur_spoilers', String(val)); set({ blurSpoilers: val }) },
  setBlurThumbnails: (val) => { localStorage.setItem('orynt_blur_thumbnails', String(val)); set({ blurThumbnails: val }) },
  setBlurTitles: (val) => { localStorage.setItem('orynt_blur_titles', String(val)); set({ blurTitles: val }) },
  setBlurDescriptions: (val) => { localStorage.setItem('orynt_blur_descriptions', String(val)); set({ blurDescriptions: val }) },
  setKeepNextEpisodeVisible: (val) => { localStorage.setItem('orynt_keep_next_episode_visible', String(val)); set({ keepNextEpisodeVisible: val }) },
  setKeepFramesFor: (val) => { localStorage.setItem('orynt_keep_frames_for', val); set({ keepFramesFor: val }) },
  setSavedFramesCount: (count) => { localStorage.setItem('orynt_saved_frames_count', String(count)); set({ savedFramesCount: count }) },
  setPosterSize: (size) => { localStorage.setItem('orynt_poster_size', size); set({ posterSize: size }) },
  setNextEpisodePrompt: (prompt) => { localStorage.setItem('orynt_next_episode_prompt', prompt); set({ nextEpisodePrompt: prompt }) },

  setAccentColor: (color) => { localStorage.setItem('orynt_accent_color', color); set({ accentColor: color }) },
  setDefaultStartPage: (page) => { localStorage.setItem('orynt_default_start_page', page); set({ defaultStartPage: page }) },
  setShowRatingsOnCards: (show) => { localStorage.setItem('orynt_show_ratings_on_cards', String(show)); set({ showRatingsOnCards: show }) },
  setDiscoveryRegion: (region) => { localStorage.setItem('orynt_discovery_region', region); set({ discoveryRegion: region }) },
  setDiscoveryMinRating: (rating) => { localStorage.setItem('orynt_discovery_min_rating', String(rating)); set({ discoveryMinRating: rating }) },
  setDiscoveryIncludeAdult: (include) => { localStorage.setItem('orynt_discovery_include_adult', String(include)); set({ discoveryIncludeAdult: include }) },
  setHwdecMode: (mode) => { localStorage.setItem('orynt_hwdec_mode', mode); set({ hwdecMode: mode }) },
  setIsolatedPlaybackMode: (value) => { localStorage.removeItem('orynt_isolated_playback'); set({ isolatedPlaybackMode: value }) },
  setIsolatedPlaybackHwdec: (mode) => { localStorage.setItem('orynt_isolated_hwdec', mode); set({ isolatedPlaybackHwdec: mode }) },
  setIsolatedPlaybackResume: (value) => { localStorage.setItem('orynt_isolated_resume', String(value)); set({ isolatedPlaybackResume: value }) },
  setCacheBufferSize: (size) => { localStorage.setItem('orynt_cache_buffer_size', size); set({ cacheBufferSize: size }) },
  setAudioPassthrough: (val) => { localStorage.setItem('orynt_audio_passthrough', String(val)); set({ audioPassthrough: val }) },
  setAutoSkipSegments: (val) => { localStorage.setItem('orynt_auto_skip_segments', String(val)); set({ autoSkipSegments: val }) },
  setSubtitleFontSize: (size) => { localStorage.setItem('orynt_sub_font_size', String(size)); set({ subtitleFontSize: size }) },
  setSubtitleBgOpacity: (opacity) => { localStorage.setItem('orynt_sub_bg_opacity', opacity); set({ subtitleBgOpacity: opacity }) },
  setVisibleHeroRatings: (ratings) => { localStorage.setItem('orynt_visible_hero_ratings', JSON.stringify(ratings)); set({ visibleHeroRatings: ratings }) },
  openrouterApiKey: localStorage.getItem('openrouter_api_key') || '',
  openrouterModel: localStorage.getItem('openrouter_model') || 'google/gemini-2.5-flash',
  setOpenrouterApiKey: (key) => { localStorage.setItem('openrouter_api_key', key); set({ openrouterApiKey: key }) },
  setOpenrouterModel: (model) => { localStorage.setItem('openrouter_model', model); set({ openrouterModel: model }) },

  mpvCacheSecs: Number(localStorage.getItem('orynt_mpv_cache_secs') || '60'),
  mpvNetworkTimeout: Number(localStorage.getItem('orynt_mpv_network_timeout') || '15'),
  mpvCustomArgs: localStorage.getItem('orynt_mpv_custom_args') || '',
  setMpvCacheSecs: (secs) => { localStorage.setItem('orynt_mpv_cache_secs', String(secs)); set({ mpvCacheSecs: secs }) },
  setMpvNetworkTimeout: (secs) => { localStorage.setItem('orynt_mpv_network_timeout', String(secs)); set({ mpvNetworkTimeout: secs }) },
  setMpvCustomArgs: (args) => { localStorage.setItem('orynt_mpv_custom_args', args); set({ mpvCustomArgs: args }) },
  resetPlayerSettings: () => {
    localStorage.setItem('orynt_hwdec_mode', 'auto')
    localStorage.setItem('orynt_cache_buffer_size', 'default')
    localStorage.setItem('orynt_mpv_cache_secs', '60')
    localStorage.setItem('orynt_mpv_network_timeout', '15')
    localStorage.setItem('orynt_mpv_custom_args', '')
    set({
      hwdecMode: 'auto',
      cacheBufferSize: 'default',
      mpvCacheSecs: 60,
      mpvNetworkTimeout: 15,
      mpvCustomArgs: ''
    })
  },

  movieMetadataSource: (localStorage.getItem('orynt_movie_meta_src') || 'tmdb') as 'tmdb' | 'tvdb',
  seriesMetadataSource: (localStorage.getItem('orynt_series_meta_src') || 'tvdb') as 'tvdb' | 'tmdb',
  animeMetadataSource: (localStorage.getItem('orynt_anime_meta_src') || 'tvdb') as 'anilist' | 'mal' | 'kitsu' | 'tvdb' | 'tmdb',
  movieMetadataFallback: false,
  seriesMetadataFallback: false,
  animeMetadataFallback: false,
  enableCommunityRatings: localStorage.getItem('orynt_community_ratings') !== 'false',
  appManagedMetadata: localStorage.getItem('orynt_app_managed_metadata') !== 'false',
  useAddonMetadataFallback: localStorage.getItem('orynt_addon_metadata_fallback') !== 'false',
  preferTvdbAnimeSeasons: localStorage.getItem('orynt_tvdb_anime_seasons') !== 'false',
  animeTitleLanguage: (localStorage.getItem('orynt_anime_title_language') || 'auto') as 'english' | 'romaji' | 'native' | 'auto',
  hideUnairedAnimeSeasons: localStorage.getItem('orynt_hide_unaired_anime_seasons') !== 'false',
  hideUnairedAnimeEpisodes: localStorage.getItem('orynt_hide_unaired_anime_eps') !== 'false',
  includeAnimeSpecials: localStorage.getItem('orynt_include_anime_specials') === 'true',
  ignoreAddonMetadataForAnime: localStorage.getItem('orynt_ignore_addon_meta_anime') !== 'false',
  useGenericAnimeSeasonLabels: localStorage.getItem('orynt_generic_anime_season_labels') !== 'false',
  avoidJapaneseSeasonNames: localStorage.getItem('orynt_avoid_jp_season_names') !== 'false',
  setMovieMetadataSource: (src) => { localStorage.setItem('orynt_movie_meta_src', src); set({ movieMetadataSource: src }); get().clearAnimeCache() },
  setSeriesMetadataSource: (src) => { localStorage.setItem('orynt_series_meta_src', src); set({ seriesMetadataSource: src }); get().clearAnimeCache() },
  setAnimeMetadataSource: (src) => { localStorage.setItem('orynt_anime_meta_src', src); set({ animeMetadataSource: src }); get().clearAnimeCache() },
  setMovieMetadataFallback: (val) => { localStorage.setItem('orynt_movie_meta_fb', String(val)); set({ movieMetadataFallback: val }); get().clearAnimeCache() },
  setSeriesMetadataFallback: (val) => { localStorage.setItem('orynt_series_meta_fb', String(val)); set({ seriesMetadataFallback: val }); get().clearAnimeCache() },
  setAnimeMetadataFallback: (val) => { localStorage.setItem('orynt_anime_meta_fb', String(val)); set({ animeMetadataFallback: val }); get().clearAnimeCache() },
  setEnableCommunityRatings: (val) => { localStorage.setItem('orynt_community_ratings', String(val)); set({ enableCommunityRatings: val }) },
  setAppManagedMetadata: (val) => { localStorage.setItem('orynt_app_managed_metadata', String(val)); set({ appManagedMetadata: val }) },
  setUseAddonMetadataFallback: (val) => { localStorage.setItem('orynt_addon_metadata_fallback', String(val)); set({ useAddonMetadataFallback: val }) },
  setPreferTvdbAnimeSeasons: (val) => { localStorage.setItem('orynt_tvdb_anime_seasons', String(val)); set({ preferTvdbAnimeSeasons: val }); get().clearAnimeCache() },
  setAnimeTitleLanguage: (val) => { localStorage.setItem('orynt_anime_title_language', val); set({ animeTitleLanguage: val }); get().clearAnimeCache() },
  setHideUnairedAnimeSeasons: (val) => { localStorage.setItem('orynt_hide_unaired_anime_seasons', String(val)); set({ hideUnairedAnimeSeasons: val }); get().clearAnimeCache() },
  setHideUnairedAnimeEpisodes: (val) => { localStorage.setItem('orynt_hide_unaired_anime_eps', String(val)); set({ hideUnairedAnimeEpisodes: val }); get().clearAnimeCache() },
  setIncludeAnimeSpecials: (val) => { localStorage.setItem('orynt_include_anime_specials', String(val)); set({ includeAnimeSpecials: val }); get().clearAnimeCache() },
  setIgnoreAddonMetadataForAnime: (val) => { localStorage.setItem('orynt_ignore_addon_meta_anime', String(val)); set({ ignoreAddonMetadataForAnime: val }) },
  setUseGenericAnimeSeasonLabels: (val) => { localStorage.setItem('orynt_generic_anime_season_labels', String(val)); set({ useGenericAnimeSeasonLabels: val }); get().clearAnimeCache() },
  setAvoidJapaneseSeasonNames: (val) => { localStorage.setItem('orynt_avoid_jp_season_names', String(val)); set({ avoidJapaneseSeasonNames: val }); get().clearAnimeCache() },
  clearAnimeCache: async () => {
    try {
      const { clearAnimeMetadataCache } = await import('../services/metadata/metadataResolver')
      await clearAnimeMetadataCache()
    } catch (e) { console.warn('[appStore] clearAnimeCache failed:', e) }
  },

  movieSearchEngine: localStorage.getItem('orynt_movie_search_engine') || 'tmdb',
  seriesSearchEngine: localStorage.getItem('orynt_series_search_engine') || 'tvdb',
  animeSeriesSearchEngine: localStorage.getItem('orynt_anime_series_search_engine') || 'mal',
  animeMovieSearchEngine: localStorage.getItem('orynt_anime_movie_search_engine') || 'mal',
  movieSearchEnabled: localStorage.getItem('orynt_movie_search_enabled') !== 'false',
  seriesSearchEnabled: localStorage.getItem('orynt_series_search_enabled') !== 'false',
  animeSeriesSearchEnabled: localStorage.getItem('orynt_anime_series_search_enabled') !== 'false',
  animeMovieSearchEnabled: localStorage.getItem('orynt_anime_movie_search_enabled') !== 'false',
  setMovieSearchEngine: (engine) => { localStorage.setItem('orynt_movie_search_engine', engine); set({ movieSearchEngine: engine }) },
  setSeriesSearchEngine: (engine) => { localStorage.setItem('orynt_series_search_engine', engine); set({ seriesSearchEngine: engine }) },
  setAnimeSeriesSearchEngine: (engine) => { localStorage.setItem('orynt_anime_series_search_engine', engine); set({ animeSeriesSearchEngine: engine }) },
  setAnimeMovieSearchEngine: (engine) => { localStorage.setItem('orynt_anime_movie_search_engine', engine); set({ animeMovieSearchEngine: engine }) },
  setMovieSearchEnabled: (val) => { localStorage.setItem('orynt_movie_search_enabled', String(val)); set({ movieSearchEnabled: val }) },
  setSeriesSearchEnabled: (val) => { localStorage.setItem('orynt_series_search_enabled', String(val)); set({ seriesSearchEnabled: val }) },
  setAnimeSeriesSearchEnabled: (val) => { localStorage.setItem('orynt_anime_series_search_enabled', String(val)); set({ animeSeriesSearchEnabled: val }) },
  setAnimeMovieSearchEnabled: (val) => { localStorage.setItem('orynt_anime_movie_search_enabled', String(val)); set({ animeMovieSearchEnabled: val }) },

  discordRichPresence: localStorage.getItem('orynt_discord_rpc') !== 'false',
  setDiscordRichPresence: (enabled) => { localStorage.setItem('orynt_discord_rpc', String(enabled)); set({ discordRichPresence: enabled }) },

  subtitleTranslationLang: localStorage.getItem('orynt_sub_translation_lang') || '',
  subtitleTranslationEnabled: localStorage.getItem('orynt_sub_translation_enabled') === 'true',
  translationCuesAhead: Number(localStorage.getItem('orynt_translation_cues_ahead') || '10'),
  contextAwareTranslation: localStorage.getItem('orynt_context_aware_translation') !== 'false',
  setSubtitleTranslationLang: (lang) => { localStorage.setItem('orynt_sub_translation_lang', lang); set({ subtitleTranslationLang: lang }) },
  setSubtitleTranslationEnabled: (enabled) => { localStorage.setItem('orynt_sub_translation_enabled', String(enabled)); set({ subtitleTranslationEnabled: enabled }) },
  setTranslationCuesAhead: (n) => { localStorage.setItem('orynt_translation_cues_ahead', String(n)); set({ translationCuesAhead: n }) },
  setContextAwareTranslation: (val) => { localStorage.setItem('orynt_context_aware_translation', String(val)); set({ contextAwareTranslation: val }) },
}))
