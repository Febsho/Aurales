import { invoke } from '@tauri-apps/api/core'
import { getTmdbApiKey } from './apiKeys'
import { cacheGet, cacheSet, cachedFetch } from './cache/sqliteCache'
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

export interface TrailerVideoStream {
  url: string
  mimeType?: string
  quality?: string
}

export interface TrailerVideoStreamOptions {
  preferVideoOnly?: boolean
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

const PIPED_API_BASES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.syncpundit.io',
  'https://api-piped.mha.fi',
  'https://pipedapi.reallyaweso.me',
]

function mediaTypeForTmdb(type: TrailerLookupInput['type']): 'movie' | 'tv' {
  return type === 'movie' ? 'movie' : 'tv'
}

export function youtubeThumbnailUrl(key: string, quality: 'max' | 'high' = 'max'): string {
  return `https://i.ytimg.com/vi/${key}/${quality === 'max' ? 'maxresdefault' : 'hqdefault'}.jpg`
}

export function buildYoutubeEmbedUrl(key: string, options: { muted?: boolean } = {}): string {
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : undefined
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
    vq: 'hd1080',
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

function trailerVideoQualityRank(stream: PipedVideoStream, options: TrailerVideoStreamOptions = {}): number {
  const text = `${stream.quality || ''} ${stream.mimeType || ''} ${stream.format || ''}`.toLowerCase()
  const numeric = Number(text.match(/(\d{3,4})p/)?.[1] || stream.height || 0)
  const formatBonus = text.includes('mp4') || text.includes('mpeg_4')
    ? 140
    : text.includes('webm')
      ? 80
      : 0
  const audioBonus = stream.videoOnly
    ? options.preferVideoOnly ? 260 : -1000
    : options.preferVideoOnly ? 0 : 160
  const lbryBonus = text.includes('lbry') ? 50 : 0
  const sizeBonus = stream.bitrate ? Math.min(stream.bitrate / 10000, 80) : 0
  return numeric + formatBonus + audioBonus + lbryBonus + sizeBonus
}

interface PipedVideoStream {
  url?: string
  format?: string
  quality?: string
  mimeType?: string
  videoOnly?: boolean
  height?: number
  bitrate?: number
  width?: number
  contentLength?: number
}

interface PipedStreamsResponse {
  videoStreams?: PipedVideoStream[]
}

function isPlayableVideoStream(stream: PipedVideoStream): boolean {
  const text = `${stream.mimeType || ''} ${stream.format || ''} ${stream.url || ''}`.toLowerCase()
  return text.includes('mp4') || text.includes('mpeg_4') || text.includes('.mp4') || text.includes('webm') || text.includes('.webm')
}

function pickPipedVideoStream(data: PipedStreamsResponse, options: TrailerVideoStreamOptions = {}): TrailerVideoStream | null {
  const streams = (data.videoStreams || [])
    .filter((stream) => {
      if (!stream.url) return false
      if (!options.preferVideoOnly && stream.videoOnly) return false
      return isPlayableVideoStream(stream)
    })
    .sort((a, b) => trailerVideoQualityRank(b, options) - trailerVideoQualityRank(a, options))

  const best = streams[0]
  return best?.url ? { url: best.url, mimeType: best.mimeType, quality: best.quality } : null
}

async function fetchDirectTrailerStream(key: string, options: TrailerVideoStreamOptions = {}): Promise<TrailerVideoStream | null> {
  for (const base of PIPED_API_BASES) {
    try {
      const body = await invoke<string>('http_get_text', { url: `${base}/streams/${key}` })
      const parsed = JSON.parse(body) as PipedStreamsResponse
      const stream = pickPipedVideoStream(parsed, options)
      if (stream) return stream
    } catch (_) {
      // Try the next public API instance.
    }
  }
  return null
}

export async function getTrailerVideoStream(key: string, options: TrailerVideoStreamOptions = {}): Promise<TrailerVideoStream | null> {
  const cacheKey = `trailer_video_stream_v2:${options.preferVideoOnly ? 'visual' : 'audio'}:${key}`
  const cached = await cacheGet<TrailerVideoStream>(cacheKey)
  if (cached && !cached.stale) return cached.data

  const stream = await fetchDirectTrailerStream(key, options)
  if (stream) {
    await cacheSet(cacheKey, stream, {
      category: CACHE_CATEGORIES.DETAIL_PAGE,
      ttlSeconds: 2 * 60 * 60,
    })
  }
  return stream
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
