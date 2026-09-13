import type { EpisodeDetails, MovieDetails, SearchResult, ShowDetails } from '../types'
import { useAppStore } from '../stores/appStore'
import { getBetterPostersUrl } from './betterPosters'
import type { ArtProvider, ArtProviderSettings } from '../stores/appStore'
import { metadataTaskQueue, scheduleTask } from './cache/backgroundTaskQueue'

// Better Posters needs an IMDb id. Catalog sources do not always include one,
// so retain both completed and in-flight resolutions globally. This prevents
// every card, row, and revisited route from independently doing the same ID
// bridge and lets cards render the final Better Poster directly.
interface BetterPosterCacheEntry {
  url?: string
  expiresAt: number
}

const betterPosterUrls = new Map<string, BetterPosterCacheEntry>()
const betterPosterRequests = new Map<string, Promise<string | undefined>>()
const MAX_BETTER_POSTER_URLS = 400
const BETTER_POSTER_FAILURE_TTL_MS = 60_000

function rememberBetterPoster(key: string, url: string | undefined): void {
  betterPosterUrls.delete(key)
  betterPosterUrls.set(key, {
    url,
    // Successful URL decisions remain stable for the session. Negative
    // decisions are deliberately short-lived so a provider/ID bridge outage
    // cannot suppress enhanced artwork until Aurales is restarted.
    expiresAt: url ? Number.POSITIVE_INFINITY : Date.now() + BETTER_POSTER_FAILURE_TTL_MS,
  })
  while (betterPosterUrls.size > MAX_BETTER_POSTER_URLS) {
    const oldest = betterPosterUrls.keys().next().value
    if (!oldest) break
    betterPosterUrls.delete(oldest)
  }
}

function cachedBetterPoster(key: string): { found: boolean; url?: string } {
  const cached = betterPosterUrls.get(key)
  if (!cached) return { found: false }
  if (cached.expiresAt <= Date.now()) {
    betterPosterUrls.delete(key)
    return { found: false }
  }
  // Refresh LRU order on access without changing the negative-cache deadline.
  betterPosterUrls.delete(key)
  betterPosterUrls.set(key, cached)
  return { found: true, url: cached.url }
}

interface ArtIds {
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  type?: 'movie' | 'series'
  season?: number
  episode?: number
}

function resolveCustomUrl(pattern: string, ids: ArtIds): string | undefined {
  if (!pattern.trim()) return undefined
  const values: Record<string, string | undefined> = {
    imdb_id: ids.imdbId ? String(ids.imdbId) : undefined,
    tmdb_id: ids.tmdbId != null ? String(ids.tmdbId) : undefined,
    tvdb_id: ids.tvdbId != null ? String(ids.tvdbId) : undefined,
    mal_id: ids.malId != null ? String(ids.malId) : undefined,
    anilist_id: ids.anilistId != null ? String(ids.anilistId) : undefined,
    type: ids.type,
    season: ids.season != null ? String(ids.season) : undefined,
    episode: ids.episode != null ? String(ids.episode) : undefined,
  }

  const missing = Array.from(pattern.matchAll(/\{([a-z_]+)\}/g)).some((match) => {
    const key = match[1]
    return !values[key]
  })
  if (missing) return undefined

  let url = pattern
  for (const [key, value] of Object.entries(values)) {
    url = url.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '')
  }

  if (url.includes('{') || !url.startsWith('http')) return undefined
  return url
}

function getCustomUrls() {
  const { customArtUrls, betterPosters } = useAppStore.getState()
  return betterPosters.enabled
    ? { ...customArtUrls, posterUrl: getBetterPostersUrl(betterPosters) }
    : customArtUrls
}

function betterPosterKey(item: Pick<SearchResult, 'type' | 'id' | 'imdbId' | 'tmdbId' | 'tvdbId' | 'malId' | 'anilistId'>, pattern: string): string {
  return `${pattern}|${item.type}|${item.imdbId || ''}|${item.tmdbId || ''}|${item.tvdbId || ''}|${item.malId || ''}|${item.anilistId || ''}|${item.id}`
}

