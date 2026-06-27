import type { SearchResult } from '../types'
import type { PlaybackItem } from './simkl/playback'
import { resolveAnimeIds, mapAniListEpisodeToTvdb } from './animeLists'
import { getTmdbApiKey } from './apiKeys'
import { mapEpisodeToProviders, isConfidenceSufficient } from './anime-mapping'
import type { TvdbEpisodeMappingInput } from './anime-mapping'

const API_URL = 'https://graphql.anilist.co'
const TOKEN_KEY = 'anilist_token'
const ACCOUNT_KEY = 'anilist_account'

const entriesCache: Map<string, { data: AniEntry[]; timestamp: number }> = new Map()
const mediaIdCache: Map<number, number> = new Map()
const progressCache = new Map<number, { data: AniListProgress | null; timestamp: number }>()
const progressPending = new Map<number, Promise<AniListProgress | null>>()
let trackedProgressCache: { data: AniListProgress[]; timestamp: number } | null = null
let trackedProgressPending: Promise<AniListProgress[]> | null = null
const EXACT_EPISODE_MARKS_KEY = 'anilist_exact_episode_marks'

export type AniListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REPEATING'

export interface AniListAccount {
  id: number
  name: string
  avatar?: string
}

export interface AniListContinueItem {
  id: string
  mediaId: string
  mediaType: 'series'
  title: string
  subtitle?: string
  poster?: string
  backdrop?: string
  season?: number
  episode?: number
  progressSeconds: number
  durationSeconds: number
  progressPct: number
  tmdbId?: number
  malId?: number
  anilistId: number
  updatedAt: string
}

interface AniMedia {
  id: number
  idMal?: number
  episodes?: number
  seasonYear?: number
  bannerImage?: string
  coverImage?: { extraLarge?: string; large?: string }
  title?: { userPreferred?: string; english?: string; romaji?: string }
}

interface AniEntry {
  id?: number
  progress?: number
  status?: AniListStatus
  updatedAt?: number
  media?: AniMedia
}

export interface AniListProgress {
  mediaId: number
  progress: number
  status?: AniListStatus
}

export interface AniListExactEpisodeMark {
  localId: string
  season: number
  episode: number
  anilistEpisode: number
  markedAt: string
}

export const ANILIST_LIST_SOURCES: { id: string; label: string; layout: 'poster' | 'landscape' }[] = [
  { id: 'CURRENT', label: 'AniList - Watching', layout: 'landscape' },
  { id: 'PLANNING', label: 'AniList - Planning', layout: 'poster' },
  { id: 'COMPLETED', label: 'AniList - Completed', layout: 'poster' },
  { id: 'PAUSED', label: 'AniList - Paused', layout: 'poster' },
  { id: 'DROPPED', label: 'AniList - Dropped', layout: 'poster' },
  { id: 'REPEATING', label: 'AniList - Rewatching', layout: 'landscape' },
]

export function getAniListToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setAniListToken(token: string): void {
  const clean = token.trim()
  if (clean) localStorage.setItem(TOKEN_KEY, clean)
  else localStorage.removeItem(TOKEN_KEY)
}

export function getStoredAniListAccount(): AniListAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY)
    return raw ? JSON.parse(raw) as AniListAccount : null
  } catch (_) {
    return null
  }
}

export function saveAniListAccount(account: AniListAccount | null): void {
  if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))
  else localStorage.removeItem(ACCOUNT_KEY)
}

export function isAniListConnected(): boolean {
  return Boolean(getAniListToken())
}

function exactMarkKey(mark: Pick<AniListExactEpisodeMark, 'localId' | 'season' | 'episode'>): string {
  return `${mark.localId}:${mark.season}:${mark.episode}`
}

