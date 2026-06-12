import type { SearchResult } from '../types'
import type { PlaybackItem } from './simkl/playback'
import { resolveAnimeIds, mapAniListEpisodeToTvdb } from './animeLists'

const API_URL = 'https://graphql.anilist.co'
const TOKEN_KEY = 'anilist_token'
const ACCOUNT_KEY = 'anilist_account'

const entriesCache: Map<string, { data: AniEntry[]; timestamp: number }> = new Map()
const mediaIdCache: Map<number, number> = new Map()

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
  } catch {
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

    try {
      const mapped = await mapAniListEpisodeToTvdb(media.id, nextEpisode)
      if (mapped) {
        mediaId = `tvdb-${mapped.tvdbId}`
        seasonNum = mapped.season
        episodeNum = mapped.episode
      } else {
        const idMap = await resolveAnimeIds({ anilistId: media.id, malId: media.idMal })
        if (idMap?.tvdbId) {
          mediaId = `tvdb-${idMap.tvdbId}`
          // Use tvdbSeason and tvdbEpOffset if available for better season assignment
          if (idMap.tvdbSeason != null && idMap.tvdbSeason > 0) {
            seasonNum = idMap.tvdbSeason
            if (idMap.tvdbEpOffset != null) {
              episodeNum = nextEpisode - idMap.tvdbEpOffset
              if (episodeNum <= 0) episodeNum = nextEpisode // safety fallback
            }
          }
        }
      }
    } catch { /* ignore */ }

    return {
      id: `${mediaId}-${seasonNum}-${episodeNum}`,
      mediaId,
      mediaType: 'series',
      title: mediaTitle(media),
      subtitle: `S${seasonNum}E${episodeNum}`,
      poster: media.coverImage?.extraLarge || media.coverImage?.large,
      backdrop: media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large,
      season: seasonNum,
      episode: episodeNum,
      progressSeconds: 0,
      durationSeconds,
      progressPct: total > 0 ? Math.min(99, (progress / total) * 100) : 0,
      malId: media.idMal,
      anilistId: media.id,
      updatedAt: entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : new Date(0).toISOString(),
    } satisfies AniListContinueItem
  }))
  return items
    .filter((item): item is AniListContinueItem => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
  let tmdbPoster: string | undefined
  let tmdbBackdrop: string | undefined
  try {
    const mapped = await resolveAnimeIds({ anilistId: media.id, malId: media.idMal })
    if (mapped?.tvdbId) {
      id = `tvdb-${mapped.tvdbId}`
      provider = 'tvdb'
      tvdbId = mapped.tvdbId
    }
    if (mapped?.imdbId) imdbId = mapped.imdbId
    if (mapped?.tmdbId) {
      tmdbId = mapped.tmdbId
      const tmdbApiKey = localStorage.getItem('tmdb_api_key') || ''
      if (tmdbApiKey) {
        try {
          const res = await fetch(`https://api.themoviedb.org/3/tv/${mapped.tmdbId}?api_key=${tmdbApiKey}`)
          if (res.ok) {
            const tmdbData = await res.json()
            if (tmdbData.poster_path) tmdbPoster = `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`
            if (tmdbData.backdrop_path) tmdbBackdrop = `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}`
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  const anilistPoster = media.coverImage?.extraLarge || media.coverImage?.large
  const anilistBackdrop = media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large

  return {
    id,
    title: mediaTitle(media),
    type: 'series',
    year: media.seasonYear,
    poster: tmdbPoster || anilistPoster,
    backdrop: tmdbBackdrop || anilistBackdrop,
    provider,
    imdbId,
    tmdbId,
    tvdbId,
    malId: media.idMal,
    anilistId: media.id,
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
