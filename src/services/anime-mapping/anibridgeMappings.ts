import type { ProviderEpisodeMapping, ProviderProgressMappingInput, TvdbEpisodeMappingInput } from './types'

type AniBridgeTargetMap = Record<string, Record<string, string | null>>
type AniBridgeMappings = Record<string, AniBridgeTargetMap | Record<string, unknown> | undefined>

interface Descriptor {
  provider: string
  id: string
  scope?: string
}

interface Range {
  start: number
  end?: number
}

const DATA_URL = 'https://github.com/anibridge/anibridge-mappings/releases/latest/download/mappings.min.json'
const PERSISTENT_CACHE = 'aurales-anibridge-mappings-v1'
const CACHE_TIMESTAMP_HEADER = 'x-aurales-cached-at'
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000

let cachedData: AniBridgeMappings | null = null
let cacheTimestamp = 0
let activePromise: Promise<AniBridgeMappings> | null = null

export async function getStoredAniBridgeEntryCount(): Promise<number> {
  const persistent = await readPersistentCache()
  const data = persistent?.data ?? cachedData
  return countMappingEntries(data)
}

export async function mapTvdbEpisodeWithAniBridge(
  input: TvdbEpisodeMappingInput,
): Promise<ProviderEpisodeMapping | null> {
  const source = `tvdb_show:${input.tvdbSeriesId}:s${input.tvdbSeasonNumber}`
  const targets = await getTargets(source)
  if (!targets) return null

  const now = new Date().toISOString()
  const result: ProviderEpisodeMapping = {
    tvdbSeriesId: input.tvdbSeriesId,
    tvdbSeasonNumber: input.tvdbSeasonNumber,
    tvdbEpisodeNumber: input.tvdbEpisodeNumber,
    tvdbEpisodeId: input.tvdbEpisodeId,
    confidence: 0.95,
    source: 'anibridge',
    updatedAt: now,
  }

  for (const [targetDescriptor, ranges] of Object.entries(targets)) {
    const descriptor = parseDescriptor(targetDescriptor)
    if (!descriptor) continue
    const mappedEpisode = mapEpisodeNumber(input.tvdbEpisodeNumber, ranges)
    if (mappedEpisode == null) continue

    if (descriptor.provider === 'anilist') {
      result.anilist = { mediaId: Number(descriptor.id), episodeNumber: mappedEpisode }
    } else if (descriptor.provider === 'mal') {
      result.mal = { id: Number(descriptor.id), episodeNumber: mappedEpisode }
    } else if (descriptor.provider === 'tmdb_show') {
      result.tmdb = { id: Number(descriptor.id), seasonNumber: parseSeasonScope(descriptor.scope), episodeNumber: mappedEpisode }
    } else if (descriptor.provider === 'tvdb_show') {
      result.trakt = result.trakt
    }
  }

  return result.anilist || result.mal || result.tmdb ? result : null
}

export async function mapProviderProgressWithAniBridge(input: ProviderProgressMappingInput): Promise<{
  tvdbSeriesId: number
  seasonNumber: number
  episodeNumber: number
} | null> {
  const sourceProvider = input.provider === 'anilist' ? 'anilist' : input.provider === 'mal' ? 'mal' : null
  if (!sourceProvider) return null

  const targets = await getTargets(`${sourceProvider}:${input.providerId}`)
  if (!targets) return null

  for (const [targetDescriptor, ranges] of Object.entries(targets)) {
    const descriptor = parseDescriptor(targetDescriptor)
    if (descriptor?.provider !== 'tvdb_show') continue
    const mappedEpisode = mapEpisodeNumber(input.providerEpisode, ranges)
    const seasonNumber = parseSeasonScope(descriptor.scope)
    const tvdbSeriesId = Number(descriptor.id)
    if (mappedEpisode != null && seasonNumber != null && Number.isFinite(tvdbSeriesId)) {
      return { tvdbSeriesId, seasonNumber, episodeNumber: mappedEpisode }
    }
  }

  return null
}