function readExactEpisodeMarks(): AniListExactEpisodeMark[] {
  try {
    const raw = localStorage.getItem(EXACT_EPISODE_MARKS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed as AniListExactEpisodeMark[] : []
  } catch (_) {
    return []
  }
}

function writeExactEpisodeMarks(marks: AniListExactEpisodeMark[]): void {
  localStorage.setItem(EXACT_EPISODE_MARKS_KEY, JSON.stringify(marks))
}

export function hasAnyAniListExactEpisodeMarks(localId: string): boolean {
  return readExactEpisodeMarks().some((mark) => mark.localId === localId)
}

export function isAniListEpisodeMarkedExact(localId: string, season: number, episode: number): boolean {
  const key = exactMarkKey({ localId, season, episode })
  return readExactEpisodeMarks().some((mark) => exactMarkKey(mark) === key)
}

export function markAniListEpisodeExact(localId: string, season: number, episode: number, anilistEpisode: number): void {
  const key = exactMarkKey({ localId, season, episode })
  const next = readExactEpisodeMarks().filter((mark) => exactMarkKey(mark) !== key)
  next.push({ localId, season, episode, anilistEpisode, markedAt: new Date().toISOString() })
  writeExactEpisodeMarks(next)
}

export function unmarkAniListEpisodeExact(localId: string, season: number, episode: number): void {
  const key = exactMarkKey({ localId, season, episode })
  writeExactEpisodeMarks(readExactEpisodeMarks().filter((mark) => exactMarkKey(mark) !== key))
}

async function anilistRequest<T>(query: string, variables?: Record<string, unknown>, requireAuth = true): Promise<T> {
  const token = getAniListToken()
  if (requireAuth && !token) throw new Error('AniList token is missing')
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.errors?.length) {
    const message = data?.errors?.[0]?.message || `AniList request failed (${res.status})`
    throw new Error(message)
  }
  return data.data as T
}

export async function fetchAniListViewer(): Promise<AniListAccount> {
  const data = await anilistRequest<{ Viewer: { id: number; name: string; avatar?: { medium?: string } } }>(`
    query Viewer {
      Viewer { id name avatar { medium } }
    }
  `)
  const account = { id: data.Viewer.id, name: data.Viewer.name, avatar: data.Viewer.avatar?.medium }
  saveAniListAccount(account)
  return account
}

export async function resolveAniListMediaId(item: { anilistId?: unknown; malId?: unknown }): Promise<number | null> {
  const direct = toNumber(item.anilistId)
  if (direct) return direct
  const mal = toNumber(item.malId)
  if (!mal) return null

  const cached = mediaIdCache.get(mal)
  if (cached) return cached

  const data = await anilistRequest<{ Media?: { id: number } }>(`
    query Resolve($malId: Int) {
      Media(idMal: $malId, type: ANIME) { id }
    }
  `, { malId: mal }, false)
  const result = data.Media?.id ?? null
  if (result) mediaIdCache.set(mal, result)
  return result
}

export async function addToAniListPlanning(anilistId?: number | string, malId?: number | string): Promise<void> {
  if (!isAniListConnected()) return
  const mediaId = await resolveAniListMediaId({ anilistId, malId })
  if (!mediaId) throw new Error('Could not resolve AniList media ID')
  await anilistRequest(`
    mutation AddPlanning($mediaId: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status) { id }
    }
  `, { mediaId, status: 'PLANNING' })
  entriesCache.clear()
}

export async function removeFromAniListList(anilistId?: number | string, malId?: number | string): Promise<void> {
  if (!isAniListConnected()) return
  const mediaId = await resolveAniListMediaId({ anilistId, malId })
  if (!mediaId) return
  const data = await anilistRequest<{ MediaList?: { id: number } }>(`
    query GetEntry($mediaId: Int) {
      MediaList(mediaId: $mediaId) { id }
    }
  `, { mediaId })
  if (!data.MediaList?.id) return
  await anilistRequest(`
    mutation DeleteEntry($id: Int) {
      DeleteMediaListEntry(id: $id) { deleted }
    }
  `, { id: data.MediaList.id })
  entriesCache.clear()
}

