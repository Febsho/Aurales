import { create } from 'zustand'
import type { HomeRowConfig, WatchProgress, SearchResult, TraktAccount } from '../types'
import type { InstalledAddon } from '../services/addons'
import type { SimklAccount } from '../services/simkl/types'
import type { AniListAccount } from '../services/anilist'
import { clearContinueWatchingSnapshotsForSource, rotateProviderCredentialScope } from '../services/cache/homeStartupSnapshot'
import { buildDefaultHomeRows } from '../data/defaultHomeRows'
import { v4 as uuid } from 'uuid'
import { cacheClearCategory } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { loadInterfaceTheme, persistInterfaceTheme, type InterfaceTheme } from '../services/interfaceTheme'

function invalidateCatalogData(): void {
  ;[
    CACHE_CATEGORIES.ADDON_CATALOG, CACHE_CATEGORIES.PROVIDER_LIST, CACHE_CATEGORIES.DISCOVER,
    CACHE_CATEGORIES.HOME_ROW, CACHE_CATEGORIES.TMDB_CARD, CACHE_CATEGORIES.TVDB_CARD, CACHE_CATEGORIES.ARTWORK,
    CACHE_CATEGORIES.DETAIL_PAGE,
  ].forEach((category) => { cacheClearCategory(category).catch(() => {}) })
}

type ProgressProvider = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist'

export type ArtProvider = 'tmdb' | 'tvdb' | 'fanart'
export type HomeHeroMode = 'dynamic' | 'fixed' | 'disabled'
export type FixedHeroSource = 'automatic' | 'trending' | 'recommended' | 'continue-watching' | 'recently-added' | 'manual'

export interface ArtProviderSettings {
  moviePoster: ArtProvider
  movieBackdrop: ArtProvider
  movieLogo: ArtProvider
  seriesPoster: ArtProvider
  seriesBackdrop: ArtProvider
  seriesLogo: ArtProvider
  animePoster: ArtProvider
  animeBackdrop: ArtProvider
  animeLogo: ArtProvider
}

export interface CustomArtUrls {
  posterUrl: string
  backdropUrl: string
  logoUrl: string
  episodeThumbnailUrl: string
}

const DEFAULT_ART_PROVIDERS: ArtProviderSettings = {
  moviePoster: 'tmdb', movieBackdrop: 'tmdb', movieLogo: 'tmdb',
  seriesPoster: 'tmdb', seriesBackdrop: 'tmdb', seriesLogo: 'tmdb',
  animePoster: 'tmdb', animeBackdrop: 'tmdb', animeLogo: 'tmdb',
}

