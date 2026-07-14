import type { EpisodeDetails, MovieDetails, SearchResult, ShowDetails } from '../types'
import { useAppStore } from '../stores/appStore'
import type { ArtProviderSettings } from '../stores/appStore'

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
  return useAppStore.getState().customArtUrls
}

export function getSearchResultCustomArt(item: SearchResult): { poster?: string; backdrop?: string; logo?: string } {
  const urls = getCustomUrls()
  const ids: ArtIds = { imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId, anilistId: item.anilistId, type: item.type }
  return {
    poster: resolveCustomUrl(urls.posterUrl, ids),
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

function artworkProviderFromUrl(url?: string): string | undefined {
  if (!url) return undefined
  const value = url.toLowerCase()
  if (value.includes('image.tmdb.org')) return 'tmdb'
  if (value.includes('thetvdb.com') || value.includes('artworks.thetvdb.com')) return 'tvdb'
  if (value.includes('fanart.tv')) return 'fanart'
  return undefined
}

/**
 * Prevent metadata-provider artwork from flashing before the configured art
 * provider resolves. Cached/provider art can then become the first image the
 * user sees instead of replacing a visibly wrong source image afterward.
 */
export function applyInitialArtworkPreference<T extends InitialArtworkItem>(
  item: T,
  mediaType: 'movie' | 'series',
  isAnime = false,
): T {
  const { artProviders } = useAppStore.getState()
  const metadataProvider = String(item.provider || '').toLowerCase()
  const knownMetadataProvider = ['tmdb', 'tvdb', 'anilist', 'mal', 'kitsu', 'fanart'].includes(metadataProvider)

  const keep = (url: string | undefined, artType: 'Poster' | 'Backdrop' | 'Logo') => {
    if (!url) return undefined
    const selected = artProviders[getProviderKey(mediaType, isAnime, artType)]
    const actual = artworkProviderFromUrl(url) || (knownMetadataProvider ? metadataProvider : undefined)
    return actual && actual !== selected ? undefined : url
  }

  const poster = keep(item.poster, 'Poster')
  const backdrop = keep(item.backdrop, 'Backdrop')
  const logo = keep(item.logo, 'Logo')
  if (poster === item.poster && backdrop === item.backdrop && logo === item.logo) return item
  return { ...item, poster, backdrop, logo }
}

export async function resolveArtFromProviders(
  mediaType: 'movie' | 'series',
  ids: { tmdbId?: string | number; tvdbId?: string | number; imdbId?: string },
  isAnime = false,
): Promise<{ poster?: string; backdrop?: string; logo?: string }> {
  const { artProviders, fanartApiKey } = useAppStore.getState()

  const posterProvider = artProviders[getProviderKey(mediaType, isAnime, 'Poster')]
  const backdropProvider = artProviders[getProviderKey(mediaType, isAnime, 'Backdrop')]
  const logoProvider = artProviders[getProviderKey(mediaType, isAnime, 'Logo')]

  const needed = new Set([posterProvider, backdropProvider, logoProvider])
  // A connected personal Fanart key also provides the preferred English-logo
  // fallback when TMDB only has a non-English logo.
  if (fanartApiKey) needed.add('fanart')

  const results: Record<string, { poster?: string; backdrop?: string; logo?: string }> = {}

  const fetches: Promise<void>[] = []
  let resolvedTvdbId = ids.tvdbId
  let resolvedTmdbId = ids.tmdbId
  let tmdbEnglishLogo: string | undefined

  // TVDB catalog entries commonly carry only their TVDB ID. Resolve its TMDB
  // counterpart before artwork selection so a TMDB preference is honored for
  // those entries instead of silently keeping TVDB's source artwork.
  if (!resolvedTmdbId && resolvedTvdbId) {
    const { tmdbFindByExternalId } = await import('./metadataEnrich')
    const tvdbId = String(resolvedTvdbId).replace(/^tvdb[-:]/i, '')
    const found = await tmdbFindByExternalId(tvdbId, 'tvdb_id').catch(() => null)
    if (found?.tmdbId) resolvedTmdbId = String(found.tmdbId)
  }

  // Catalog previews often carry TMDB/IMDb but omit TVDB. Resolve that missing
  // bridge before deciding that a configured TVDB/Fanart source is unavailable.
  // This is especially important for movies, whose TVDB IDs use `movie-*`.
  if ((needed.has('tvdb') || needed.has('fanart')) && !resolvedTvdbId) {
    const { getTvdbIdByRemoteId } = await import('./tvdb')
    if (ids.imdbId) resolvedTvdbId = await getTvdbIdByRemoteId(ids.imdbId).catch(() => undefined)
    if (!resolvedTvdbId && ids.tmdbId) resolvedTvdbId = await getTvdbIdByRemoteId(String(ids.tmdbId)).catch(() => undefined)
  }

  // TMDB is the universal safety fallback (see the return below, which falls
  // back to results.tmdb for poster/backdrop/logo). Fetch it whenever a tmdbId
  // exists — not just for series/TMDB-selected. Anime *movies* select the
  // anime providers (TVDB/Fanart), which have no movie record, so without this
  // they'd resolve no logo at all.
  if (resolvedTmdbId) {
    fetches.push(
      import('./tmdb').then(({ getTmdbCardMetadata }) =>
        getTmdbCardMetadata(mediaType, resolvedTmdbId!, ids.imdbId).then((card) => {
          tmdbEnglishLogo = card.englishLogo
          results.tmdb = { poster: card.poster, backdrop: card.backdrop, logo: card.logo }
        })
      ).catch(() => undefined)
    )
  }

  if (needed.has('tvdb') && resolvedTvdbId) {
    fetches.push(
      import('./tvdb').then(({ tvdbProvider }) => {
        const tvdbId = String(resolvedTvdbId).replace('tvdb-', '')
        const isMovie = tvdbId.startsWith('movie-') || mediaType === 'movie'
        const fetchPromise = isMovie
          ? tvdbProvider.getMovie(`tvdb-${tvdbId}`)
          : tvdbProvider.getShow(`tvdb-${tvdbId}`)
        return fetchPromise.then((show) => {
          results.tvdb = { poster: show.poster, backdrop: show.backdrop, logo: show.logo }
        })
      }).catch(() => undefined)
    )
  }

  if (needed.has('fanart') && fanartApiKey) {
    fetches.push(
      import('./fanart').then(async ({ getFanartMovieArt, getFanartShowArt }) => {
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
    poster: results[posterProvider]?.poster || results.tmdb?.poster,
    backdrop: results[backdropProvider]?.backdrop || results.tmdb?.backdrop,
    logo: logoProvider === 'tmdb'
      ? tmdbEnglishLogo || results.fanart?.logo || results.tmdb?.logo
      : results[logoProvider]?.logo || tmdbEnglishLogo || results.tmdb?.logo,
  }
}
