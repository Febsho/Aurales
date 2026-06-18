import type { AnimeApiEntry } from './types'

const DEFAULT_BASE_URL = 'https://animeapi.my.id'
const SETTINGS_KEY = 'animeapi_base_url'
const ENABLED_KEY = 'animeapi_enabled'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1_000

let mockMode = false

export function setAnimeApiMockMode(enabled: boolean): void {
  mockMode = enabled
}

export function isAnimeApiMockMode(): boolean {
  return mockMode
}

export function getAnimeApiBaseUrl(): string {
  return localStorage.getItem(SETTINGS_KEY) || DEFAULT_BASE_URL
}

export function setAnimeApiBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (trimmed) localStorage.setItem(SETTINGS_KEY, trimmed)
  else localStorage.removeItem(SETTINGS_KEY)
}

export function isAnimeApiEnabled(): boolean {
  const val = localStorage.getItem(ENABLED_KEY)
  return val !== 'false'
}

export function setAnimeApiEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(enabled))
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function animeApiGet<T>(path: string): Promise<T | null> {
  if (mockMode) return null
  if (!isAnimeApiEnabled()) return null

  const baseUrl = getAnimeApiBaseUrl()
  const url = `${baseUrl}${path}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS)
      if (res.status === 404) return null
      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)))
          continue
        }
        console.warn(`[animeApi] rate limited: ${path}`)
        return null
      }
      if (!res.ok) {
        console.warn(`[animeApi] HTTP ${res.status} for ${path}`)
        return null
      }
      return await res.json() as T
    } catch (e) {
      if (attempt < MAX_RETRIES && e instanceof Error && e.name !== 'AbortError') {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        continue
      }
      console.warn(`[animeApi] request failed: ${path}`, e)
      return null
    }
  }
  return null
}

export async function lookupByTvdb(tvdbId: number): Promise<AnimeApiEntry[] | null> {
  const result = await animeApiGet<AnimeApiEntry | AnimeApiEntry[]>(`/thetvdb/${tvdbId}`)
  if (!result) return null
  return Array.isArray(result) ? result : [result]
}

export async function lookupByTvdbSeries(tvdbId: number): Promise<AnimeApiEntry[] | null> {
  const result = await animeApiGet<AnimeApiEntry | AnimeApiEntry[]>(`/thetvdb/series/${tvdbId}`)
  if (!result) return null
  return Array.isArray(result) ? result : [result]
}

export async function lookupByAniList(anilistId: number): Promise<AnimeApiEntry | null> {
  return animeApiGet<AnimeApiEntry>(`/anilist/${anilistId}`)
}

export async function lookupByMal(malId: number): Promise<AnimeApiEntry | null> {
  return animeApiGet<AnimeApiEntry>(`/myanimelist/${malId}`)
}

export async function lookupByTrakt(traktId: number): Promise<AnimeApiEntry | null> {
  return animeApiGet<AnimeApiEntry>(`/trakt/shows/${traktId}`)
}

export async function lookupBySimkl(simklId: number): Promise<AnimeApiEntry | null> {
  return animeApiGet<AnimeApiEntry>(`/simkl/${simklId}`)
}

export async function lookupByKitsu(kitsuId: number): Promise<AnimeApiEntry | null> {
  return animeApiGet<AnimeApiEntry>(`/kitsu/${kitsuId}`)
}

export async function lookupByAniDb(anidbId: number): Promise<AnimeApiEntry | null> {
  return animeApiGet<AnimeApiEntry>(`/anidb/${anidbId}`)
}