function normalizeArtProviderSettings(value: unknown): ArtProviderSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof ArtProviderSettings, string>>
  const normalize = (provider?: string): ArtProvider =>
    provider === 'tvdb' || provider === 'fanart' ? provider : 'tmdb'
  return {
    moviePoster: normalize(raw.moviePoster),
    movieBackdrop: normalize(raw.movieBackdrop),
    movieLogo: normalize(raw.movieLogo),
    seriesPoster: normalize(raw.seriesPoster),
    seriesBackdrop: normalize(raw.seriesBackdrop),
    seriesLogo: normalize(raw.seriesLogo),
    animePoster: normalize(raw.animePoster),
    animeBackdrop: normalize(raw.animeBackdrop),
    animeLogo: normalize(raw.animeLogo),
  }
}

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
  scrobbleMdblist: boolean
  scrobbleAnilist: boolean
  setScrobbleSimkl: (enabled: boolean) => void
  setScrobbleTrakt: (enabled: boolean) => void
  setScrobblePmdb: (enabled: boolean) => void
  setScrobbleMdblist: (enabled: boolean) => void
  setScrobbleAnilist: (enabled: boolean) => void

  // Simkl
  simklConnected: boolean
  simklAccount: SimklAccount | null
  setSimklConnected: (connected: boolean) => void
  setSimklAccount: (account: SimklAccount | null) => void

  // AniList
  anilistConnected: boolean
  anilistAccount: AniListAccount | null
  setAnilistConnected: (connected: boolean) => void
  setAnilistAccount: (account: AniListAccount | null) => void

  // Addons
  addons: InstalledAddon[]
  setAddons: (addons: InstalledAddon[]) => void
  addAddon: (addon: InstalledAddon) => void
  removeAddon: (addonId: string) => void
  renameAddon: (addonId: string, displayName: string) => void

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
  completedIds: Set<string>
  setWatchProgress: (id: string, progress: WatchProgress) => void
  removeWatchProgress: (mediaIds: string[], season?: number, episode?: number) => void

  // Recently watched
  recentlyWatched: SearchResult[]
  addRecentlyWatched: (item: SearchResult) => void

  preferredSubtitles: string[]
  preferredAudio: string[]
  setPreferredSubtitles: (langs: string[]) => void
  setPreferredAudio: (langs: string[]) => void

  continueWatchingSource: ProgressProvider
  continueWatchingLimit: number
  watchedCheckmarkSources: ProgressProvider[]
  pmdbApiKey: string
  pmdbSaveResumePosition: boolean
  mdblistSaveResumePosition: boolean
  mdblistSyncFrequency: string
  mdblistLastSyncTime: string
  pmdbSyncFrequency: string
  pmdbLastSyncTime: string
  traktSaveResumePosition: boolean
  traktSyncFrequency: string
  simklSaveResumePosition: boolean
  simklSyncFrequency: string
  anilistSyncFrequency: string
  introdbApiKey: string
  animeTrackingProvider: 'anilist' | 'simkl' | 'trakt' | 'local'
  resumePriorityOrder: ProgressProvider[]

  setContinueWatchingSource: (src: ProgressProvider) => void
  setContinueWatchingLimit: (limit: number) => void
  setResumePriorityOrder: (order: ProgressProvider[]) => void
  setWatchedCheckmarkSources: (sources: ProgressProvider[]) => void
  setPmdBApiKey: (key: string) => void
  setPmdBSaveResumePosition: (val: boolean) => void
  setMdblistSaveResumePosition: (val: boolean) => void
  setMdblistSyncFrequency: (freq: string) => void
  setMdblistLastSyncTime: (time: string) => void
  setPmdBSyncFrequency: (freq: string) => void
  setPmdBLastSyncTime: (time: string) => void
  setTraktSaveResumePosition: (val: boolean) => void
  setTraktSyncFrequency: (freq: string) => void
  setSimklSaveResumePosition: (val: boolean) => void
  setSimklSyncFrequency: (freq: string) => void
  setAnilistSyncFrequency: (freq: string) => void
  setIntrodbApiKey: (key: string) => void
  setAnimeTrackingProvider: (prov: 'anilist' | 'simkl' | 'trakt' | 'local') => void

  // Library & Spoilers
  blurSpoilers: boolean
  blurThumbnails: boolean
  blurTitles: boolean
  blurDescriptions: boolean
  keepNextEpisodeVisible: boolean

  setBlurSpoilers: (val: boolean) => void
  setBlurThumbnails: (val: boolean) => void
  setBlurTitles: (val: boolean) => void
  setBlurDescriptions: (val: boolean) => void
  setKeepNextEpisodeVisible: (val: boolean) => void

  posterSize: 'compact' | 'default' | 'large' | 'huge'
  nextEpisodePrompt: 'auto' | 'off' | '30s' | '45s' | '1m' | '1.5m' | '2m'
  heroTrailerDelay: number
  homeHeroMode: HomeHeroMode
  fixedHeroSource: FixedHeroSource
  fixedHeroManualItem: SearchResult | null
  setPosterSize: (size: 'compact' | 'default' | 'large' | 'huge') => void
  setNextEpisodePrompt: (prompt: 'auto' | 'off' | '30s' | '45s' | '1m' | '1.5m' | '2m') => void
  setHeroTrailerDelay: (seconds: number) => void
  setHomeHeroMode: (mode: HomeHeroMode) => void
  setFixedHeroSource: (source: FixedHeroSource) => void
  setFixedHeroManualItem: (item: SearchResult | null) => void

  // New settings options
  accentColor: 'green' | 'purple' | 'blue' | 'red' | 'orange' | 'pink' | 'white'
  interfaceTheme: InterfaceTheme
  themeBackground: 'theme' | 'oled'
  navigationStyle: 'sidebar' | 'topbar'
  defaultStartPage: 'home' | 'discover' | 'collections' | 'search'
  showRatingsOnCards: boolean
  showGenreOnCards: boolean
  posterTrailerPreviews: boolean
  posterTrailerHoverDelayMs: number
  posterTrailerSound: boolean
  trailerVolume: number
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
  autoPlayFirstStream: boolean
  preloadPlaybackSources: boolean
  subtitleFontSize: number
  subtitleBgOpacity: string
  subtitleColor: string
  subtitleBorderStyle: 'outline' | 'shadow' | 'none'
  subtitlePreset: 'standard' | 'boxed' | 'classic' | 'minimal' | 'bold' | 'custom'
  subtitleScale: number
  subtitleBold: boolean
  subtitleItalic: boolean
  subtitleOutlineColor: string
  subtitleBgColor: string
  subtitleOutlineThickness: number
  subtitleShadowOffset: number
  subtitleShadowOpacity: number
  subtitleVerticalPosition: number
  subtitleAlignment: 'left' | 'center' | 'right'
  subtitleHorizontalMargin: number
  subtitleTextBlur: number
  subtitleScaleWithWindow: boolean
  subtitleAssOverride: 'apply' | 'scale_only' | 'ignore'
  visibleHeroRatings: string[]
  fanartApiKey: string
  setFanartApiKey: (key: string) => void
  openrouterApiKey: string
  openrouterModel: string

  // Art providers
  artProviders: ArtProviderSettings
  setArtProviders: (providers: ArtProviderSettings) => void
  customArtUrls: CustomArtUrls
  setCustomArtUrls: (urls: CustomArtUrls) => void
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
  setInterfaceTheme: (theme: InterfaceTheme) => void
  setThemeBackground: (bg: 'theme' | 'oled') => void
  setNavigationStyle: (style: 'sidebar' | 'topbar') => void
  setDefaultStartPage: (page: 'home' | 'discover' | 'collections' | 'search') => void
  setShowRatingsOnCards: (show: boolean) => void
  setShowGenreOnCards: (show: boolean) => void
  setPosterTrailerPreviews: (show: boolean) => void
  setPosterTrailerHoverDelayMs: (delayMs: number) => void
  setPosterTrailerSound: (sound: boolean) => void
  setTrailerVolume: (volume: number) => void
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
  setAutoPlayFirstStream: (val: boolean) => void
  setPreloadPlaybackSources: (val: boolean) => void
  setSubtitleFontSize: (size: number) => void
  setSubtitleBgOpacity: (opacity: string) => void
  setSubtitleColor: (color: string) => void
  setSubtitleBorderStyle: (style: 'outline' | 'shadow' | 'none') => void
  setSubtitlePreset: (preset: 'standard' | 'boxed' | 'classic' | 'minimal' | 'bold' | 'custom') => void
  setSubtitleScale: (scale: number) => void
  setSubtitleBold: (bold: boolean) => void
  setSubtitleItalic: (italic: boolean) => void
  setSubtitleOutlineColor: (color: string) => void
  setSubtitleBgColor: (color: string) => void
  setSubtitleOutlineThickness: (thickness: number) => void
  setSubtitleShadowOffset: (offset: number) => void
  setSubtitleShadowOpacity: (opacity: number) => void
  setSubtitleVerticalPosition: (pos: number) => void
  setSubtitleAlignment: (align: 'left' | 'center' | 'right') => void
  setSubtitleHorizontalMargin: (margin: number) => void
  setSubtitleTextBlur: (blur: number) => void
  setSubtitleScaleWithWindow: (scale: boolean) => void
  setSubtitleAssOverride: (override: 'apply' | 'scale_only' | 'ignore') => void
  resetSubtitleSettings: () => void
  setVisibleHeroRatings: (ratings: string[]) => void
  setOpenrouterApiKey: (key: string) => void
  setOpenrouterModel: (model: string) => void

  mpvCacheSecs: number
  mpvNetworkTimeout: number
  mpvCustomArgs: string
  seekStepSeconds: number
  setMpvCacheSecs: (secs: number) => void
  setMpvNetworkTimeout: (secs: number) => void
  setMpvCustomArgs: (args: string) => void
  setSeekStepSeconds: (secs: number) => void
  resetPlayerSettings: () => void

  // Image cache settings
  imageQuality: 'data-saver' | 'balanced' | 'high'
  imageCacheSizeMb: number
  imageKeepDays: number
  setImageQuality: (q: 'data-saver' | 'balanced' | 'high') => void
  setImageCacheSizeMb: (mb: number) => void
  setImageKeepDays: (days: number) => void
}

function loadPersistedAddons(): InstalledAddon[] {
  try {
    const raw = localStorage.getItem('aurales_addons')
    if (raw) return JSON.parse(raw)
  } catch (_) { /* ignore */ }
  return []
}

function persistAddons(addons: InstalledAddon[]): void {
  localStorage.setItem('aurales_addons', JSON.stringify(addons))
}

