import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useContextMenu, type ProviderKey, type ProviderWatchState } from '../hooks/useContextMenu'
import { useAppStore } from '../stores/appStore'
import { useToast } from './ui/Toast'
import type { SearchResult } from '../types'
import { getLocalWatchedStatus, searchResultToLookup, isWatchedFromProviders, isWatchedFromProviderFresh } from '../services/watchedStatus'
import { cacheClearCategory } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { saveRecommendationFeedback } from '../services/discovery/feedbackStore'
import type { RecommendationFeedbackKind } from '../services/discovery/types'

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
  const providerLoadIdRef = useRef(0)
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

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return
    const updatePosition = () => {
      if (!menuRef.current) return
      const rect = menuRef.current.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const visibleHeight = Math.min(menuRef.current.scrollHeight, vh - 16)
      let ax = x
      let ay = y
      if (x + rect.width > vw - 8) ax = vw - rect.width - 8
      if (y + visibleHeight > vh - 8) ay = vh - visibleHeight - 8
      if (ax < 8) ax = 8
      if (ay < 8) ay = 8
      setAdjusted({ x: ax, y: ay })
    }
    updatePosition()
    const observer = new ResizeObserver(() => {
      updatePosition()
    })
    observer.observe(menuRef.current)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, x, y])

  const [enrichedItem, setEnrichedItem] = useState<SearchResult | null>(null)

  useEffect(() => {
    if (!open || !target) {
      setEnrichedItem(null)
      return
    }

    let cancelled = false
    const rawItem = target.item
    setEnrichedItem(rawItem)

    ;(async () => {
      try {
        const imdbId = rawItem.imdbId || (String(rawItem.id).startsWith('tt') ? rawItem.id : undefined)
        const tvdbId = rawItem.tvdbId ? Number(String(rawItem.tvdbId).replace(/^tvdb[-:]/i, '')) : undefined
        const tmdbId = rawItem.tmdbId ? Number(String(rawItem.tmdbId).replace(/^tmdb[-:]/i, '')) : undefined

        // 1. Check local anime lists (fast O(1) in-memory lookup)
        const { lookupByImdbId, lookupByTvdbId, lookupByTmdbId } = await import('../services/animeLists')
        let animeMatch: any = null
        if (imdbId) {
          animeMatch = await lookupByImdbId(imdbId)
        }
        if (!animeMatch && tvdbId) {
          const matches = await lookupByTvdbId(tvdbId)
          if (matches && matches.length > 0) animeMatch = matches[0]
        }
        if (!animeMatch && tmdbId) {
          const matches = await lookupByTmdbId(tmdbId)
          if (matches.length > 0) animeMatch = matches[0]
        }

        if (animeMatch && !cancelled) {
          const tmdbIdVal = typeof animeMatch.themoviedb_id === 'object'
            ? (animeMatch.themoviedb_id.tv || animeMatch.themoviedb_id.movie)
            : animeMatch.themoviedb_id

          setEnrichedItem({
            ...rawItem,
            isAnime: true,
            anilistId: rawItem.anilistId || animeMatch.anilist_id,
            malId: rawItem.malId || animeMatch.mal_id,
            tvdbId: rawItem.tvdbId || animeMatch.tvdb_id,
            tmdbId: rawItem.tmdbId || tmdbIdVal,
            imdbId: rawItem.imdbId || (Array.isArray(animeMatch.imdb_id) ? animeMatch.imdb_id[0] : animeMatch.imdb_id),
          })
          return
        }

        // 2. Resolve TMDB ID if needed and not anime
        if (!tmdbId && imdbId && !cancelled) {
          const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
          const found = await tmdbFindByExternalId(imdbId, 'imdb_id')
          if (found.tmdbId && !cancelled) {
            setEnrichedItem({
              ...rawItem,
              tmdbId: String(found.tmdbId),
            })
          }
        }
      } catch (e) {
        console.error('[ContextMenu] Enrichment failed:', e)
      }
    })()

    return () => { cancelled = true }
  }, [open, target])

  const loadProviderStates = useCallback(async (item: SearchResult) => {
    if (!target) return
    const loadId = ++providerLoadIdRef.current
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

    const applyResult = (provider: ProviderKey, watched: boolean) => {
      if (providerLoadIdRef.current !== loadId) return
      setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, watched, loading: false } : s))
    }

    if (traktConnected) {
      checkTraktWatched(item, target).then((watched) => {
        applyResult('trakt', watched)
      })
    }
    if (simklConnected) {
      checkSimklWatched(item, target).then((watched) => {
        applyResult('simkl', watched)
      })
    }
    if (pmdbConnected) {
      checkPmdbWatched(item, target).then((watched) => {
        applyResult('pmdb', watched)
      })
    }
    if (anilistConnected && isAnimeItem(item)) {
      checkAniListWatched(item, target).then((watched) => {
        applyResult('anilist', watched)
      })
    }
  }, [target, traktConnected, simklConnected, pmdbConnected, anilistConnected, watchProgress])

  useEffect(() => {
    if (!open || !target || !enrichedItem) {
      providerLoadIdRef.current += 1
      return
    }
    loadProviderStates(enrichedItem)
  }, [open, target, enrichedItem, loadProviderStates])

  const handleToggleProvider = useCallback(async (provider: ProviderKey) => {
    if (!target) return
    const item = enrichedItem || target.item
    const enrichedTarget = { ...target, item }
    const state = providerStates.find((s) => s.provider === provider)
    if (!state || state.loading) return
    const newWatched = !state.watched
    setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, loading: true } : s))

    try {
      if (provider === 'local') {
        await toggleLocalWatched(enrichedTarget, newWatched, watchProgress, setWatchProgress, removeWatchProgress)
      } else if (provider === 'trakt') {
        await toggleTraktWatched(enrichedTarget, newWatched)
      } else if (provider === 'simkl') {
        await toggleSimklWatched(enrichedTarget, newWatched)
      } else if (provider === 'pmdb') {
        await togglePmdbWatched(enrichedTarget, newWatched)
      } else if (provider === 'anilist') {
        await toggleAniListWatched(enrichedTarget, newWatched)
      }
      await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)
      setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, watched: newWatched, loading: false } : s))
      const label = PROVIDER_META[provider].label
      toast('success', `${newWatched ? 'Marked' : 'Unmarked'} on ${label}`)
    } catch (err) {
      setProviderStates((prev) => prev.map((s) => s.provider === provider ? { ...s, loading: false } : s))
      toast('error', `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }, [target, enrichedItem, providerStates, watchProgress, setWatchProgress, removeWatchProgress, toast])

  const handleMarkAllProviders = useCallback(async (watched: boolean) => {
    if (!target) return
    const item = enrichedItem || target.item
    const enrichedTarget = { ...target, item }
    const connectedProviders = providerStates.filter((s) => s.connected && !s.loading)
    setProviderStates((prev) => prev.map((s) => s.connected ? { ...s, loading: true } : s))

    const results = await Promise.allSettled(
      connectedProviders.map(async (s) => {
        if (s.watched === watched) return
        if (s.provider === 'local') {
          await toggleLocalWatched(enrichedTarget, watched, watchProgress, setWatchProgress, removeWatchProgress)
        } else if (s.provider === 'trakt') {
          await toggleTraktWatched(enrichedTarget, watched)
        } else if (s.provider === 'simkl') {
          await toggleSimklWatched(enrichedTarget, watched)
        } else if (s.provider === 'pmdb') {
          await togglePmdbWatched(enrichedTarget, watched)
        } else if (s.provider === 'anilist') {
          await toggleAniListWatched(enrichedTarget, watched)
        }
      })
    )

    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed < connectedProviders.length) {
      await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)
    }
    const successfulProviders = new Set(
      connectedProviders
        .filter((_, index) => results[index]?.status === 'fulfilled')
        .map((s) => s.provider)
    )
    setProviderStates((prev) => prev.map((s) =>
      successfulProviders.has(s.provider)
        ? { ...s, watched, loading: false }
        : { ...s, loading: false }
    ))
    if (failed > 0) toast('warning', `${failed} provider(s) failed`)
    else toast('success', `${watched ? 'Marked' : 'Unmarked'} on all providers`)
    close()
  }, [target, enrichedItem, providerStates, watchProgress, setWatchProgress, removeWatchProgress, toast, close])

  const handleGoToDetail = useCallback(() => {
    if (!target) return
    const item = enrichedItem || target.item
    const path = item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`
    navigate(path, {
      state: {
        poster: item.poster, backdrop: item.backdrop, logo: item.logo, title: item.title,
        year: item.year, rating: item.rating, overview: item.overview,
        imdbId: item.imdbId, tmdbId: item.tmdbId, tvdbId: item.tvdbId,
        malId: item.malId, anilistId: item.anilistId,
        addonUrl: item.addonUrl, provider: item.provider,
        sourceAddonId: item.sourceAddonId, sourceAddonItemId: item.sourceAddonItemId,
      },
    })
    close()
  }, [target, enrichedItem, navigate, close])

  const handleCopyId = useCallback(() => {
    if (!target) return
    const item = enrichedItem || target.item
    const ids = [item.imdbId, item.tmdbId ? `tmdb:${item.tmdbId}` : null, item.tvdbId ? `tvdb:${item.tvdbId}` : null, item.id].filter(Boolean).join(', ')
    navigator.clipboard.writeText(ids)
    toast('info', 'IDs copied')
    close()
  }, [target, enrichedItem, toast, close])

  const handleRecommendationFeedback = useCallback((kind: RecommendationFeedbackKind) => {
    if (!target) return
    const item = enrichedItem || target.item
    saveRecommendationFeedback(item, kind)
    toast('success', kind === 'more-like-this' ? 'Recommendations adjusted' : 'Feedback saved')
    close()
  }, [target, enrichedItem, toast, close])

  if (!open || !target) return null

  const item = enrichedItem || target.item
  const isEpisode = target.kind === 'episode'
  const isSeason = target.kind === 'season'
  const episodeStill = isEpisode ? target.episode.still : undefined
  const title = isEpisode
    ? `S${target.seasonNumber}E${target.episode.episodeNumber}`
    : isSeason
      ? `Season ${target.seasonNumber}`
      : item.title

  const menu = (
    <div className="fixed inset-0 z-[300]" onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={menuRef}
        className="fixed min-w-[280px] max-w-[320px] rounded-2xl border border-white/[0.08] overscroll-contain"
        style={{
          left: adjusted.x || x,
          top: adjusted.y || y,
          maxHeight: 'calc(100vh - 16px)',
          overflowY: 'auto',
          scrollbarWidth: 'thin',
          background: 'rgba(10, 10, 12, 0.45)',
          backdropFilter: 'blur(40px) saturate(220%)',
          WebkitBackdropFilter: 'blur(40px) saturate(220%)',
          boxShadow: '0 32px 64px rgba(0,0,0,0.65), inset 0 1px 1px rgba(255,255,255,0.12)',
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
                    <p className="text-[11px] text-white/40 mt-0.5">{item.year} &middot; {isAnimeItem(item) ? 'Anime' : item.type === 'movie' ? 'Movie' : 'Series'}</p>
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
          {target.kind === 'media' && <div className="border-t border-white/[0.08] px-1.5 py-1.5">
            <p className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/25">Recommendations</p>
            {([['more-like-this','Show me more like this'],['less-like-this','Show me less like this'],['already-seen',"I've already seen this"],['not-interested','Not interested'],['hide','Hide this title']] as const).map(([kind,label]) => <button key={kind} onClick={() => handleRecommendationFeedback(kind)} className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-white/70 transition-colors hover:bg-white/[0.08]">{label}</button>)}
          </div>}
        </div>
      </div>
    </div>
  )

  return createPortal(menu, document.body)
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function isAnimeItem(item: SearchResult): boolean {
  const genres = item.genres?.map((g) => g.toLowerCase()) || []
  const hasAnimeGenre = genres.includes('anime') || item.isAnime || item.provider === 'anilist' || item.provider === 'mal' || /^(mal|anilist)[-:]/i.test(item.id)
  const isDiscoverAnime = (item.genreIds?.includes(16) || genres.includes('animation')) && ['ja', 'zh', 'ko'].includes(item.originalLanguage || '')
  return Boolean(hasAnimeGenre || isDiscoverAnime)
}

function seasonEpToAbsolute(season: number, episode: number, seasonCounts?: { season: number; count: number }[]): number | null {
  if (!seasonCounts?.length) return null
  let absolute = 0
  for (const s of seasonCounts) {
    if (s.season >= season) break
    absolute += s.count
  }
  return absolute + episode
}

function providerEpisodeForTarget(
  item: SearchResult,
  season: number,
  episode: number,
  appSeasonCounts?: { season: number; count: number }[],
  explicitAbsolute?: number,
): { season: number; episode: number } {
  const absolute = explicitAbsolute ?? seasonEpToAbsolute(season, episode, appSeasonCounts)
  return isAnimeItem(item) && absolute != null
    ? { season: 1, episode: absolute }
    : { season, episode }
}

function appEpisodeForTarget(season: number, episode: number): { season: number; episode: number } {
  return { season, episode }
}

function numericId(value: unknown): number | undefined {
  if (value == null) return undefined
  const num = Number(String(value).replace(/^(tmdb|tvdb|mal|anilist)-/i, ''))
  return Number.isFinite(num) && num > 0 ? num : undefined
}

function aniListExactMarkIds(item: SearchResult): string[] {
  const ids = [
    item.id,
    item.imdbId,
    item.tmdbId,
    item.tmdbId ? `tmdb-${numericId(item.tmdbId) ?? item.tmdbId}` : undefined,
    item.tvdbId,
    item.tvdbId ? `tvdb-${numericId(item.tvdbId) ?? item.tvdbId}` : undefined,
    item.malId ? `mal-${item.malId}` : undefined,
    item.anilistId ? `anilist-${item.anilistId}` : undefined,
  ].filter((id): id is string | number => id != null && id !== '')
  return [...new Set(ids.map(String))]
}

async function mapAnimeEpisodeForTarget(
  item: SearchResult,
  target: Extract<NonNullable<ReturnType<typeof useContextMenu.getState>['target']>, { kind: 'episode' }>,
) {
  if (!isAnimeItem(item)) return null
  const tvdbSeriesId = numericId(item.tvdbId)
  if (!tvdbSeriesId) return null
  try {
    const { mapEpisodeToProviders, isConfidenceSufficient } = await import('../services/anime-mapping')
    const mapping = await mapEpisodeToProviders({
      localMediaId: item.id,
      tvdbSeriesId,
      tvdbSeasonNumber: target.seasonNumber,
      tvdbEpisodeNumber: target.episode.episodeNumber,
      tvdbEpisodeId: numericId(target.episode.tvdbId),
    })
    return mapping && isConfidenceSufficient(mapping) ? mapping : null
  } catch (_) {
    return null
  }
}

async function resolveAniListEpisodeForTarget(
  item: SearchResult,
  target: Extract<NonNullable<ReturnType<typeof useContextMenu.getState>['target']>, { kind: 'episode' }>,
): Promise<{ anilistId?: number | string; malId?: number | string; episode: number }> {
  const absoluteEpisode = target.episode.absoluteEpisodeNumber ?? target.episode.debugOriginalAbsoluteNumber
  const providerEpisode = providerEpisodeForTarget(item, target.seasonNumber, target.episode.episodeNumber, target.appSeasonCounts, absoluteEpisode)
  const mapping = await mapAnimeEpisodeForTarget(item, target)
  if (mapping?.anilist?.mediaId && mapping.anilist.episodeNumber) {
    return {
      anilistId: mapping.anilist.mediaId,
      malId: mapping.mal?.id ?? item.malId,
      episode: mapping.anilist.episodeNumber,
    }
  }
  if (mapping?.mal?.id && mapping.mal.episodeNumber) {
    return {
      anilistId: item.anilistId,
      malId: mapping.mal.id,
      episode: mapping.mal.episodeNumber,
    }
  }

  const tvdbSeriesId = numericId(item.tvdbId)
  if (isAnimeItem(item) && tvdbSeriesId) {
    try {
      const { mapTvdbEpisodeToAnimeProviders } = await import('../services/animeLists')
      const mapped = await mapTvdbEpisodeToAnimeProviders(tvdbSeriesId, target.seasonNumber, target.episode.episodeNumber)
      if ((mapped?.anilistId || mapped?.malId) && mapped.episode) {
        return {
          anilistId: mapped.anilistId ?? item.anilistId,
          malId: mapped.malId ?? item.malId,
          episode: mapped.episode,
        }
      }
    } catch (_) {
      // Fall back below.
    }
  }

  return {
    anilistId: item.anilistId,
    malId: item.malId,
    episode: providerEpisode.episode,
  }
}

async function mapAnimeProvidersForTarget(
  item: SearchResult,
  target: Extract<NonNullable<ReturnType<typeof useContextMenu.getState>['target']>, { kind: 'episode' }>,
) {
  const tvdbSeriesId = numericId(item.tvdbId)
  if (!isAnimeItem(item) || !tvdbSeriesId) return null
  try {
    const { mapTvdbEpisodeToAnimeProviders } = await import('../services/animeLists')
    const result = await mapTvdbEpisodeToAnimeProviders(tvdbSeriesId, target.seasonNumber, target.episode.episodeNumber)
    if (result) return result
  } catch (_) { /* fall through */ }
  try {
    const { mapEpisodeToProviders, isConfidenceSufficient } = await import('../services/anime-mapping')
    const apiMapping = await mapEpisodeToProviders({
      localMediaId: item.id,
      tvdbSeriesId,
      tvdbSeasonNumber: target.seasonNumber,
      tvdbEpisodeNumber: target.episode.episodeNumber,
    })
    if (apiMapping && isConfidenceSufficient(apiMapping)) {
      return {
        anilistId: apiMapping.anilist?.mediaId,
        malId: apiMapping.mal?.id,
        simklId: apiMapping.simkl?.id,
        traktId: apiMapping.trakt?.id,
        tmdbId: apiMapping.tmdb?.id,
        episode: apiMapping.simkl?.episodeNumber ?? apiMapping.trakt?.episodeNumber ?? target.episode.episodeNumber,
        season: apiMapping.trakt?.seasonNumber ?? target.seasonNumber,
      }
    }
  } catch (_) { /* fall through */ }
  return null
}

async function resolvePmdbEpisodeForTarget(
  item: SearchResult,
  target: Extract<NonNullable<ReturnType<typeof useContextMenu.getState>['target']>, { kind: 'episode' }>,
): Promise<{ tmdbId: number; season: number; episode: number }> {
  let tmdbId = numericId(item.tmdbId)
  if (!tmdbId) {
    const { lookupTmdbId } = await import('../services/pmdb')
    const preferred = 'tv'
    if (item.imdbId) {
      const mapped = await lookupTmdbId('imdb', item.imdbId, preferred).catch(() => null)
      if (mapped) tmdbId = mapped.tmdbId
    }
    if (!tmdbId && item.tvdbId) {
      const mapped = await lookupTmdbId('tvdb', String(item.tvdbId).replace('tvdb-', ''), preferred).catch(() => null)
      if (mapped) tmdbId = mapped.tmdbId
    }
  }
  const fallback = {
    tmdbId: tmdbId || 0,
    season: target.seasonNumber,
    episode: target.episode.episodeNumber,
  }
  if (!isAnimeItem(item)) return fallback
  const mapped = await mapAnimeProvidersForTarget(item, target)
  if (mapped?.tmdbId && mapped.episode) {
    const absoluteEpisode = target.episode.absoluteEpisodeNumber ??
      target.episode.debugOriginalAbsoluteNumber ??
      seasonEpToAbsolute(target.seasonNumber, target.episode.episodeNumber, target.appSeasonCounts)
    const tvdbSeriesId = numericId(item.tvdbId)
    if (tvdbSeriesId && absoluteEpisode != null) {
      try {
        const { shouldFlattenPmdbAnimeEpisodes } = await import('../services/animeLists')
        if (await shouldFlattenPmdbAnimeEpisodes(tvdbSeriesId, mapped.tmdbId)) {
          return {
            tmdbId: mapped.tmdbId,
            season: 1,
            episode: absoluteEpisode,
          }
        }
      } catch (_) {
        // Use provider mapping below.
      }
    }
    return {
      tmdbId: mapped.tmdbId || tmdbId || 0,
      season: mapped.season,
      episode: mapped.episode,
    }
  }
  return fallback
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
  if (target.kind === 'season') {
    const lookup = { ...searchResultToLookup(item), season: target.seasonNumber, seasonEpisodeCount: target.episodeCount }
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
      lookup.appSeasonEpCounts = target.appSeasonCounts
      const mapped = await mapAnimeProvidersForTarget(item, target)
      if (mapped?.traktId) {
        lookup.traktId = mapped.traktId
        lookup.season = mapped.season
        lookup.episode = mapped.episode
        lookup.appSeasonEpCounts = undefined
      }
    } else if (target?.kind === 'season') {
      lookup.season = target.seasonNumber
      lookup.seasonEpisodeCount = target.episodeCount
      lookup.isAnime = isAnimeItem(item)
      lookup.appSeasonEpCounts = target.appSeasonCounts
    }
    return await isWatchedFromProviderFresh(lookup, 'trakt')
  } catch (err) {
    console.error('[TraktCheck] error:', err)
    return false
  }
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
      lookup.appSeasonEpCounts = target.appSeasonCounts
      const mapped = await mapAnimeProvidersForTarget(item, target)
      if (mapped?.simklId) {
        lookup.simklId = mapped.simklId
        lookup.malId = mapped.malId ?? lookup.malId
      }
    } else if (target?.kind === 'season') {
      lookup.season = target.seasonNumber
      lookup.seasonEpisodeCount = target.episodeCount
      lookup.isAnime = isAnimeItem(item)
      lookup.appSeasonEpCounts = target.appSeasonCounts
    }
    return await isWatchedFromProviderFresh(lookup, 'simkl')
  } catch (_) { return false }
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
      lookup.appSeasonEpCounts = target.appSeasonCounts
      const mapped = await resolvePmdbEpisodeForTarget(item, target)
      lookup.tmdbId = mapped.tmdbId
      lookup.season = mapped.season
      lookup.episode = mapped.episode
      lookup.appSeasonEpCounts = undefined
    } else if (target?.kind === 'season') {
      lookup.season = target.seasonNumber
      lookup.seasonEpisodeCount = target.episodeCount
      lookup.isAnime = isAnimeItem(item)
      lookup.appSeasonEpCounts = target.appSeasonCounts
    }
    return isWatchedFromProviders(lookup, ['pmdb'], new Map())
  } catch (_) { return false }
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
      lookup.appSeasonEpCounts = target.appSeasonCounts
    } else if (target?.kind === 'season') {
      lookup.season = target.seasonNumber
      lookup.seasonEpisodeCount = target.episodeCount
      lookup.isAnime = true
      lookup.appSeasonEpCounts = target.appSeasonCounts
    }
    return isWatchedFromProviders(lookup, ['anilist'], new Map())
  } catch (_) { return false }
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
    const trakt = await import('../services/trakt/sync')
    const animeProviders = await mapAnimeProvidersForTarget(item, target)
    if (isAnimeItem(item) && animeProviders?.traktId) {
      const payload = {
        shows: [{
          ids: { trakt: animeProviders.traktId },
          seasons: [{ number: animeProviders.season, episodes: [{ number: animeProviders.episode, watched_at: new Date().toISOString() }] }],
        }],
      }
      if (watched) await trakt.addToHistory(payload)
      else await trakt.removeFromHistory({ shows: [{ ids: { trakt: animeProviders.traktId }, seasons: [{ number: animeProviders.season, episodes: [{ number: animeProviders.episode }] }] }] })
    } else if (watched) {
      await trakt.markEpisodeWatched(imdbId, target.seasonNumber, target.episode.episodeNumber, target.appSeasonCounts)
    } else {
      await trakt.markEpisodeUnwatched(imdbId, target.seasonNumber, target.episode.episodeNumber, target.appSeasonCounts)
    }
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
  const anime = isAnimeItem(item)
  const mediaRef = {
    localId: item.id,
    title: item.title,
    year: item.year,
    type: anime ? 'anime' as const : item.type === 'movie' ? 'movie' as const : 'show' as const,
    contentType: item.type === 'movie' ? 'movie' as const : 'series' as const,
    isAnime: anime,
    imdbId: item.imdbId,
    tmdbId: Number.isFinite(tmdbId) ? tmdbId : undefined,
    tvdbId: Number.isFinite(tvdbId) ? tvdbId : undefined,
    malId: item.malId != null ? Number(item.malId) : undefined,
    anilistId: item.anilistId != null ? Number(item.anilistId) : undefined,
    simklId: item.simklId,
  }

  if (item.type === 'movie') {
    const { markMovieWatchedOnSimkl, removeWatchedFromSimkl } = await import('../services/simkl/history')
    if (watched) await markMovieWatchedOnSimkl(mediaRef)
    else await removeWatchedFromSimkl(mediaRef, 'movie')
  } else if (target.kind === 'episode') {
    const { markEpisodeWatchedOnSimkl, removeEpisodeWatchedOnSimkl, markSimklEpisodePending, unmarkSimklEpisodePending } = await import('../services/simkl/history')
    const mapping = await mapAnimeEpisodeForTarget(item, target)
    const animeProviders = await mapAnimeProvidersForTarget(item, target)
    const providerEpisode = animeProviders?.simklId
      ? { season: 1, episode: animeProviders.episode }
      : mapping?.simkl?.episodeNumber
      ? { season: mapping.simkl.seasonNumber ?? target.seasonNumber, episode: mapping.simkl.episodeNumber }
      : appEpisodeForTarget(target.seasonNumber, target.episode.episodeNumber)
    const mappedRef = animeProviders?.simklId
      ? { ...mediaRef, simklId: animeProviders.simklId, malId: animeProviders.malId ?? mediaRef.malId }
      : mapping?.simkl?.id
      ? { ...mediaRef, simklId: mapping.simkl.id }
      : mediaRef
    if (watched) {
      await markEpisodeWatchedOnSimkl(mappedRef, providerEpisode)
      markSimklEpisodePending(item.id, target.seasonNumber, target.episode.episodeNumber)
      // Also retain the provider coordinate because some menu/status lookups
      // carry the resolved SIMKL episode directly.
      markSimklEpisodePending(item.id, providerEpisode.season, providerEpisode.episode)
    } else {
      await removeEpisodeWatchedOnSimkl(mappedRef, providerEpisode)
      unmarkSimklEpisodePending(item.id, target.seasonNumber, target.episode.episodeNumber)
      unmarkSimklEpisodePending(item.id, providerEpisode.season, providerEpisode.episode)
    }
  } else if (target.kind === 'season') {
    const { markEpisodeWatchedOnSimkl, removeEpisodeWatchedOnSimkl, markSimklEpisodePending, unmarkSimklEpisodePending } = await import('../services/simkl/history')
    for (let ep = 1; ep <= target.episodeCount; ep++) {
      const pseudoTarget = { ...target, kind: 'episode' as const, episode: { ...({} as import('../types').EpisodeDetails), episodeNumber: ep, seasonNumber: target.seasonNumber, id: `${item.id}:${target.seasonNumber}:${ep}`, name: '' } }
      const mapped = await mapAnimeProvidersForTarget(item, pseudoTarget)
      const providerEpisode = mapped?.simklId ? { season: 1, episode: mapped.episode } : appEpisodeForTarget(target.seasonNumber, ep)
      const mappedRef = mapped?.simklId ? { ...mediaRef, simklId: mapped.simklId, malId: mapped.malId ?? mediaRef.malId } : mediaRef
      if (watched) {
        await markEpisodeWatchedOnSimkl(mappedRef, providerEpisode)
        markSimklEpisodePending(item.id, target.seasonNumber, ep)
        markSimklEpisodePending(item.id, providerEpisode.season, providerEpisode.episode)
      } else {
        await removeEpisodeWatchedOnSimkl(mappedRef, providerEpisode)
        unmarkSimklEpisodePending(item.id, target.seasonNumber, ep)
        unmarkSimklEpisodePending(item.id, providerEpisode.season, providerEpisode.episode)
      }
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
  let tmdbId = numericId(item.tmdbId)
  if (!tmdbId) {
    const { lookupTmdbId } = await import('../services/pmdb')
    const preferred = item.type === 'movie' ? 'movie' as const : 'tv' as const
    if (item.imdbId) {
      const mapped = await lookupTmdbId('imdb', item.imdbId, preferred).catch(() => null)
      if (mapped) tmdbId = mapped.tmdbId
    }
    if (!tmdbId && item.tvdbId) {
      const mapped = await lookupTmdbId('tvdb', String(item.tvdbId).replace('tvdb-', ''), preferred).catch(() => null)
      if (mapped) tmdbId = mapped.tmdbId
    }
  }
  if (!tmdbId || !Number.isFinite(tmdbId)) throw new Error('No TMDB ID for PMDB')

  const { scrobblePMDB, removePMDBWatched } = await import('../services/pmdb')
  if (item.type === 'movie') {
    if (watched) await scrobblePMDB(tmdbId, 'movie')
    else await removePMDBWatched(tmdbId, 'movie')
  } else if (target.kind === 'episode') {
    const providerEpisode = await resolvePmdbEpisodeForTarget(item, target)
    if (watched) {
      await scrobblePMDB(providerEpisode.tmdbId || tmdbId, 'tv', providerEpisode.season, providerEpisode.episode)
      if (providerEpisode.season !== target.seasonNumber || providerEpisode.episode !== target.episode.episodeNumber) {
        await removePMDBWatched(providerEpisode.tmdbId || tmdbId, 'tv', target.seasonNumber, target.episode.episodeNumber)
      }
    } else {
      await removePMDBWatched(providerEpisode.tmdbId || tmdbId, 'tv', providerEpisode.season, providerEpisode.episode)
      if (providerEpisode.season !== target.seasonNumber || providerEpisode.episode !== target.episode.episodeNumber) {
        await removePMDBWatched(providerEpisode.tmdbId || tmdbId, 'tv', target.seasonNumber, target.episode.episodeNumber)
      }
    }
  } else if (target.kind === 'season') {
    for (let ep = 1; ep <= target.episodeCount; ep++) {
      const pseudoTarget = { ...target, kind: 'episode' as const, episode: { ...({} as import('../types').EpisodeDetails), episodeNumber: ep, seasonNumber: target.seasonNumber, id: `${item.id}:${target.seasonNumber}:${ep}`, name: '' } }
      const providerEpisode = await resolvePmdbEpisodeForTarget(item, pseudoTarget)
      if (watched) {
        await scrobblePMDB(providerEpisode.tmdbId || tmdbId, 'tv', providerEpisode.season, providerEpisode.episode)
        if (providerEpisode.season !== target.seasonNumber || providerEpisode.episode !== ep) {
          await removePMDBWatched(providerEpisode.tmdbId || tmdbId, 'tv', target.seasonNumber, ep)
        }
      } else {
        await removePMDBWatched(providerEpisode.tmdbId || tmdbId, 'tv', providerEpisode.season, providerEpisode.episode)
        if (providerEpisode.season !== target.seasonNumber || providerEpisode.episode !== ep) {
          await removePMDBWatched(providerEpisode.tmdbId || tmdbId, 'tv', target.seasonNumber, ep)
        }
      }
    }
  } else {
    if (watched) await scrobblePMDB(tmdbId, 'tv')
    else {
      const watchedItems = await import('../services/pmdb').then((m) => m.getPMDBWatched())
      const showItems = watchedItems.filter((entry) => entry.tmdb_id === tmdbId && entry.media_type === 'tv' && entry.season != null && entry.episode != null)
      await Promise.all(showItems.map((entry) => removePMDBWatched(tmdbId, 'tv', entry.season, entry.episode)))
    }
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
      const { markAniListEpisodeExact, saveAniListProgress } = await import('../services/anilist')
      const resolved = await resolveAniListEpisodeForTarget(item, target)
      await saveAniListProgress(
        { anilistId: resolved.anilistId, malId: resolved.malId, episode: resolved.episode } as any,
        0.5,
      )
      for (const id of aniListExactMarkIds(item)) {
        markAniListEpisodeExact(id, target.seasonNumber, target.episode.episodeNumber, resolved.episode)
      }
    } else if (target.kind === 'season') {
      const { markAniListEpisodeExact, saveAniListProgress } = await import('../services/anilist')
      const episode = seasonEpToAbsolute(target.seasonNumber, target.episodeCount, target.appSeasonCounts) ?? target.episodeCount
      await saveAniListProgress(
        { anilistId: item.anilistId, malId: item.malId, episode } as any,
        1,
      )
      for (let ep = 1; ep <= target.episodeCount; ep++) {
        for (const id of aniListExactMarkIds(item)) {
          markAniListEpisodeExact(id, target.seasonNumber, ep, seasonEpToAbsolute(target.seasonNumber, ep, target.appSeasonCounts) ?? ep)
        }
      }
    } else {
      const { addToAniListPlanning } = await import('../services/anilist')
      await addToAniListPlanning(item.anilistId as number | undefined, item.malId as number | undefined)
    }
  } else {
    if (target.kind === 'episode') {
      const { getAniListProgress, saveAniListProgress, unmarkAniListEpisodeExact } = await import('../services/anilist')
      const resolved = await resolveAniListEpisodeForTarget(item, target)
      for (const id of aniListExactMarkIds(item)) {
        unmarkAniListEpisodeExact(id, target.seasonNumber, target.episode.episodeNumber)
      }
      const current = await getAniListProgress(resolved.anilistId, resolved.malId)
      const previousEpisode = resolved.episode - 1
      if (current?.progress === resolved.episode && previousEpisode > 0) {
        await saveAniListProgress(
          { anilistId: resolved.anilistId, malId: resolved.malId, episode: previousEpisode } as any,
          0.5,
        )
      } else if (current?.progress === 1 && resolved.episode === 1) {
        const { removeFromAniListList } = await import('../services/anilist')
        await removeFromAniListList(resolved.anilistId as number | undefined, resolved.malId as number | undefined)
      }
    } else if (target.kind === 'season') {
      const { saveAniListProgress, unmarkAniListEpisodeExact } = await import('../services/anilist')
      for (let ep = 1; ep <= target.episodeCount; ep++) {
        for (const id of aniListExactMarkIds(item)) {
          unmarkAniListEpisodeExact(id, target.seasonNumber, ep)
        }
      }
      const previousEpisode = (seasonEpToAbsolute(target.seasonNumber, 1, target.appSeasonCounts) ?? 1) - 1
      if (previousEpisode > 0) {
        await saveAniListProgress(
          { anilistId: item.anilistId, malId: item.malId, episode: previousEpisode } as any,
          0.5,
        )
      } else {
        const { removeFromAniListList } = await import('../services/anilist')
        await removeFromAniListList(item.anilistId as number | undefined, item.malId as number | undefined)
      }
    } else {
      const { removeFromAniListList } = await import('../services/anilist')
      await removeFromAniListList(item.anilistId as number | undefined, item.malId as number | undefined)
    }
  }
}
