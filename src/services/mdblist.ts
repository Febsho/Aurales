import { useAppStore } from '../stores/appStore'
import { getSelfhstIconUrl } from './serviceIcons'

export interface MdblistRating {
  source: string
  label: string
  value: string
  icon: string
  iconUrl?: string
}

interface RatingRequest {
  mediaType: 'movie' | 'series'
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  season?: number
  episode?: number
}

const BASE_URL = 'https://api.mdblist.com'
const BUILTIN_KEY = '9x2ikjc88drsgwc0ocsp2p5wn'

const PROVIDER_LABELS: Record<string, string> = {
  imdb: 'IMDb',
  tomatoesaudience: 'TOMATOES',
  tomato_meter: 'TOMATOES',
  tomato: 'TOMATOES',
  rottentomatoes: 'TOMATOES',
  metacritic: 'Metacritic',
  metacriticuser: 'MC User',
  tmdb: 'TMDB',
  trakt: 'Trakt',
  letterboxd: 'Letterboxd',
  myanimelist: 'MAL',
  mal: 'MAL',
  popcorn: 'POPCORN',
}

const PROVIDER_ICONS: Record<string, string> = {
  imdb: 'IMDb',
  tomatoesaudience: 'RT',
  tomato_meter: 'RT',
  tomato: 'RT',
  rottentomatoes: 'RT',
  metacritic: 'M',
  metacriticuser: 'M',
  tmdb: 'TMDB',
  trakt: 'T',
  letterboxd: 'LB',
  myanimelist: 'MAL',
  mal: 'MAL',
  popcorn: 'PO',
}

export async function getMdblistRatings(req: RatingRequest): Promise<MdblistRating[]> {
  const apiKey = useAppStore.getState().mdblistApiKey.trim() || BUILTIN_KEY

  const media = req.mediaType === 'movie' ? 'movie' : 'show'
  const candidates: string[] = []
  if (req.imdbId) candidates.push(`/imdb/${media}/${encodeURIComponent(req.imdbId)}`)
  if (req.tmdbId) candidates.push(`/tmdb/${media}/${encodeURIComponent(String(req.tmdbId))}`)
  if (req.tvdbId) candidates.push(`/tvdb/${media}/${encodeURIComponent(String(req.tvdbId))}`)
  if (req.malId) candidates.push(`/mal/${media}/${encodeURIComponent(String(req.malId))}`)

  for (const path of candidates) {
    try {
      const url = new URL(`${BASE_URL}${path}`)
      url.searchParams.set('apikey', apiKey)
      if (req.season != null) url.searchParams.set('season', String(req.season))
      if (req.episode != null) url.searchParams.set('episode', String(req.episode))
      const res = await fetch(url.toString())
      if (!res.ok) continue
      const data = await res.json()
      const ratings = normalizeRatings(data)
      if (ratings.length > 0) return ratings
    } catch (_) {
      // Try next ID route.
    }
  }
  return []
}

function normalizeRatings(data: any): MdblistRating[] {
  const raw = data?.ratings ?? data?.rating ?? data?.external_ratings ?? data?.score ?? []
  const items: MdblistRating[] = []

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const source = normalizeSource(entry?.source ?? entry?.name ?? entry?.provider ?? entry?.id)
      const value = formatValue(entry?.value ?? entry?.score ?? entry?.rating ?? entry?.percent, entry?.type)
      if (source && value) items.push(toRating(source, value))
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const source = normalizeSource(key)
      const formatted = typeof value === 'object'
        ? formatValue((value as any).value ?? (value as any).score ?? (value as any).rating ?? (value as any).percent, (value as any).type)
        : formatValue(value)
      if (source && formatted) items.push(toRating(source, formatted))
    }
  }

  const directKeys = ['imdb', 'rottentomatoes', 'tomato_meter', 'tomatoesaudience', 'metacritic', 'tmdb', 'trakt', 'letterboxd', 'myanimelist', 'mal']
  for (const key of directKeys) {
    if (data?.[key] == null) continue
    const source = normalizeSource(key)
    const value = typeof data[key] === 'object' ? formatValue(data[key].rating ?? data[key].score ?? data[key].value) : formatValue(data[key])
    if (source && value) items.push(toRating(source, value))
  }

  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.source}:${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

function normalizeSource(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function formatValue(value: unknown, type?: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const val = value.trim()
    if (val.includes('/10')) return val.split('/10')[0].trim()
    return val
  }
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const typeText = String(type || '').toLowerCase()
  if (typeText.includes('percent') || num > 10) return `${Math.round(num)}%`
  return `${Number.isInteger(num) ? num : num.toFixed(1)}`
}

export function getRatingIconUrl(source: string): string | null {
  const norm = source.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (norm === 'imdb') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/IMDB_Logo_2016.svg/960px-IMDB_Logo_2016.svg.png'
  }
  if (norm === 'metacritic' || norm === 'metacriticuser') {
    return 'https://upload.wikimedia.org/wikipedia/commons/f/f2/Metacritic_M.png'
  }
  if (norm === 'rottentomatoes' || norm === 'tomato' || norm === 'tomatometer') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5b/Rotten_Tomatoes.svg/250px-Rotten_Tomatoes.svg.png'
  }
  if (norm === 'tomatoesaudience' || norm === 'rottentomatoesaudience' || norm === 'popcorn') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Rotten_Tomatoes_positive_audience.svg/250px-Rotten_Tomatoes_positive_audience.svg.png'
  }
  if (norm === 'trakt') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Trakt.tv-favicon.svg/250px-Trakt.tv-favicon.svg.png'
  }
  if (norm === 'tmdb') {
    return 'https://raw.githubusercontent.com/yodaluca23/fusion-icon-packs/refs/heads/main/icons/TMDb.png'
  }
  if (norm === 'letterboxd') {
    return 'https://a.ltrbxd.com/logos/letterboxd-decal-dots-pos-rgb-500px.png'
  }
  if (norm === 'myanimelist' || norm === 'mal') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/MyAnimeList_favicon.svg/250px-MyAnimeList_favicon.svg.png'
  }
  if (norm === 'anilist') {
    return 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/AniList_logo.svg/250px-AniList_logo.svg.png'
  }
  if (norm === 'rogerebert') {
    return 'https://raw.githubusercontent.com/yodaluca23/fusion-icon-packs/refs/heads/main/icons/RogerEbert.png'
  }
  return getSelfhstIconUrl(source)
}

function toRating(source: string, value: string): MdblistRating {
  return {
    source,
    label: PROVIDER_LABELS[source] || source.toUpperCase(),
    icon: PROVIDER_ICONS[source] || source.slice(0, 2).toUpperCase(),
    iconUrl: getRatingIconUrl(source) ?? undefined,
    value,
  }
}