/** Resolve and memoize the final Better Posters URL, including the shared
 * IMDb-ID bridge for catalog entries that initially lack an IMDb id. */
export function resolveBetterPoster(item: SearchResult): Promise<string | undefined> {
  const { betterPosters } = useAppStore.getState()
  if (!betterPosters.enabled) return Promise.resolve(undefined)
  const pattern = getBetterPostersUrl(betterPosters)
  const key = betterPosterKey(item, pattern)
  const cached = cachedBetterPoster(key)
  if (cached.found) return Promise.resolve(cached.url)
  const existing = betterPosterRequests.get(key)
  if (existing) return existing

  // A long Home feed can make dozens of cards approach the viewport at once.
  // Keep the IMDb bridge bounded instead of starting one network chain per
  // card; scheduleTask also shares callers that race for the same item.
  const request = scheduleTask(metadataTaskQueue, {
    id: `better-poster:${key}`,
    dedupKey: `better-poster:${key}`,
    priority: 'low',
    group: 'metadata',
    execute: async () => {
      let imdbId = item.imdbId
      if (!imdbId) {
        const { resolveImdbId } = await import('./metadataEnrich')
        imdbId = await resolveImdbId({
          tmdbId: item.tmdbId,
          tvdbId: item.tvdbId,
          malId: item.malId,
          anilistId: item.anilistId,
        }, item.type === 'movie' ? 'movie' : 'series')
      }
      const url = imdbId ? resolveCustomUrl(pattern, { imdbId, type: item.type }) : undefined
      rememberBetterPoster(key, url)
      return url
    },
  }).catch(() => {
    rememberBetterPoster(key, undefined)
    return undefined
  }).finally(() => betterPosterRequests.delete(key))
  betterPosterRequests.set(key, request)
  return request
}

export function getSearchResultCustomArt(item: SearchResult): { poster?: string; backdrop?: string; logo?: string } {
  const urls = getCustomUrls()
  const ids: ArtIds = { imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId, anilistId: item.anilistId, type: item.type }
  const betterPattern = useAppStore.getState().betterPosters.enabled ? getBetterPostersUrl(useAppStore.getState().betterPosters) : undefined
  const resolvedBetterPoster = betterPattern ? cachedBetterPoster(betterPosterKey(item, betterPattern)).url : undefined
  return {
    poster: resolvedBetterPoster || resolveCustomUrl(urls.posterUrl, ids),
    backdrop: resolveCustomUrl(urls.backdropUrl, ids),
    logo: resolveCustomUrl(urls.logoUrl, ids),
  }
}

export function applySearchResultArt<T extends SearchResult>(item: T): T {
  const { poster, backdrop, logo } = getSearchResultCustomArt(item)
  if (!poster && !backdrop && !logo) return item
  return { ...item, ...(poster && { poster }), ...(backdrop && { backdrop }), ...(logo && { logo }) }
}

export function applyMovieArt<T extends MovieDetails>(movie: T): T {
  const urls = getCustomUrls()
  const ids: ArtIds = { imdbId: movie.imdbId, tmdbId: movie.tmdbId, tvdbId: movie.tvdbId, type: 'movie' }
  const poster = resolveCustomUrl(urls.posterUrl, ids)
  const backdrop = resolveCustomUrl(urls.backdropUrl, ids)
  const logo = resolveCustomUrl(urls.logoUrl, ids)
  if (!poster && !backdrop && !logo) return movie
  return { ...movie, ...(poster && { poster }), ...(backdrop && { backdrop }), ...(logo && { logo }) }
}

export function applyShowArt<T extends ShowDetails>(show: T): T {
  const urls = getCustomUrls()
  const ids: ArtIds = { imdbId: show.imdbId, tmdbId: show.tmdbId, tvdbId: show.tvdbId, malId: show.malId, anilistId: show.anilistId, type: 'series' }
  const poster = resolveCustomUrl(urls.posterUrl, ids)
  const backdrop = resolveCustomUrl(urls.backdropUrl, ids)
  const logo = resolveCustomUrl(urls.logoUrl, ids)
  if (!poster && !backdrop && !logo) return show
  return { ...show, ...(poster && { poster }), ...(backdrop && { backdrop }), ...(logo && { logo }) }
}

