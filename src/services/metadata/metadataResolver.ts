import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../../stores/appStore'
import { resolveAnimeMetadata } from './animeResolver'
import { classifyMediaItem } from './metadataClassifier'
import { resolveExternalIds } from './externalIdResolver'
import { addonFallback, appMediaToSearchResult } from './metadataNormalizer'
import { fetchAppProviderMetadata } from './metadataProviders'
import type { AddonMediaInput, AppMediaItem } from './types'
import type { SearchResult } from '../../types'

/** Bump this when the anime metadata mapping changes to invalidate stale cache entries. */
const ANIME_RESOLVER_VERSION = 8
const METADATA_CLASSIFIER_VERSION = 5

function numericProviderId(value: string | number | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = Number(String(value).trim().replace(/^[a-z_]+[-:]/i, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function animeSettingsSignature(): string {
  const settings = useAppStore.getState()
  return [
    settings.animeMetadataSource,
    settings.animeMetadataFallback,
    settings.animeTitleLanguage,
    settings.hideUnairedAnimeSeasons,
    settings.hideUnairedAnimeEpisodes,
    settings.includeAnimeSpecials,
    settings.useGenericAnimeSeasonLabels,
    settings.avoidJapaneseSeasonNames,
    settings.preferTvdbAnimeSeasons,
  ].map(String).join('|')
}

const pending = new Map<string, Promise<AppMediaItem>>()
const cacheKey = (input: AddonMediaInput) => `${animeSettingsSignature()}:${input.addonId}:${input.id || input.imdbId || input.tmdbId || input.tvdbId || input.title}`

const metadataMemCache = new Map<string, { item: AppMediaItem; ts: number }>()
const MEM_CACHE_TTL = 5 * 60 * 1000

function memCacheKey(ids: { id?: string; imdbId?: string; tmdbId?: number; tvdbId?: number; anilistId?: number }): string {
  return `${ids.id || ''}|${ids.imdbId || ''}|${ids.tmdbId || 0}|${ids.tvdbId || 0}|${ids.anilistId || 0}`
}

function memCacheGet(ids: { id?: string; imdbId?: string; tmdbId?: number; tvdbId?: number; anilistId?: number }): AppMediaItem | null {
  const key = memCacheKey(ids)
  const entry = metadataMemCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > MEM_CACHE_TTL) {
    metadataMemCache.delete(key)
    return null
  }
  return entry.item
}

function memCacheSet(ids: { id?: string; imdbId?: string; tmdbId?: number; tvdbId?: number; anilistId?: number }, item: AppMediaItem): void {
  const key = memCacheKey(ids)
  metadataMemCache.set(key, { item, ts: Date.now() })
  if (metadataMemCache.size > 500) {
    const oldest = metadataMemCache.keys().next().value
    if (oldest) metadataMemCache.delete(oldest)
  }
}

export async function getAppMetadataByIds(ids: {
  id?: string
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  anilistId?: number
}): Promise<AppMediaItem | null> {
  try {
    const raw = await invoke<string | null>('get_app_metadata_by_ids', {
      id: ids.id || null,
      imdbId: ids.imdbId || null,
      tmdbId: ids.tmdbId || null,
      tvdbId: ids.tvdbId || null,
      anilistId: ids.anilistId || null,
    })
    return raw ? JSON.parse(raw) as AppMediaItem : null
  } catch (e) {
    console.error('[metadata] getAppMetadataByIds error:', e)
    return null
  }
}

export async function getAppMetadataByIdsBatch(items: {
  id?: string
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  anilistId?: number
}[]): Promise<(AppMediaItem | null)[]> {
  if (items.length === 0) return []
  try {
    const results = await invoke<(string | null)[]>('get_app_metadata_by_ids_batch', { items })
    return results.map((raw) => raw ? JSON.parse(raw) as AppMediaItem : null)
  } catch (e) {
    console.error('[metadata] getAppMetadataByIdsBatch error:', e)
    return items.map(() => null)
  }
}

export async function enrichSearchResultsWithAppMetadata(items: SearchResult[]): Promise<SearchResult[]> {
  const settings = useAppStore.getState()
  if (!settings.appManagedMetadata) return items

  // 1. Check in-memory cache first, then batch-fetch remaining from DB
  const memResults: (AppMediaItem | null)[] = items.map((item) => {
    const ids = {
      id: item.id,
      imdbId: item.imdbId,
      tmdbId: numericProviderId(item.tmdbId),
      tvdbId: numericProviderId(item.tvdbId),
      anilistId: numericProviderId(item.anilistId),
    }
    return memCacheGet(ids)
  })

  const needsDbLookup = memResults.map((r, i) => r === null ? i : -1).filter((i) => i >= 0)

  let dbResults: (AppMediaItem | null)[] = memResults.slice()
  if (needsDbLookup.length > 0) {
    const batchInput = needsDbLookup.map((i) => ({
      id: items[i].id,
      imdbId: items[i].imdbId,
      tmdbId: numericProviderId(items[i].tmdbId),
      tvdbId: numericProviderId(items[i].tvdbId),
      anilistId: numericProviderId(items[i].anilistId),
    }))
    const fetched = await getAppMetadataByIdsBatch(batchInput)
    needsDbLookup.forEach((origIdx, batchIdx) => {
      const item = fetched[batchIdx]
      dbResults[origIdx] = item
      if (item) memCacheSet(batchInput[batchIdx], item)
    })
  }

  const cacheLookupResults = items.map((item, i) => {
    const raw = dbResults[i]
    const cached = raw?.sourceMetadataProvider === 'fallback_addon' || raw?.metadataClassifierVersion !== METADATA_CLASSIFIER_VERSION ? null : raw
    return { item, cached }
  })

  // 2. Identify items that are NOT cached and need to be resolved
  const uncachedInputs: { input: AddonMediaInput; index: number }[] = []
  
  cacheLookupResults.forEach(({ item, cached }, index) => {
    if (!cached) {
      const tmdbId = numericProviderId(item.tmdbId)
      const tvdbId = numericProviderId(item.tvdbId)
      const anilistId = numericProviderId(item.anilistId)
      
      uncachedInputs.push({
        index,
        input: {
          addonId: item.sourceAddonId || item.provider || 'tmdb',
          addonType: item.type,
          id: item.sourceAddonItemId || item.id,
          title: item.title,
          year: item.year,
          imdbId: item.imdbId,
          tmdbId,
          tvdbId,
          anilistId,
          rawAddonMeta: item,
        }
      })
    }
  })

  // 3. Resolve uncached items in batch with concurrency limit (e.g. 4)
  if (uncachedInputs.length > 0) {
    try {
      const resolvedList = await resolveMetadataBatch(
        uncachedInputs.map(x => x.input),
        6
      )
      resolvedList.forEach((resolvedItem) => {
        if (!resolvedItem) return
        if (resolvedItem.sourceMetadataProvider === 'fallback_addon') return
        const matched = cacheLookupResults.find(({ item }) => {
          const tmdbId = numericProviderId(item.tmdbId)
          const tvdbId = numericProviderId(item.tvdbId)
          const anilistId = numericProviderId(item.anilistId)

          return (
            (resolvedItem.imdbId && resolvedItem.imdbId === item.imdbId) ||
            (resolvedItem.tmdbId && resolvedItem.tmdbId === tmdbId) ||
            (resolvedItem.tvdbId && resolvedItem.tvdbId === tvdbId) ||
            (resolvedItem.anilistId && resolvedItem.anilistId === anilistId) ||
            (resolvedItem.sourceAddonItemId && resolvedItem.sourceAddonItemId === item.id)
          );
        })
        if (matched) {
          matched.cached = resolvedItem
        }
      })
    } catch (e) {
      console.error('[metadata] Batch enrichment failed:', e)
    }
  }

  // 4. Map everything to SearchResult
  return cacheLookupResults.map(({ item, cached }) => {
    if (cached) {
      const result = appMediaToSearchResult(cached, item.addonUrl)
      // Anime detection relies on genreIds/originalLanguage (dropped by the app
      // metadata layer) and on isAnime — which is only 'anime'-typed for series,
      // so anime MOVIES would otherwise look like plain movies. Carry the source
      // item's fields forward so anime movies keep their AniList option and label.
      const genreIds = result.genreIds ?? item.genreIds
      const originalLanguage = result.originalLanguage ?? item.originalLanguage
      const isAnime = result.isAnime || item.isAnime || Boolean(genreIds?.includes(16) && ['ja', 'zh', 'ko'].includes(originalLanguage || ''))
      return { ...result, genreIds, originalLanguage, isAnime }
    }
    return item
  })
}

export async function resolveAppMetadata(input: AddonMediaInput): Promise<AppMediaItem> {
  const key = cacheKey(input)
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async () => {
    const settings = useAppStore.getState()
    if (settings.appManagedMetadata) {
      const cached = await invoke<string | null>('get_app_metadata_for_addon', { addonId: input.addonId, addonItemId: input.id || '' }).catch(() => null)
      if (cached) {
        const parsed = JSON.parse(cached) as AppMediaItem
        if (parsed.sourceMetadataProvider === 'fallback_addon') {
          await invoke('delete_app_metadata', { addonId: input.addonId, addonItemId: input.id || '' }).catch(() => undefined)
        } else if (parsed.metadataClassifierVersion !== METADATA_CLASSIFIER_VERSION) {
          await invoke('delete_app_metadata', { addonId: input.addonId, addonItemId: input.id || '' }).catch(() => undefined)
        } else if (parsed.type === 'anime' || parsed.isAnime) {
          const activeSettings = animeSettingsSignature()
          if (parsed.animeResolverVersion !== ANIME_RESOLVER_VERSION || parsed.animeSettingsSignature !== activeSettings) {
            console.log('[metadata] Anime cache stale, re-resolving:', input.id)
            await invoke('delete_app_metadata', { addonId: input.addonId, addonItemId: input.id || '' }).catch(() => undefined)
          } else {
            return parsed
          }
        } else {
          return parsed
        }
      }
    }
    const kind = await classifyMediaItem(input)
    const ids = await resolveExternalIds(input, kind)
    let item = kind === 'anime'
      ? await resolveAnimeMetadata(input, ids, settings.animeTitleLanguage, settings.preferTvdbAnimeSeasons, {
          hideUnairedSeasons: settings.hideUnairedAnimeSeasons,
          hideUnairedEpisodes: settings.hideUnairedAnimeEpisodes,
          includeSpecials: settings.includeAnimeSpecials,
          useGenericSeasonLabels: settings.useGenericAnimeSeasonLabels ?? true,
          avoidJapaneseSeasonNames: settings.avoidJapaneseSeasonNames ?? true,
        })
      : await fetchAppProviderMetadata(input, ids, kind)

    if (item && kind !== 'anime') {
      const genres = (item.genres || []).map((g) => g.toLowerCase())
      const originalLanguage = String(item.originalLanguage || '').toLowerCase()
      const isAnime = (genres.includes('animation') || genres.includes('anime')) && ['ja', 'zh', 'ko'].includes(originalLanguage)
      if (isAnime) {
        const animeItem = await resolveAnimeMetadata(input, ids, settings.animeTitleLanguage, settings.preferTvdbAnimeSeasons, {
          hideUnairedSeasons: settings.hideUnairedAnimeSeasons,
          hideUnairedEpisodes: settings.hideUnairedAnimeEpisodes,
          includeSpecials: settings.includeAnimeSpecials,
          useGenericSeasonLabels: settings.useGenericAnimeSeasonLabels ?? true,
          avoidJapaneseSeasonNames: settings.avoidJapaneseSeasonNames ?? true,
        }).catch(() => null)
        if (animeItem) {
          item = animeItem
        }
      }
    }
    if (item && kind === 'anime') {
      // MDBList ratings are optional decoration. Do not keep episode metadata
      // behind another network request; persist the rating when it arrives.
      void (async () => {
        const { getMdblistRatings } = await import('../mdblist')
        const ratings = await getMdblistRatings({
          mediaType: item.type === 'movie' ? 'movie' : 'series',
          imdbId: item.imdbId,
          tmdbId: item.tmdbId,
          tvdbId: item.tvdbId,
        })
        const mal = ratings.find((r) => r.source === 'myanimelist')
        if (mal) {
          const val = parseFloat(mal.value)
          if (!isNaN(val)) {
            item.rating = val
          }
        }
        if (item.sourceMetadataProvider !== 'fallback_addon') {
          await invoke('save_app_metadata', { mediaJson: JSON.stringify(item), addonId: input.addonId,
            addonItemId: input.id || '', mediaType: item.type }).catch(() => undefined)
        }
      })().catch(() => undefined)
    }
    if (!item) {
      if (!settings.useAddonMetadataFallback) throw new Error('No app metadata match')
      item = addonFallback({ ...input, ...ids }, kind)
    }
    if (item && (item.type === 'anime' || item.isAnime)) {
      item.animeResolverVersion = ANIME_RESOLVER_VERSION
      item.animeSettingsSignature = animeSettingsSignature()
    }
    item.metadataClassifierVersion = METADATA_CLASSIFIER_VERSION
    if (item.sourceMetadataProvider !== 'fallback_addon') {
      await invoke('save_app_metadata', { mediaJson: JSON.stringify(item), addonId: input.addonId,
        addonItemId: input.id || '', mediaType: item.type }).catch(() => undefined)
    }
    return item
  })().finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

export async function clearAppMetadataCache(): Promise<void> {
  pending.clear()
  metadataMemCache.clear()
  await invoke('clear_app_metadata')
  const { cacheClearCategory } = await import('../cache/sqliteCache')
  await Promise.all([
    cacheClearCategory('addon_catalog'),
    cacheClearCategory('provider_list'),
    cacheClearCategory('simkl_list'),
    cacheClearCategory('anime_mapping'),
  ])
}

export async function clearAnimeMetadataCache(): Promise<void> {
  pending.clear()
  metadataMemCache.clear()
  // Clear all TVDB season caches from localStorage
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && (key.startsWith('tvdb_season_v4:') || key.startsWith('tmdb_season:'))) {
      keysToRemove.push(key)
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key)
  }
  await invoke('clear_app_metadata').catch(() => undefined)
  console.log('[metadata] Anime metadata cache cleared, removed', keysToRemove.length, 'season cache entries')
}

export async function resolveMetadataBatch(inputs: AddonMediaInput[], concurrency = 4): Promise<AppMediaItem[]> {
  const results: AppMediaItem[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (cursor < inputs.length) {
      const index = cursor++
      const item = await resolveAppMetadata(inputs[index]).catch(() => null)
      if (item) results[index] = item
    }
  }))
  return results.filter(Boolean)
}
