import { cachedFetch } from './cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from './cache/constants'
import { useAppStore } from '../stores/appStore'

const BASE = 'https://webservice.fanart.tv/v3.2'

interface FanartImage {
  url: string
  likes: string
  lang: string
  width?: string | number
  height?: string | number
}

interface FanartMovieResponse {
  movieposter?: FanartImage[]
  moviebackground?: FanartImage[]
  hdmovielogo?: FanartImage[]
  movielogo?: FanartImage[]
}

interface FanartShowResponse {
  tvposter?: FanartImage[]
  showbackground?: FanartImage[]
  hdtvlogo?: FanartImage[]
  tvbanner?: FanartImage[]
}

function pickBest(images?: FanartImage[], prefer4k = false): string | undefined {
  if (!images?.length) return undefined

  if (prefer4k) {
    const k4 = images.filter((i) => {
      const w = Number(i.width)
      const h = Number(i.height)
      return w === 3840 || h === 2160
    })
    if (k4.length > 0) {
      const en = k4.filter((i) => i.lang === 'en' || i.lang === '')
      const sorted = (en.length ? en : k4).sort((a, b) => Number(b.likes) - Number(a.likes))
      return sorted[0]?.url
    }
  }

  const en = images.filter((i) => i.lang === 'en' || i.lang === '')
  const sorted = (en.length ? en : images).sort((a, b) => Number(b.likes) - Number(a.likes))
  return sorted[0]?.url
}

function cacheKeyToken(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return String(hash >>> 0)
}

export async function getFanartMovieArt(tmdbId: string | number): Promise<{ poster?: string; backdrop?: string; logo?: string }> {
  const apiKey = useAppStore.getState().fanartApiKey
  if (!apiKey || !tmdbId) return {}

  return cachedFetch(`fanart_movie:${cacheKeyToken(apiKey)}:${tmdbId}`, async () => {
    const res = await fetch(`${BASE}/movies/${tmdbId}?api_key=${apiKey}`)
    if (!res.ok) return {}
    const data = await res.json() as FanartMovieResponse
    return {
      poster: pickBest(data.movieposter),
      backdrop: pickBest(data.moviebackground, true),
      logo: pickBest(data.hdmovielogo) || pickBest(data.movielogo),
    }
  }, { category: CACHE_CATEGORIES.ARTWORK, ttlSeconds: CACHE_TTLS.ARTWORK })
}

export async function getFanartShowArt(tvdbId: string | number): Promise<{ poster?: string; backdrop?: string; logo?: string }> {
  const apiKey = useAppStore.getState().fanartApiKey
  if (!apiKey || !tvdbId) return {}

  return cachedFetch(`fanart_show:${cacheKeyToken(apiKey)}:${tvdbId}`, async () => {
    const res = await fetch(`${BASE}/tv/${tvdbId}?api_key=${apiKey}`)
    if (!res.ok) return {}
    const data = await res.json() as FanartShowResponse
    return {
      poster: pickBest(data.tvposter),
      backdrop: pickBest(data.showbackground, true),
      logo: pickBest(data.hdtvlogo),
    }
  }, { category: CACHE_CATEGORIES.ARTWORK, ttlSeconds: CACHE_TTLS.ARTWORK })
}