export function applyEpisodeArt<T extends EpisodeDetails>(episode: T, _parent?: Record<string, unknown>): T {
  const urls = getCustomUrls()
  if (!urls.episodeThumbnailUrl) return episode
  const parent = _parent || {}
  const ids: ArtIds = {
    imdbId: parent.imdbId as string,
    tmdbId: parent.tmdbId as string | number,
    tvdbId: parent.tvdbId as string | number,
    malId: parent.malId as string | number,
    anilistId: parent.anilistId as string | number,
    type: 'series',
    season: episode.seasonNumber,
    episode: episode.episodeNumber,
  }
  const still = resolveCustomUrl(urls.episodeThumbnailUrl, ids)
  if (!still) return episode
  return { ...episode, still }
}

function getProviderKey(mediaType: 'movie' | 'series', isAnime: boolean, artType: 'Poster' | 'Backdrop' | 'Logo'): keyof ArtProviderSettings {
  const prefix = isAnime ? 'anime' : mediaType === 'movie' ? 'movie' : 'series'
  return `${prefix}${artType}` as keyof ArtProviderSettings
}

type InitialArtworkItem = {
  poster?: string
  backdrop?: string
  logo?: string
  provider?: string
}

/**
 * Keep catalog/navigation artwork available for first paint. The configured
 * provider replaces individual fields after it resolves successfully; hiding
 * valid existing art here makes every card and detail Hero blank whenever that
 * provider is slow, unavailable, or rate-limited.
 */
export function applyInitialArtworkPreference<T extends InitialArtworkItem>(
  item: T,
  _mediaType: 'movie' | 'series',
  _isAnime = false,
): T {
  return item
}

