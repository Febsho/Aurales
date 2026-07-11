import type { SearchResult } from '../types'
import type { PlaybackItem } from './simkl/playback'
import { invoke } from '@tauri-apps/api/core'
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
  updatedAt?: number
  /** Total episodes of the media (null/0 when AniList doesn't know, e.g. ongoing). */
  episodes?: number
  /** Number of completed rewatches. */
  repeat?: number
}

/** Rich AniList list entry with everything the sync needs (req 1). */
export interface AniListFullEntry {
  mediaId: number
  idMal?: number
  status?: AniListStatus
  progress: number
  repeat: number
  score?: number
  updatedAt?: number
  episodes?: number
  title: string
  titles: { userPreferred?: string; english?: string; romaji?: string; native?: string }
  seasonYear?: number
  poster?: string
  backdrop?: string
}

let fullListCache: { data: AniListFullEntry[]; timestamp: number } | null = null
let fullListPending: Promise<AniListFullEntry[]> | null = null

export interface AniListExactEpisodeMark {
  localId: string
  season: number
  episode: number
  anilistEpisode: number
  markedAt: string
  watched?: boolean
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
  return readExactEpisodeMarks().some((mark) => exactMarkKey(mark) === key && mark.watched !== false)
}

export function hasAniListEpisodeExactState(localId: string, season: number, episode: number): boolean {
  const key = exactMarkKey({ localId, season, episode })
  return readExactEpisodeMarks().some((mark) => exactMarkKey(mark) === key)
}

export function getAniListEpisodeExactState(localId: string, season: number, episode: number): AniListExactEpisodeMark | null {
  const key = exactMarkKey({ localId, season, episode })
  return readExactEpisodeMarks().find((mark) => exactMarkKey(mark) === key) || null
}

export function markAniListEpisodeExact(localId: string, season: number, episode: number, anilistEpisode: number): void {
  const key = exactMarkKey({ localId, season, episode })
  const next = readExactEpisodeMarks().filter((mark) => exactMarkKey(mark) !== key)
  next.push({ localId, season, episode, anilistEpisode, markedAt: new Date().toISOString(), watched: true })
  writeExactEpisodeMarks(next)
}

export function unmarkAniListEpisodeExact(localId: string, season: number, episode: number): void {
  const key = exactMarkKey({ localId, season, episode })
  const marks = readExactEpisodeMarks()
  const previous = marks.find((mark) => exactMarkKey(mark) === key)
  const next = marks.filter((mark) => exactMarkKey(mark) !== key)
  next.push({ localId, season, episode, anilistEpisode: previous?.anilistEpisode ?? episode, markedAt: new Date().toISOString(), watched: false })
  writeExactEpisodeMarks(next)
}

async function anilistRequest<T>(query: string, variables?: Record<string, unknown>, requireAuth = true): Promise<T> {
  const token = getAniListToken()
  if (requireAuth && !token) throw new Error('AniList token is missing')
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const body = JSON.stringify({ query, variables })
  let data: any
  try {
    const res = await fetch(API_URL, { method: 'POST', headers, body })
    data = await res.json().catch(() => null)
    if (!res.ok || data?.errors?.length) {
      const message = data?.errors?.[0]?.message || `AniList request failed (${res.status})`
      throw new Error(message)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/failed to fetch|networkerror|load failed/i.test(message)) throw error
    try {
      const raw = await invoke<string>('http_request', { method: 'POST', url: API_URL, headers, body })
      data = JSON.parse(raw)
    } catch (nativeError) {
      throw new Error(`AniList network request failed: ${nativeError instanceof Error ? nativeError.message : nativeError}`)
    }
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || 'AniList returned an error')
  }
  return data.data as T
}

export function clearAniListProgressCaches(): void {
  entriesCache.clear()
  progressCache.clear()
  progressPending.clear()
  trackedProgressCache = null
  trackedProgressPending = null
  fullListCache = null
  fullListPending = null
  titleSearchCache.clear()
  // A manual provider sync means AniList is the source of truth. Remove local
  // exact mark/unmark overrides left by previous dropdown actions so they
  // cannot permanently mask newer remote progress.
  localStorage.removeItem(EXACT_EPISODE_MARKS_KEY)
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

const titleSearchCache = new Map<string, number | null>()

function normalizeTitleForMatch(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '')
}

/**
 * Last-resort AniList id resolution by title search (req 3). Only accepts
 * confident matches so remakes/sequels/seasons aren't confused: an exact
 * normalized-title match, or a partial match confirmed by release year. Returns
 * null when ambiguous — a wrong match would falsely mark episodes watched.
 */