function loadPersistedHomeRows(): HomeRowConfig[] | null {
  try {
    const raw = localStorage.getItem('aurales_home_rows')
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
  localStorage.setItem('aurales_home_rows', JSON.stringify(rows))
}

function loadPersistedWatchProgress(): Map<string, WatchProgress> {
  try {
    const raw = localStorage.getItem('aurales_watch_progress')
    if (raw) {
      const parsed = JSON.parse(raw)
      return new Map(Object.entries(parsed))
    }
  } catch (_) { /* ignore */ }
  return new Map()
}

function buildCompletedIds(map: Map<string, WatchProgress>): Set<string> {
  const ids = new Set<string>()
  for (const [key, p] of map) {
    if (!p.completed) continue
    ids.add(key)
    if (p.mediaId) ids.add(String(p.mediaId))
    if (p.imdbId) ids.add(String(p.imdbId))
  }
  return ids
}

function persistWatchProgress(map: Map<string, WatchProgress>): void {
  try {
    const obj = Object.fromEntries(map.entries())
    localStorage.setItem('aurales_watch_progress', JSON.stringify(obj))
  } catch (_) { /* ignore */ }
}

function loadPersistedPreferredSubtitles(): string[] {
  try {
    const raw = localStorage.getItem('aurales_preferred_subtitles')
    if (raw) return JSON.parse(raw)
  } catch (_) { /* ignore */ }
  return ['en']
}

function loadPersistedPreferredAudio(): string[] {
  try {
    const raw = localStorage.getItem('aurales_preferred_audio')
    if (raw) return JSON.parse(raw)
  } catch (_) { /* ignore */ }
  return ['en', 'ja']
}

function loadRecentlyViewed(): SearchResult[] {
  try {
    const raw = localStorage.getItem('aurales_recently_viewed')
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

const DEFAULT_HOME_ROWS: HomeRowConfig[] = buildDefaultHomeRows()

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
  setTmdbApiKey: (key) => { localStorage.setItem('tmdb_api_key', key); invalidateCatalogData(); set({ tmdbApiKey: key }) },
  setTvdbApiKey: (key) => { localStorage.setItem('tvdb_api_key', key); invalidateCatalogData(); set({ tvdbApiKey: key }) },
  setTraktClientId: (key) => { localStorage.setItem('trakt_client_id', key); set({ traktClientId: key }) },
  setTraktClientSecret: (key) => { localStorage.setItem('trakt_client_secret', key); set({ traktClientSecret: key }) },
  setTraktConnected: (connected) => {
    invalidateCatalogData()
    if (!connected) clearContinueWatchingSnapshotsForSource('trakt')
    set({ traktConnected: connected })
  },
  setTraktAccount: (account) => {
    const previous = get().traktAccount
    if (previous?.username && previous.username !== account?.username) clearContinueWatchingSnapshotsForSource('trakt')
    if (account) localStorage.setItem('trakt_account', JSON.stringify(account))
    else localStorage.removeItem('trakt_account')
    set({ traktAccount: account })
  },
  setMdblistApiKey: (key) => {
    const changed = get().mdblistApiKey !== key
    localStorage.setItem('mdblist_api_key', key)
    if (changed) rotateProviderCredentialScope('mdblist', Boolean(key || localStorage.getItem('mdblist_oauth_tokens')))
    set({ mdblistApiKey: key })
  },

  scrobbleSimkl: localStorage.getItem('scrobble_simkl') !== 'false',
  scrobbleTrakt: localStorage.getItem('scrobble_trakt') !== 'false',
  scrobblePmdb: localStorage.getItem('scrobble_pmdb') !== 'false',
  scrobbleMdblist: localStorage.getItem('scrobble_mdblist') !== 'false',
  scrobbleAnilist: localStorage.getItem('scrobble_anilist') !== 'false',
  setScrobbleSimkl: (enabled) => { localStorage.setItem('scrobble_simkl', String(enabled)); set({ scrobbleSimkl: enabled }) },
  setScrobbleTrakt: (enabled) => { localStorage.setItem('scrobble_trakt', String(enabled)); set({ scrobbleTrakt: enabled }) },
  setScrobblePmdb: (enabled) => { localStorage.setItem('scrobble_pmdb', String(enabled)); set({ scrobblePmdb: enabled }) },
  setScrobbleMdblist: (enabled) => { localStorage.setItem('scrobble_mdblist', String(enabled)); set({ scrobbleMdblist: enabled }) },
  setScrobbleAnilist: (enabled) => { localStorage.setItem('scrobble_anilist', String(enabled)); set({ scrobbleAnilist: enabled }) },

  simklConnected: !!localStorage.getItem('simkl_token'),
  simklAccount: (() => {
    try {
      const raw = localStorage.getItem('simkl_account')
      return raw ? JSON.parse(raw) as SimklAccount : null
    } catch (_) { return null }
  })(),
  setSimklConnected: (connected) => {
    invalidateCatalogData()
    if (!connected) clearContinueWatchingSnapshotsForSource('simkl')
    set({ simklConnected: connected })
  },
  setSimklAccount: (account) => {
    const previous = get().simklAccount
    if (previous?.id && previous.id !== account?.id) clearContinueWatchingSnapshotsForSource('simkl')
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
  setAnilistConnected: (connected) => {
    invalidateCatalogData()
    if (!connected) clearContinueWatchingSnapshotsForSource('anilist')
    set({ anilistConnected: connected })
  },
  setAnilistAccount: (account) => {
    const previous = get().anilistAccount
    if (previous?.id && previous.id !== account?.id) clearContinueWatchingSnapshotsForSource('anilist')
    if (account) localStorage.setItem('anilist_account', JSON.stringify(account))
    else localStorage.removeItem('anilist_account')
    set({ anilistAccount: account })
  },

  addons: loadPersistedAddons(),
  setAddons: (addons) => { persistAddons(addons); invalidateCatalogData(); set({ addons }) },
  addAddon: (addon) => set((s) => {
    invalidateCatalogData()
    const next = [...s.addons, addon]
    persistAddons(next)
    return { addons: next }
  }),
  removeAddon: (addonId) => set((s) => {
    invalidateCatalogData()
    const next = s.addons.filter((a) => a.manifest.id !== addonId)
    persistAddons(next)
    return { addons: next }
  }),
  renameAddon: (addonId, displayName) => set((s) => {
    const next = s.addons.map((addon) => addon.manifest.id === addonId
      ? { ...addon, displayName: displayName.trim() || undefined }
      : addon)
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
  completedIds: buildCompletedIds(loadPersistedWatchProgress()),
  setWatchProgress: (id, progress) => set((s) => {
    const map = new Map(s.watchProgress)
    map.set(id, progress)
    persistWatchProgress(map)
    return { watchProgress: map, completedIds: buildCompletedIds(map) }
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
    return { watchProgress: map, completedIds: buildCompletedIds(map) }
  }),

  recentlyWatched: loadRecentlyViewed(),
  addRecentlyWatched: (item) => set((s) => {
    const next = [item, ...s.recentlyWatched.filter((r) => r.id !== item.id)].slice(0, 30)
    localStorage.setItem('aurales_recently_viewed', JSON.stringify(next))
    return { recentlyWatched: next }
  }),

  preferredSubtitles: loadPersistedPreferredSubtitles(),
  preferredAudio: loadPersistedPreferredAudio(),
  setPreferredSubtitles: (langs) => {
    localStorage.setItem('aurales_preferred_subtitles', JSON.stringify(langs))
    const updates: Partial<AppState> = { preferredSubtitles: langs }
    if (!localStorage.getItem('aurales_sub_translation_lang') && langs[0]) {
      updates.subtitleTranslationLang = langs[0]
    }
    set(updates)
  },
  setPreferredAudio: (langs) => {
    localStorage.setItem('aurales_preferred_audio', JSON.stringify(langs))
    set({ preferredAudio: langs })
  },

  continueWatchingSource: (localStorage.getItem('aurales_cw_source') || 'local') as ProgressProvider,
  continueWatchingLimit: Number(localStorage.getItem('aurales_cw_limit') || '10'),
  watchedCheckmarkSources: (() => {
    try {
      const raw = localStorage.getItem('aurales_watched_checkmark_sources')
      if (raw) return JSON.parse(raw) as ProgressProvider[]
    } catch (_) { /* ignore */ }
    return ['local'] as ProgressProvider[]
  })(),
  pmdbApiKey: localStorage.getItem('pmdb_api_key') || '',
  pmdbSaveResumePosition: localStorage.getItem('pmdb_save_resume') !== 'false',
  mdblistSaveResumePosition: localStorage.getItem('mdblist_save_resume') !== 'false',
  mdblistSyncFrequency: localStorage.getItem('mdblist_sync_freq') || 'every_5',
  mdblistLastSyncTime: localStorage.getItem('mdblist_last_sync') || '',
  pmdbSyncFrequency: localStorage.getItem('pmdb_sync_freq') || 'every_minute',
  pmdbLastSyncTime: localStorage.getItem('pmdb_last_sync') || '',
  traktSaveResumePosition: localStorage.getItem('trakt_save_resume') !== 'false',
  traktSyncFrequency: localStorage.getItem('trakt_sync_freq') || 'every_5',
  simklSaveResumePosition: localStorage.getItem('simkl_save_resume') !== 'false',
  simklSyncFrequency: localStorage.getItem('simkl_sync_freq') || 'every_5',
  anilistSyncFrequency: localStorage.getItem('anilist_sync_freq') || 'every_5',
  introdbApiKey: localStorage.getItem('introdb_api_key') || '',
  animeTrackingProvider: (localStorage.getItem('anime_tracking_provider') || 'anilist') as 'anilist' | 'simkl' | 'trakt' | 'local',

  blurSpoilers: localStorage.getItem('aurales_blur_spoilers') === 'true',
  blurThumbnails: localStorage.getItem('aurales_blur_thumbnails') !== 'false',
  blurTitles: localStorage.getItem('aurales_blur_titles') !== 'false',
  blurDescriptions: localStorage.getItem('aurales_blur_descriptions') !== 'false',
  keepNextEpisodeVisible: localStorage.getItem('aurales_keep_next_episode_visible') === 'true',
  posterSize: (localStorage.getItem('aurales_poster_size') || 'default') as 'compact' | 'default' | 'large' | 'huge',
  nextEpisodePrompt: (localStorage.getItem('aurales_next_episode_prompt') || 'auto') as 'auto' | 'off' | '30s' | '45s' | '1m' | '1.5m' | '2m',
  heroTrailerDelay: Number(localStorage.getItem('aurales_hero_trailer_delay') || '3'),
  homeHeroMode: (localStorage.getItem('aurales_home_hero_mode') || 'dynamic') as HomeHeroMode,
  fixedHeroSource: (localStorage.getItem('aurales_fixed_hero_source') || 'automatic') as FixedHeroSource,
  fixedHeroManualItem: (() => {
    try { return JSON.parse(localStorage.getItem('aurales_fixed_hero_manual_item') || 'null') as SearchResult | null }
    catch { return null }
  })(),
  resumePriorityOrder: (() => {
    try {
      const raw = localStorage.getItem('aurales_resume_priority')
      if (raw) return JSON.parse(raw) as ProgressProvider[]
    } catch (_) { /* ignore */ }
    return ['local', 'simkl', 'trakt', 'pmdb', 'mdblist'] as ProgressProvider[]
  })(),

  // New settings options initial values
  accentColor: (localStorage.getItem('aurales_accent_color') || 'white') as 'green' | 'purple' | 'blue' | 'red' | 'orange' | 'pink' | 'white',
  interfaceTheme: loadInterfaceTheme(),
  themeBackground: (localStorage.getItem('aurales_theme_background') || 'theme') as 'theme' | 'oled',
  navigationStyle: (localStorage.getItem('aurales_navigation_style') || (loadInterfaceTheme() === 'cinematic' ? 'topbar' : 'sidebar')) as 'sidebar' | 'topbar',
  defaultStartPage: (localStorage.getItem('aurales_default_start_page') || 'home') as 'home' | 'discover' | 'collections' | 'search',
  showRatingsOnCards: localStorage.getItem('aurales_show_ratings_on_cards') === 'true',
  showGenreOnCards: localStorage.getItem('aurales_show_genre_on_cards') === 'true',
  posterTrailerPreviews: localStorage.getItem('aurales_poster_trailer_previews') !== 'false',
  posterTrailerHoverDelayMs: (() => {
    const delayMs = Number(localStorage.getItem('aurales_poster_trailer_hover_delay_ms') || '2000')
    return [0, 250, 500, 750, 1000, 1500, 2000].includes(delayMs) ? delayMs : 2000
  })(),
  posterTrailerSound: localStorage.getItem('aurales_poster_trailer_sound') !== 'false',
  trailerVolume: (() => {
    const volume = Number(localStorage.getItem('aurales_trailer_volume') || '50')
    return Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 50
  })(),
  discoveryRegion: localStorage.getItem('aurales_discovery_region') || 'US',
  discoveryMinRating: Number(localStorage.getItem('aurales_discovery_min_rating') || '6'),
  discoveryIncludeAdult: localStorage.getItem('aurales_discovery_include_adult') === 'true',
  hwdecMode: (localStorage.getItem('aurales_hwdec_mode') || 'auto') as 'auto' | 'no' | 'nvdec' | 'vaapi' | 'videotoolbox',
  isolatedPlaybackMode: false,
  isolatedPlaybackHwdec: (localStorage.getItem('aurales_isolated_hwdec') || 'auto-safe') as 'auto-safe' | 'no',
  isolatedPlaybackResume: localStorage.getItem('aurales_isolated_resume') === 'true',
  cacheBufferSize: (localStorage.getItem('aurales_cache_buffer_size') || 'default') as 'default' | 'large' | 'aggressive',
  audioPassthrough: localStorage.getItem('aurales_audio_passthrough') === 'true',
  autoSkipSegments: localStorage.getItem('aurales_auto_skip_segments') === 'true',
  autoPlayFirstStream: localStorage.getItem('aurales_auto_play_first_stream') === 'true',
  preloadPlaybackSources: localStorage.getItem('aurales_preload_playback_sources') === 'true',
  subtitleFontSize: Number(localStorage.getItem('aurales_sub_font_size') || '24'),
  subtitleBgOpacity: localStorage.getItem('aurales_sub_bg_opacity') || '0',
  subtitleColor: localStorage.getItem('aurales_sub_color') || '#FFFFFF',
  subtitleBorderStyle: (localStorage.getItem('aurales_sub_border_style') as 'outline' | 'shadow' | 'none') || 'outline',
  subtitlePreset: (localStorage.getItem('aurales_sub_preset') as any) || 'standard',
  subtitleScale: Number(localStorage.getItem('aurales_sub_scale') || '1.0'),
  subtitleBold: localStorage.getItem('aurales_sub_bold') === 'true',
  subtitleItalic: localStorage.getItem('aurales_sub_italic') === 'true',
  subtitleOutlineColor: localStorage.getItem('aurales_sub_outline_color') || '#000000',
  subtitleBgColor: localStorage.getItem('aurales_sub_bg_color') || '#000000',
  subtitleOutlineThickness: Number(localStorage.getItem('aurales_sub_outline_thickness') || '1.4'),
  subtitleShadowOffset: Number(localStorage.getItem('aurales_sub_shadow_offset') || '1.0'),
  subtitleShadowOpacity: Number(localStorage.getItem('aurales_sub_shadow_opacity') || '0.5'),
  subtitleVerticalPosition: Number(localStorage.getItem('aurales_sub_vertical_position') || '100'),
  subtitleAlignment: (localStorage.getItem('aurales_sub_alignment') as any) || 'center',
  subtitleHorizontalMargin: Number(localStorage.getItem('aurales_sub_horizontal_margin') || '19'),
  subtitleTextBlur: Number(localStorage.getItem('aurales_sub_text_blur') || '0.0'),
  subtitleScaleWithWindow: localStorage.getItem('aurales_sub_scale_with_window') !== 'false',
  subtitleAssOverride: (localStorage.getItem('aurales_sub_ass_override') as any) || 'scale_only',
  visibleHeroRatings: (() => {
    try {
      const raw = localStorage.getItem('aurales_visible_hero_ratings')
      if (raw) return JSON.parse(raw) as string[]
    } catch (_) { /* ignore */ }
    return ['imdb', 'rottentomatoes', 'tomatoesaudience', 'metacritic', 'tmdb', 'trakt', 'letterboxd', 'myanimelist']
  })(),

  setContinueWatchingSource: (src) => { localStorage.setItem('aurales_cw_source', src); set({ continueWatchingSource: src }) },
  setContinueWatchingLimit: (limit) => { localStorage.setItem('aurales_cw_limit', String(limit)); set({ continueWatchingLimit: limit }) },
  setWatchedCheckmarkSources: (sources) => {
    localStorage.setItem('aurales_watched_checkmark_sources', JSON.stringify(sources))
    set({ watchedCheckmarkSources: sources })
  },
  setPmdBApiKey: (key) => {
    const changed = get().pmdbApiKey !== key
    localStorage.setItem('pmdb_api_key', key)
    if (changed) rotateProviderCredentialScope('pmdb', Boolean(key))
    set({ pmdbApiKey: key })
  },
  setPmdBSaveResumePosition: (val) => { localStorage.setItem('pmdb_save_resume', String(val)); set({ pmdbSaveResumePosition: val }) },
  setMdblistSaveResumePosition: (val) => { localStorage.setItem('mdblist_save_resume', String(val)); set({ mdblistSaveResumePosition: val }) },
  setMdblistSyncFrequency: (freq) => { localStorage.setItem('mdblist_sync_freq', freq); set({ mdblistSyncFrequency: freq }) },
  setMdblistLastSyncTime: (time) => { localStorage.setItem('mdblist_last_sync', time); set({ mdblistLastSyncTime: time }) },
  setPmdBSyncFrequency: (freq) => { localStorage.setItem('pmdb_sync_freq', freq); set({ pmdbSyncFrequency: freq }) },
  setPmdBLastSyncTime: (time) => { localStorage.setItem('pmdb_last_sync', time); set({ pmdbLastSyncTime: time }) },
  setTraktSaveResumePosition: (val) => { localStorage.setItem('trakt_save_resume', String(val)); set({ traktSaveResumePosition: val }) },
  setTraktSyncFrequency: (freq) => { localStorage.setItem('trakt_sync_freq', freq); set({ traktSyncFrequency: freq }) },
  setSimklSaveResumePosition: (val) => { localStorage.setItem('simkl_save_resume', String(val)); set({ simklSaveResumePosition: val }) },
  setSimklSyncFrequency: (freq) => { localStorage.setItem('simkl_sync_freq', freq); set({ simklSyncFrequency: freq }) },
  setAnilistSyncFrequency: (freq) => { localStorage.setItem('anilist_sync_freq', freq); set({ anilistSyncFrequency: freq }) },
  setIntrodbApiKey: (key) => { localStorage.setItem('introdb_api_key', key); set({ introdbApiKey: key }) },
  setAnimeTrackingProvider: (prov) => { localStorage.setItem('anime_tracking_provider', prov); set({ animeTrackingProvider: prov }) },

  setBlurSpoilers: (val) => { localStorage.setItem('aurales_blur_spoilers', String(val)); set({ blurSpoilers: val }) },
  setBlurThumbnails: (val) => { localStorage.setItem('aurales_blur_thumbnails', String(val)); set({ blurThumbnails: val }) },
  setBlurTitles: (val) => { localStorage.setItem('aurales_blur_titles', String(val)); set({ blurTitles: val }) },
  setBlurDescriptions: (val) => { localStorage.setItem('aurales_blur_descriptions', String(val)); set({ blurDescriptions: val }) },
  setKeepNextEpisodeVisible: (val) => { localStorage.setItem('aurales_keep_next_episode_visible', String(val)); set({ keepNextEpisodeVisible: val }) },
  setPosterSize: (size) => { localStorage.setItem('aurales_poster_size', size); set({ posterSize: size }) },
  setNextEpisodePrompt: (prompt) => { localStorage.setItem('aurales_next_episode_prompt', prompt); set({ nextEpisodePrompt: prompt }) },
  setHeroTrailerDelay: (seconds) => {
    const safe = [0, 3, 5, 10, 15, 30].includes(seconds) ? seconds : 0
    localStorage.setItem('aurales_hero_trailer_delay', String(safe))
    set({ heroTrailerDelay: safe })
  },
  setHomeHeroMode: (mode) => { localStorage.setItem('aurales_home_hero_mode', mode); set({ homeHeroMode: mode }) },
  setFixedHeroSource: (source) => { localStorage.setItem('aurales_fixed_hero_source', source); set({ fixedHeroSource: source }) },
  setFixedHeroManualItem: (item) => {
    if (item) localStorage.setItem('aurales_fixed_hero_manual_item', JSON.stringify(item))
    else localStorage.removeItem('aurales_fixed_hero_manual_item')
    set({ fixedHeroManualItem: item })
  },
  setResumePriorityOrder: (order) => { localStorage.setItem('aurales_resume_priority', JSON.stringify(order)); set({ resumePriorityOrder: order }) },

  setAccentColor: (color) => { localStorage.setItem('aurales_accent_color', color); set({ accentColor: color }) },
  setInterfaceTheme: (theme) => { persistInterfaceTheme(theme); set({ interfaceTheme: theme }) },
  setThemeBackground: (bg) => { localStorage.setItem('aurales_theme_background', bg); set({ themeBackground: bg }) },
  setNavigationStyle: (style) => { localStorage.setItem('aurales_navigation_style', style); set({ navigationStyle: style }) },
  setDefaultStartPage: (page) => { localStorage.setItem('aurales_default_start_page', page); set({ defaultStartPage: page }) },
  setShowRatingsOnCards: (show) => { localStorage.setItem('aurales_show_ratings_on_cards', String(show)); set({ showRatingsOnCards: show }) },
  setShowGenreOnCards: (show) => { localStorage.setItem('aurales_show_genre_on_cards', String(show)); set({ showGenreOnCards: show }) },
  setPosterTrailerPreviews: (show) => { localStorage.setItem('aurales_poster_trailer_previews', String(show)); set({ posterTrailerPreviews: show }) },
  setPosterTrailerHoverDelayMs: (delayMs) => {
    const safe = [0, 250, 500, 750, 1000, 1500, 2000].includes(delayMs) ? delayMs : 500
    localStorage.setItem('aurales_poster_trailer_hover_delay_ms', String(safe))
    set({ posterTrailerHoverDelayMs: safe })
  },
  setPosterTrailerSound: (sound) => { localStorage.setItem('aurales_poster_trailer_sound', String(sound)); set({ posterTrailerSound: sound }) },
  setTrailerVolume: (volume) => {
    const safe = Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : 80
    localStorage.setItem('aurales_trailer_volume', String(safe))
    set({ trailerVolume: safe })
  },
  setDiscoveryRegion: (region) => { localStorage.setItem('aurales_discovery_region', region); invalidateCatalogData(); set({ discoveryRegion: region }) },
  setDiscoveryMinRating: (rating) => { localStorage.setItem('aurales_discovery_min_rating', String(rating)); set({ discoveryMinRating: rating }) },
  setDiscoveryIncludeAdult: (include) => { localStorage.setItem('aurales_discovery_include_adult', String(include)); set({ discoveryIncludeAdult: include }) },
  setHwdecMode: (mode) => { localStorage.setItem('aurales_hwdec_mode', mode); set({ hwdecMode: mode }) },
  setIsolatedPlaybackMode: (value) => { localStorage.removeItem('aurales_isolated_playback'); set({ isolatedPlaybackMode: value }) },
  setIsolatedPlaybackHwdec: (mode) => { localStorage.setItem('aurales_isolated_hwdec', mode); set({ isolatedPlaybackHwdec: mode }) },
  setIsolatedPlaybackResume: (value) => { localStorage.setItem('aurales_isolated_resume', String(value)); set({ isolatedPlaybackResume: value }) },
  setCacheBufferSize: (size) => { localStorage.setItem('aurales_cache_buffer_size', size); set({ cacheBufferSize: size }) },
  setAudioPassthrough: (val) => { localStorage.setItem('aurales_audio_passthrough', String(val)); set({ audioPassthrough: val }) },
  setAutoSkipSegments: (val) => { localStorage.setItem('aurales_auto_skip_segments', String(val)); set({ autoSkipSegments: val }) },
  setAutoPlayFirstStream: (val) => { localStorage.setItem('aurales_auto_play_first_stream', String(val)); set({ autoPlayFirstStream: val }) },
  setPreloadPlaybackSources: (val) => { localStorage.setItem('aurales_preload_playback_sources', String(val)); set({ preloadPlaybackSources: val }) },
  setSubtitleFontSize: (size) => { localStorage.setItem('aurales_sub_font_size', String(size)); set({ subtitleFontSize: size, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleBgOpacity: (opacity) => { localStorage.setItem('aurales_sub_bg_opacity', opacity); set({ subtitleBgOpacity: opacity, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleColor: (color) => { localStorage.setItem('aurales_sub_color', color); set({ subtitleColor: color, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleBorderStyle: (style) => { localStorage.setItem('aurales_sub_border_style', style); set({ subtitleBorderStyle: style, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitlePreset: (preset) => {
    localStorage.setItem('aurales_sub_preset', preset)
    const updates: Partial<AppState> = { subtitlePreset: preset }
    if (preset === 'standard') {
      updates.subtitleColor = '#FFFFFF'
      updates.subtitleOutlineColor = '#000000'
      updates.subtitleBgColor = '#000000'
      updates.subtitleBgOpacity = '0'
      updates.subtitleOutlineThickness = 1.4
      updates.subtitleShadowOffset = 1.0
      updates.subtitleShadowOpacity = 0.5
      updates.subtitleTextBlur = 0.0
      updates.subtitleBold = false
      updates.subtitleItalic = false
      updates.subtitleBorderStyle = 'outline'
    } else if (preset === 'boxed') {
      updates.subtitleColor = '#FFFFFF'
      updates.subtitleOutlineColor = '#000000'
      updates.subtitleBgColor = '#000000'
      updates.subtitleBgOpacity = '0.8'
      updates.subtitleOutlineThickness = 0
      updates.subtitleShadowOffset = 0
      updates.subtitleShadowOpacity = 0
      updates.subtitleTextBlur = 0.0
      updates.subtitleBold = false
      updates.subtitleItalic = false
      updates.subtitleBorderStyle = 'none'
    } else if (preset === 'classic') {
      updates.subtitleColor = '#FFFF00'
      updates.subtitleOutlineColor = '#000000'
      updates.subtitleBgColor = '#000000'
      updates.subtitleBgOpacity = '0'
      updates.subtitleOutlineThickness = 1.4
      updates.subtitleShadowOffset = 1.0
      updates.subtitleShadowOpacity = 0.5
      updates.subtitleTextBlur = 0.0
      updates.subtitleBold = false
      updates.subtitleItalic = false
      updates.subtitleBorderStyle = 'outline'
    } else if (preset === 'minimal') {
      updates.subtitleColor = '#FFFFFF'
      updates.subtitleOutlineColor = '#000000'
      updates.subtitleBgColor = '#000000'
      updates.subtitleBgOpacity = '0'
      updates.subtitleOutlineThickness = 0
      updates.subtitleShadowOffset = 1.5
      updates.subtitleShadowOpacity = 0.6
      updates.subtitleTextBlur = 0.0
      updates.subtitleBold = false
      updates.subtitleItalic = false
      updates.subtitleBorderStyle = 'shadow'
    } else if (preset === 'bold') {
      updates.subtitleColor = '#FFFFFF'
      updates.subtitleOutlineColor = '#000000'
      updates.subtitleBgColor = '#000000'
      updates.subtitleBgOpacity = '0'
      updates.subtitleOutlineThickness = 2.0
      updates.subtitleShadowOffset = 1.5
      updates.subtitleShadowOpacity = 0.6
      updates.subtitleTextBlur = 0.0
      updates.subtitleBold = true
      updates.subtitleItalic = false
      updates.subtitleBorderStyle = 'outline'
    }
    if (updates.subtitleColor) localStorage.setItem('aurales_sub_color', updates.subtitleColor)
    if (updates.subtitleOutlineColor) localStorage.setItem('aurales_sub_outline_color', updates.subtitleOutlineColor)
    if (updates.subtitleBgColor) localStorage.setItem('aurales_sub_bg_color', updates.subtitleBgColor)
    if (updates.subtitleBgOpacity) localStorage.setItem('aurales_sub_bg_opacity', updates.subtitleBgOpacity)
    if (updates.subtitleOutlineThickness !== undefined) localStorage.setItem('aurales_sub_outline_thickness', String(updates.subtitleOutlineThickness))
    if (updates.subtitleShadowOffset !== undefined) localStorage.setItem('aurales_sub_shadow_offset', String(updates.subtitleShadowOffset))
    if (updates.subtitleShadowOpacity !== undefined) localStorage.setItem('aurales_sub_shadow_opacity', String(updates.subtitleShadowOpacity))
    if (updates.subtitleTextBlur !== undefined) localStorage.setItem('aurales_sub_text_blur', String(updates.subtitleTextBlur))
    if (updates.subtitleBold !== undefined) localStorage.setItem('aurales_sub_bold', String(updates.subtitleBold))
    if (updates.subtitleItalic !== undefined) localStorage.setItem('aurales_sub_italic', String(updates.subtitleItalic))
    if (updates.subtitleBorderStyle) localStorage.setItem('aurales_sub_border_style', updates.subtitleBorderStyle)
    set(updates)
  },
  setSubtitleScale: (scale) => { localStorage.setItem('aurales_sub_scale', String(scale)); set({ subtitleScale: scale }) },
  setSubtitleBold: (bold) => { localStorage.setItem('aurales_sub_bold', String(bold)); set({ subtitleBold: bold, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleItalic: (italic) => { localStorage.setItem('aurales_sub_italic', String(italic)); set({ subtitleItalic: italic, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleOutlineColor: (color) => { localStorage.setItem('aurales_sub_outline_color', color); set({ subtitleOutlineColor: color, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleBgColor: (color) => { localStorage.setItem('aurales_sub_bg_color', color); set({ subtitleBgColor: color, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleOutlineThickness: (thickness) => { localStorage.setItem('aurales_sub_outline_thickness', String(thickness)); set({ subtitleOutlineThickness: thickness, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleShadowOffset: (offset) => { localStorage.setItem('aurales_sub_shadow_offset', String(offset)); set({ subtitleShadowOffset: offset, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleShadowOpacity: (opacity) => { localStorage.setItem('aurales_sub_shadow_opacity', String(opacity)); set({ subtitleShadowOpacity: opacity, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleVerticalPosition: (pos) => { localStorage.setItem('aurales_sub_vertical_position', String(pos)); set({ subtitleVerticalPosition: pos }) },
  setSubtitleAlignment: (align) => { localStorage.setItem('aurales_sub_alignment', align); set({ subtitleAlignment: align }) },
  setSubtitleHorizontalMargin: (margin) => { localStorage.setItem('aurales_sub_horizontal_margin', String(margin)); set({ subtitleHorizontalMargin: margin }) },
  setSubtitleTextBlur: (blur) => { localStorage.setItem('aurales_sub_text_blur', String(blur)); set({ subtitleTextBlur: blur, subtitlePreset: 'custom' }); localStorage.setItem('aurales_sub_preset', 'custom') },
  setSubtitleScaleWithWindow: (scale) => { localStorage.setItem('aurales_sub_scale_with_window', String(scale)); set({ subtitleScaleWithWindow: scale }) },
  setSubtitleAssOverride: (override) => { localStorage.setItem('aurales_sub_ass_override', override); set({ subtitleAssOverride: override }) },
  resetSubtitleSettings: () => {
    localStorage.removeItem('aurales_sub_preset')
    localStorage.removeItem('aurales_sub_scale')
    localStorage.removeItem('aurales_sub_bold')
    localStorage.removeItem('aurales_sub_italic')
    localStorage.removeItem('aurales_sub_outline_color')
    localStorage.removeItem('aurales_sub_bg_color')
    localStorage.removeItem('aurales_sub_outline_thickness')
    localStorage.removeItem('aurales_sub_shadow_offset')
    localStorage.removeItem('aurales_sub_shadow_opacity')
    localStorage.removeItem('aurales_sub_vertical_position')
    localStorage.removeItem('aurales_sub_alignment')
    localStorage.removeItem('aurales_sub_horizontal_margin')
    localStorage.removeItem('aurales_sub_text_blur')
    localStorage.removeItem('aurales_sub_scale_with_window')
    localStorage.removeItem('aurales_sub_ass_override')
    localStorage.removeItem('aurales_sub_font_size')
    localStorage.removeItem('aurales_sub_bg_opacity')
    localStorage.removeItem('aurales_sub_color')
    localStorage.removeItem('aurales_sub_border_style')
    set({
      subtitlePreset: 'standard',
      subtitleScale: 1.0,
      subtitleBold: false,
      subtitleItalic: false,
      subtitleOutlineColor: '#000000',
      subtitleBgColor: '#000000',
      subtitleOutlineThickness: 1.4,
      subtitleShadowOffset: 1.0,
      subtitleShadowOpacity: 0.5,
      subtitleVerticalPosition: 100,
      subtitleAlignment: 'center',
      subtitleHorizontalMargin: 19,
      subtitleTextBlur: 0.0,
      subtitleScaleWithWindow: true,
      subtitleAssOverride: 'scale_only',
      subtitleFontSize: 24,
      subtitleBgOpacity: '0',
      subtitleColor: '#FFFFFF',
      subtitleBorderStyle: 'outline'
    })
  },
  setVisibleHeroRatings: (ratings) => { localStorage.setItem('aurales_visible_hero_ratings', JSON.stringify(ratings)); set({ visibleHeroRatings: ratings }) },
  fanartApiKey: localStorage.getItem('fanart_api_key') || '',
  setFanartApiKey: (key) => { localStorage.setItem('fanart_api_key', key); invalidateCatalogData(); set({ fanartApiKey: key }) },
  openrouterApiKey: localStorage.getItem('openrouter_api_key') || '',
  openrouterModel: localStorage.getItem('openrouter_model') || 'google/gemini-2.5-flash',
  setOpenrouterApiKey: (key) => { localStorage.setItem('openrouter_api_key', key); set({ openrouterApiKey: key }) },
  setOpenrouterModel: (model) => { localStorage.setItem('openrouter_model', model); set({ openrouterModel: model }) },

  mpvCacheSecs: Number(localStorage.getItem('aurales_mpv_cache_secs') || '60'),
  mpvNetworkTimeout: Number(localStorage.getItem('aurales_mpv_network_timeout') || '15'),
  mpvCustomArgs: localStorage.getItem('aurales_mpv_custom_args') || '',
  seekStepSeconds: Number(localStorage.getItem('aurales_seek_step_secs') || '10'),
  setMpvCacheSecs: (secs) => { localStorage.setItem('aurales_mpv_cache_secs', String(secs)); set({ mpvCacheSecs: secs }) },
  setMpvNetworkTimeout: (secs) => { localStorage.setItem('aurales_mpv_network_timeout', String(secs)); set({ mpvNetworkTimeout: secs }) },
  setMpvCustomArgs: (args) => { localStorage.setItem('aurales_mpv_custom_args', args); set({ mpvCustomArgs: args }) },
  setSeekStepSeconds: (secs) => { localStorage.setItem('aurales_seek_step_secs', String(secs)); set({ seekStepSeconds: secs }) },
  resetPlayerSettings: () => {
    localStorage.setItem('aurales_hwdec_mode', 'auto')
    localStorage.setItem('aurales_cache_buffer_size', 'default')
    localStorage.setItem('aurales_mpv_cache_secs', '60')
    localStorage.setItem('aurales_mpv_network_timeout', '15')
    localStorage.setItem('aurales_mpv_custom_args', '')
    localStorage.setItem('aurales_preload_playback_sources', 'false')
    set({
      hwdecMode: 'auto',
      cacheBufferSize: 'default',
      mpvCacheSecs: 60,
      mpvNetworkTimeout: 15,
      mpvCustomArgs: '',
      preloadPlaybackSources: false,
    })
  },

  // Image cache settings
  imageQuality: (localStorage.getItem('aurales_image_quality') || 'balanced') as 'data-saver' | 'balanced' | 'high',
  imageCacheSizeMb: Number(localStorage.getItem('aurales_image_cache_size_mb') || '500'),
  imageKeepDays: Number(localStorage.getItem('aurales_image_keep_days') || '3'),
  setImageQuality: (q) => { localStorage.setItem('aurales_image_quality', q); set({ imageQuality: q }) },
  setImageCacheSizeMb: (mb) => {
    localStorage.setItem('aurales_image_cache_size_mb', String(mb))
    set({ imageCacheSizeMb: mb })
    void import('../services/imageCache').then(({ configureImageCache }) => configureImageCache(mb, get().imageKeepDays))
  },
  setImageKeepDays: (days) => {
    localStorage.setItem('aurales_image_keep_days', String(days))
    set({ imageKeepDays: days })
    void import('../services/imageCache').then(({ configureImageCache }) => configureImageCache(get().imageCacheSizeMb, days))
  },

  artProviders: normalizeArtProviderSettings(JSON.parse(localStorage.getItem('aurales_art_providers') || 'null') || DEFAULT_ART_PROVIDERS),
  setArtProviders: (providers) => {
    const normalized = normalizeArtProviderSettings(providers)
    localStorage.setItem('aurales_art_providers', JSON.stringify(normalized))
    invalidateCatalogData()
    set({ artProviders: normalized })
  },
  customArtUrls: JSON.parse(localStorage.getItem('aurales_custom_art_urls') || 'null') || {
    posterUrl: '', backdropUrl: '', logoUrl: '', episodeThumbnailUrl: '',
  } as CustomArtUrls,
  setCustomArtUrls: (urls) => { localStorage.setItem('aurales_custom_art_urls', JSON.stringify(urls)); invalidateCatalogData(); set({ customArtUrls: urls }) },
  movieMetadataSource: (localStorage.getItem('aurales_movie_meta_src') || 'tmdb') as 'tmdb' | 'tvdb',
  seriesMetadataSource: (localStorage.getItem('aurales_series_meta_src') || 'tvdb') as 'tvdb' | 'tmdb',
  animeMetadataSource: (localStorage.getItem('aurales_anime_meta_src') || 'tvdb') as 'anilist' | 'mal' | 'kitsu' | 'tvdb' | 'tmdb',
  movieMetadataFallback: false,
  seriesMetadataFallback: false,
  animeMetadataFallback: false,
  enableCommunityRatings: localStorage.getItem('aurales_community_ratings') !== 'false',
  appManagedMetadata: localStorage.getItem('aurales_app_managed_metadata') !== 'false',
  useAddonMetadataFallback: localStorage.getItem('aurales_addon_metadata_fallback') !== 'false',
  preferTvdbAnimeSeasons: localStorage.getItem('aurales_tvdb_anime_seasons') !== 'false',
  animeTitleLanguage: (localStorage.getItem('aurales_anime_title_language') || 'auto') as 'english' | 'romaji' | 'native' | 'auto',
  hideUnairedAnimeSeasons: localStorage.getItem('aurales_hide_unaired_anime_seasons') !== 'false',
  hideUnairedAnimeEpisodes: localStorage.getItem('aurales_hide_unaired_anime_eps') !== 'false',
  includeAnimeSpecials: localStorage.getItem('aurales_include_anime_specials') === 'true',
  ignoreAddonMetadataForAnime: localStorage.getItem('aurales_ignore_addon_meta_anime') !== 'false',
  useGenericAnimeSeasonLabels: localStorage.getItem('aurales_generic_anime_season_labels') !== 'false',
  avoidJapaneseSeasonNames: localStorage.getItem('aurales_avoid_jp_season_names') !== 'false',
  setMovieMetadataSource: (src) => { localStorage.setItem('aurales_movie_meta_src', src); invalidateCatalogData(); set({ movieMetadataSource: src }); get().clearAnimeCache() },
  setSeriesMetadataSource: (src) => { localStorage.setItem('aurales_series_meta_src', src); invalidateCatalogData(); set({ seriesMetadataSource: src }); get().clearAnimeCache() },
  setAnimeMetadataSource: (src) => { localStorage.setItem('aurales_anime_meta_src', src); invalidateCatalogData(); set({ animeMetadataSource: src }); get().clearAnimeCache() },
  setMovieMetadataFallback: (val) => { localStorage.setItem('aurales_movie_meta_fb', String(val)); set({ movieMetadataFallback: val }); get().clearAnimeCache() },
  setSeriesMetadataFallback: (val) => { localStorage.setItem('aurales_series_meta_fb', String(val)); set({ seriesMetadataFallback: val }); get().clearAnimeCache() },
  setAnimeMetadataFallback: (val) => { localStorage.setItem('aurales_anime_meta_fb', String(val)); set({ animeMetadataFallback: val }); get().clearAnimeCache() },
  setEnableCommunityRatings: (val) => { localStorage.setItem('aurales_community_ratings', String(val)); set({ enableCommunityRatings: val }) },
  setAppManagedMetadata: (val) => { localStorage.setItem('aurales_app_managed_metadata', String(val)); invalidateCatalogData(); set({ appManagedMetadata: val }) },
  setUseAddonMetadataFallback: (val) => { localStorage.setItem('aurales_addon_metadata_fallback', String(val)); set({ useAddonMetadataFallback: val }) },
  setPreferTvdbAnimeSeasons: (val) => { localStorage.setItem('aurales_tvdb_anime_seasons', String(val)); set({ preferTvdbAnimeSeasons: val }); get().clearAnimeCache() },
  setAnimeTitleLanguage: (val) => { localStorage.setItem('aurales_anime_title_language', val); set({ animeTitleLanguage: val }); get().clearAnimeCache() },
  setHideUnairedAnimeSeasons: (val) => { localStorage.setItem('aurales_hide_unaired_anime_seasons', String(val)); set({ hideUnairedAnimeSeasons: val }); get().clearAnimeCache() },
  setHideUnairedAnimeEpisodes: (val) => { localStorage.setItem('aurales_hide_unaired_anime_eps', String(val)); set({ hideUnairedAnimeEpisodes: val }); get().clearAnimeCache() },
  setIncludeAnimeSpecials: (val) => { localStorage.setItem('aurales_include_anime_specials', String(val)); set({ includeAnimeSpecials: val }); get().clearAnimeCache() },
  setIgnoreAddonMetadataForAnime: (val) => { localStorage.setItem('aurales_ignore_addon_meta_anime', String(val)); set({ ignoreAddonMetadataForAnime: val }) },
  setUseGenericAnimeSeasonLabels: (val) => { localStorage.setItem('aurales_generic_anime_season_labels', String(val)); set({ useGenericAnimeSeasonLabels: val }); get().clearAnimeCache() },
  setAvoidJapaneseSeasonNames: (val) => { localStorage.setItem('aurales_avoid_jp_season_names', String(val)); set({ avoidJapaneseSeasonNames: val }); get().clearAnimeCache() },
  clearAnimeCache: async () => {
    try {
      const { clearAnimeMetadataCache } = await import('../services/metadata/metadataResolver')
      await clearAnimeMetadataCache()
    } catch (e) { console.warn('[appStore] clearAnimeCache failed:', e) }
  },

  movieSearchEngine: localStorage.getItem('aurales_movie_search_engine') || 'tmdb',
  seriesSearchEngine: localStorage.getItem('aurales_series_search_engine') || 'tvdb',
  animeSeriesSearchEngine: localStorage.getItem('aurales_anime_series_search_engine') || 'mal',
  animeMovieSearchEngine: localStorage.getItem('aurales_anime_movie_search_engine') || 'mal',
  movieSearchEnabled: localStorage.getItem('aurales_movie_search_enabled') !== 'false',
  seriesSearchEnabled: localStorage.getItem('aurales_series_search_enabled') !== 'false',
  animeSeriesSearchEnabled: localStorage.getItem('aurales_anime_series_search_enabled') !== 'false',
  animeMovieSearchEnabled: localStorage.getItem('aurales_anime_movie_search_enabled') !== 'false',
  setMovieSearchEngine: (engine) => { localStorage.setItem('aurales_movie_search_engine', engine); set({ movieSearchEngine: engine }) },
  setSeriesSearchEngine: (engine) => { localStorage.setItem('aurales_series_search_engine', engine); set({ seriesSearchEngine: engine }) },
  setAnimeSeriesSearchEngine: (engine) => { localStorage.setItem('aurales_anime_series_search_engine', engine); set({ animeSeriesSearchEngine: engine }) },
  setAnimeMovieSearchEngine: (engine) => { localStorage.setItem('aurales_anime_movie_search_engine', engine); set({ animeMovieSearchEngine: engine }) },
  setMovieSearchEnabled: (val) => { localStorage.setItem('aurales_movie_search_enabled', String(val)); set({ movieSearchEnabled: val }) },
  setSeriesSearchEnabled: (val) => { localStorage.setItem('aurales_series_search_enabled', String(val)); set({ seriesSearchEnabled: val }) },
  setAnimeSeriesSearchEnabled: (val) => { localStorage.setItem('aurales_anime_series_search_enabled', String(val)); set({ animeSeriesSearchEnabled: val }) },
  setAnimeMovieSearchEnabled: (val) => { localStorage.setItem('aurales_anime_movie_search_enabled', String(val)); set({ animeMovieSearchEnabled: val }) },

  discordRichPresence: localStorage.getItem('aurales_discord_rpc') !== 'false',
  setDiscordRichPresence: (enabled) => { localStorage.setItem('aurales_discord_rpc', String(enabled)); set({ discordRichPresence: enabled }) },

  subtitleTranslationLang: localStorage.getItem('aurales_sub_translation_lang') || loadPersistedPreferredSubtitles()[0] || '',
  subtitleTranslationEnabled: localStorage.getItem('aurales_sub_translation_enabled') === 'true',
  translationCuesAhead: Number(localStorage.getItem('aurales_translation_cues_ahead') || '10'),
  contextAwareTranslation: localStorage.getItem('aurales_context_aware_translation') !== 'false',
  setSubtitleTranslationLang: (lang) => { localStorage.setItem('aurales_sub_translation_lang', lang); set({ subtitleTranslationLang: lang }) },
  setSubtitleTranslationEnabled: (enabled) => { localStorage.setItem('aurales_sub_translation_enabled', String(enabled)); set({ subtitleTranslationEnabled: enabled }) },
  setTranslationCuesAhead: (n) => { localStorage.setItem('aurales_translation_cues_ahead', String(n)); set({ translationCuesAhead: n }) },
  setContextAwareTranslation: (val) => { localStorage.setItem('aurales_context_aware_translation', String(val)); set({ contextAwareTranslation: val }) },
}))
