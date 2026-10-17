import { invoke } from '@tauri-apps/api/core'
import type { MovieDetails, ShowDetails } from '../../types'
import { getTmdbApiKey, getTvdbApiKey } from '../apiKeys'
import { cacheGet, cacheSet } from '../cache/sqliteCache'
import { CACHE_CATEGORIES, CACHE_TTLS } from '../cache/constants'
import { tmdbProvider } from '../tmdb'
import { tvdbProvider } from '../tvdb'
import { recordDetailProviderRequest } from '../performanceMetrics'

type DetailProvider = 'tmdb' | 'tvdb'
type DetailPriority = 'playback' | 'interactive' | 'visible' | 'background'

interface NativeDetailResponse<T> {
  data: T
  stale: boolean
  cacheStatus: 'hit' | 'miss'
}

const fallbackPending = new Map<string, Promise<ShowDetails>>()
const navigationGroups = new Map<string, { key: string; generation: number; users: number }>()
let nextNavigationGeneration = 0

function beginNavigationRequest(group: string, key: string): number {
  const current = navigationGroups.get(group)
  if (current?.key === key) {
    current.users += 1
    return current.generation
  }
  const generation = ++nextNavigationGeneration
  navigationGroups.set(group, { key, generation, users: 1 })
  return generation
}

function finishNavigationRequest(group: string, key: string, generation: number): void {
  const current = navigationGroups.get(group)
  if (!current || current.key !== key || current.generation !== generation) return
  current.users -= 1
  if (current.users === 0) navigationGroups.delete(group)
}

function ensureCurrentNavigation(group: string, key: string, generation: number): void {
  const current = navigationGroups.get(group)
  if (!current || current.key !== key || current.generation !== generation) throw staleRequestError()
}

function imageQuality(): 'data-saver' | 'balanced' | 'high' {
  try {
    const value = localStorage.getItem('aurales_image_quality')
    return value === 'data-saver' || value === 'high' ? value : 'balanced'
  } catch (_) {
    return 'balanced'
  }
}

function detailCacheKey(provider: DetailProvider, id: string, quality: ReturnType<typeof imageQuality>): string {
  return `detail:series-provider:v3:${provider}:${id}:image:${quality}`
}

function staleRequestError(): DOMException {
  return new DOMException('Detail request was superseded', 'AbortError')
}

function isNativeCancellation(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return /detail request was (superseded|cancelled)/i.test(message)
}

async function loadDetailPageFallback(provider: DetailProvider, cleanProviderId: string, quality: ReturnType<typeof imageQuality>): Promise<ShowDetails> {
  const key = detailCacheKey(provider, cleanProviderId, quality)
  const cached = await cacheGet<ShowDetails>(key)
  if (cached?.data) return cached.data

  const existing = fallbackPending.get(key)
  if (existing) return existing

  recordDetailProviderRequest()
  const request = (provider === 'tmdb'
    ? tmdbProvider.getShow(`tmdb-${cleanProviderId}`)
    : tvdbProvider.getShow(`tvdb-${cleanProviderId}`))
    .then((show) => {
      void cacheSet(key, show, {
        category: CACHE_CATEGORIES.DETAIL_PAGE,
        ttlSeconds: CACHE_TTLS.TVDB_SEASON,
      })
      return show
    })
    .finally(() => fallbackPending.delete(key))
  fallbackPending.set(key, request)
  return request
}

/**
 * Compatibility wrapper for the series-detail provider operation. Providers are
 * coordinated natively; the established TypeScript path remains available if
 * native execution is unavailable or fails before returning provider data.
 */
export async function loadDetailPage(
  provider: DetailProvider,
  id: string,
  options: { cancelGroup?: string; priority?: DetailPriority } = {},
): Promise<ShowDetails> {
  const cleanProviderId = id.replace(/^(tmdb|tvdb)[-:]/i, '')
  const quality = imageQuality()
  const cancelGroup = options.cancelGroup || `detail:series:${provider}`
  const operationKey = `series:${provider}:${cleanProviderId}:image:${quality}`
  const generation = beginNavigationRequest(cancelGroup, operationKey)
  try {
    try {
      const response = await invoke<NativeDetailResponse<ShowDetails>>('load_detail_page', {
        request: {
          provider,
          mediaType: 'series',
          id: cleanProviderId,
          apiKey: provider === 'tmdb' ? getTmdbApiKey() : getTvdbApiKey(),
          imageQuality: quality,
          priority: options.priority || 'visible',
          cancelGroup,
          timeoutMs: 15_000,
        },
      })
      if (response.stale) throw staleRequestError()
      ensureCurrentNavigation(cancelGroup, operationKey, generation)
      if (response.cacheStatus === 'miss') recordDetailProviderRequest()
      return response.data
    } catch (error) {
      if ((error instanceof DOMException && error.name === 'AbortError') || isNativeCancellation(error)) throw staleRequestError()
      ensureCurrentNavigation(cancelGroup, operationKey, generation)
      console.warn('[detail] Native detail load failed, using compatibility path:', error)
    }

    const fallback = await loadDetailPageFallback(provider, cleanProviderId, quality)
    ensureCurrentNavigation(cancelGroup, operationKey, generation)
    return fallback
  } finally {
    finishNavigationRequest(cancelGroup, operationKey, generation)
  }
}

/** Movie variant of the coarse detail operation. The page-level cache remains
 * authoritative, matching the pre-migration refresh behavior. */
export async function loadMovieDetailPage(
  id: string,
  options: { cancelGroup?: string; priority?: DetailPriority } = {},
): Promise<MovieDetails> {
  const cleanProviderId = id.replace(/^tmdb[-:]/i, '')
  const quality = imageQuality()
  const cancelGroup = options.cancelGroup || 'detail:movie:tmdb'
  const operationKey = `movie:tmdb:${cleanProviderId}:image:${quality}`
  const generation = beginNavigationRequest(cancelGroup, operationKey)
  try {
    try {
      const response = await invoke<NativeDetailResponse<MovieDetails>>('load_detail_page', {
        request: {
          provider: 'tmdb',
          mediaType: 'movie',
          id: cleanProviderId,
          apiKey: getTmdbApiKey(),
          imageQuality: quality,
          priority: options.priority || 'visible',
          cancelGroup,
          timeoutMs: 15_000,
        },
      })
      if (response.stale) throw staleRequestError()
      ensureCurrentNavigation(cancelGroup, operationKey, generation)
      return response.data
    } catch (error) {
      if ((error instanceof DOMException && error.name === 'AbortError') || isNativeCancellation(error)) throw staleRequestError()
      ensureCurrentNavigation(cancelGroup, operationKey, generation)
      console.warn('[detail] Native movie detail load failed, using compatibility path:', error)
      const fallback = await tmdbProvider.getMovie(`tmdb-${cleanProviderId}`)
      ensureCurrentNavigation(cancelGroup, operationKey, generation)
      return fallback
    }
  } finally {
    finishNavigationRequest(cancelGroup, operationKey, generation)
  }
}