export async function resolveArtFromProviders(
  mediaType: 'movie' | 'series',
  ids: { tmdbId?: string | number; tvdbId?: string | number; imdbId?: string },
  isAnime = false,
  role: 'poster' | 'backdrop' | 'all' = 'all',
): Promise<{ poster?: string; backdrop?: string; logo?: string }> {
  const { appManagedMetadata, artProviders, fanartApiKey } = useAppStore.getState()
  // When addon metadata is authoritative, its artwork is authoritative too.
  // Besides unexpectedly replacing the supplied art, provider lookups for every
  // visible card can saturate the same network connection the catalog uses.
  if (!appManagedMetadata) return {}

  const posterProvider = artProviders[getProviderKey(mediaType, isAnime, 'Poster')]
  const backdropProvider = artProviders[getProviderKey(mediaType, isAnime, 'Backdrop')]
  const logoProvider = artProviders[getProviderKey(mediaType, isAnime, 'Logo')]

  const needed = new Set<ArtProvider>()
  if (role === 'poster' || role === 'all') needed.add(posterProvider)
  if (role === 'backdrop' || role === 'all') needed.add(backdropProvider)
  if (role === 'all') needed.add(logoProvider)
  // A connected personal Fanart key also provides the preferred English-logo
  // fallback when TMDB only has a non-English logo.
  if (role === 'all' && fanartApiKey) needed.add('fanart')

  const results: Record<string, { poster?: string; backdrop?: string; logo?: string }> = {}

  const fetches: Promise<void>[] = []
  let resolvedTvdbId = ids.tvdbId
  let resolvedTmdbId = ids.tmdbId
  let tmdbEnglishLogo: string | undefined

  // Resolve missing cross-provider IDs concurrently. Artwork from an ID we
  // already have must start immediately rather than waiting for the opposite
  // provider's bridge lookup first.
  const tmdbIdPromise = (async () => {
    if (!resolvedTmdbId && resolvedTvdbId) {
      const { tmdbFindByExternalId } = await import('./metadataEnrich')
      const tvdbId = String(resolvedTvdbId).replace(/^tvdb[-:]/i, '')
      const found = await tmdbFindByExternalId(tvdbId, 'tvdb_id').catch(() => null)
      if (found?.tmdbId) resolvedTmdbId = String(found.tmdbId)
    }
    return resolvedTmdbId
  })()

  const tvdbIdPromise = (async () => {
    if ((needed.has('tvdb') || needed.has('fanart')) && !resolvedTvdbId) {
      const { getTvdbIdByRemoteId } = await import('./tvdb')
      if (ids.imdbId) resolvedTvdbId = await getTvdbIdByRemoteId(ids.imdbId).catch(() => undefined)
      if (!resolvedTvdbId && ids.tmdbId) resolvedTvdbId = await getTvdbIdByRemoteId(String(ids.tmdbId)).catch(() => undefined)
    }
    return resolvedTvdbId
  })()

  // TMDB is the universal safety fallback (see the return below, which falls
  // back to results.tmdb for poster/backdrop/logo). Fetch it whenever a tmdbId
  // exists — not just for series/TMDB-selected. Anime *movies* select the
  // anime providers (TVDB/Fanart), which have no movie record, so without this
  // they'd resolve no logo at all.
  if (needed.has('tmdb') || role !== 'all') fetches.push(
    tmdbIdPromise.then((tmdbId) => {
      if (!tmdbId) return undefined
      return import('./tmdb').then(({ getTmdbCardMetadata }) =>
        getTmdbCardMetadata(mediaType, tmdbId, ids.imdbId).then((card) => {
          tmdbEnglishLogo = card.englishLogo
          results.tmdb = { poster: card.poster, backdrop: card.backdrop, logo: card.logo }
        })
      )
    }).catch(() => undefined)
  )

  if (needed.has('tvdb')) {
    fetches.push(
      tvdbIdPromise.then((resolvedId) => {
        if (!resolvedId) return undefined
        return import('./tvdb').then(({ tvdbProvider }) => {
        const tvdbId = String(resolvedId).replace('tvdb-', '')
        const isMovie = tvdbId.startsWith('movie-') || mediaType === 'movie'
        const fetchPromise = isMovie
          ? tvdbProvider.getMovie(`tvdb-${tvdbId}`)
          : tvdbProvider.getShow(`tvdb-${tvdbId}`)
        return fetchPromise.then((show) => {
          results.tvdb = { poster: show.poster, backdrop: show.backdrop, logo: show.logo }
        })
        })
      }).catch(() => undefined)
    )
  }

  if (needed.has('fanart') && fanartApiKey) {
    fetches.push(
      import('./fanart').then(async ({ getFanartMovieArt, getFanartShowArt }) => {
        await tvdbIdPromise
        const isFanartMovie = mediaType === 'movie' || String(resolvedTvdbId || '').replace('tvdb-', '').startsWith('movie-')
        if (isFanartMovie && ids.tmdbId) {
          const art = await getFanartMovieArt(ids.tmdbId).catch(() => null)
          if (art && (art.poster || art.backdrop || art.logo)) {
            results.fanart = art
            return
          }
        }

        // Fallback to TVDB lookup for Fanart (some anime movies are cataloged under TV/TVDB on Fanart)
        if (!resolvedTvdbId && ids.tmdbId && mediaType !== 'movie') {
          const { getTvdbIdFromTmdb } = await import('./tmdb')
          resolvedTvdbId = await getTvdbIdFromTmdb(ids.tmdbId).catch(() => null) || undefined
        }
        const tvdbId = resolvedTvdbId || ids.tvdbId
        if (tvdbId) {
          const cleanTvdbId = String(tvdbId).replace('tvdb-', '')
          const art = await getFanartShowArt(cleanTvdbId).catch(() => null)
          if (art && (art.poster || art.backdrop || art.logo)) {
            results.fanart = art
          }
        }
      }).catch(() => undefined)
    )
  }

  await Promise.all(fetches)

  return {
    poster: role === 'backdrop' ? undefined : results[posterProvider]?.poster || results.tmdb?.poster,
    backdrop: role === 'poster' ? undefined : results[backdropProvider]?.backdrop || results.tmdb?.backdrop,
    logo: role !== 'all' ? undefined : logoProvider === 'tmdb'
      ? tmdbEnglishLogo || results.fanart?.logo || results.tmdb?.logo
      : results[logoProvider]?.logo || tmdbEnglishLogo || results.tmdb?.logo,
  }
}
