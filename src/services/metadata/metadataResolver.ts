import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../../stores/appStore'
import { resolveAnimeMetadata } from './animeResolver'
import { classifyMediaItem } from './metadataClassifier'
import { resolveExternalIds } from './externalIdResolver'
import { addonFallback, appMediaToSearchResult } from './metadataNormalizer'
import { fetchAppProviderMetadata } from './metadataProviders'
import { cacheClearCategory, cacheDelete, cacheGet, cacheSet } from '../cache/sqliteCache'
import { CACHE_CATEGORIES } from '../cache/constants'
import { clearAnimeSeasonMemoryCache } from './animeSeasonCache'
import type { AddonMediaInput, AppMediaItem } from './types'
import type { SearchResult } from '../../types'
import { getPlatformCapabilities } from '../../platform/capabilities'

/** Bump this when the anime metadata mapping changes to invalidate stale cache entries. */
const ANIME_RESOLVER_VERSION = 8
const METADATA_CLASSIFIER_VERSION = 5
export type MetadataEnrichmentMode = 'cache-only' | 'visible-card' | 'detail'

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
let metadataGeneration = 0
let metadataMutationQueue: Promise<void> = Promise.resolve()

function serializeMetadataMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const queued = metadataMutationQueue.then(mutation, mutation)
  metadataMutationQueue = queued.then(() => undefined, () => undefined)
  return queued
}

function readAfterMetadataMutations<T>(read: () => Promise<T>): Promise<T> {
  return metadataMutationQueue.then(read, read)
}

function metadataSettingsSignature(): string {
  const settings = useAppStore.getState()
  return [
    settings.movieMetadataSource, settings.movieMetadataFallback,
    settings.seriesMetadataSource, settings.seriesMetadataFallback,
    settings.appManagedMetadata, settings.useAddonMetadataFallback,
  ].map(String).join('|')
}

const cacheKey = (input: AddonMediaInput) => JSON.stringify([
  metadataGeneration, metadataSettingsSignature(), input.addonId, input.addonUrl, input.addonType,
  input.id, input.title, input.year, input.imdbId, input.tmdbId, input.tvdbId,
  input.traktId, input.simklId, input.anilistId, input.malId,
])
const persistentMetadataKey = (input: AddonMediaInput) => `app_metadata_v1:${cacheKey(input)}`

async function persistAppMetadata(input: AddonMediaInput, item: AppMediaItem): Promise<void> {
  if (getPlatformCapabilities().platform === 'web') {
    return cacheSet(persistentMetadataKey(input), item, {
      category: item.type === 'anime' || item.isAnime ? CACHE_CATEGORIES.ANIME_METADATA : CACHE_CATEGORIES.APP_METADATA,
      ttlSeconds: null,
    })
  }
  return serializeMetadataMutation(() => invoke('save_app_metadata', {
    mediaJson: JSON.stringify(item), addonId: input.addonId,
    addonItemId: input.id || '', mediaType: item.type,
  }).catch(() => undefined)).then(() => undefined)
}

function deleteAppMetadata(input: AddonMediaInput): Promise<void> {
  if (getPlatformCapabilities().platform === 'web') return cacheDelete(persistentMetadataKey(input))
  return serializeMetadataMutation(() => invoke('delete_app_metadata', {
    addonId: input.addonId, addonItemId: input.id || '',
  }).then(() => undefined))
}

function lookupToAddonInput(item: {
  id?: string; sourceAddonId?: string; sourceAddonItemId?: string; mediaType?: string; addonType?: string
  addonUrl?: string; title?: string; year?: number; imdbId?: string; tmdbId?: number; tvdbId?: number
  anilistId?: number; malId?: number; traktId?: number; simklId?: number
}): AddonMediaInput {
  return {
    addonId: item.sourceAddonId || 'tmdb',
    addonUrl: item.addonUrl,
    addonType: item.addonType || item.mediaType,
    id: item.sourceAddonItemId || item.id,
    title: item.title,
    year: item.year,
    imdbId: item.imdbId,
    tmdbId: item.tmdbId,
    tvdbId: item.tvdbId,
    anilistId: item.anilistId,
    malId: item.malId,
    traktId: item.traktId,
    simklId: item.simklId,
  }
}

const metadataMemCache = new Map<string, { item: AppMediaItem; ts: number }>()
const MEM_CACHE_TTL = 5 * 60 * 1000

type MetadataMemoryIdentity = {
  id?: string
  sourceAddonId?: string
  sourceAddonItemId?: string
  mediaType?: string
  imdbId?: string
  tmdbId?: number
  tvdbId?: number
  anilistId?: number
  malId?: number
  traktId?: number
  simklId?: number
}

