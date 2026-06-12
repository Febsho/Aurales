import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { getSimklPlaybackProgress } from '../services/simkl/playback'
import { getPlaybackProgress as getTraktPlaybackProgress } from '../services/trakt/sync'
import { getPMDBPlaybackProgress } from '../services/pmdb'
import { getAniListContinueWatching } from '../services/anilist'
import { getTmdbLandscapeBackdrop, tmdbProvider } from '../services/tmdb'
import StreamSelector from './StreamSelector'
import type { HomeRowConfig } from '../types'
import { formatTime } from '../services/player'

type SourceType = 'local' | 'simkl' | 'trakt' | 'pmdb' | 'anilist'

const SOURCE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'simkl', label: 'Simkl' },
  { value: 'trakt', label: 'Trakt' },
  { value: 'pmdb', label: 'PMDB' },
  { value: 'anilist', label: 'AniList' },
]

interface ContinueWatchingRowProps {
  row: HomeRowConfig
  headerLeftControls?: React.ReactNode
  headerRightControls?: React.ReactNode
}

interface ContinueWatchingItem {
  id: string
  mediaId: string
  mediaType: 'movie' | 'series'
  title: string
  subtitle?: string
  poster?: string
  backdrop?: string
  season?: number
  episode?: number
  progressSeconds: number
  durationSeconds: number
  progressPct: number
  imdbId?: string
  tmdbId?: number
  malId?: number
  anilistId?: number
  updatedAt: string
}

function normalizeResumeMediaId(mediaId: string, season?: number, episode?: number): string {
  if (season == null || episode == null) return mediaId
  const suffix = `:${season}:${episode}`
  return mediaId.endsWith(suffix) ? mediaId.slice(0, -suffix.length) : mediaId
}

