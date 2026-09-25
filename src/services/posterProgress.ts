import { useAppStore } from '../stores/appStore'
import { getContinueWatchingAccountScope, readContinueWatchingStartupSnapshot, type ContinueWatchingSource } from './cache/homeStartupSnapshot'
import { refreshSimklPlaybackCache } from './simkl/playback'
import { getPlaybackProgress as getTraktPlaybackProgress } from './trakt/sync'
import { getPMDBPlaybackProgress } from './pmdb'
import { getMdblistPlaybackProgress, hasMdblistOAuth } from './mdblist'
import { getAniListContinueWatching } from './anilist'
import { getServerCatalogItems, listServerCatalogs } from './serverIntegrations'

type PosterProgress = { type: 'movie' | 'series'; pct: number; title?: string; ids: Array<string | number | null | undefined> }

const listeners = new Set<() => void>()
let snapshot = new Map<string, number>()
let currentScope = ''
let lastRefresh = 0
let pending: Promise<void> | null = null
let pendingScope = ''
let progressBySource = new Map<string, Map<string, number>>()

function publish(progress: Map<string, number>) {
  snapshot = progress
  listeners.forEach((listener) => listener())
}

function add(progress: Map<string, number>, item: PosterProgress) {
  if (!Number.isFinite(item.pct) || item.pct <= 0 || item.pct >= 100) return
  for (const id of item.ids) {
    if (id == null || !String(id).trim()) continue
    const key = `${item.type}:${id}`
    progress.set(key, Math.max(progress.get(key) ?? 0, item.pct))
  }
  if (item.title) {
    const title = item.title.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    if (title) {
      for (const key of [`title:${item.type}:${title}`, `title:${title}`]) {
        progress.set(key, Math.max(progress.get(key) ?? 0, item.pct))
      }
    }
  }
}

function publishSources() {
  const combined = new Map<string, number>()
  for (const sourceProgress of progressBySource.values()) {
    for (const [key, pct] of sourceProgress) combined.set(key, Math.max(combined.get(key) ?? 0, pct))
  }
  publish(combined)
}

