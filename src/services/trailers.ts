import { invoke } from '@tauri-apps/api/core'
import { getTmdbApiKey } from './apiKeys'
import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'

const TMDB_BASE_URL = 'https://api.themoviedb.org/3'

export type TrailerSource = {
  source: 'tmdb' | 'youtube'
  site: 'YouTube'
  key: string
  url: string
  embedUrl: string
  thumbnailUrl: string
  language?: string
  official?: boolean
}

interface TrailerLookupInput {
  type: 'movie' | 'series' | 'show' | 'anime'
  tmdbId?: string | number
  title: string
  year?: number
  language?: string
}

interface TmdbVideo {
  id?: string
  key?: string
  site?: string
  type?: string
  official?: boolean
  iso_639_1?: string | null
  name?: string
}

const REJECT_YOUTUBE_TERMS = [
  'fan trailer',
  'concept trailer',
  'reaction',
  'review',
  'explained',
  'breakdown',
  'ending',
  'clip',
]

function mediaTypeForTmdb(type: TrailerLookupInput['type']): 'movie' | 'tv' {
  return type === 'movie' ? 'movie' : 'tv'
}

export function youtubeThumbnailUrl(key: string, quality: 'max' | 'high' = 'max'): string {
  return `https://i.ytimg.com/vi/${key}/${quality === 'max' ? 'maxresdefault' : 'hqdefault'}.jpg`
}

export function buildYoutubeEmbedUrl(key: string, options: { muted?: boolean } = {}): string {
  const pageOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined
  // YouTube rejects non-HTTP origins such as tauri://localhost when `origin` is
  // supplied. The embed works without it because we do not need the iframe API.
  const origin = pageOrigin && /^https?:\/\//.test(pageOrigin) ? pageOrigin : undefined
  const params = new URLSearchParams({
    autoplay: '1',
    mute: options.muted === false ? '0' : '1',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    iv_load_policy: '3',
    cc_load_policy: '0',
    enablejsapi: '1',
    autohide: '1',
    showinfo: '0',
    vq: 'highres',
  })
  if (origin) params.set('origin', origin)
  return `https://www.youtube-nocookie.com/embed/${key}?${params.toString()}`
}

function makeYoutubeSource(key: string, source: TrailerSource['source'], language?: string, official?: boolean): TrailerSource {
  return {
    source,
    site: 'YouTube',
    key,
    url: `https://www.youtube.com/watch?v=${key}`,
    embedUrl: buildYoutubeEmbedUrl(key),
    thumbnailUrl: youtubeThumbnailUrl(key),
    language,
    official,
  }
}

function isValidYoutubeKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(value)
}

function scoreTmdbVideo(video: TmdbVideo, preferredLanguage?: string): number {
  let score = 0
  if (video.site === 'YouTube') score += 1000
  if (video.type === 'Trailer') score += 500
  if (video.official === true) score += 200
  if (preferredLanguage && video.iso_639_1 === preferredLanguage) score += 80
  if (video.iso_639_1 === 'en') score += 50
  if (video.type === 'Teaser') score -= 70
  return score
}

function pickTmdbTrailer(videos: TmdbVideo[], preferredLanguage?: string): TrailerSource | null {
  const candidates = videos
    .filter((video) => video.site === 'YouTube' && isValidYoutubeKey(video.key))
    .sort((a, b) => scoreTmdbVideo(b, preferredLanguage) - scoreTmdbVideo(a, preferredLanguage))

  const bestTrailer = candidates.find((video) => video.type === 'Trailer') || candidates[0]
  return bestTrailer && bestTrailer.key
    ? makeYoutubeSource(bestTrailer.key, 'tmdb', bestTrailer.iso_639_1 || undefined, bestTrailer.official)
    : null
}

async function fetchTmdbTrailer(input: TrailerLookupInput): Promise<TrailerSource | null> {
  if (!input.tmdbId) return null
  const apiKey = getTmdbApiKey()
  if (!apiKey) return null

  const id = String(input.tmdbId).replace('tmdb-', '')
  if (!id) return null

  const url = new URL(`${TMDB_BASE_URL}/${mediaTypeForTmdb(input.type)}/${id}/videos`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('language', input.language ? `${input.language}-${input.language.toUpperCase()}` : 'en-US')

  const response = await fetch(url.toString())
  if (!response.ok) throw new Error(`TMDB trailer lookup failed: ${response.status}`)
  const data = await response.json() as { results?: TmdbVideo[] }
  const preferred = pickTmdbTrailer(data.results || [], input.language)
  if (preferred) return preferred

  if (input.language && input.language !== 'en') {
    const fallback = new URL(`${TMDB_BASE_URL}/${mediaTypeForTmdb(input.type)}/${id}/videos`)
    fallback.searchParams.set('api_key', apiKey)
    fallback.searchParams.set('language', 'en-US')
    const fallbackResponse = await fetch(fallback.toString())
    if (fallbackResponse.ok) {
      const fallbackData = await fallbackResponse.json() as { results?: TmdbVideo[] }
      return pickTmdbTrailer(fallbackData.results || [], 'en')
    }
  }

  return null
}

function decodeHtml(value: string): string {
  return value
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function extractYoutubeFallback(html: string, title: string): TrailerSource | null {
  const lowerTitle = title.toLowerCase()
  const seen = new Set<string>()
  const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,2200}?"title":\{"runs":\[\{"text":"([^"]+)"/g)]

  for (const match of matches) {
    const key = match[1]
    const candidateTitle = decodeHtml(match[2] || '').toLowerCase()
    if (!isValidYoutubeKey(key) || seen.has(key)) continue
    seen.add(key)
    if (!candidateTitle.includes('trailer')) continue
    if (!candidateTitle.includes(lowerTitle.split(':')[0])) continue
    if (REJECT_YOUTUBE_TERMS.some((term) => candidateTitle.includes(term))) continue
    if (candidateTitle.includes('teaser') && matches.length > 1) continue
    return makeYoutubeSource(key, 'youtube', undefined, candidateTitle.includes('official'))
  }

  for (const match of html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g)) {
    const key = match[1]
    if (isValidYoutubeKey(key) && !seen.has(key)) return makeYoutubeSource(key, 'youtube')
  }

  return null
}

async function fetchYoutubeFallback(input: TrailerLookupInput): Promise<TrailerSource | null> {
  const query = [input.title, input.year, 'official trailer'].filter(Boolean).join(' ')
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  const html = await invoke<string>('http_get_text', { url })
  return extractYoutubeFallback(html, input.title)
}

export async function getTrailerSource(input: TrailerLookupInput): Promise<TrailerSource | null> {
  const tmdbId = input.tmdbId ? String(input.tmdbId).replace('tmdb-', '') : ''
  const cacheKey = [
    'trailer_source_v1',
    mediaTypeForTmdb(input.type),
    tmdbId || 'no-tmdb',
    input.title.trim().toLowerCase(),
    input.year || 'no-year',
    input.language || 'en',
  ].join(':')

  return cachedFetch<TrailerSource | null>(cacheKey, async () => {
    const tmdbTrailer = await fetchTmdbTrailer(input).catch(() => null)
    if (tmdbTrailer) return tmdbTrailer
    return fetchYoutubeFallback(input).catch(() => null)
  }, { category: CACHE_CATEGORIES.TMDB_CARD, ttlSeconds: CACHE_TTLS.TMDB_CARD })
}

export function preloadTrailerSource(input: TrailerLookupInput): void {
  getTrailerSource(input).catch(() => undefined)
}
