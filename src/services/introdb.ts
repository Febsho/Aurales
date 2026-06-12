/**
 * IntroDB – https://introdb.app
 * Provides intro, outro, and recap skip timestamps for TV episodes.
 * API docs: https://introdb.app/docs/api
 *
 * Correct endpoint: GET https://introdb.app/segments?imdb_id={tt...}&season={n}&episode={n}
 * No authentication required for reads.
 * Times in response are SECONDS — converted to ms for PMDBSkipSegment compatibility.
 */
import type { PMDBSkipSegment } from './pmdb'

const BASE_URL = 'https://introdb.app'

export interface IntroDBSegment {
  segment_type: 'intro' | 'outro' | 'recap' | 'credits'
  start_sec: number
  end_sec: number
}

/**
 * Fetch skip segments for a TV episode from IntroDB.
 *
 * @param imdbId  IMDB ID string (e.g. "tt1234567") — IntroDB uses IMDB IDs, NOT TMDB IDs
 * @param season  Season number
 * @param episode Episode number
 * @returns Normalised PMDBSkipSegment (times in ms) or empty array on failure/no data
 */
export async function getIntroDBSkips(
  imdbId: string,
  season: number,
  episode: number
): Promise<PMDBSkipSegment[]> {
  if (!imdbId || !imdbId.startsWith('tt')) return []

  try {
    const url = `${BASE_URL}/segments?imdb_id=${encodeURIComponent(imdbId)}&season=${season}&episode=${episode}`
    const res = await fetch(url)
    if (!res.ok) {
      if (res.status !== 404) {
        console.warn('[IntroDB] Fetch failed:', res.status)
      }
      return []
    }

    // Response is an array of segments OR wrapped in { data: [...] } or { segments: [...] }
    const raw = await res.json()
    const segments: IntroDBSegment[] = Array.isArray(raw)
      ? raw
      : (raw.segments ?? raw.data ?? raw.items ?? [])

    if (!segments.length) return []

    const intro = segments.find((s) => s.segment_type === 'intro')
    const outro = segments.find((s) => s.segment_type === 'outro' || s.segment_type === 'credits')
    const recap = segments.find((s) => s.segment_type === 'recap')

    // Need at least one valid segment to return anything
    if (!intro && !outro && !recap) return []

    // Use imdbId as pseudo-tmdb_id placeholder (0) — the player only uses the ms timestamps
    const seg: PMDBSkipSegment = {
      id: `introdb-${imdbId}-s${season}e${episode}`,
      tmdb_id: 0,
      media_type: 'tv',
      season,
      episode,
      intro_start_ms: intro ? Math.round(intro.start_sec * 1000) : 0,
      intro_end_ms: intro ? Math.round(intro.end_sec * 1000) : 0,
      credits_start_ms: outro ? Math.round(outro.start_sec * 1000) : undefined,
      credits_end_ms: outro ? Math.round(outro.end_sec * 1000) : undefined,
      recap_start_ms: recap ? Math.round(recap.start_sec * 1000) : undefined,
      recap_end_ms: recap ? Math.round(recap.end_sec * 1000) : undefined,
    }

    return [seg]
  } catch (e) {
    console.error('[IntroDB] Error fetching skips:', e)
    return []
  }
}