export async function searchAniListMediaId(title: string, year?: number): Promise<number | null> {
  const clean = title?.trim()
  if (!clean) return null
  const cacheKey = `${normalizeTitleForMatch(clean)}|${year ?? ''}`
  if (titleSearchCache.has(cacheKey)) return titleSearchCache.get(cacheKey)!

  try {
    const data = await anilistRequest<{ Page?: { media?: { id: number; seasonYear?: number; format?: string; title?: { romaji?: string; english?: string; native?: string; userPreferred?: string }; synonyms?: string[] }[] } }>(`
      query Search($search: String) {
        Page(perPage: 8) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id seasonYear format
            title { romaji english native userPreferred }
            synonyms
          }
        }
      }
    `, { search: clean }, false)

    const media = data.Page?.media || []
    const target = normalizeTitleForMatch(clean)
    let best: { id: number; score: number } | null = null
    for (const m of media) {
      const names = [m.title?.romaji, m.title?.english, m.title?.native, m.title?.userPreferred, ...(m.synonyms || [])]
        .filter((n): n is string => Boolean(n))
      const exact = names.some((n) => normalizeTitleForMatch(n) === target)
      let score = 0
      if (exact) {
        score = 100
      } else {
        const contains = names.some((n) => { const nn = normalizeTitleForMatch(n); return nn.length > 3 && (nn.includes(target) || target.includes(nn)) })
        if (!contains) continue
        score = 60
      }
      if (year != null && m.seasonYear != null) score += Math.abs(m.seasonYear - year) <= 1 ? 10 : -25
      if (m.format === 'TV' || m.format === 'TV_SHORT' || m.format === 'ONA' || m.format === 'MOVIE') score += 5
      if (!best || score > best.score) best = { id: m.id, score }
    }
    // Require high confidence: exact title, or a partial match confirmed by year.
    const result = best && best.score >= 70 ? best.id : null
    titleSearchCache.set(cacheKey, result)
    if (import.meta.env.DEV) console.log(`[anilist-search] "${clean}" (${year ?? '?'}) → ${result ?? 'no confident match'}`)
    return result
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[anilist-search] failed:', e)
    titleSearchCache.set(cacheKey, null)
    return null
  }
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
  // Viewer-scoped lookup via Media.mediaListEntry (root MediaList isn't scoped).
  const data = await anilistRequest<{ Media?: { mediaListEntry?: { id: number } } }>(`
    query GetEntry($mediaId: Int) {
      Media(id: $mediaId, type: ANIME) { mediaListEntry { id } }
    }
  `, { mediaId })
  const entryId = data.Media?.mediaListEntry?.id
  if (!entryId) return
  await anilistRequest(`
    mutation DeleteEntry($id: Int) {
      DeleteMediaListEntry(id: $id) { deleted }
    }
  `, { id: entryId })
  entriesCache.clear()
  progressCache.delete(mediaId)
  trackedProgressCache = null
}

export async function isInAniListList(anilistId?: number | string, malId?: number | string): Promise<boolean> {
  if (!isAniListConnected()) return false
  const mediaId = await resolveAniListMediaId({ anilistId, malId })
  if (!mediaId) return false
  // Viewer-scoped lookup via Media.mediaListEntry (root MediaList isn't scoped).
  const data = await anilistRequest<{ Media?: { mediaListEntry?: { id: number } } }>(`
    query GetEntry($mediaId: Int) {
      Media(id: $mediaId, type: ANIME) { mediaListEntry { id } }
    }
  `, { mediaId })
  return Boolean(data.Media?.mediaListEntry?.id)
}