export async function isInAniListList(anilistId?: number | string, malId?: number | string): Promise<boolean> {
  if (!isAniListConnected()) return false
  const mediaId = await resolveAniListMediaId({ anilistId, malId })
  if (!mediaId) return false
  const data = await anilistRequest<{ MediaList?: { id: number } }>(`
    query GetEntry($mediaId: Int) {
      MediaList(mediaId: $mediaId) { id }
    }
  `, { mediaId })
  return Boolean(data.MediaList?.id)
}

export async function getAniListProgress(anilistId?: number | string, malId?: number | string): Promise<AniListProgress | null> {
  if (!isAniListConnected()) return null
  const mediaId = await resolveAniListMediaId({ anilistId, malId })
  if (!mediaId) return null
  const cached = progressCache.get(mediaId)
  if (cached && Date.now() - cached.timestamp < 30_000) return cached.data
  const existing = progressPending.get(mediaId)
  if (existing) return existing

  const request = anilistRequest<{ MediaList?: { mediaId?: number; progress?: number; status?: AniListStatus } }>(`
      query GetProgress($mediaId: Int) {
        MediaList(mediaId: $mediaId) { mediaId progress status }
      }
    `, { mediaId })
    .then((data) => data.MediaList ? {
      mediaId: data.MediaList.mediaId || mediaId,
      progress: Math.max(0, Number(data.MediaList.progress) || 0),
      status: data.MediaList.status,
    } : null)
    .then((data) => {
      progressCache.set(mediaId, { data, timestamp: Date.now() })
      return data
    })
    .finally(() => progressPending.delete(mediaId))

  progressPending.set(mediaId, request)
  return request
}

