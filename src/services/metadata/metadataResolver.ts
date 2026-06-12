import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../../stores/appStore'
import { resolveAnimeMetadata } from './animeResolver'
import { classifyMediaItem } from './metadataClassifier'
import { resolveExternalIds } from './externalIdResolver'
import { addonFallback } from './metadataNormalizer'
import { fetchAppProviderMetadata } from './metadataProviders'
import type { AddonMediaInput, AppMediaItem } from './types'

/** Bump this when the anime metadata mapping changes to invalidate stale cache entries. */
const ANIME_RESOLVER_VERSION = 5
const ANIME_VERSION_KEY = 'orynt_anime_resolver_version'

const pending = new Map<string, Promise<AppMediaItem>>()
const cacheKey = (input: AddonMediaInput) => `${input.addonId}:${input.id || input.imdbId || input.tmdbId || input.tvdbId || input.title}`

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
        // Invalidate stale anime cache if resolver version has changed
        if (parsed.type === 'anime') {
          const cachedVersion = parseInt(localStorage.getItem(ANIME_VERSION_KEY) || '0', 10)
          if (cachedVersion < ANIME_RESOLVER_VERSION) {
            console.log('[metadata] Anime cache stale (version', cachedVersion, '< ', ANIME_RESOLVER_VERSION, '), re-resolving:', input.id)
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
    if (item && kind === 'anime') {
      try {
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
      } catch { /* ignore */ }
    }
    if (!item) {
      if (!settings.useAddonMetadataFallback) throw new Error('No app metadata match')
      item = addonFallback({ ...input, ...ids }, kind)
    }
    if (item && item.type === 'anime') {
      localStorage.setItem(ANIME_VERSION_KEY, String(ANIME_RESOLVER_VERSION))

    }
    await invoke('save_app_metadata', { mediaJson: JSON.stringify(item), addonId: input.addonId,
      addonItemId: input.id || '', mediaType: item.type }).catch(() => undefined)
    return item
  })().finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

export async function clearAppMetadataCache(): Promise<void> {
  pending.clear()
  await invoke('clear_app_metadata')
}

export async function clearAnimeMetadataCache(): Promise<void> {
  pending.clear()
  localStorage.removeItem(ANIME_VERSION_KEY)
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