export function subscribePosterProgress(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getPosterProgressSnapshot() { return snapshot }

export function ensurePosterProgress(force = false) {
  const state = useAppStore.getState()
  const sources: ContinueWatchingSource[] = [
    ...(state.simklConnected ? ['simkl' as const] : []),
    ...(state.traktConnected ? ['trakt' as const] : []),
    ...(state.pmdbApiKey ? ['pmdb' as const] : []),
    ...(state.mdblistApiKey || hasMdblistOAuth() ? ['mdblist' as const] : []),
    ...(state.anilistConnected ? ['anilist' as const] : []),
  ]
  const scope = sources.map((source) => `${source}:${getContinueWatchingAccountScope(source) ?? 'connected'}`).join('|')
  if (scope !== currentScope) {
    currentScope = scope
    lastRefresh = 0
    progressBySource = new Map()
    for (const source of sources) {
      const accountScope = getContinueWatchingAccountScope(source)
      if (!accountScope) continue
      const cached = new Map<string, number>()
      for (const item of readContinueWatchingStartupSnapshot(source, accountScope, state.continueWatchingLimit) ?? []) {
        add(cached, { type: item.mediaType, pct: item.progressPct, ids: [item.mediaId, item.imdbId, item.tmdbId,
          item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined,
          item.anilistId != null ? `anilist-${item.anilistId}` : undefined,
          item.malId != null ? `mal-${item.malId}` : undefined] })
      }
      progressBySource.set(source, cached)
    }
    publishSources()
  }
  if ((pending && pendingScope === scope) || (!force && Date.now() - lastRefresh < 120_000)) return
  lastRefresh = Date.now()
  const activeScope = scope
  const jobs = sources.map(async (source): Promise<PosterProgress[]> => {
    if (source === 'pmdb') {
      const items = await getPMDBPlaybackProgress()
      return items.map((item) => ({ type: item.media_type === 'movie' ? 'movie' : 'series',
        pct: item.runtime_ms > 0 ? item.position_ms / item.runtime_ms * 100
          : item.progress != null ? (item.progress > 1 ? item.progress : item.progress * 100) : 0,
        ids: [item.tmdb_id, `tmdb-${item.tmdb_id}`] }))
    }
    if (source === 'simkl') {
      const items = await refreshSimklPlaybackCache()
      return items.map((item) => {
        const ids = (item.movie || item.show || item.anime)?.ids
        return { type: item.type === 'movie' ? 'movie' : 'series', title: (item.movie || item.show || item.anime)?.title, pct: item.progress,
          ids: [ids?.imdb, ids?.tmdb, ids?.tmdb != null ? `tmdb-${ids.tmdb}` : undefined,
            ids?.simkl != null ? `simkl-${ids.simkl}` : undefined] }
      })
    }
    if (source === 'trakt') {
      const items = await getTraktPlaybackProgress() as Array<{ type: string; progress: number; movie?: { title?: string; ids?: { imdb?: string; tmdb?: number } }; show?: { title?: string; ids?: { imdb?: string; tmdb?: number } } }>
      return items.map((item) => {
        const ids = (item.type === 'movie' ? item.movie : item.show)?.ids
        return { type: item.type === 'movie' ? 'movie' : 'series', title: (item.type === 'movie' ? item.movie : item.show)?.title, pct: item.progress,
          ids: [ids?.imdb, ids?.tmdb, ids?.tmdb != null ? `tmdb-${ids.tmdb}` : undefined] }
      })
    }
    if (source === 'mdblist') {
      const items = await getMdblistPlaybackProgress()
      return items.map((item) => {
        const media = item.movie || item.show
        const imdb = media?.ids?.imdb || media?.imdb_id
        const tmdb = media?.ids?.tmdb || media?.tmdb_id
        return { type: item.type === 'movie' ? 'movie' : 'series', title: media?.title, pct: item.progress,
          ids: [imdb, tmdb, tmdb != null ? `tmdb-${tmdb}` : undefined] }
      })
    }
    const items = await getAniListContinueWatching()
    return items.map((item) => ({ type: 'series', title: item.title, pct: item.progressPct,
      ids: [item.mediaId, item.tmdbId, item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined,
        item.anilistId != null ? `anilist-${item.anilistId}` : undefined,
        item.malId != null ? `mal-${item.malId}` : undefined] }))
  })
  jobs.push((async () => {
    const catalogs = await listServerCatalogs()
    const activeCatalogs = catalogs.filter((catalog) => catalog.kind === 'continue-watching')
    const results = await Promise.allSettled(activeCatalogs.map((catalog) => getServerCatalogItems(catalog.connectionId, catalog.catalogId, 100)))
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value.flatMap((item) => {
      const userData = (item.raw.UserData || {}) as { PlaybackPositionTicks?: unknown; Played?: unknown }
      const runtimeTicks = Number(item.raw.RunTimeTicks) || 0
      const positionTicks = Number(userData.PlaybackPositionTicks) || 0
      const pct = runtimeTicks > 0 ? positionTicks / runtimeTicks * 100 : 0
      if (userData.Played === true || pct <= 0 || pct >= 100) return []
      return [{ type: item.type, title: item.title, pct, ids: [item.id, item.imdbId, item.tmdbId,
        item.tmdbId != null ? `tmdb-${item.tmdbId}` : undefined, item.tvdbId,
        item.malId != null ? `mal-${item.malId}` : undefined,
        item.anilistId != null ? `anilist-${item.anilistId}` : undefined] }]
    }) : [])
  })())
  const run = Promise.allSettled(jobs.map(async (job, index) => {
    const items = await job
    if (currentScope !== activeScope) return
    const next = new Map<string, number>()
    items.forEach((item) => add(next, item))
    progressBySource.set(index === sources.length ? 'server' : sources[index], next)
    publishSources()
  })).then(() => {})
  pending = run
  pendingScope = scope
  void run.finally(() => { if (pending === run) pending = null })
}

if (typeof window !== 'undefined') {
  window.addEventListener('aurales:server-catalogs-changed', () => ensurePosterProgress(true))
}