export async function getAniListTrackedProgress(): Promise<AniListProgress[]> {
  if (!isAniListConnected()) return []
  if (trackedProgressCache && Date.now() - trackedProgressCache.timestamp < 30_000) return trackedProgressCache.data
  if (trackedProgressPending) return trackedProgressPending

  trackedProgressPending = (async () => {
    const viewer = getStoredAniListAccount() || await fetchAniListViewer()
    const statuses: AniListStatus[] = ['CURRENT', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']
    const groups = await Promise.all(statuses.map((status) => getAniListEntries(viewer.name, status)))
    const items = groups.flatMap((entries) => entries.map((entry) => ({
      mediaId: entry.media?.id || 0,
      progress: Math.max(0, Number(entry.progress) || 0),
      status: entry.status,
    }))).filter((entry) => entry.mediaId > 0)
    trackedProgressCache = { data: items, timestamp: Date.now() }
    return items
  })().finally(() => { trackedProgressPending = null })

  return trackedProgressPending
}

export async function saveAniListProgress(item: PlaybackItem, progressRatio: number): Promise<void> {
  if (!isAniListConnected()) return
  const mediaId = await resolveAniListMediaId(item)
  if (!mediaId) return
  const episode = toNumber(item.episode)
  if (!episode) return
  const media = await getAniListMedia(mediaId)
  const totalEpisodes = media?.episodes ?? 0
  const status: AniListStatus = totalEpisodes > 0 && (episode >= totalEpisodes || progressRatio >= 0.9) ? 'COMPLETED' : 'CURRENT'
  await anilistRequest(`
    mutation SaveProgress($mediaId: Int, $progress: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) { id }
    }
  `, { mediaId, progress: episode, status })
  entriesCache.clear()
  progressCache.delete(mediaId)
  trackedProgressCache = null
}

export async function saveAniListProgressMapped(
  item: PlaybackItem,
  progressRatio: number,
): Promise<void> {
  if (!isAniListConnected()) return

  if (item.tvdbId && item.localId && item.season != null && item.episode != null) {
    try {
      const epInput: TvdbEpisodeMappingInput = {
        localMediaId: item.localId,
        tvdbSeriesId: item.tvdbId,
        tvdbSeasonNumber: item.season,
        tvdbEpisodeNumber: item.episode,
      }
      const mapping = await mapEpisodeToProviders(epInput)
      if (mapping?.anilist && isConfidenceSufficient(mapping)) {
        const mediaId = mapping.anilist.mediaId
        const episode = mapping.anilist.episodeNumber
        if (mediaId && episode) {
          const media = await getAniListMedia(mediaId)
          const totalEpisodes = media?.episodes ?? 0
          const status: AniListStatus = totalEpisodes > 0 && (episode >= totalEpisodes || progressRatio >= 0.9) ? 'COMPLETED' : 'CURRENT'
          await anilistRequest(`
            mutation SaveProgress($mediaId: Int, $progress: Int, $status: MediaListStatus) {
              SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) { id }
            }
          `, { mediaId, progress: episode, status })
          entriesCache.clear()
          progressCache.delete(mediaId)
          trackedProgressCache = null
          return
        }
      }
    } catch (e) {
      console.warn('[anilist] animeApi mapped save failed, falling back:', e)
    }
  }

  return saveAniListProgress(item, progressRatio)
}

export async function getAniListContinueWatching(): Promise<AniListContinueItem[]> {
  const viewer = getStoredAniListAccount() || await fetchAniListViewer()
  const entries = await getAniListEntries(viewer.name, 'CURRENT')
  const items = await Promise.all(entries.map(async (entry): Promise<AniListContinueItem | null> => {
    const media = entry.media
    if (!media?.id) return null
    const total = media.episodes || 0
    const progress = entry.progress || 0
    if (total > 0 && progress >= total) return null
    const nextEpisode = progress + 1
    const durationSeconds = 24 * 60

    let mediaId = `anilist-${media.id}`
    let seasonNum = 1
    let episodeNum = nextEpisode
    let tmdbId: number | undefined

    try {
      const mapped = await mapAniListEpisodeToTvdb(media.id, nextEpisode)
      if (mapped) {
        mediaId = `tvdb-${mapped.tvdbId}`
        seasonNum = mapped.season
        episodeNum = mapped.episode
      }
      const idMap = await resolveAnimeIds({ anilistId: media.id, malId: media.idMal })
      if (idMap?.tmdbId) tmdbId = idMap.tmdbId
      if (!mapped && idMap?.tvdbId) {
        mediaId = `tvdb-${idMap.tvdbId}`
        if (idMap.tvdbSeason != null && idMap.tvdbSeason > 0) {
          seasonNum = idMap.tvdbSeason
          if (idMap.tvdbEpOffset != null) {
            episodeNum = nextEpisode - idMap.tvdbEpOffset
            if (episodeNum <= 0) episodeNum = nextEpisode
          }
        }
      }
    } catch (_) { /* ignore */ }

    let poster: string | undefined
    let backdrop: string | undefined
    if (tmdbId) {
      const tmdbApiKey = getTmdbApiKey()
      if (tmdbApiKey) {
        try {
          const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbApiKey}`)
          if (res.ok) {
            const tmdbData = await res.json()
            if (tmdbData.poster_path) poster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`
            if (tmdbData.backdrop_path) backdrop = `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`
          }
        } catch (_) { /* ignore */ }
      }
    }
    if (!poster) poster = media.coverImage?.extraLarge || media.coverImage?.large
    if (!backdrop) backdrop = media.bannerImage

    return {
      id: `${mediaId}-${seasonNum}-${episodeNum}`,
      mediaId,
      mediaType: 'series',
      title: mediaTitle(media),
      subtitle: `S${seasonNum}E${episodeNum}`,
      poster,
      backdrop,
      season: seasonNum,
      episode: episodeNum,
      progressSeconds: 0,
      durationSeconds,
      progressPct: total > 0 ? Math.min(99, (progress / total) * 100) : 0,
      tmdbId,
      malId: media.idMal,
      anilistId: media.id,
      updatedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : new Date(0).toISOString(),
    } satisfies AniListContinueItem
  }))
  const filtered = items
    .filter((item): item is AniListContinueItem => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  const seenMediaIds = new Set<string>()
  const deduplicatedItems: AniListContinueItem[] = []
  for (const item of filtered) {
    if (seenMediaIds.has(item.mediaId)) continue
    seenMediaIds.add(item.mediaId)
    deduplicatedItems.push(item)
  }

  return deduplicatedItems
}

