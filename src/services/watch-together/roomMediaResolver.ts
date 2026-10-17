import type { SearchResult, StreamResult } from '../../types'
import type { RoomMedia, RoomEpisode } from './types'
import { getAddonStreams, getStreamAddons } from '../addons'
import { isPlayableStream } from '../streams/playableUrl'

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildStremioId(media: RoomMedia, episode?: RoomEpisode): string {
  let baseId: string
  if (media.imdbId) {
    baseId = media.imdbId
  } else if (media.tmdbId) {
    baseId = `tmdb:${media.tmdbId}`
  } else if (media.tvdbId) {
    baseId = `tvdb:${media.tvdbId}`
  } else {
    baseId = media.localMediaId
  }

  if (episode) {
    return `${baseId}:${episode.seasonNumber}:${episode.episodeNumber}`
  }
  return baseId
}

function mediaTypeToStremio(type: RoomMedia['type']): string {
  return type === 'movie' ? 'movie' : 'series'
}

function roomMediaToSearchResult(media: RoomMedia): SearchResult {
  return {
    id: media.localMediaId,
    title: media.title,
    type: media.type === 'movie' ? 'movie' : 'series',
    year: media.year,
    poster: media.poster,
    backdrop: media.backdrop,
    overview: media.overview,
    provider: 'watch-together',
    imdbId: media.imdbId,
    tmdbId: media.tmdbId,
    tvdbId: media.tvdbId,
    anilistId: media.anilistId,
    sourceAddonId: media.sourceAddonId,
    sourceAddonItemId: media.sourceAddonItemId,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index])
    }
  }))
  return results
}

// ── Resolver ────────────────────────────────────────────────────────────────

export async function resolveRoomMediaLocally(
  roomMedia: RoomMedia,
  episode?: RoomEpisode,
): Promise<{
  localMedia: SearchResult | null
  streams: Array<StreamResult & { addonId: string; addonName: string }>
  status: 'resolved' | 'no_streams' | 'not_found'
}> {
  const stremioType = mediaTypeToStremio(roomMedia.type)
  const stremioId = buildStremioId(roomMedia, episode)
  const streamAddons = getStreamAddons(stremioType)

  if (streamAddons.length === 0) {
    return { localMedia: null, streams: [], status: 'not_found' }
  }

  const allStreams: Array<StreamResult & { addonId: string; addonName: string }> = []

  const results = await mapLimit(streamAddons, 4, async (addon) => {
    try {
      const streams = await getAddonStreams(addon.url, stremioType, stremioId)
      return streams
        .filter(isPlayableStream)
        .map((s) => ({
          ...s,
          addonId: addon.manifest.id,
          addonName: addon.manifest.name,
        }))
    } catch {
      return []
    }
  })

  for (const result of results) allStreams.push(...result)

  const localMedia = roomMediaToSearchResult(roomMedia)

  if (allStreams.length > 0) {
    return { localMedia, streams: allStreams, status: 'resolved' }
  }

  return { localMedia, streams: [], status: 'no_streams' }
}
