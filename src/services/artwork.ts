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

  const results: Record<string, { poster?: string; backdrop?: string; logo?: string }> = {}

  const fetches: Promise<void>[] = []
  let resolvedTvdbId = ids.tvdbId

  if (needed.has('tmdb') && ids.tmdbId) {
    fetches.push(
      import('./tmdb').then(({ getTmdbCardMetadata, getTmdbLandscapeBackdrop }) =>
        Promise.all([
          getTmdbCardMetadata(mediaType, ids.tmdbId!),
          getTmdbLandscapeBackdrop(mediaType, ids.tmdbId!),
        ]).then(([card, backdrop]) => {
          results.tmdb = { poster: card.poster, backdrop: backdrop || card.backdrop, logo: card.logo }
        })
      ).catch(() => undefined)
    )
  }

  if (needed.has('tvdb') && ids.tvdbId) {
    fetches.push(
      import('./tvdb').then(({ tvdbProvider }) => {
        const tvdbId = String(ids.tvdbId).replace('tvdb-', '')
        return tvdbProvider.getShow(`tvdb-${tvdbId}`).then((show) => {
          results.tvdb = { poster: show.poster, backdrop: show.backdrop, logo: show.logo }
        })
      }).catch(() => undefined)
    )
  }

  if (needed.has('fanart') && fanartApiKey) {
    fetches.push(
      import('./fanart').then(({ getFanartMovieArt, getFanartShowArt }) => {
        if (mediaType === 'movie' && ids.tmdbId) {
          return getFanartMovieArt(ids.tmdbId).then((art) => { results.fanart = art })
        } else if (mediaType === 'series') {
          return (async () => {
            if (!resolvedTvdbId && ids.tmdbId) {
              const { getTvdbIdFromTmdb } = await import('./tmdb')
              resolvedTvdbId = await getTvdbIdFromTmdb(ids.tmdbId)
            }
            if (!resolvedTvdbId) return
            const tvdbId = String(resolvedTvdbId).replace('tvdb-', '')
            return getFanartShowArt(tvdbId).then((art) => { results.fanart = art })
          })()
        }
      }).catch(() => undefined)
    )
  }

  await Promise.all(fetches)

  return {
    poster: results[posterProvider]?.poster,
    backdrop: results[backdropProvider]?.backdrop,
    logo: results[logoProvider]?.logo,
  }
}