export async function getAniListList(status: AniListStatus | string): Promise<SearchResult[]> {
  const viewer = getStoredAniListAccount() || await fetchAniListViewer()
  const entries = await getAniListEntries(viewer.name, status as AniListStatus)
  const results = await Promise.all(entries.map((entry) => anilistEntryToSearchResult(entry)))
  return results.filter((item): item is SearchResult => item !== null)
}

export async function getAniListWatched(): Promise<AniEntry[]> {
  const viewer = getStoredAniListAccount() || await fetchAniListViewer()
  return getAniListEntries(viewer.name, 'COMPLETED')
}

async function anilistEntryToSearchResult(entry: AniEntry): Promise<SearchResult | null> {
  const media = entry.media
  if (!media?.id) return null

  let id = `anilist-${media.id}`
  let provider = 'anilist'
  let imdbId: string | undefined
  let tmdbId: number | undefined
  let tvdbId: number | undefined
  try {
    const mapped = await resolveAnimeIds({ anilistId: media.id, malId: media.idMal })
    if (mapped?.tvdbId) {
      id = `tvdb-${mapped.tvdbId}`
      provider = 'tvdb'
      tvdbId = mapped.tvdbId
    }
    if (mapped?.imdbId) imdbId = mapped.imdbId
    if (mapped?.tmdbId) tmdbId = mapped.tmdbId
  } catch (_) { /* ignore */ }

  const anilistPoster = media.coverImage?.extraLarge || media.coverImage?.large
  const anilistBackdrop = media.bannerImage

  return {
    id,
    title: mediaTitle(media),
    type: 'series',
    year: media.seasonYear,
    poster: anilistPoster,
    backdrop: anilistBackdrop,
    provider,
    imdbId,
    tmdbId,
    tvdbId,
    malId: media.idMal,
    anilistId: media.id,
    isAnime: true,
  }
}

async function getAniListMedia(id: number): Promise<AniMedia | null> {
  const data = await anilistRequest<{ Media?: AniMedia }>(`
    query Media($id: Int) {
      Media(id: $id, type: ANIME) { id idMal episodes }
    }
  `, { id })
  return data.Media || null
}

async function getAniListEntries(userName: string, status: AniListStatus): Promise<AniEntry[]> {
  const cacheKey = `${userName}:${status}`
  const cached = entriesCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.timestamp < 30000) {
    return cached.data
  }

  const data = await anilistRequest<{ MediaListCollection?: { lists?: { entries?: AniEntry[] }[] } }>(`
    query Lists($userName: String, $status: MediaListStatus) {
      MediaListCollection(userName: $userName, type: ANIME, status: $status) {
        lists {
          entries {
            id
            progress
            status
            updatedAt
            media {
              id
              idMal
              episodes
              seasonYear
              bannerImage
              coverImage { extraLarge large }
              title { userPreferred english romaji }
            }
          }
        }
      }
    }
  `, { userName, status })
  const result = data.MediaListCollection?.lists?.flatMap((list) => list.entries || []) || []
  entriesCache.set(cacheKey, { data: result, timestamp: now })
  return result
}

function mediaTitle(media: AniMedia): string {
  return media.title?.userPreferred || media.title?.english || media.title?.romaji || `AniList ${media.id}`
}

function toNumber(value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : undefined
}
