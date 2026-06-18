import type { StreamResult } from '../../types'
import type { RoomMedia, RoomEpisode, RoomStream } from './types'
import { getAddonStreams, getStreamAddons } from '../addons'

// ── Fingerprinting ──────────────────────────────────────────────────────────

export function createStreamFingerprint(stream: StreamResult & { addonId?: string }): string {
  if (stream.infoHash) {
    const parts = [stream.addonId ?? '', stream.infoHash, stream.fileIdx ?? 0]
    return parts.join(':')
  }
  const label = [stream.name ?? '', stream.title ?? ''].join('|')
  let hash = 0
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0
  }
  return `${stream.addonId ?? 'unknown'}:label:${hash}`
}

// ── Build stremio media ID ──────────────────────────────────────────────────

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

// ── Find matching local stream ──────────────────────────────────────────────

export async function findMatchingLocalStream(
  roomMedia: RoomMedia,
  roomEpisode?: RoomEpisode,
  hostStream?: RoomStream,
): Promise<{ stream: StreamResult; addonId: string; addonName: string } | null> {
  const stremioType = mediaTypeToStremio(roomMedia.type)
  const stremioId = buildStremioId(roomMedia, roomEpisode)
  const streamAddons = getStreamAddons(stremioType)

  const allStreams: Array<StreamResult & { addonId: string; addonName: string }> = []

  for (const addon of streamAddons) {
    try {
      const results = await getAddonStreams(addon.url, stremioType, stremioId)
      for (const s of results) {
        allStreams.push({ ...s, addonId: addon.manifest.id, addonName: addon.manifest.name })
      }
    } catch {
      // addon unavailable, skip
    }
  }

  if (allStreams.length === 0) return null

  if (hostStream) {
    const matched = matchStreamToHost(allStreams, hostStream)
    if (matched) return matched
  }

  // No host stream or no match — return first available
  const first = allStreams[0]
  return { stream: first, addonId: first.addonId, addonName: first.addonName }
}

// ── Match against host stream ───────────────────────────────────────────────

export function matchStreamToHost(
  localStreams: Array<StreamResult & { addonId: string; addonName: string }>,
  hostStream: RoomStream,
): { stream: StreamResult; addonId: string; addonName: string } | null {
  // Priority 1: same addon + infoHash + fileIdx
  if (hostStream.addonId && hostStream.infoHash) {
    const exact = localStreams.find(
      (s) =>
        s.addonId === hostStream.addonId &&
        s.infoHash === hostStream.infoHash &&
        (hostStream.fileIdx == null || s.fileIdx === hostStream.fileIdx),
    )
    if (exact) return { stream: exact, addonId: exact.addonId, addonName: exact.addonName }
  }

  // Priority 2: same stream fingerprint
  if (hostStream.streamFingerprint) {
    const byFingerprint = localStreams.find(
      (s) => createStreamFingerprint(s) === hostStream.streamFingerprint,
    )
    if (byFingerprint) {
      return { stream: byFingerprint, addonId: byFingerprint.addonId, addonName: byFingerprint.addonName }
    }
  }

  // Priority 3: same quality label
  if (hostStream.quality) {
    const byQuality = localStreams.find((s) => {
      const streamQuality =
        s.name?.match(/\b(4k|2160p|1080p|720p|480p)\b/i)?.[0]?.toLowerCase() ??
        s.title?.match(/\b(4k|2160p|1080p|720p|480p)\b/i)?.[0]?.toLowerCase()
      return streamQuality === hostStream.quality?.toLowerCase()
    })
    if (byQuality) {
      return { stream: byQuality, addonId: byQuality.addonId, addonName: byQuality.addonName }
    }
  }

  return null
}