async function getTargets(sourceDescriptor: string): Promise<AniBridgeTargetMap | null> {
  const data = await loadAniBridgeMappings()
  const targets = data[sourceDescriptor]
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return null
  return targets as AniBridgeTargetMap
}

function loadAniBridgeMappings(): Promise<AniBridgeMappings> {
  if (cachedData && Date.now() - cacheTimestamp < CACHE_DURATION_MS) return Promise.resolve(cachedData)
  if (activePromise) return activePromise

  activePromise = (async () => {
    const persistent = await readPersistentCache()
    if (persistent && Date.now() - persistent.timestamp < CACHE_DURATION_MS) {
      cachedData = persistent.data
      cacheTimestamp = persistent.timestamp
      return persistent.data
    }

    try {
      const response = await fetch(DATA_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as AniBridgeMappings
      cachedData = data
      cacheTimestamp = Date.now()
      void writePersistentCache(data)
      console.log(`[anibridge] loaded ${countMappingEntries(data).toLocaleString()} mapping sources`)
      return data
    } catch (e) {
      console.warn('[anibridge] fetch failed:', e)
      if (persistent) {
        cachedData = persistent.data
        cacheTimestamp = persistent.timestamp
      }
      return cachedData ?? {}
    } finally {
      activePromise = null
    }
  })()

  return activePromise
}

async function readPersistentCache(): Promise<{ data: AniBridgeMappings; timestamp: number } | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(PERSISTENT_CACHE)
    const response = await cache.match(DATA_URL)
    if (!response) return null
    const data = await response.json() as AniBridgeMappings
    const timestamp = Number(response.headers.get(CACHE_TIMESTAMP_HEADER)) || 0
    return data && typeof data === 'object' ? { data, timestamp } : null
  } catch (_) {
    return null
  }
}

async function writePersistentCache(data: AniBridgeMappings): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(PERSISTENT_CACHE)
    await cache.put(DATA_URL, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        [CACHE_TIMESTAMP_HEADER]: String(Date.now()),
      },
    }))
  } catch (_) { /* memory cache still works */ }
}

function countMappingEntries(data?: AniBridgeMappings | null): number {
  if (!data) return 0
  return Object.keys(data).filter((key) => !key.startsWith('$')).length
}

function parseDescriptor(value: string): Descriptor | null {
  const [provider, id, scope] = value.split(':')
  if (!provider || !id) return null
  return { provider, id, scope }
}

function parseSeasonScope(scope?: string): number | undefined {
  if (!scope?.startsWith('s')) return undefined
  const parsed = Number(scope.slice(1))
  return Number.isFinite(parsed) ? parsed : undefined
}

function mapEpisodeNumber(sourceEpisode: number, ranges: Record<string, string | null>): number | undefined {
  for (const [sourceRangeText, targetRangeText] of Object.entries(ranges)) {
    if (targetRangeText == null) continue
    const sourceRange = parseRange(sourceRangeText)
    if (!sourceRange || !contains(sourceRange, sourceEpisode)) continue
    return mapRangeOffset(sourceEpisode - sourceRange.start, targetRangeText)
  }
  return undefined
}

function parseRange(text: string): Range | null {
  const match = /^(\d+)(?:-(\d*)?)?$/.exec(text)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : undefined
  return { start, end }
}

function contains(range: Range, value: number): boolean {
  return value >= range.start && (range.end == null || value <= range.end)
}

function mapRangeOffset(sourceOffset: number, targetText: string): number | undefined {
  const [segmentsText, ratioText] = targetText.split('|')
  const ratio = ratioText ? Number(ratioText) : 1
  if (!Number.isFinite(ratio) || ratio === 0) return undefined

  const targetOffset = ratio > 0
    ? sourceOffset * ratio + ratio - 1
    : Math.floor(sourceOffset / Math.abs(ratio))

  let remaining = targetOffset
  for (const segmentText of segmentsText.split(',')) {
    const segment = parseRange(segmentText)
    if (!segment) continue
    const length = segment.end == null ? Number.POSITIVE_INFINITY : segment.end - segment.start + 1
    if (remaining < length) return segment.start + remaining
    remaining -= length
  }
  return undefined
}