export async function getAniListProgress(anilistId?: number | string, malId?: number | string): Promise<AniListProgress | null> {
  if (!isAniListConnected()) return null
  const mediaId = await resolveAniListMediaId({ anilistId, malId })
  if (!mediaId) return null
  const cached = progressCache.get(mediaId)
  if (cached && Date.now() - cached.timestamp < 30_000) return cached.data
  const existing = progressPending.get(mediaId)
  if (existing) return existing

  // Use Media.mediaListEntry (authenticated-user scoped), NOT the root
  // MediaList(mediaId:) query — the latter isn't scoped to the viewer without a
  // userId and returns an arbitrary/other user's entry for the same media.
  const request = anilistRequest<{ Media?: { id?: number; episodes?: number; mediaListEntry?: { status?: AniListStatus; progress?: number; repeat?: number; updatedAt?: number } } }>(`
      query GetProgress($mediaId: Int) {
        Media(id: $mediaId, type: ANIME) {
          id episodes
          mediaListEntry { status progress repeat updatedAt }
        }
      }
    `, { mediaId })
    .then((data) => {
      const listEntry = data.Media?.mediaListEntry
      return listEntry ? {
        mediaId,
        progress: Math.max(0, Number(listEntry.progress) || 0),
        status: listEntry.status,
        updatedAt: listEntry.updatedAt,
        episodes: data.Media?.episodes,
        repeat: Math.max(0, Number(listEntry.repeat) || 0),
      } : null
    })
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
    // Back the tracked-progress view with the full MediaListCollection so callers
    // get episode counts and repeat data (needed for accurate COMPLETED detection).
    const full = await getAniListFullList()
    const items: AniListProgress[] = full
      .filter((entry) => entry.status !== 'PLANNING')
      .map((entry) => ({
        mediaId: entry.mediaId,
        progress: entry.progress,
        status: entry.status,
        updatedAt: entry.updatedAt,
        episodes: entry.episodes,
        repeat: entry.repeat,
      }))
    trackedProgressCache = { data: items, timestamp: Date.now() }
    return items
  })().finally(() => { trackedProgressPending = null })

  return trackedProgressPending
}

/**
 * Fetch the viewer's complete anime MediaListCollection in one request — every
 * status, with media id, MAL id, status, progress, repeat, score, updatedAt,
 * total episodes, and titles (req 1). Cached for 30s; force bypasses the cache.
 */
export async function getAniListFullList(force = false): Promise<AniListFullEntry[]> {
  if (!isAniListConnected()) return []
  if (!force && fullListCache && Date.now() - fullListCache.timestamp < 30_000) return fullListCache.data
  if (!force && fullListPending) return fullListPending

  const run = (async () => {
    const viewer = getStoredAniListAccount() || await fetchAniListViewer()
    const data = await anilistRequest<{ MediaListCollection?: { lists?: { entries?: (AniEntry & { repeat?: number; score?: number })[] }[] } }>(`
      query FullList($userName: String) {
        MediaListCollection(userName: $userName, type: ANIME) {
          lists {
            entries {
              id
              status
              progress
              repeat
              score
              updatedAt
              media {
                id
                idMal
                episodes
                seasonYear
                bannerImage
                coverImage { extraLarge large }
                title { userPreferred english romaji native }
              }
            }
          }
        }
      }
    `, { userName: viewer.name })

    const raw = data.MediaListCollection?.lists?.flatMap((list) => list.entries || []) || []
    const entries: AniListFullEntry[] = raw
      .filter((entry) => entry.media?.id)
      .map((entry) => {
        const media = entry.media!
        return {
          mediaId: media.id,
          idMal: media.idMal,
          status: entry.status,
          progress: Math.max(0, Number(entry.progress) || 0),
          repeat: Math.max(0, Number((entry as { repeat?: number }).repeat) || 0),
          score: (entry as { score?: number }).score,
          updatedAt: entry.updatedAt,
          episodes: media.episodes,
          title: mediaTitle(media),
          titles: {
            userPreferred: media.title?.userPreferred,
            english: media.title?.english,
            romaji: media.title?.romaji,
            native: (media.title as { native?: string } | undefined)?.native,
          },
          seasonYear: media.seasonYear,
          poster: media.coverImage?.extraLarge || media.coverImage?.large,
          backdrop: media.bannerImage,
        }
      })
    fullListCache = { data: entries, timestamp: Date.now() }
    return entries
  })()

  if (!force) fullListPending = run.finally(() => { fullListPending = null })
  return run
}

/**
 * An AniList entry counts as "fully watched" (title-level) when it is COMPLETED,
 * has at least one rewatch, or its progress covers all known episodes. REPEATING
 * implies it was completed at least once. PAUSED/DROPPED/CURRENT partials are not
 * title-watched but still carry episode progress used elsewhere.
 */
function isEntryFullyWatched(entry: AniListFullEntry): boolean {
  if (entry.status === 'COMPLETED' || entry.status === 'REPEATING') return true
  if (entry.repeat > 0) return true
  if (entry.episodes && entry.episodes > 0 && entry.progress >= entry.episodes) return true
  return false
}

/**
 * Watched-key list for the fast title-level watched cache (watchedCacheStore).
 * Emits anilist:/mal: keys for every fully-watched entry plus resolved
 * tmdb:/tvdb:/imdb: keys so anime completed on AniList is recognised across the
 * app regardless of which id a given catalog item carries.
 */