function memCacheKey(ids: MetadataMemoryIdentity): string {
  return JSON.stringify([
    ids.sourceAddonId || '', ids.sourceAddonItemId || ids.id || '', ids.mediaType || '',
    ids.imdbId || '', ids.tmdbId || 0, ids.tvdbId || 0, ids.anilistId || 0,
    ids.malId || 0, ids.traktId || 0, ids.simklId || 0,
  ])
}

function memCacheGet(ids: MetadataMemoryIdentity): AppMediaItem | null {
  const key = memCacheKey(ids)
  const entry = metadataMemCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > MEM_CACHE_TTL) {
    metadataMemCache.delete(key)
    return null
  }
  return entry.item
}

function memCacheSet(ids: MetadataMemoryIdentity, item: AppMediaItem): void {
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
  if (getPlatformCapabilities().platform === 'web') return null
  try {
    const raw = await readAfterMetadataMutations(() => invoke<string | null>('get_app_metadata_by_ids', {
      id: ids.id || null,
      imdbId: ids.imdbId || null,
      tmdbId: ids.tmdbId || null,
      tvdbId: ids.tvdbId || null,
      anilistId: ids.anilistId || null,
    }))
    return raw ? JSON.parse(raw) as AppMediaItem : null
  } catch (e) {
    console.error('[metadata] getAppMetadataByIds error:', e)
    return null
  }
}

export async function getAppMetadataByIdsBatch(items: Array<{
  id?: string; sourceAddonId?: string; sourceAddonItemId?: string; mediaType?: string; addonType?: string
  addonUrl?: string; title?: string; year?: number; imdbId?: string; tmdbId?: number; tvdbId?: number
  anilistId?: number; malId?: number; traktId?: number; simklId?: number
}>): Promise<(AppMediaItem | null)[]> {
  if (items.length === 0) return []
  if (getPlatformCapabilities().platform === 'web') {
    return Promise.all(items.map(async (item) => {
      const input = lookupToAddonInput(item)
      const cached = await cacheGet<AppMediaItem>(persistentMetadataKey(input))
      return cached?.data?.sourceMetadataProvider === 'fallback_addon' ? null : cached?.data || null
    }))
  }
  try {
    const results = await readAfterMetadataMutations(() => invoke<(string | null)[]>('get_app_metadata_by_ids_batch', { items }))
    return results.map((raw) => raw ? JSON.parse(raw) as AppMediaItem : null)
  } catch (e) {
    console.error('[metadata] getAppMetadataByIdsBatch error:', e)
    return items.map(() => null)
  }
}