export default function ContinueWatchingRow({ row, headerLeftControls, headerRightControls }: ContinueWatchingRowProps) {
  const [items, setItems] = useState<ContinueWatchingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  const watchProgress = useAppStore((s) => s.watchProgress)
  const updateHomeRow = useAppStore((s) => s.updateHomeRow)
  const continueWatchingSource = useAppStore((s) => s.continueWatchingSource)
  const continueWatchingLimit = useAppStore((s) => s.continueWatchingLimit)
  const setContinueWatchingSource = useAppStore((s) => s.setContinueWatchingSource)
  const keepFramesFor = useAppStore((s) => s.keepFramesFor)
  const source = (row.sourceType || continueWatchingSource) as SourceType
  const scrollRef = useRef<HTMLDivElement>(null)

  const changeSource = (next: SourceType) => {
    updateHomeRow(row.id, { sourceType: next })
    if (next === 'local' || next === 'trakt' || next === 'simkl' || next === 'pmdb' || next === 'anilist') {
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
    setLoading(true)
    setError(null)

    const loadProgress = async () => {
      try {
        let list: ContinueWatchingItem[] = []

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
          const simklRaw = await getSimklPlaybackProgress()
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
              const defaultDuration = i.type === 'movie' ? 120 * 60 : 45 * 60
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
              const defaultDuration = isMovie ? 120 * 60 : 45 * 60
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

          // Since Trakt doesn't return artwork URLs, fetch posters in the background for items missing posters
          if (!cancelled && list.length > 0) {
            const resolvedList = await Promise.all(
              list.map(async (item) => {
                if (item.poster && item.backdrop) return item
                try {
                  if (item.mediaType === 'movie' && item.tmdbId) {
                    const meta = await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`)
                    return { ...item, poster: meta.poster, backdrop: meta.backdrop }
                  } else if (item.mediaType === 'series' && item.tmdbId) {
                    const meta = await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)
                    return { ...item, poster: meta.poster, backdrop: meta.backdrop }
                  }
                } catch {
                  // Fallback to BTTTR if imdbId is present
                  if (item.imdbId) {
                    const poster = `https://btttr.cc/poster/auto/${item.imdbId}/auto.png`
                    return { ...item, poster }
                  }
                }
                return item
              })
            )
            list = resolvedList
          }
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

          // Since PMDB doesn't return metadata, fetch title & posters from TMDB
          if (!cancelled && list.length > 0) {
            const resolvedList = await Promise.all(
              list.map(async (item) => {
                try {
                  if (item.mediaType === 'movie' && item.tmdbId) {
                    const meta = await tmdbProvider.getMovie(`tmdb-${item.tmdbId}`)
                    return {
                      ...item,
                      mediaId: meta.imdbId || item.mediaId,
                      imdbId: meta.imdbId,
                      title: meta.title || 'Movie',
                      poster: meta.poster,
                      backdrop: meta.backdrop
                    }
                  } else if (item.mediaType === 'series' && item.tmdbId) {
                    const meta = await tmdbProvider.getShow(`tmdb-${item.tmdbId}`)
                    return {
                      ...item,
                      mediaId: meta.imdbId || item.mediaId,
                      imdbId: meta.imdbId,
                      title: meta.title || 'Show',
                      poster: meta.poster,
                      backdrop: meta.backdrop
                    }
                  }
                } catch (e) {
                  console.error('Failed to enrich PMDB item from TMDB:', e)
                }
                return item
              })
            )
            list = resolvedList
          }
        } else if (source === 'anilist') {
          list = await getAniListContinueWatching()
        }

        if (!cancelled && list.length > 0) {
          list = await Promise.all(
            list.map(async (item) => {
              if (!item.tmdbId) return item
              try {
                if (item.mediaType === 'series' && item.season != null && item.episode != null) {
                  const episode = await tmdbProvider.getEpisode(`tmdb-${item.tmdbId}`, item.season, item.episode)
                  if (keepFramesFor !== 'none' && episode.still) return { ...item, backdrop: episode.still }
                }

                if (item.mediaType === 'movie') {
                  const backdrop = await getTmdbLandscapeBackdrop('movie', item.tmdbId)
                  if (backdrop) return { ...item, backdrop }
                }

                if (!item.backdrop) {
                  const backdrop = await getTmdbLandscapeBackdrop('series', item.tmdbId)
                  if (backdrop) return { ...item, backdrop }
                }
              } catch {
                // Keep local/provider artwork if TMDB cannot enrich the row.
              }
              return item
            })
          )
        }

        if (!cancelled) {
          setItems(list.slice(0, continueWatchingLimit))
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to load Continue Watching.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadProgress()
    return () => { cancelled = true }
  }, [source, watchProgress, continueWatchingLimit, streamSelectorData])

  // ── Source selector (always rendered in header) ─────────────────────────────
  const sourceSelector = (
    <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
      {SOURCE_OPTIONS.map((opt) => (
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

  if (loading) {
    return (
      <div className="mb-8 select-none">
        <div className="flex items-center justify-between px-6 mb-4">
          <div className="flex items-center gap-2.5">
            {headerLeftControls}
            <h2 className="text-xl font-bold tracking-tight text-white/95">{row.title}</h2>
          </div>
          <div className="flex items-center gap-3">
            {sourceSelector}
            {headerRightControls}
          </div>
        </div>
        <div className="flex gap-4 overflow-x-hidden px-6 pb-2 animate-pulse">
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
            <h2 className="text-xl font-bold tracking-tight text-white/95">{row.title}</h2>
          </div>
          <div className="flex items-center gap-3">
            {sourceSelector}
            {headerRightControls}
          </div>
        </div>
        <div className="px-6">
          <div className="flex gap-4 overflow-x-hidden pb-2">
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
    <div className="mb-8">
      <div className="flex items-center justify-between px-6 mb-4">
        <div className="flex items-center gap-2.5">
          {headerLeftControls}
          <h2 className="text-xl font-bold tracking-tight text-white/95">{row.title}</h2>
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
        className="flex gap-4 overflow-x-auto overscroll-x-contain px-6 pb-2 scrollbar-none"
        style={{ scrollbarWidth: 'none', scrollSnapType: 'x proximity' }}
      >
        {items.map((item) => {
          const progressPercent = Math.min(100, Math.max(0, item.progressPct))
          return (
            <button
              key={item.id}
              onClick={() => {
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
              }}
              className="flex-shrink-0 w-72 group cursor-pointer focus:outline-none text-left transition-all duration-300"
            >
              <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated border border-white/5 transition-all duration-400 ease-out group-hover:border-white/20 group-hover:shadow-[0_20px_40px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.15)] group-hover:-translate-y-1.5 group-hover:scale-[1.03]">
                {item.backdrop ? (
                  <img
                    src={item.backdrop}
                    alt={item.title}
                    className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                    loading="lazy"
                  />
                ) : item.poster ? (
                  <img
                    src={item.poster}
                    alt={item.title}
                    className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
                    <span className="text-xl font-bold text-muted/30">{item.title?.charAt(0) || '?'}</span>
                  </div>
                )}

                {/* Permanent subtle dark gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent transition-opacity duration-300 group-hover:from-black/95" />

                {/* Resume Play Icon Overlay on Hover */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <span className="w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-xl flex items-center justify-center">
                    <svg className="w-6 h-6 ml-0.5 text-accent" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </span>
                </div>

                {/* Media Info Overlay */}
                <div className="absolute bottom-4 left-3 right-3 flex flex-col gap-1 z-10">
                  <h3 className="text-sm font-bold text-white tracking-wide truncate drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                    {item.title}
                  </h3>
                  <div className="flex items-center gap-2">
                    {item.subtitle ? (
                      <span className="text-[10px] bg-accent/20 border border-accent/20 text-accent font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider">
                        {item.subtitle}
                      </span>
                    ) : (
                      <span className="text-[10px] bg-white/10 text-gray-300 font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider">
                        Movie
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                      {formatTime(item.progressSeconds)} left
                    </span>
                  </div>
                </div>

                {/* Thin progress bar at the bottom */}
                <div className="absolute bottom-0 inset-x-0 h-1 bg-white/10">
                  <div className="h-full bg-accent" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {streamSelectorData && (
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
      )}
    </div>
  )
}
