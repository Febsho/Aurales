import type { StreamResult } from '../../types'
import type { RoomMedia, RoomEpisode, RoomStream } from './types'
import { getAddonStreams, getStreamAddons } from '../addons'
import { getPlayableStreamUrl, isPlayableStream } from '../streams/playableUrl'
import { streamPreloadManager, StreamPreloadPriority } from '../streams/preloadManager'
import { buildSmartContext } from '../streams/preparedStreams'
import { rankStreams, type SmartStream } from '../streams/smartScoring'
import { probeStreamUrl } from '../streams/streamProbe'
import type { LocalSourceCandidate } from '../../stores/watchTogetherStore'
import { annotateTorBoxStreams, resolveTorBoxStream } from '../torbox'

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

/**
 * The only stream information that is safe and useful to share with a room.
 * URLs and provider credentials deliberately stay on the local machine.
 */
export function createRoomStream(stream: StreamResult & { addonId: string }): RoomStream {
  const label = [stream.name, stream.title, stream.filename, stream.behaviorHints?.filename]
    .filter(Boolean)
    .join(' ')
  const quality = label.match(/\b(4k|2160p|1080p|720p|480p)\b/i)?.[0]?.toLowerCase()
  return {
    addonId: stream.addonId,
    name: stream.name,
    title: stream.title,
    quality,
    infoHash: stream.infoHash,
    fileIdx: stream.fileIdx,
    streamFingerprint: createStreamFingerprint(stream),
  }
}

/** A quality label alone is not enough to identify the same release. */
export function isSameRoomStream(
  stream: StreamResult & { addonId: string },
  reference: RoomStream,
): boolean {
  if (reference.addonId && reference.infoHash) {
    return stream.addonId === reference.addonId
      && stream.infoHash === reference.infoHash
      && (reference.fileIdx == null || stream.fileIdx === reference.fileIdx)
  }
  return Boolean(reference.streamFingerprint && createStreamFingerprint(stream) === reference.streamFingerprint)
}

function preferredMediaId(media: RoomMedia): string {
  if (media.imdbId) return media.imdbId
  if (media.tmdbId) return `tmdb:${media.tmdbId}`
  if (media.tvdbId) return `tvdb:${media.tvdbId}`
  return media.localMediaId
}

/**
 * Resolve private, client-local playback candidates. Room peers never receive
 * the selected addon or URL; they only coordinate media identity and time.
 */
export async function resolveLocalSourceCandidates(
  media: RoomMedia,
  episode?: RoomEpisode,
  signal?: AbortSignal,
): Promise<LocalSourceCandidate[]> {
  const mediaType = media.type === 'movie' ? 'movie' : 'series'
  const rawStreams = await streamPreloadManager.request({
    mediaType,
    mediaId: preferredMediaId(media),
    imdbId: media.imdbId,
    tmdbId: media.tmdbId,
    seasonEpisode: episode ? { season: episode.seasonNumber, episode: episode.episodeNumber } : undefined,
    sourceAddonId: media.sourceAddonId,
    sourceAddonItemId: media.sourceAddonItemId,
  }, { priority: StreamPreloadPriority.PLAYBACK })
  if (signal?.aborted) return []
  const streams = await annotateTorBoxStreams(rawStreams).catch(() => rawStreams)

  const ranked = rankStreams(streams as SmartStream[], buildSmartContext({
    title: media.title,
    season: episode?.seasonNumber,
    episode: episode?.episodeNumber,
  })).filter(({ score }) => score > -500)

  // Probe the leading candidates. Remaining ranked sources stay available as
  // runtime fallbacks because some providers reject lightweight HTTP probes.
  const measured = await Promise.all(ranked.slice(0, 3).map(async (candidate) => {
    try {
      const url = getPlayableStreamUrl(candidate.stream) || await resolveTorBoxStream(candidate.stream, {
        title: media.title,
        season: episode?.seasonNumber,
        episode: episode?.episodeNumber,
      })
      const probe = await probeStreamUrl(url, 4_000)
      return { candidate, probe, playableUrl: probe?.finalUrl || url }
    } catch (_) {
      return { candidate, probe: null, playableUrl: '' }
    }
  }))
  if (signal?.aborted) return []

  // A status of 0 means the lightweight probe itself timed out or could not
  // reach the source. It is not proof that the full player cannot open it, so
  // keep that candidate as a runtime fallback. Only reject an actual HTTP
  // response that definitively failed the probe's playability checks.
  const rejected = new Set(measured
    .filter(({ probe }) => probe && probe.status > 0 && !probe.ok)
    .map(({ candidate }) => candidate.stream))
  const probedUrls = new Map(measured.map(({ candidate, playableUrl }) => [candidate.stream, playableUrl]))
  return ranked
    .filter(({ stream }) => !rejected.has(stream) && Boolean(probedUrls.get(stream) || getPlayableStreamUrl(stream)))
    .map(({ stream, score, reasons }) => ({
      stream,
      addonId: stream.addonId,
      addonName: stream.addonName,
      playableUrl: probedUrls.get(stream) || getPlayableStreamUrl(stream)!,
      score,
      reasons,
    }))
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
  allowDifferentStream = false,
): Promise<{ stream: StreamResult; addonId: string; addonName: string } | null> {
  const stremioType = mediaTypeToStremio(roomMedia.type)
  const stremioId = buildStremioId(roomMedia, roomEpisode)
  const streamAddons = getStreamAddons(stremioType)

  const allStreams: Array<StreamResult & { addonId: string; addonName: string }> = []

  for (const addon of streamAddons) {
    try {
      const results = await getAddonStreams(addon.url, stremioType, stremioId)
      for (const s of results) allStreams.push({ ...s, addonId: addon.manifest.id, addonName: addon.manifest.name })
    } catch (_) {
      // addon unavailable, skip
    }
  }

  const annotated = await annotateTorBoxStreams(allStreams).catch(() => allStreams)
  const playableStreams = annotated.filter((stream) => isPlayableStream(stream) || stream.behaviorHints?.torboxCached === true)
  if (playableStreams.length === 0) return null

  if (hostStream) {
    const matched = matchStreamToHost(playableStreams, hostStream)
    if (matched) return matched
    if (!allowDifferentStream) return null
  }

  // No host stream, or the room allows guests to use a different stream.
  const first = playableStreams[0]
  return { stream: first, addonId: first.addonId, addonName: first.addonName }
}

// ── Match against host stream ───────────────────────────────────────────────

export function matchStreamToHost(
  localStreams: Array<StreamResult & { addonId: string; addonName: string }>,
  hostStream: RoomStream,
): { stream: StreamResult; addonId: string; addonName: string } | null {
  // Priority 1: same addon + infoHash + fileIdx
  if (hostStream.addonId && hostStream.infoHash) {
    const exact = localStreams.find((s) => isSameRoomStream(s, hostStream))
    if (exact) return { stream: exact, addonId: exact.addonId, addonName: exact.addonName }
  }

  // Priority 2: same stream fingerprint
  if (hostStream.streamFingerprint) {
    const byFingerprint = localStreams.find(
      (s) => isSameRoomStream(s, hostStream),
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