export async function getAniListWatchedTitleKeys(): Promise<string[]> {
  if (!isAniListConnected()) return []
  const list = await getAniListFullList()
  const watched = list.filter(isEntryFullyWatched)
  const keys = new Set<string>()

  // Resolve external ids with limited concurrency (resolveAnimeIds is cached, so
  // repeat runs are cheap). Failures are non-fatal — anilist:/mal: keys remain.
  let cursor = 0
  const worker = async () => {
    while (cursor < watched.length) {
      const entry = watched[cursor++]
      keys.add(`anilist:${entry.mediaId}`)
      if (entry.idMal) keys.add(`mal:${entry.idMal}`)
      try {
        const ids = await resolveAnimeIds({ anilistId: entry.mediaId, malId: entry.idMal })
        if (ids?.tmdbId) keys.add(`tmdb:${ids.tmdbId}`)
        if (ids?.tvdbId) keys.add(`tvdb:${ids.tvdbId}`)
        if (ids?.imdbId) keys.add(`imdb:${ids.imdbId}`)
      } catch (_) { /* keep anilist/mal keys */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, watched.length) }, worker))
  return [...keys]
}

export interface AniListSyncReport {
  found: number
  matched: number
  episodesImported: number
  unmatched: { anilistId: number; title: string }[]
  errors: string[]
}

/**
 * Manual "Sync from AniList": pulls the full list, resolves each entry to local
 * ids, populates the watched-key cache, and returns a detailed report (req 9).
 * Emits development logging for every entry, resolution, and failure (req 7).
 */
export async function syncAniListWatchedHistory(): Promise<AniListSyncReport> {
  const report: AniListSyncReport = { found: 0, matched: 0, episodesImported: 0, unmatched: [], errors: [] }
  if (!isAniListConnected()) { report.errors.push('AniList is not connected'); return report }

  try {
    clearAniListProgressCaches()
    const list = await getAniListFullList(true)
    report.found = list.length
    console.log(`[anilist-sync] Fetched ${list.length} AniList entries`)

    const keys = new Set<string>()
    let cursor = 0
    const worker = async () => {
      while (cursor < list.length) {
        const entry = list[cursor++]
        report.episodesImported += entry.progress
        const fully = isEntryFullyWatched(entry)
        let method = 'anilist-id'
        let resolvedLocal: string | undefined
        try {
          const ids = await resolveAnimeIds({ anilistId: entry.mediaId, malId: entry.idMal })
          if (ids?.tmdbId) { resolvedLocal = `tmdb-${ids.tmdbId}`; method = 'fribb-map' }
          else if (ids?.tvdbId) { resolvedLocal = `tvdb-${ids.tvdbId}`; method = 'fribb-map' }
          else if (ids?.imdbId) { resolvedLocal = ids.imdbId; method = 'fribb-map' }
          if (resolvedLocal) {
            report.matched++
            if (fully) {
              keys.add(`anilist:${entry.mediaId}`)
              if (entry.idMal) keys.add(`mal:${entry.idMal}`)
              if (ids?.tmdbId) keys.add(`tmdb:${ids.tmdbId}`)
              if (ids?.tvdbId) keys.add(`tvdb:${ids.tvdbId}`)
              if (ids?.imdbId) keys.add(`imdb:${ids.imdbId}`)
            }
          } else {
            report.unmatched.push({ anilistId: entry.mediaId, title: entry.title })
          }
        } catch (e) {
          report.errors.push(`${entry.title}: ${e instanceof Error ? e.message : String(e)}`)
          report.unmatched.push({ anilistId: entry.mediaId, title: entry.title })
        }
        console.log(`[anilist-sync] entry anilist=${entry.mediaId} mal=${entry.idMal ?? '-'} "${entry.title}" status=${entry.status} progress=${entry.progress}/${entry.episodes ?? '?'} → local=${resolvedLocal ?? 'UNMATCHED'} via=${resolvedLocal ? method : 'none'} watched=${fully}`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker))

    if (keys.size > 0) {
      const { useWatchedCacheStore } = await import('../stores/watchedCacheStore')
      useWatchedCacheStore.getState().addWatchedKeys(keys)
    }
    console.log(`[anilist-sync] Done: found=${report.found} matched=${report.matched} episodes=${report.episodesImported} unmatched=${report.unmatched.length} errors=${report.errors.length}`)
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e))
    console.error('[anilist-sync] Sync failed:', e)
  }
  return report
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
