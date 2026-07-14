import { lazy, Suspense, useState, useEffect, useRef, forwardRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { refreshSimklPlaybackCache, removeSimklPlaybackProgress } from '../services/simkl/playback'
import { getPlaybackProgress as getTraktPlaybackProgress, removePlaybackItem as removeTraktPlaybackItem } from '../services/trakt/sync'
import { getPMDBPlaybackProgress, deletePMDBResumePoint } from '../services/pmdb'
import { getMdblistUpNext, getMdblistPlaybackProgress, hasMdblistOAuth, scrobbleMdblist } from '../services/mdblist'
import { getAniListContinueWatching } from '../services/anilist'
import { tmdbProvider } from '../services/tmdb'
// Lazy: StreamSelector pulls in the full player stack; only load it on demand
const StreamSelector = lazy(() => import('./StreamSelector'))
import type { HomeRowConfig, SearchResult } from '../types'
import { getSearchResultCustomArt, resolveArtFromProviders } from '../services/artwork'
import { formatTime } from '../services/player'
import { useContextMenu } from '../hooks/useContextMenu'
import { streamPreloadManager } from '../services/streams/preloadManager'
import {
  getContinueWatchingAccountScope,
  clearContinueWatchingStartupSnapshot,
  mergeContinueWatchingPresentation,
  readContinueWatchingStartupSnapshot,
  stableListFingerprint,
  writeContinueWatchingStartupSnapshot,
  type ContinueWatchingSnapshotItem,
  type ContinueWatchingSource,
} from '../services/cache/homeStartupSnapshot'
import { markContinueWatchingSettled, waitForHeroImageSettled } from '../services/cache/homeStartupCoordinator'
import { metadataTaskQueue, scheduleTask } from '../services/cache/backgroundTaskQueue'

type SourceType = ContinueWatchingSource

const SOURCE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'simkl', label: 'Simkl' },
  { value: 'trakt', label: 'Trakt' },
  { value: 'pmdb', label: 'PMDB' },
  { value: 'mdblist', label: 'MDBList' },
  { value: 'anilist', label: 'AniList' },
]

function revealContinueCard(card: HTMLElement) {
  const row = card.closest<HTMLElement>('.cinematic-row-track')
  if (!row) return
  const cardRect = card.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const inset = 24
  if (cardRect.right > rowRect.right - inset) {
    row.scrollBy({ left: cardRect.right - rowRect.right + inset, behavior: 'smooth' })
  } else if (cardRect.left < rowRect.left + inset) {
    row.scrollBy({ left: cardRect.left - rowRect.left - inset, behavior: 'smooth' })
  }
}

interface ContinueWatchingRowProps {
  row: HomeRowConfig
  headerLeftControls?: React.ReactNode
  headerRightControls?: React.ReactNode
}

type ContinueWatchingItem = ContinueWatchingSnapshotItem

function normalizeResumeMediaId(mediaId: string, season?: number, episode?: number): string {
  if (season == null || episode == null) return mediaId
  const suffix = `:${season}:${episode}`
  return mediaId.endsWith(suffix) ? mediaId.slice(0, -suffix.length) : mediaId
}

// Module-level cache survives component remounts (e.g. switching tabs and back),
// so the row shows its last result instantly and revalidates in the background
// instead of flashing a loading skeleton and refetching from scratch each time.
const cwItemsCache = new Map<string, ContinueWatchingItem[]>()
const cwRevalidatedThisSession = new Set<string>()

