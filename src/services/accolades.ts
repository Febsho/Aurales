import { getOmdbApiKey } from './apiKeys'

const CACHE_PREFIX = 'aurales_accolade_v1:'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface CachedAccolade {
  label: string | null
  fetchedAt: number
}

interface OmdbTitleResponse {
  Response?: string
  Awards?: string
}

export interface EditorialAccoladeMetadata {
  type: 'movie' | 'series'
  year?: number
  releaseDate?: string
  rating?: number
  voteCount?: number
  status?: string
  seriesType?: string
  latestSeasonAirDate?: string
  crewNames?: string[]
}

function daysFrom(date: string | undefined, now: Date): number | null {
  if (!date) return null
  const timestamp = Date.parse(date)
  if (!Number.isFinite(timestamp)) return null
  return Math.floor((now.getTime() - timestamp) / 86_400_000)
}

export function editorialAccolade(
  metadata: EditorialAccoladeMetadata,
  now = new Date(),
): string | null {
  const crew = new Set((metadata.crewNames ?? []).map((name) => name.toLowerCase()))
  if (metadata.type === 'movie') {
    if (crew.has('hayao miyazaki')) return 'Miyazaki Movie'
    if (crew.has('christopher nolan')) return 'Nolan Movie'
  }

  const currentYear = now.getFullYear()
  if (metadata.type === 'series') {
    if (metadata.seriesType?.toLowerCase() === 'miniseries') return 'Limited Series'

    const latestSeasonAge = daysFrom(metadata.latestSeasonAirDate, now)
    if (
      metadata.year != null
      && metadata.year < currentYear
      && latestSeasonAge != null
      && latestSeasonAge >= -45
      && latestSeasonAge <= 365
    ) {
      return 'New Season'
    }

    if ((metadata.year ?? 0) >= currentYear) return 'New Series'
    if (/returning|in production|planned/i.test(metadata.status ?? '')) return 'Returning'
  } else {
    const releaseAge = daysFrom(metadata.releaseDate, now)
    if (releaseAge != null && releaseAge >= -30 && releaseAge <= 90) return 'In Cinema'
    if ((metadata.year ?? 0) >= currentYear) return 'New Movie'
  }

  if (metadata.rating != null && metadata.rating >= 8 && (metadata.voteCount ?? 0) >= 1_000) {
    return 'Top Rated'
  }
  return null
}

export function isGenericAwardAccolade(label: string): boolean {
  return /^Winner of \d+ Awards$|^\d+ Award Nominations$/i.test(label)
}

function countLabel(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural.replace('{count}', String(count))
}

/** Turn OMDb's sourced award summary into one short, display-safe highlight. */
export function accoladeFromAwards(awards?: string | null): string | null {
  if (!awards || awards === 'N/A') return null
  const text = awards.replace(/\s+/g, ' ').trim()

  const majorAwards: Array<{
    pattern: RegExp
    singular: string
    plural: string
  }> = [
    {
      pattern: /Won (\d+) Oscars?\b/i,
      singular: 'Academy Award® Winner',
      plural: 'Winner of {count} Academy Awards®',
    },
    {
      pattern: /Nominated for (\d+) Oscars?\b/i,
      singular: 'Academy Award® Nominee',
      plural: '{count}× Academy Award® Nominee',
    },
    {
      pattern: /Won (\d+) Primetime Emmys?\b/i,
      singular: 'Primetime Emmy® Winner',
      plural: 'Winner of {count} Primetime Emmy® Awards',
    },
    {
      pattern: /Nominated for (\d+) Primetime Emmys?\b/i,
      singular: 'Primetime Emmy® Nominee',
      plural: '{count}× Primetime Emmy® Nominee',
    },
    {
      pattern: /Won (\d+) Golden Globes?\b/i,
      singular: 'Golden Globe® Winner',
      plural: 'Winner of {count} Golden Globe® Awards',
    },
    {
      pattern: /Nominated for (\d+) Golden Globes?\b/i,
      singular: 'Golden Globe® Nominee',
      plural: '{count}× Golden Globe® Nominee',
    },
    {
      pattern: /Won (\d+) BAFTA Awards?\b/i,
      singular: 'BAFTA Award Winner',
      plural: 'Winner of {count} BAFTA Awards',
    },
    {
      pattern: /Nominated for (\d+) BAFTA Awards?\b/i,
      singular: 'BAFTA Award Nominee',
      plural: '{count}× BAFTA Award Nominee',
    },
  ]

  for (const award of majorAwards) {
    const match = text.match(award.pattern)
    if (match) {
      const count = Number(match[1])
      if (Number.isFinite(count) && count > 0) {
        return countLabel(count, award.singular, award.plural)
      }
    }
  }

  // Generic totals are useful only when they are substantial. This prevents a
  // low-signal "1 win" pill from appearing above almost every title.
  const totals = text.match(/(\d+) wins? & (\d+) nominations? total/i)
  if (totals) {
    const wins = Number(totals[1])
    const nominations = Number(totals[2])
    if (wins >= 5) return `Winner of ${wins} Awards`
    if (nominations >= 10) return `${nominations} Award Nominations`
  }

  return null
}

function readCachedAccolade(imdbId: string): CachedAccolade | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${imdbId}`)
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedAccolade
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null
    return cached
  } catch {
    return null
  }
}

function writeCachedAccolade(imdbId: string, label: string | null) {
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${imdbId}`,
      JSON.stringify({ label, fetchedAt: Date.now() } satisfies CachedAccolade),
    )
  } catch {
    // A disabled/full storage area should not affect the details page.
  }
}

export async function fetchTitleAccolade(
  imdbId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!/^tt\d+$/.test(imdbId)) return null

  const cached = readCachedAccolade(imdbId)
  if (cached) return cached.label

  const params = new URLSearchParams({
    i: imdbId,
    apikey: getOmdbApiKey(),
    plot: 'short',
  })
  const response = await fetch(`https://www.omdbapi.com/?${params}`, { signal })
  if (!response.ok) throw new Error(`OMDb accolade request failed (${response.status})`)

  const data = await response.json() as OmdbTitleResponse
  const label = data.Response === 'True' ? accoladeFromAwards(data.Awards) : null
  writeCachedAccolade(imdbId, label)
  return label
}
