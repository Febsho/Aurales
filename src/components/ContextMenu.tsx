import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useContextMenu, type ProviderKey, type ProviderWatchState } from '../hooks/useContextMenu'
import { useAppStore } from '../stores/appStore'
import { useToast } from './ui/Toast'
import type { SearchResult } from '../types'
import { getLocalWatchedStatus, searchResultToLookup, isWatchedFromProviders } from '../services/watchedStatus'

const PROVIDER_META: Record<ProviderKey, { label: string; color: string }> = {
  local: { label: 'Local', color: '#a3a3a3' },
  trakt: { label: 'Trakt', color: '#ef4444' },
  simkl: { label: 'Simkl', color: '#0ea5e9' },
  pmdb: { label: 'PMDB', color: '#a855f7' },
  anilist: { label: 'AniList', color: '#3b82f6' },
}

export default function ContextMenu() {
  const { open, x, y, target, close } = useContextMenu()
  const menuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { toast } = useToast()
  const [providerStates, setProviderStates] = useState<ProviderWatchState[]>([])
  const [adjusted, setAdjusted] = useState({ x: 0, y: 0 })

  const traktConnected = useAppStore((s) => s.traktConnected)
  const simklConnected = useAppStore((s) => s.simklConnected)
  const anilistConnected = useAppStore((s) => s.anilistConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const pmdbConnected = !!pmdbApiKey
  const watchProgress = useAppStore((s) => s.watchProgress)
  const setWatchProgress = useAppStore((s) => s.setWatchProgress)
  const removeWatchProgress = useAppStore((s) => s.removeWatchProgress)

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, close])

  useEffect(() => {
    if (!open || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let ax = x
    let ay = y
    if (x + rect.width > vw - 8) ax = vw - rect.width - 8
    if (y + rect.height > vh - 8) ay = vh - rect.height - 8
    if (ax < 8) ax = 8
    if (ay < 8) ay = 8
    setAdjusted({ x: ax, y: ay })
  }, [open, x, y])

  useEffect(() => {
    if (!open || !target) { setProviderStates([]); return }
    loadProviderStates()
  }, [open, target])

  const loadProviderStates = useCallback(async () => {
    if (!target) return
    const item = target.item
    const states: ProviderWatchState[] = []

    const localWatched = checkLocalWatched(item, target, watchProgress)
    states.push({ provider: 'local', connected: true, watched: localWatched, loading: false })

    if (traktConnected) {
      states.push({ provider: 'trakt', connected: true, watched: false, loading: true })
    }
    if (simklConnected) {
      states.push({ provider: 'simkl', connected: true, watched: false, loading: true })
    }
    if (pmdbConnected) {
      states.push({ provider: 'pmdb', connected: true, watched: false, loading: true })
    }
    if (anilistConnected && isAnimeItem(item)) {
      states.push({ provider: 'anilist', connected: true, watched: false, loading: true })
    }

    setProviderStates([...states])

    if (traktConnected) {
      checkTraktWatched(item, target).then((watched) => {
        setProviderStates((prev) => prev.map((s) => s.provider === 'trakt' ? { ...s, watched, loading: false } : s))
      })
    }
    if (simklConnected) {
      checkSimklWatched(item, target).then((watched) => {
        setProviderStates((prev) => prev.map((s) => s.provider === 'simkl' ? { ...s, watched, loading: false } : s))
      })
    }
    if (pmdbConnected) {
      checkPmdbWatched(item, target).then((watched) => {
        setProviderStates((prev) => prev.map((s) => s.provider === 'pmdb' ? { ...s, watched, loading: false } : s))
      })
    }
    if (anilistConnected && isAnimeItem(item)) {
      checkAniListWatched(item, target).then((watched) => {
        setProviderStates((prev) => prev.map((s) => s.provider === 'anilist' ? { ...s, watched, loading: false } : s))
      })
    }
  }, [target, traktConnected, simklConnected, pmdbConnected, anilistConnected, watchProgress])

  const handleToggleProvider = useCallback(async (provider: ProviderKey) => {
    if (!target) return
    const state = providerStates.find((s) => s.provider === provider)
    if (!state || state.loading) return
    const newWatched = !state.watched
    setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, loading: true } : s))

    try {
      if (provider === 'local') {
        await toggleLocalWatched(target, newWatched, watchProgress, setWatchProgress, removeWatchProgress)
      } else if (provider === 'trakt') {
        await toggleTraktWatched(target, newWatched)
      } else if (provider === 'simkl') {
        await toggleSimklWatched(target, newWatched)
      } else if (provider === 'pmdb') {
        await togglePmdbWatched(target, newWatched)
      } else if (provider === 'anilist') {
        await toggleAniListWatched(target, newWatched)
      }
      setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, watched: newWatched, loading: false } : s))
      const label = PROVIDER_META[provider].label
      toast('success', `${newWatched ? 'Marked' : 'Unmarked'} on ${label}`)
    } catch (err) {
      setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, loading: false } : s))
      toast('error', `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [target, providerStates, watchProgress, setWatchProgress, removeWatchProgress, toast])

  const handleMarkAllProviders = useCallback(async (watched: boolean) => {
    if (!target) return
    const connectedProviders = providerStates.filter((s) => s.connected && !s.loading)
    setProviderStates((prev) => prev.map((s) => s.connected ? { ...s, loading: true } : s))

    const results = await Promise.allSettled(
      connectedProviders.map(async (s) => {
        if (s.watched === watched) return
        if (s.provider === 'local') {
          await toggleLocalWatched(target, watched, watchProgress, setWatchProgress, removeWatchProgress)
        } else if (s.provider === 'trakt') {
          await toggleTraktWatched(target, watched)
        } else if (s.provider === 'simkl') {
          await toggleSimklWatched(target, watched)
        } else if (s.provider === 'pmdb') {
          await togglePmdbWatched(target, watched)
        } else if (s.provider === 'anilist') {
          await toggleAniListWatched(target, watched)
        }
      })
    )

    const failed = results.filter((r) => r.status === 'rejected').length
    setProviderStates((prev) => prev.map((s) => s.connected ? { ...s, watched, loading: false } : s))
    if (failed > 0) toast('warning', `${failed} provider(s) failed`)
    else toast('success', `${watched ? 'Marked' : 'Unmarked'} on all providers`)
    close()
  }, [target, providerStates, watchProgress, setWatchProgress, removeWatchProgress, toast, close])

  const handleGoToDetail = useCallback(() => {
    if (!target) return
    const item = target.item
    const path = item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`
    navigate(path, {
      state: {
        poster: item.poster, backdrop: item.backdrop, title: item.title,
        year: item.year, rating: item.rating, overview: item.overview,
        imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId,
        malId: item.malId, anilistId: item.anilistId,
        addonUrl: item.addonUrl, provider: item.provider,
        sourceAddonId: item.sourceAddonId, sourceAddonItemId: item.sourceAddonItemId,
      },
    })
    close()
  }, [target, navigate, close])

  const handleCopyId = useCallback(() => {
    if (!target) return
    const item = target.item
    const ids = [item.imdbId, item.tmdbId ? `tmdb:${item.tmdbId}` : null, item.tvdbId ? `tvdb:${item.tvdbId}` : null, item.id].filter(Boolean).join(', ')
    navigator.clipboard.writeText(ids)
    toast('info', 'IDs copied')
    close()
  }, [target, toast, close])

  if (!open || !target) return null

  const item = target.item
  const isEpisode = target.kind === 'episode'
  const isSeason = target.kind === 'season'
  const episodeStill = isEpisode ? target.episode.still : undefined
  const title = isEpisode
    ? `S${target.seasonNumber}E${target.episode.episodeNumber}`
    : isSeason
      ? `Season ${target.seasonNumber}`
      : item.title

  return (
    <div className="fixed inset-0 z-[300]" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={menuRef}
        className="fixed min-w-[280px] max-w-[320px] rounded-2xl overflow-hidden border border-white/[0.12]"
        style={{
          left: adjusted.x || x,
          top: adjusted.y || y,
          backdropFilter: 'blur(60px) saturate(200%)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.1)',
          animation: 'menuIn 150ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-white/[0.08] to-white/[0.02] pointer-events-none"></div>
        <div className="relative">
          {isEpisode && episodeStill && (
            <div className="relative w-full aspect-video overflow-hidden">
              <img
                src={episodeStill.replace('/w300', '/w780').replace('/w500', '/w780')}
                alt=""
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
              <div className="absolute bottom-3 left-3.5 right-3.5">
                <p className="text-[13px] font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{title}</p>
                {target.episode.name && (
                  <p className="text-[11px] text-white/70 truncate mt-0.5 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">{target.episode.name}</p>
                )}
                {target.episode.runtime && (
                  <p className="text-[10px] text-white/40 mt-0.5">{target.episode.runtime}m</p>
                )}
              </div>
            </div>
          )}
          {!isEpisode && (
            <div className="px-3.5 pt-3 pb-2 border-b border-white/[0.08]">
              <div className="flex items-center gap-2.5">
                {item.poster && (
                  <img src={item.poster} alt="" className="w-8 h-12 rounded-md object-cover flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-white truncate">{title}</p>
                  {!isSeason && item.year && (
                    <p className="text-[11px] text-white/40 mt-0.5">{item.year} &middot; {item.type === 'movie' ? 'Movie' : 'Series'}</p>
                  )}
                  {isSeason && (
                    <p className="text-[11px] text-white/40 mt-0.5">{target.episodeCount} episodes</p>
                  )}
                </div>
              </div>
            </div>
          )}
          {isEpisode && !episodeStill && (
            <div className="px-3.5 pt-3 pb-2 border-b border-white/[0.08]">
              <div className="flex items-center gap-2.5">
                {item.poster && (
                  <img src={item.poster} alt="" className="w-8 h-12 rounded-md object-cover flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-white truncate">{title}</p>
                  {target.episode.name && (
                    <p className="text-[11px] text-white/40 truncate mt-0.5">{target.episode.name}</p>
                  )}
                </div>
              </div>
            </div>
          )}
          {providerStates.length > 0 && (
            <div className="px-1.5 py-1.5 border-b border-white/[0.08]">
              <p className="px-2.5 py-1 text-[10px] font-semibold text-white/25 uppercase tracking-wider">Watch Status</p>
              {providerStates.map((state) => (
                <button
                  key={state.provider}
                  onClick={() => handleToggleProvider(state.provider)}
                  disabled={state.loading}
                  className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-50 group"
                >
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: PROVIDER_META[state.provider].color }}></div>
                  <span className="text-[13px] text-white/80 flex-1 text-left">{PROVIDER_META[state.provider].label}</span>
                  {state.loading ? (
                    <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin"></div>
                  ) : (
                    <div className={`w-4 h-4 rounded flex items-center justify-center transition-all ${state.watched ? 'bg-accent' : 'border border-white/20 group-hover:border-white/40'}`}>
                      {state.watched && (
                        <svg className="w-2.5 h-2.5 text-black" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          {providerStates.length > 1 && (
            <div className="px-1.5 py-1 border-b border-white/[0.08]">
              <button onClick={() => handleMarkAllProviders(true)} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer">
                <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-[13px] text-white/70">Mark all providers</span>
              </button>
              <button onClick={() => handleMarkAllProviders(false)} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer">
                <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-[13px] text-white/70">Unmark all providers</span>
              </button>
            </div>
          )}
          <div className="px-1.5 py-1.5">
            {target.kind === 'media' && (
              <button onClick={handleGoToDetail} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer">
                <svg className="w-4 h-4 text-white/50" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-[13px] text-white/70">Go to details</span>
              </button>
            )}
            <button onClick={handleCopyId} className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer">
              <svg className="w-4 h-4 text-white/50" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[13px] text-white/70">Copy IDs</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function isAnimeItem(item: SearchResult): boolean {
  return item.type === 'series' && !!(item.anilistId || item.malId)
}

function checkLocalWatched(
  item: SearchResult,
  target: ReturnType<typeof useContextMenu.getState>['target'],
  watchProgress: Map<string, import('../types').WatchProgress>,
): boolean {
  if (!target) return false
  if (target.kind === 'episode') {
    const lookup = { ...searchResultToLookup(item), season: target.seasonNumber, episode: target.episode.episodeNumber }
    return getLocalWatchedStatus(lookup, watchProgress)
  }
  return getLocalWatchedStatus(searchResultToLookup(item), watchProgress)
}

async function checkTraktWatched(
  item: SearchResult,
  target: ReturnType<typeof useContextMenu.getState>['target'],
): Promise<boolean> {
  try {
    const lookup = { ...searchResultToLookup(item) }
    if (target?.kind === 'episode') {
      lookup.season = target.seasonNumber
      lookup.episode = target.episode.episodeNumber
      lookup.absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
      lookup.isAnime = isAnimeItem(item)
    }
    return isWatchedFromProviders(lookup, ['trakt'], new Map())
  } catch { return false }
}

async function checkSimklWatched(
  item: SearchResult,
  target: ReturnType<typeof useContextMenu.getState>['target'],
): Promise<boolean> {
  try {
    const lookup = { ...searchResultToLookup(item) }
    if (target?.kind === 'episode') {
      lookup.season = target.seasonNumber
      lookup.episode = target.episode.episodeNumber
      lookup.absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
      lookup.isAnime = isAnimeItem(item)
    }
    return isWatchedFromProviders(lookup, ['simkl'], new Map())
  } catch { return false }
}

async function checkPmdbWatched(
  item: SearchResult,
  target: ReturnType<typeof useContextMenu.getState>['target'],
): Promise<boolean> {
  try {
    const lookup = { ...searchResultToLookup(item) }
    if (target?.kind === 'episode') {
      lookup.season = target.seasonNumber
      lookup.episode = target.episode.episodeNumber
      lookup.absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
      lookup.isAnime = isAnimeItem(item)
    }
    return isWatchedFromProviders(lookup, ['pmdb'], new Map())
  } catch { return false }
}

async function checkAniListWatched(
  item: SearchResult,
  target: ReturnType<typeof useContextMenu.getState>['target'],
): Promise<boolean> {
  try {
    const lookup = { ...searchResultToLookup(item) }
    if (target?.kind === 'episode') {
      lookup.season = target.seasonNumber
      lookup.episode = target.episode.episodeNumber
      lookup.absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
      lookup.isAnime = true
    }
    return isWatchedFromProviders(lookup, ['anilist'], new Map())
  } catch { return false }
}

async function toggleLocalWatched(
  target: NonNullable<ReturnType<typeof useContextMenu.getState>['target']>,
  watched: boolean,
  watchProgress: Map<string, import('../types').WatchProgress>,
  setWatchProgress: (id: string, progress: import('../types').WatchProgress) => void,
  removeWatchProgress: (mediaIds: string[], season?: number, episode?: number) => void,
) {
  const item = target.item
  if (target.kind === 'episode') {
    const key = `${item.id}:${target.seasonNumber}:${target.episode.episodeNumber}`
    if (watched) {
      setWatchProgress(key, {
        id: key, mediaType: 'series', mediaId: item.id,
        season: target.seasonNumber, episode: target.episode.episodeNumber,
        progressSeconds: 0, durationSeconds: 1, completed: true,
        title: target.episode.name, updatedAt: new Date().toISOString(),
        imdbId: item.imdbId, tmdbId: item.tmdbId as string | undefined,
      })
    } else {
      removeWatchProgress([item.id], target.seasonNumber, target.episode.episodeNumber)
    }
  } else if (target.kind === 'season') {
    const ids = [item.id, item.imdbId].filter(Boolean) as string[]
    if (watched) {
      for (let ep = 1; ep <= target.episodeCount; ep++) {
        const key = `${item.id}:${target.seasonNumber}:${ep}`
        setWatchProgress(key, {
          id: key, mediaType: 'series', mediaId: item.id,
          season: target.seasonNumber, episode: ep,
          progressSeconds: 0, durationSeconds: 1, completed: true,
          updatedAt: new Date().toISOString(),
          imdbId: item.imdbId, tmdbId: item.tmdbId as string | undefined,
        })
      }
    } else {
      for (let ep = 1; ep <= target.episodeCount; ep++) {
        removeWatchProgress(ids, target.seasonNumber, ep)
      }
    }
  } else {
    if (watched) {
      setWatchProgress(item.id, {
        id: item.id, mediaType: item.type, mediaId: item.id,
        progressSeconds: 0, durationSeconds: 1, completed: true,
        title: item.title, poster: item.poster,
        updatedAt: new Date().toISOString(),
        imdbId: item.imdbId, tmdbId: item.tmdbId as string | undefined,
      })
    } else {
      removeWatchProgress([item.id, item.imdbId].filter(Boolean) as string[])
    }
  }
}

async function toggleTraktWatched(
  target: NonNullable<ReturnType<typeof useContextMenu.getState>['target']>,
  watched: boolean,
) {
  const item = target.item
  const imdbId = item.imdbId
  if (!imdbId) throw new Error('No IMDb ID for Trakt')

  if (item.type === 'movie') {
    const { markMovieWatched, markMovieUnwatched } = await import('../services/trakt/sync')
    if (watched) await markMovieWatched(imdbId)
    else await markMovieUnwatched(imdbId)
  } else if (target.kind === 'episode') {
    const { markEpisodeWatched, markEpisodeUnwatched } = await import('../services/trakt/sync')
    if (watched) await markEpisodeWatched(imdbId, target.seasonNumber, target.episode.episodeNumber, target.appSeasonCounts)
    else await markEpisodeUnwatched(imdbId, target.seasonNumber, target.episode.episodeNumber, target.appSeasonCounts)
  } else if (target.kind === 'season') {
    const { markEpisodeWatched, markEpisodeUnwatched } = await import('../services/trakt/sync')
    for (let ep = 1; ep <= target.episodeCount; ep++) {
      if (watched) await markEpisodeWatched(imdbId, target.seasonNumber, ep, target.appSeasonCounts)
      else await markEpisodeUnwatched(imdbId, target.seasonNumber, ep, target.appSeasonCounts)
    }
  } else {
    const { markShowUnwatched, addToHistory } = await import('../services/trakt/sync')
    if (watched) await addToHistory({ shows: [{ ids: { imdb: imdbId }, watched_at: new Date().toISOString() }] })
    else await markShowUnwatched(imdbId)
  }
}

async function toggleSimklWatched(
  target: NonNullable<ReturnType<typeof useContextMenu.getState>['target']>,
  watched: boolean,
) {
  const item = target.item
  const tmdbId = item.tmdbId != null ? Number(String(item.tmdbId).replace('tmdb-', '')) : undefined
  const tvdbId = item.tvdbId != null ? Number(String(item.tvdbId).replace('tvdb-', '')) : undefined
  const mediaRef = {
    localId: item.id,
    title: item.title,
    year: item.year,
    imdbId: item.imdbId,
    tmdbId: Number.isFinite(tmdbId) ? tmdbId : undefined,
    tvdbId: Number.isFinite(tvdbId) ? tvdbId : undefined,
  }

  if (item.type === 'movie') {
    const { markMovieWatchedOnSimkl, removeWatchedFromSimkl } = await import('../services/simkl/history')
    if (watched) await markMovieWatchedOnSimkl(mediaRef)
    else await removeWatchedFromSimkl(mediaRef, 'movie')
  } else if (target.kind === 'episode') {
    const { markEpisodeWatchedOnSimkl, removeEpisodeWatchedOnSimkl } = await import('../services/simkl/history')
    const absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
    const providerEpisode = isAnimeItem(item) && absoluteEpisode != null
      ? { season: 1, episode: absoluteEpisode }
      : { season: target.seasonNumber, episode: target.episode.episodeNumber }
    if (watched) await markEpisodeWatchedOnSimkl(mediaRef, providerEpisode)
    else await removeEpisodeWatchedOnSimkl(mediaRef, providerEpisode)
  } else if (target.kind === 'season') {
    const { markEpisodeWatchedOnSimkl, removeEpisodeWatchedOnSimkl } = await import('../services/simkl/history')
    for (let ep = 1; ep <= target.episodeCount; ep++) {
      if (watched) await markEpisodeWatchedOnSimkl(mediaRef, { season: target.seasonNumber, episode: ep })
      else await removeEpisodeWatchedOnSimkl(mediaRef, { season: target.seasonNumber, episode: ep })
    }
  } else {
    if (watched) {
      const { markMovieWatchedOnSimkl } = await import('../services/simkl/history')
      await markMovieWatchedOnSimkl(mediaRef)
    } else {
      const { removeWatchedFromSimkl } = await import('../services/simkl/history')
      await removeWatchedFromSimkl(mediaRef, 'show')
    }
  }
}

async function togglePmdbWatched(
  target: NonNullable<ReturnType<typeof useContextMenu.getState>['target']>,
  watched: boolean,
) {
  const item = target.item
  const tmdbId = Number(item.tmdbId)
  if (!tmdbId || !Number.isFinite(tmdbId)) throw new Error('No TMDB ID for PMDB')

  const { scrobblePMDB } = await import('../services/pmdb')
  if (item.type === 'movie') {
    if (watched) await scrobblePMDB(tmdbId, 'movie')
    else throw new Error('PMDB does not support unwatch')
  } else if (target.kind === 'episode') {
    const absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
    const providerEpisode = isAnimeItem(item) && absoluteEpisode != null
      ? { season: 1, episode: absoluteEpisode }
      : { season: target.seasonNumber, episode: target.episode.episodeNumber }
    if (watched) await scrobblePMDB(tmdbId, 'tv', providerEpisode.season, providerEpisode.episode)
    else throw new Error('PMDB does not support unwatch')
  } else if (target.kind === 'season') {
    if (watched) {
      for (let ep = 1; ep <= target.episodeCount; ep++) {
        await scrobblePMDB(tmdbId, 'tv', target.seasonNumber, ep)
      }
    } else {
      throw new Error('PMDB does not support unwatch')
    }
  } else {
    if (watched) await scrobblePMDB(tmdbId, 'tv')
    else throw new Error('PMDB does not support unwatch')
  }
}

async function toggleAniListWatched(
  target: NonNullable<ReturnType<typeof useContextMenu.getState>['target']>,
  watched: boolean,
) {
  const item = target.item
  if (!item.anilistId && !item.malId) throw new Error('No AniList/MAL ID')

  if (watched) {
    if (target.kind === 'episode') {
      const { saveAniListProgress } = await import('../services/anilist')
      await saveAniListProgress(
        { anilistId: item.anilistId, malId: item.malId, episode: target.episode.episodeNumber } as any,
        0.5,
      )
    } else {
      const { addToAniListPlanning } = await import('../services/anilist')
      await addToAniListPlanning(item.anilistId as number | undefined, item.malId as number | undefined)
    }
  } else {
    const { removeFromAniListList } = await import('../services/anilist')
    await removeFromAniListList(item.anilistId as number | undefined, item.malId as number | undefined)
  }
}