export default function ContinueWatchingRow({ row, headerLeftControls, headerRightControls }: ContinueWatchingRowProps) {
  const continueWatchingSource = useAppStore((s) => s.continueWatchingSource)
  const continueWatchingLimit = useAppStore((s) => s.continueWatchingLimit)
  const source = (row.sourceType || continueWatchingSource) as SourceType
  const accountScope = getContinueWatchingAccountScope(source)
  const startupSnapshot = readContinueWatchingStartupSnapshot(source, accountScope, continueWatchingLimit)
  const cwKey = `${source}:${accountScope || 'unscoped'}:${continueWatchingLimit}`

  const [items, setItems] = useState<ContinueWatchingItem[]>(() => cwItemsCache.get(cwKey) ?? startupSnapshot ?? [])
  const [loading, setLoading] = useState(() => !cwItemsCache.has(cwKey) && !startupSnapshot)
  const [error, setError] = useState<string | null>(null)
  const [remoteRefreshRevision, setRemoteRefreshRevision] = useState(0)
  const [streamSelectorData, setStreamSelectorData] = useState<{
    mediaId: string
    mediaType: 'movie' | 'series'
    title: string
    artwork: { poster?: string; backdrop?: string }
    seasonEpisode?: { season: number; episode: number }
    startTime?: number
    tmdbId?: number
    malId?: number
    anilistId?: number
  } | null>(null)
  const [cwMenu, setCwMenu] = useState<{ x: number; y: number; item: ContinueWatchingItem } | null>(null)
  const cwMenuRef = useRef<HTMLDivElement>(null)

  const navigate = useNavigate()
  const watchProgress = useAppStore((s) => s.watchProgress)
  const updateHomeRow = useAppStore((s) => s.updateHomeRow)
  const setContinueWatchingSource = useAppStore((s) => s.setContinueWatchingSource)
  const removeWatchProgress = useAppStore((s) => s.removeWatchProgress)
  const cinematic = useAppStore((s) => s.interfaceTheme) === 'cinematic'
  const posterSize = useAppStore((s) => s.posterSize)
  // Landscape cards scale with the global poster-size setting so the Continue
  // Watching row fits the same way the poster rows do.
  const cwWidthClass = posterSize === 'compact' ? 'w-[248px]' : posterSize === 'large' ? 'w-[336px]' : posterSize === 'huge' ? 'w-[400px]' : 'w-72'
  const [focusedItem, setFocusedItem] = useState<ContinueWatchingItem | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const clear = (event: Event) => {
      const clearedSource = (event as CustomEvent<SourceType>).detail
      for (const key of cwItemsCache.keys()) if (key.startsWith(`${clearedSource}:`)) cwItemsCache.delete(key)
      for (const key of cwRevalidatedThisSession) if (key.startsWith(`${clearedSource}:`)) cwRevalidatedThisSession.delete(key)
      if (clearedSource === source) setRemoteRefreshRevision((revision) => revision + 1)
    }
    window.addEventListener('aurales:cw-cache-clear', clear)
    return () => window.removeEventListener('aurales:cw-cache-clear', clear)
  }, [source])

  useEffect(() => {
    if (!cwMenu) return
    const handle = (e: MouseEvent) => {
      if (cwMenuRef.current && !cwMenuRef.current.contains(e.target as Node)) setCwMenu(null)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCwMenu(null)
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', handleKey)
    }
  }, [cwMenu])

  const changeSource = (next: SourceType) => {
    updateHomeRow(row.id, { sourceType: next })
    if (next === 'local' || next === 'trakt' || next === 'simkl' || next === 'pmdb' || next === 'mdblist' || next === 'anilist') {
      setContinueWatchingSource(next)
    }
  }

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const amount = Math.max(640, Math.floor(scrollRef.current.clientWidth * 0.85))
    const scrollAmount = direction === 'left' ? -amount : amount
    scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' })
  }

  useEffect(() => {
    // Playback saves progress every few seconds. Do not reload this row while
    // its stream selector/player is open, because the loading branch would
    // unmount the portal and stop the native player.
    if (streamSelectorData) return
    let cancelled = false
    // Show the cached result for this source immediately; only fall back to the
    // loading skeleton when we have nothing cached yet. Either way we revalidate
    // in the background below and update the cache when it resolves.
    const cached = cwItemsCache.get(cwKey) || readContinueWatchingStartupSnapshot(source, accountScope, continueWatchingLimit)
    if (cached) { setItems(cached); setLoading(false) } else { setLoading(true) }
    setError(null)

    if (source !== 'local' && cached && cwRevalidatedThisSession.has(cwKey)) {
      markContinueWatchingSettled()
      return () => { cancelled = true }
    }

    const loadProgress = async () => {
      try {
        await waitForHeroImageSettled()
        if (cancelled) return
        let list: ContinueWatchingItem[] = []
        const enrichItem = <T,>(id: string, execute: () => Promise<T>) => scheduleTask(metadataTaskQueue, {
          id: `cw-enrich:${id}`,
          dedupKey: `cw-enrich:${id}`,
          priority: 'low',
          group: 'metadata',
          execute,
        })

        if (source === 'local') {
          const localItems = Array.from(watchProgress.values())
            .filter((i) => !i.completed && i.progressSeconds > 5)
            .map((i) => {
              const pct = i.durationSeconds > 0 ? (i.progressSeconds / i.durationSeconds) * 100 : 0
              return {
                id: i.id,
                mediaId: normalizeResumeMediaId(i.mediaId, i.season, i.episode),
                mediaType: i.mediaType === 'movie' ? 'movie' : 'series',
                title: i.title || 'Untitled',
                subtitle: i.season != null && i.episode != null ? `S${i.season} E${i.episode}` : undefined,
                poster: i.poster,
                backdrop: i.backdrop,
                season: i.season,
                episode: i.episode,
                progressSeconds: i.progressSeconds,
                durationSeconds: i.durationSeconds,
                progressPct: pct,
                imdbId: i.imdbId,
                tmdbId: i.tmdbId ? Number(i.tmdbId) : undefined,
                updatedAt: i.updatedAt || new Date(0).toISOString(),
              } satisfies ContinueWatchingItem
            })
          list = localItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        } else if (source === 'simkl') {
          const simklRaw = await refreshSimklPlaybackCache()
          const simklItems: ContinueWatchingItem[] = simklRaw
            .filter((i) => i.progress != null && i.progress > 0 && i.progress < 85)
            .map((i) => {
              const media = i.movie || i.show || i.anime
              if (!media) return null
              const ids = media.ids
              let poster = media.poster
              if (poster && !poster.startsWith('http')) {
                const cleaned = poster.startsWith('/') ? poster.slice(1) : poster
                poster = `https://simkl.in/posters/${cleaned}_ca.jpg`
              }
              let backdrop = media.fanart
              if (backdrop && !backdrop.startsWith('http')) {
                const cleanedFanart = backdrop.startsWith('/') ? backdrop.slice(1) : backdrop
                backdrop = `https://simkl.in/fanart/${cleanedFanart}_medium.jpg`
              }
              const defaultDuration = i.type === 'movie' ? 120 * 60 : i.type === 'anime' ? 24 * 60 : 45 * 60
              const progressSec = Math.floor((i.progress / 100) * defaultDuration)

              return {
                id: String(i.id),
                mediaId: String(ids.imdb || ids.tmdb || ids.simkl || i.id),
                mediaType: (i.type === 'show' ? 'series' : i.type === 'movie' ? 'movie' : 'series') as 'movie' | 'series',
                title: media.title,
                subtitle: i.episode ? `S${i.episode.season} E${i.episode.number}` : undefined,
                poster,
                backdrop,
                season: i.episode?.season,
                episode: i.episode?.number,
                progressSeconds: progressSec,
                durationSeconds: defaultDuration,
                progressPct: i.progress,
                imdbId: ids.imdb,
                tmdbId: ids.tmdb ? Number(ids.tmdb) : undefined,
                updatedAt: i.paused_at || new Date().toISOString(),
              } satisfies ContinueWatchingItem
            })
            .filter(Boolean) as ContinueWatchingItem[]
          list = simklItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        } else if (source === 'trakt') {
          const traktRaw = await getTraktPlaybackProgress() as any[]
          const traktItems: ContinueWatchingItem[] = traktRaw
            .filter((i) => i.progress != null && i.progress > 0 && i.progress < 85)
            .map((i) => {
              const isMovie = i.type === 'movie'
              const title = isMovie ? i.movie?.title : i.show?.title
              const year = isMovie ? i.movie?.year : i.show?.year
              const imdbId = isMovie ? i.movie?.ids?.imdb : i.show?.ids?.imdb
              const tmdbId = isMovie ? i.movie?.ids?.tmdb : i.show?.ids?.tmdb
              const season = isMovie ? undefined : i.episode?.season
              const episode = isMovie ? undefined : i.episode?.number
              const runtime = isMovie ? i.movie?.runtime : i.episode?.runtime
              const defaultDuration = runtime ? runtime * 60 : (isMovie ? 120 * 60 : 24 * 60)
              const progressSec = Math.floor((i.progress / 100) * defaultDuration)

              return {
                id: String(i.id),
                mediaId: String(imdbId || tmdbId || i.id),
                mediaType: (isMovie ? 'movie' : 'series') as 'movie' | 'series',
                title: title || 'Untitled',
                subtitle: !isMovie && season != null && episode != null ? `S${season} E${episode}` : undefined,
                season,
                episode,
                progressSeconds: progressSec,
                durationSeconds: defaultDuration,
                progressPct: i.progress,
                imdbId,
                tmdbId: tmdbId ? Number(tmdbId) : undefined,
                updatedAt: i.paused_at || new Date().toISOString(),
              } satisfies ContinueWatchingItem
            })
          list = traktItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          list = mergeContinueWatchingPresentation(list, cached || [])

        } else if (source === 'pmdb') {
          const pmdbRaw = await getPMDBPlaybackProgress()
          const pmdbItems: ContinueWatchingItem[] = pmdbRaw
            .filter((i) => i.position_ms > 0 && (!i.runtime_ms || (i.position_ms / i.runtime_ms) < 0.85))
            .map((i) => {
              const isMovie = i.media_type === 'movie'
              const season = isMovie ? undefined : i.season
              const episode = isMovie ? undefined : i.episode
              const defaultDuration = i.runtime_ms > 0 ? Math.floor(i.runtime_ms / 1000) : (isMovie ? 120 * 60 : 45 * 60)
              const progressSec = Math.floor(i.position_ms / 1000)
              const progressPct = i.runtime_ms > 0 ? (i.position_ms / i.runtime_ms) * 100 : 0

              return {
                id: i.id,
                mediaId: `tmdb-${i.tmdb_id}`,
                mediaType: (isMovie ? 'movie' : 'series') as 'movie' | 'series',
                title: `${isMovie ? 'Movie' : 'Show'} ${i.tmdb_id}`,
                subtitle: !isMovie && season != null && episode != null ? `S${season} E${episode}` : undefined,
                season,
                episode,
                progressSeconds: progressSec,
                durationSeconds: defaultDuration,
                progressPct,
                tmdbId: i.tmdb_id,
                updatedAt: i.updated_at || i.updated || i.paused_at || i.created_at || new Date().toISOString(),
              } satisfies ContinueWatchingItem
            })
          list = pmdbItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          list = mergeContinueWatchingPresentation(list, cached || [])

        } else if (source === 'mdblist') {
          const [playbackRaw, upNextRaw] = await Promise.all([
            getMdblistPlaybackProgress(),
            getMdblistUpNext(),
          ])

          const playbackItems: ContinueWatchingItem[] = playbackRaw
            .filter((i) => i.progress > 0 && i.progress < 85)
            .map((i) => {
              const media = i.movie || i.show || {}
              const ids = media.ids || {}
              const isMovie = i.type === 'movie'
              const ep = i.episode as any
              const defaultDuration = i.runtime ? i.runtime * 60 : (isMovie ? 120 * 60 : 45 * 60)
              const progressSec = Math.floor((i.progress / 100) * defaultDuration)
              const imdbId = ids.imdb || media.imdb_id
              const tmdbId = ids.tmdb ? Number(ids.tmdb) : (media.tmdb_id ? Number(media.tmdb_id) : undefined)

              return {
                id: `mdblist-pb-${i.id}`,
                mediaId: String(imdbId || (tmdbId ? `tmdb-${tmdbId}` : i.id)),
                mediaType: (isMovie ? 'movie' : 'series') as 'movie' | 'series',
                title: media.title || (isMovie ? 'Movie' : 'Show'),
                subtitle: ep ? `S${ep.season} E${ep.number}` : undefined,
                season: ep?.season,
                episode: ep?.number,
                progressSeconds: progressSec,
                durationSeconds: defaultDuration,
                progressPct: i.progress,
                imdbId,
                tmdbId,
                updatedAt: i.paused_at || i.updated_at || new Date().toISOString(),
              } satisfies ContinueWatchingItem
            })

          const upNextItems: ContinueWatchingItem[] = upNextRaw.map((u) => ({
            id: `mdblist-upnext-${u.showId}-${u.season}-${u.episode}`,
            mediaId: u.imdbId || (u.tmdbId ? `tmdb-${u.tmdbId}` : u.showId),
            mediaType: 'series' as const,
            title: u.title,
            subtitle: `S${u.season} E${u.episode}`,
            season: u.season,
            episode: u.episode,
            progressSeconds: 0,
            durationSeconds: 0,
            progressPct: 0,
            imdbId: u.imdbId,
            tmdbId: u.tmdbId,
            updatedAt: u.lastWatchedAt || new Date().toISOString(),
          }))

          const seenIds = new Set(playbackItems.map((i) => i.mediaId))
          const merged = [
            ...playbackItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
            ...upNextItems.filter((i) => !seenIds.has(i.mediaId)),
          ]
          const presentedMerged = mergeContinueWatchingPresentation(merged, cached || [])

          list = presentedMerged
        } else if (source === 'anilist') {
          list = await getAniListContinueWatching()
        }

        list = mergeContinueWatchingPresentation(list, cached || [])
        markContinueWatchingSettled()

        if (!cancelled && list.length > 0) {
          list = await Promise.all(
            list.map((item) => enrichItem(`metadata:${item.id}`, async () => {
              if (!item.tmdbId) return item
              try {
                if (item.mediaType === 'series') {
                  let updated = { ...item }
                  if (!item.poster || !item.imdbId || /^(Show \d+|Untitled)$/.test(item.title)) {
                    const show = await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)
                    updated = {
                      ...updated,
                      mediaId: show.imdbId || updated.mediaId,
                      imdbId: show.imdbId || updated.imdbId,
                      title: show.title || updated.title,
                      poster: show.poster || updated.poster,
                      backdrop: show.backdrop || updated.backdrop,
                    }
                  }
                  if (item.season != null && item.episode != null) {
                    const episode = await tmdbProvider.getEpisode(`tmdb-${item.tmdbId}`, item.season, item.episode)
                    if (episode.still) updated.backdrop = episode.still
                    if (episode.runtime && episode.runtime > 0) {
                      const runtimeSec = episode.runtime * 60
                      updated.durationSeconds = runtimeSec
                      updated.progressSeconds = Math.floor((item.progressPct / 100) * runtimeSec)
                    }
                  }
                  return updated
                }

                if (item.mediaType === 'movie') {
                  const movie = await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`)
                  const updated = {
                    ...item,
                    mediaId: movie.imdbId || item.mediaId,
                    imdbId: movie.imdbId || item.imdbId,
                    title: movie.title || item.title,
                    poster: movie.poster || item.poster,
                  }
                  if (movie.backdrop) updated.backdrop = movie.backdrop
                  if (movie.runtime && movie.runtime > 0) {
                    const runtimeSec = movie.runtime * 60
                    updated.durationSeconds = runtimeSec
                    updated.progressSeconds = Math.floor((item.progressPct / 100) * runtimeSec)
                  }
                  return updated
                }

              } catch (_) {
                // Keep local/provider artwork if TMDB cannot enrich the row.
              }
              return item
            }))
          )

          // Posters go through the same artwork pipeline as every other card
          // (custom art URLs, then the preferred art provider), instead of
          // whatever the sync provider (Simkl/Trakt/…) returned.
          list = await Promise.all(
            list.map((item) => enrichItem(`art:${item.id}`, async () => {
              try {
                const custom = getSearchResultCustomArt({
                  id: item.mediaId,
                  title: item.title,
                  type: item.mediaType,
                  imdbId: item.imdbId,
                  tmdbId: item.tmdbId != null ? String(item.tmdbId) : undefined,
                  malId: item.malId,
                  anilistId: item.anilistId,
                } as unknown as SearchResult)
                const provider = await resolveArtFromProviders(
                  item.mediaType,
                  { tmdbId: item.tmdbId, imdbId: item.imdbId },
                  Boolean(item.malId || item.anilistId),
                )
                const poster = custom.poster || provider.poster || item.poster
                return poster !== item.poster ? { ...item, poster } : item
              } catch (_) {
                return item
              }
            }))
          )
        }

        if (!cancelled) {
          const candidate = list.filter((i) => i.backdrop || i.poster).slice(0, continueWatchingLimit)
          const visible = source !== 'local' && candidate.length === 0 && cached?.length ? cached : candidate
          if (accountScope && visible.length) writeContinueWatchingStartupSnapshot(source, accountScope, continueWatchingLimit, visible)
          const previous = cwItemsCache.get(cwKey) || cached || []
          const identityChanged = stableListFingerprint(visible) !== stableListFingerprint(previous)
          cwItemsCache.set(cwKey, visible)
          if (source === 'local' || identityChanged) setItems(visible)
          streamPreloadManager.setContinueWatching(visible.slice(0, 5).map((item) => ({
            mediaType: item.mediaType,
            mediaId: item.imdbId || item.mediaId,
            imdbId: item.imdbId,
            tmdbId: item.tmdbId,
            seasonEpisode: item.season != null && item.episode != null ? { season: item.season, episode: item.episode } : undefined,
            progressPct: item.progressPct,
          })))
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to load Continue Watching.')
        }
      } finally {
        if (source !== 'local') cwRevalidatedThisSession.add(cwKey)
        if (!cancelled) {
          setLoading(false)
          markContinueWatchingSettled()
        }
      }
    }

    loadProgress()
    return () => { cancelled = true }
  }, [source, accountScope, cwKey, source === 'local' ? watchProgress : null, continueWatchingLimit, streamSelectorData, remoteRefreshRevision])

  // ── Source selector (always rendered in header) ─────────────────────────────
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistConnected = !!useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()

  const visibleSources = SOURCE_OPTIONS.filter((opt) => {
    switch (opt.value) {
      case 'local': return true
      case 'simkl': return simklConnected
      case 'trakt': return traktConnected
      case 'anilist': return anilistConnected
      case 'pmdb': return !!pmdbApiKey
      case 'mdblist': return mdblistConnected
      default: return false
    }
  })

  const sourceSelector = (
    <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
      {visibleSources.map((opt) => (
        <button
          key={opt.value}
          onClick={() => changeSource(opt.value)}
          className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
            source === opt.value
              ? 'bg-white/15 text-white'
              : 'text-white/40 hover:text-white/70'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )

  const displayTitle = row.title

  const playItem = (item: ContinueWatchingItem) => setStreamSelectorData({
    mediaId: item.mediaId,
    mediaType: item.mediaType,
    title: item.title,
    artwork: { poster: item.poster, backdrop: item.backdrop },
    seasonEpisode: item.season != null && item.episode != null ? { season: item.season, episode: item.episode } : undefined,
    startTime: Number.isFinite(item.progressSeconds) && item.progressSeconds > 0 ? item.progressSeconds : undefined,
    tmdbId: item.tmdbId,
    malId: item.malId,
    anilistId: item.anilistId,
  })

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!cinematic || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(':scope > button'))
    const index = cards.indexOf(document.activeElement as HTMLElement)
    const next = cards[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus({ preventScroll: true })
    next.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }

  if (loading) {
    return (
      <div className="mb-8 select-none">
        <div className="flex items-center justify-between px-6 mb-4">
          <div className="flex items-center gap-2.5">
            {headerLeftControls}
            <h2 className="text-xl font-bold tracking-tight text-white/95">{displayTitle}</h2>
          </div>
          <div className="flex items-center gap-3">
            {sourceSelector}
            {headerRightControls}
          </div>
        </div>
        <div className="flex gap-4 overflow-x-hidden px-6 pt-4 -mt-4 pb-4 animate-pulse">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-72 aspect-video bg-neutral-800/40 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (error || items.length === 0) {
    return (
      <div className="mb-8 select-none">
        <div className="flex items-center justify-between px-6 mb-4">
          <div className="flex items-center gap-2.5">
            {headerLeftControls}
            <h2 className="text-xl font-bold tracking-tight text-white/95">{displayTitle}</h2>
          </div>
          <div className="flex items-center gap-3">
            {sourceSelector}
            {headerRightControls}
          </div>
        </div>
        <div className="px-6">
          <div className="flex gap-4 overflow-x-hidden pt-4 -mt-4 pb-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-72 aspect-video rounded-xl border border-dashed border-white/5 bg-white/[0.02] flex items-center justify-center">
                <span className="text-[11px] text-white/15 select-none">Nothing in progress</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <section className={`cw-fixed mb-8 ${cinematic ? 'cinematic-media-row !mb-0' : ''}`}>
      <div className="flex items-center justify-between px-6 mb-4 relative z-[60]">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className={cinematic ? 'text-sm font-light tracking-wider uppercase text-white/40' : 'text-xl font-bold tracking-tight text-white/95'}>{displayTitle}</h2>
        </div>
        <div className="flex items-center gap-3">
          {sourceSelector}
          {headerRightControls}
          <div className="flex gap-1">
            <button
              onClick={() => scroll('left')}
              className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => scroll('right')}
              className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        onKeyDown={handleRowKeyDown}
        className={`flex overflow-x-auto overflow-y-visible overscroll-x-contain scrollbar-none scroll-gpu ${cinematic ? 'items-center h-[212px] pt-4 -mt-4 pb-4 px-8 gap-5 snap-x snap-mandatory scroll-px-8 relative z-50' : 'pt-4 -mt-4 pb-6 px-6 gap-4'}`}
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {/* ── Cinematic: Resume Spotlight layout ────────────────────── */}
        {cinematic && items.map((item) => {
          const progressPercent = Math.min(100, Math.max(0, item.progressPct))
          const remaining = formatTime(Math.max(0, item.durationSeconds - item.progressSeconds))
          return (
            <button
              key={item.id}
              onClick={() => playItem(item)}
              onMouseEnter={() => setFocusedItem(item)}
              onMouseLeave={() => setFocusedItem((current) => current?.id === item.id ? null : current)}
              onFocus={(event) => {
                setFocusedItem(item)
                const card = event.currentTarget
                window.setTimeout(() => revealContinueCard(card), 80)
              }}
              onBlur={() => setFocusedItem((current) => current?.id === item.id ? null : current)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCwMenu({ x: e.clientX, y: e.clientY, item })
              }}
              className="snap-start relative flex-shrink-0 group cursor-pointer text-left focus-ring transition-all duration-300 ease-out w-[320px]"
            >
              <div className="relative overflow-hidden bg-surface-elevated border border-white/[0.08] transition-all duration-300 ease-out h-[180px] rounded-xl group-hover:border-white/30 group-focus-within:border-white/30 group-hover:shadow-[0_8px_32px_rgba(0,0,0,0.5)] group-focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.5)] group-hover:bg-white/[0.03] group-focus-within:bg-white/[0.03]">
                {/* 16:9 backdrop */}
                {item.backdrop ? (
                  <img 
                    src={item.backdrop} 
                    alt={item.title} 
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] group-focus-within:scale-[1.04]" 
                    loading="lazy" 
                    draggable={false} 
                  />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-surface-elevated to-surface flex items-center justify-center">
                    <span className="font-bold text-muted/30 text-lg">{item.title?.charAt(0) || '?'}</span>
                  </div>
                )}
                {/* Dark gradient */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent transition-opacity duration-300 group-hover:from-black/95 group-hover:via-black/35" />
                
                {/* Liquid Glass Play Button Overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-300 ease-out z-20">
                  <span className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center transition-all duration-300 group-hover:scale-105 group-hover:bg-white/20 group-hover:border-white/30 shadow-[0_8px_32px_0_rgba(31,38,135,0.37)]">
                    <svg className="w-6 h-6 ml-0.5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  </span>
                </div>

                {/* Info overlay */}
                <div className="absolute bottom-3.5 left-4 right-4 z-10 transition-transform duration-300 group-hover:-translate-y-1 group-focus-within:-translate-y-1">
                  <h3 className="text-[14px] font-bold text-white tracking-wide truncate drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{item.title}</h3>
                  <div className="flex items-center gap-2 mt-1 opacity-80 group-hover:opacity-100 transition-opacity duration-300">
                    {item.subtitle ? (
                      <span className="text-[9px] bg-accent/20 border border-accent/30 text-accent font-semibold px-1 py-0.5 rounded uppercase tracking-wider">{item.subtitle}</span>
                    ) : (
                      <span className="text-[9px] bg-white/10 text-gray-300 font-semibold px-1 py-0.5 rounded uppercase tracking-wider">Movie</span>
                    )}
                    <span className="text-[11px] text-white/70 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">{remaining} left</span>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="absolute bottom-0 inset-x-0 h-[3px] bg-white/10 transition-all duration-300 group-hover:h-[4px]">
                  <div className="h-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            </button>
          )
        })}
        {/* ── Default: existing landscape cards ────────────────────── */}
        {!cinematic && items.map((item) => {
          const progressPercent = Math.min(100, Math.max(0, item.progressPct))
          const remaining = formatTime(Math.max(0, item.durationSeconds - item.progressSeconds))
          return (
            <button
              key={item.id}
              onClick={() => playItem(item)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCwMenu({ x: e.clientX, y: e.clientY, item })
              }}
              className={`snap-start relative flex-shrink-0 group cursor-pointer text-left focus-ring transition-all duration-300 ease-out ${cwWidthClass} focus:outline-none`}
            >
              <div className="relative rounded-xl overflow-hidden bg-surface-elevated border border-white/[0.08] transition-all duration-300 ease-out aspect-video group-hover:border-white/30 group-focus-within:border-white/30 group-hover:shadow-[0_8px_32px_rgba(0,0,0,0.5)] group-focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.5)] group-hover:bg-white/[0.03] group-focus-within:bg-white/[0.03]">
                {/* 16:9 backdrop */}
                {(item.backdrop || item.poster) ? (
                  <img 
                    src={item.backdrop || item.poster} 
                    alt={item.title} 
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] group-focus-within:scale-[1.04]" 
                    loading="lazy" 
                    draggable={false} 
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
                    <span className="text-xl font-bold text-muted/30">{item.title?.charAt(0) || '?'}</span>
                  </div>
                )}
                
                {/* Permanent subtle dark gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent transition-opacity duration-300 group-hover:from-black/95 group-hover:via-black/35" />

                {/* Liquid Glass Play Button Overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-300 ease-out z-20">
                  <span className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center transition-all duration-300 group-hover:scale-105 group-hover:bg-white/20 group-hover:border-white/30 shadow-[0_8px_32px_0_rgba(31,38,135,0.37)]">
                    <svg className="w-5 h-5 ml-0.5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  </span>
                </div>

                {/* Info overlay */}
                <div className="absolute bottom-3.5 left-4 right-4 z-10 transition-transform duration-300 group-hover:-translate-y-1 group-focus-within:-translate-y-1">
                  <h3 className="text-[13px] font-bold text-white tracking-wide truncate drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{item.title}</h3>
                  <div className="flex items-center gap-2 mt-1 opacity-80 group-hover:opacity-100 transition-opacity duration-300">
                    {item.subtitle ? (
                      <span className="text-[9px] bg-accent/20 border border-accent/30 text-accent font-semibold px-1 py-0.5 rounded uppercase tracking-wider">{item.subtitle}</span>
                    ) : (
                      <span className="text-[9px] bg-white/10 text-gray-300 font-semibold px-1 py-0.5 rounded uppercase tracking-wider">Movie</span>
                    )}
                    <span className="text-[10px] text-white/70 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">{remaining} left</span>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="absolute bottom-0 inset-x-0 h-[3px] bg-white/10 transition-all duration-300 group-hover:h-[4px]">
                  <div className="h-full bg-accent transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {streamSelectorData && (
        <Suspense fallback={null}>
          <StreamSelector
            open={true}
            onClose={() => setStreamSelectorData(null)}
            mediaType={streamSelectorData.mediaType}
            mediaId={streamSelectorData.mediaId}
            title={streamSelectorData.title}
            artwork={streamSelectorData.artwork}
            seasonEpisode={streamSelectorData.seasonEpisode}
            startTime={streamSelectorData.startTime}
            tmdbId={streamSelectorData.tmdbId}
            malId={streamSelectorData.malId}
            anilistId={streamSelectorData.anilistId}
          />
        </Suspense>
      )}

      {cwMenu && (
        <ContinueWatchingMenu
          ref={cwMenuRef}
          x={cwMenu.x}
          y={cwMenu.y}
          item={cwMenu.item}
          source={source}
          onClose={() => setCwMenu(null)}
          onRemove={(removedItem) => {
            // Remove at the source, not just from local component state —
            // otherwise the item reappears on the next load.
            if (source === 'local') {
              removeWatchProgress([removedItem.mediaId, removedItem.imdbId].filter(Boolean) as string[], removedItem.season, removedItem.episode)
            } else if (source === 'trakt') {
              removeTraktPlaybackItem(removedItem.id).catch((e) => console.warn('[CW] Trakt remove failed:', e))
            } else if (source === 'simkl') {
              removeSimklPlaybackProgress(Number(removedItem.id)).catch((e) => console.warn('[CW] Simkl remove failed:', e))
            } else if (source === 'pmdb') {
              deletePMDBResumePoint(removedItem.id).catch((e) => console.warn('[CW] PMDB remove failed:', e))
            } else if (source === 'mdblist' && removedItem.id.startsWith('mdblist-pb-')) {
              scrobbleMdblist(
                'clear',
                removedItem.tmdbId,
                removedItem.mediaType,
                0,
                removedItem.season,
                removedItem.episode,
                removedItem.imdbId,
              ).catch((e) => console.warn('[CW] MDBList remove failed:', e))
            }
            setItems((prev) => {
              const next = prev.filter((i) => i.id !== removedItem.id)
              cwItemsCache.set(cwKey, next)
              if (accountScope) {
                if (next.length) writeContinueWatchingStartupSnapshot(source, accountScope, continueWatchingLimit, next)
                else clearContinueWatchingStartupSnapshot(source, accountScope, continueWatchingLimit)
              }
              return next
            })
            setCwMenu(null)
          }}
          onGoTo={(item) => {
            const path = item.mediaType === 'movie' ? `/movie/${item.mediaId}` : `/series/${item.mediaId}`
            navigate(path, {
              state: {
                poster: item.poster,
                backdrop: item.backdrop,
                title: item.title,
              },
            })
            setCwMenu(null)
          }}
          onPlay={(item) => {
            setStreamSelectorData({
              mediaId: item.mediaId,
              mediaType: item.mediaType,
              title: item.title,
              artwork: { poster: item.poster, backdrop: item.backdrop },
              seasonEpisode: item.season != null && item.episode != null ? { season: item.season, episode: item.episode } : undefined,
              startTime: Number.isFinite(item.progressSeconds) && item.progressSeconds > 0 ? item.progressSeconds : undefined,
              tmdbId: item.tmdbId,
              malId: item.malId,
              anilistId: item.anilistId,
            })
            setCwMenu(null)
          }}
        />
      )}
    </section>
  )
}

const ContinueWatchingMenu = forwardRef<
  HTMLDivElement,
  {
    x: number
    y: number
    item: ContinueWatchingItem
    source: SourceType
    onClose: () => void
    onRemove: (item: ContinueWatchingItem) => void
    onGoTo: (item: ContinueWatchingItem) => void
    onPlay: (item: ContinueWatchingItem) => void
  }
>(({ x, y, item, source, onClose, onRemove, onGoTo, onPlay }, ref) => {
  const [adjusted, setAdjusted] = useState({ x, y })
  const innerRef = useRef<HTMLDivElement>(null)
  const menuRef = (ref as React.RefObject<HTMLDivElement>) || innerRef

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const visibleHeight = Math.min(el.scrollHeight, vh - 16)
    let ax = x
    let ay = y
    if (x + rect.width > vw - 8) ax = vw - rect.width - 8
    if (y + visibleHeight > vh - 8) ay = vh - visibleHeight - 8
    if (ax < 8) ax = 8
    if (ay < 8) ay = 8
    setAdjusted({ x: ax, y: ay })
  }, [x, y])

  const menu = (
    <div className="fixed inset-0 z-[300]" onContextMenu={(e) => e.preventDefault()} onClick={onClose}>
      <div
        ref={menuRef}
        onClick={(e) => e.stopPropagation()}
        className="fixed min-w-[240px] max-w-[280px] rounded-2xl border border-white/[0.12] overscroll-contain"
        style={{
          left: adjusted.x,
          top: adjusted.y,
          maxHeight: 'calc(100vh - 16px)',
          overflowY: 'auto',
          scrollbarWidth: 'thin',
          background: 'rgba(20, 20, 22, 0.75)',
          backdropFilter: 'blur(60px) saturate(200%)',
          WebkitBackdropFilter: 'blur(60px) saturate(200%)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.1)',
          animation: 'menuIn 150ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-white/[0.08] to-white/[0.02] pointer-events-none" />
        <div className="relative">
          <div className="px-3.5 pt-3 pb-2 border-b border-white/[0.08]">
            <div className="flex items-center gap-2.5">
              {(item.backdrop || item.poster) && (
                <img src={item.backdrop || item.poster} alt="" className="w-12 h-8 rounded-md object-cover flex-shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-white truncate">{item.title}</p>
                <p className="text-[11px] text-white/40 mt-0.5">
                  {item.subtitle || (item.mediaType === 'movie' ? 'Movie' : 'Series')}
                  {source !== 'local' ? ` · ${source.charAt(0).toUpperCase() + source.slice(1)}` : ''}
                </p>
              </div>
            </div>
          </div>
          <div className="px-1.5 py-1.5">
            <button onClick={() => onPlay(item)} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer">
              <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              <span className="text-[13px] text-white/70">Resume Playing</span>
            </button>
            <button onClick={() => onGoTo(item)} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer">
              <svg className="w-4 h-4 text-white/50" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[13px] text-white/70">Go to {item.mediaType === 'movie' ? 'Movie' : 'Series'}</span>
            </button>
            <div className="my-1 border-t border-white/[0.06]" />
            <button onClick={() => onRemove(item)} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors cursor-pointer">
              <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span className="text-[13px] text-red-400">Remove from Continue Watching</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(menu, document.body)
})