export async function enrichSearchResultsWithAppMetadata(
  items: SearchResult[],
  options: { mode?: MetadataEnrichmentMode } = {},
): Promise<SearchResult[]> {
  const settings = useAppStore.getState()
  if (!settings.appManagedMetadata) return items
  const mode = options.mode || 'cache-only'
  const generationAtLookupStart = metadataGeneration
  const settingsSignatureAtLookupStart = metadataSettingsSignature()

  // 1. Check in-memory cache first, then batch-fetch remaining from DB
  const memResults: (AppMediaItem | null)[] = items.map((item) => {
    const ids = {
      id: item.id,
      sourceAddonId: item.sourceAddonId || item.provider || 'tmdb',
      sourceAddonItemId: item.sourceAddonItemId || item.id,
      mediaType: item.type,
      imdbId: item.imdbId,
      tmdbId: numericProviderId(item.tmdbId),
      tvdbId: numericProviderId(item.tvdbId),
      anilistId: numericProviderId(item.anilistId),
      malId: numericProviderId(item.malId),
      traktId: numericProviderId(item.traktId),
      simklId: numericProviderId(item.simklId),
    }
    return memCacheGet(ids)
  })

  const needsDbLookup = memResults.map((r, i) => r === null ? i : -1).filter((i) => i >= 0)

  let dbResults: (AppMediaItem | null)[] = memResults.slice()
  if (needsDbLookup.length > 0) {
    const batchInput = needsDbLookup.map((i) => ({
      id: items[i].id,
      sourceAddonId: items[i].sourceAddonId || items[i].provider || 'tmdb',
      sourceAddonItemId: items[i].sourceAddonItemId || items[i].id,
      mediaType: items[i].type,
      addonType: items[i].type,
      addonUrl: items[i].addonUrl,
      title: items[i].title,
      year: items[i].year,
      imdbId: items[i].imdbId,
      tmdbId: numericProviderId(items[i].tmdbId),
      tvdbId: numericProviderId(items[i].tvdbId),
      anilistId: numericProviderId(items[i].anilistId),
      malId: numericProviderId(items[i].malId),
      traktId: numericProviderId(items[i].traktId),
      simklId: numericProviderId(items[i].simklId),
    }))
    const fetched = await getAppMetadataByIdsBatch(batchInput)
    const lookupWasInvalidated = generationAtLookupStart !== metadataGeneration
    if (lookupWasInvalidated) {
      dbResults = items.map(() => null)
    } else {
      needsDbLookup.forEach((origIdx, batchIdx) => {
        const item = fetched[batchIdx]
        dbResults[origIdx] = item
        if (item) memCacheSet({ ...batchInput[batchIdx], sourceAddonId: batchInput[batchIdx].sourceAddonId }, item)
      })
    }
  }

  const cacheLookupResults = items.map((item, i) => {
    const raw = dbResults[i]
    const metadataSettingsAreStale = Boolean(raw && raw.metadataSettingsSignature !== metadataSettingsSignature())
    const animeCacheIsStale = Boolean(raw && (raw.type === 'anime' || raw.isAnime) && (
      raw.animeResolverVersion !== ANIME_RESOLVER_VERSION || raw.animeSettingsSignature !== animeSettingsSignature()
    ))
    const cached = raw?.sourceMetadataProvider === 'fallback_addon' || raw?.metadataClassifierVersion !== METADATA_CLASSIFIER_VERSION || metadataSettingsAreStale || animeCacheIsStale ? null : raw
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
          addonUrl: item.addonUrl,
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
  if (uncachedInputs.length > 0 && mode !== 'cache-only') {
    try {
      const resolvedList = await resolveMetadataBatch(
        uncachedInputs.map(x => x.input),
        mode === 'visible-card' ? 1 : 3
      )
      resolvedList.forEach((resolvedItem, resolvedIndex) => {
        if (!resolvedItem) return
        if (resolvedItem.sourceMetadataProvider === 'fallback_addon') return
        const targetIndex = uncachedInputs[resolvedIndex]?.index
        if (targetIndex != null) {
          cacheLookupResults[targetIndex].cached = resolvedItem
          const resolvedInput = uncachedInputs[resolvedIndex]?.input
          if (resolvedInput) memCacheSet({
            id: resolvedInput.id,
            sourceAddonId: resolvedInput.addonId,
            sourceAddonItemId: resolvedInput.id,
            mediaType: resolvedInput.addonType,
            imdbId: resolvedInput.imdbId,
            tmdbId: resolvedInput.tmdbId,
            tvdbId: resolvedInput.tvdbId,
            anilistId: resolvedInput.anilistId,
            malId: resolvedInput.malId,
            traktId: resolvedInput.traktId,
            simklId: resolvedInput.simklId,
          }, resolvedItem)
        }
      })
    } catch (e) {
      console.error('[metadata] Batch enrichment failed:', e)
    }
  }

  // 4. Map everything to SearchResult
  if (generationAtLookupStart !== metadataGeneration || settingsSignatureAtLookupStart !== metadataSettingsSignature()) {
    return items
  }
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
  const generation = metadataGeneration
  const settingsSignatureAtStart = metadataSettingsSignature()
  const existing = pending.get(key)
  if (existing) return existing
  const work = (async () => {
    const settings = useAppStore.getState()
    if (settings.appManagedMetadata) {
      const cached = getPlatformCapabilities().platform === 'web'
        ? await cacheGet<AppMediaItem>(persistentMetadataKey(input)).then((result) => result?.data ? JSON.stringify(result.data) : null).catch(() => null)
        : await readAfterMetadataMutations(() =>
            invoke<string | null>('get_app_metadata_for_addon', { addonId: input.addonId, addonItemId: input.id || '' })
          ).catch(() => null)
      if (generation !== metadataGeneration) return resolveAppMetadata(input)
      if (settingsSignatureAtStart !== metadataSettingsSignature()) return resolveAppMetadata(input)
      if (cached) {
        let parsed: AppMediaItem | null = null
        try {
          parsed = JSON.parse(cached) as AppMediaItem
        } catch (error) {
          console.warn('[metadata] Discarding malformed cached metadata:', input.id, error)
        }
        if (!parsed) {
          await deleteAppMetadata(input).catch(() => undefined)
        } else if (parsed.sourceMetadataProvider === 'fallback_addon') {
          await deleteAppMetadata(input).catch(() => undefined)
        } else if (parsed.metadataClassifierVersion !== METADATA_CLASSIFIER_VERSION) {
          await deleteAppMetadata(input).catch(() => undefined)
        } else if (parsed.metadataSettingsSignature !== settingsSignatureAtStart) {
          await deleteAppMetadata(input).catch(() => undefined)
        } else if (parsed.type === 'anime' || parsed.isAnime) {
          const activeSettings = animeSettingsSignature()
          if (parsed.animeResolverVersion !== ANIME_RESOLVER_VERSION || parsed.animeSettingsSignature !== activeSettings) {
            console.log('[metadata] Anime cache stale, re-resolving:', input.id)
            await deleteAppMetadata(input).catch(() => undefined)
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
    if (settingsSignatureAtStart !== metadataSettingsSignature()) return resolveAppMetadata(input)
    if (item && kind === 'anime') {
      const ratingItem = item
      // MDBList ratings are optional decoration. Do not keep episode metadata
      // behind another network request; persist the rating when it arrives.
      void (async () => {
        const { getMdblistRatings } = await import('../mdblist')
        const ratings = await getMdblistRatings({
          mediaType: ratingItem.type === 'movie' ? 'movie' : 'series',
          imdbId: ratingItem.imdbId,
          tmdbId: ratingItem.tmdbId,
          tvdbId: ratingItem.tvdbId,
        })
        const mal = ratings.find((r) => r.source === 'myanimelist')
        if (mal) {
          const val = parseFloat(mal.value)
          if (!isNaN(val)) {
            ratingItem.rating = val
          }
        }
        if (generation === metadataGeneration && settingsSignatureAtStart === metadataSettingsSignature() && ratingItem.sourceMetadataProvider !== 'fallback_addon') {
          await persistAppMetadata(input, ratingItem).catch(() => undefined)
        }
      })().catch(() => undefined)
    }
    if (settingsSignatureAtStart !== metadataSettingsSignature()) return resolveAppMetadata(input)
    if (!item) {
      if (!settings.useAddonMetadataFallback) throw new Error('No app metadata match')
      item = addonFallback({ ...input, ...ids }, kind)
    }
    if (item && (item.type === 'anime' || item.isAnime)) {
      item.animeResolverVersion = ANIME_RESOLVER_VERSION
      item.animeSettingsSignature = animeSettingsSignature()
    }
    item.metadataClassifierVersion = METADATA_CLASSIFIER_VERSION
    item.metadataSettingsSignature = settingsSignatureAtStart
    if (generation !== metadataGeneration) return resolveAppMetadata(input)
    if (item.sourceMetadataProvider !== 'fallback_addon') {
      await persistAppMetadata(input, item)
    }
    if (generation !== metadataGeneration || settingsSignatureAtStart !== metadataSettingsSignature()) {
      return resolveAppMetadata(input)
    }
    return item
  })()
  const task = work.finally(() => {
    if (pending.get(key) === task) pending.delete(key)
  })
  pending.set(key, task)
  return task
}

export async function clearAppMetadataCache(): Promise<void> {
  metadataGeneration += 1
  pending.clear()
  metadataMemCache.clear()
  const cacheClear = Promise.all([
    cacheClearCategory('addon_catalog'),
    cacheClearCategory('provider_list'),
    cacheClearCategory('simkl_list'),
    cacheClearCategory('anime_mapping'),
    cacheClearCategory(CACHE_CATEGORIES.APP_METADATA),
    cacheClearCategory(CACHE_CATEGORIES.ANIME_METADATA),
  ])
  clearAnimeSeasonMemoryCache(cacheClear)
  const nativeClear = getPlatformCapabilities().platform === 'web'
    ? Promise.resolve()
    : serializeMetadataMutation(() => invoke('clear_app_metadata'))
  await Promise.all([nativeClear, cacheClear])
}

export async function clearAnimeMetadataCache(): Promise<void> {
  metadataGeneration += 1
  pending.clear()
  metadataMemCache.clear()
  // Bump both cache generations synchronously before awaiting native/SQLite
  // work so in-flight readers cannot revive snapshots being cleared. Provider
  // lists also hold already-enriched SearchResults for anime.
  const cacheClear = Promise.all([
    cacheClearCategory('anime_mapping'),
    cacheClearCategory('provider_list'),
    cacheClearCategory(CACHE_CATEGORIES.ANIME_METADATA),
  ])
  clearAnimeSeasonMemoryCache(cacheClear)
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
  const nativeClear = getPlatformCapabilities().platform === 'web'
    ? Promise.resolve()
    : serializeMetadataMutation(() => invoke('clear_anime_app_metadata')).catch(() => undefined)
  await Promise.all([nativeClear, cacheClear])
  console.log('[metadata] Anime metadata cache cleared, removed', keysToRemove.length, 'season cache entries')
}

export async function resolveMetadataBatch(inputs: AddonMediaInput[], concurrency = 4): Promise<Array<AppMediaItem | null>> {
  const results: Array<AppMediaItem | null> = new Array(inputs.length).fill(null)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (cursor < inputs.length) {
      const index = cursor++
      const item = await resolveAppMetadata(inputs[index]).catch(() => null)
      if (item) results[index] = item
    }
  }))
  return results
}
