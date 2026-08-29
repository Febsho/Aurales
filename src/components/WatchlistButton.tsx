import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import type { SearchResult } from '../types'
import { useLocalWatchlist } from '../hooks/useLocalWatchlist'
import { localWatchlistKey, toggleLocalWatchlist } from '../services/localWatchlist'
import {
  addToSimklWatchlist,
  removeFromSimklWatchlist,
  getSimklWatchStatus,
  setSimklWatchStatus,
} from '../services/simkl/lists'
import type { SimklWatchStatus } from '../services/simkl/types'
import {
  addToWatchlist as addToTraktWatchlist,
  removeFromWatchlist as removeFromTraktWatchlist,
} from '../services/trakt/lists'
import { getWatchlist as getTraktWatchlist } from '../services/trakt/sync'
import {
  addToPMDBWatchlist,
  removeFromPMDBWatchlist,
  getPMDBWatchlistItems,
} from '../services/pmdb'
import {
  addToMdblistWatchlist,
  removeFromMdblistWatchlist,
  getMdblistWatchlistItems,
  hasMdblistOAuth,
} from '../services/mdblist'
import {
  isAniListConnected,
  addToAniListPlanning,
  removeFromAniListList,
  getAniListProgress,
  setAniListStatus,
  type AniListStatus,
} from '../services/anilist'
import { resolveAnimeIds } from '../services/animeLists'
import type { MediaRef } from '../services/simkl/mappings'

type Provider = 'local' | 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist'

interface ProviderState {
  inList: boolean
  loading: boolean
  checking: boolean
  status?: string | null
}

const PROVIDER_LABELS: Record<Provider, string> = {
  local: 'Local',
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PMDB',
  mdblist: 'MDBList',
  anilist: 'AniList',
}

const SIMKL_STATUSES: { value: SimklWatchStatus; label: string }[] = [
  { value: 'plantowatch', label: 'Plan to Watch' },
  { value: 'watching', label: 'Watching' },
  { value: 'hold', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'dropped', label: 'Dropped' },
]

const ANILIST_STATUSES: { value: AniListStatus; label: string }[] = [
  { value: 'PLANNING', label: 'Planning' },
  { value: 'CURRENT', label: 'Watching' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'DROPPED', label: 'Dropped' },
]

function statusLabel(provider: Provider, status?: string | null): string | null {
  if (!status) return null
  const options = provider === 'simkl' ? SIMKL_STATUSES : provider === 'anilist' ? ANILIST_STATUSES : []
  return options.find((option) => option.value === status)?.label ?? status
}

interface WatchlistButtonProps {
  mediaRef: MediaRef
  item?: SearchResult
  mediaType?: 'movie' | 'series'
  anilistId?: number | string
  malId?: number | string
  tvdbId?: number | string
  isAnime?: boolean
  className?: string
  detailSize?: boolean
}

export default function WatchlistButton({ mediaRef, item, mediaType = 'movie', isAnime, anilistId, malId, tvdbId, className = '', detailSize = false }: WatchlistButtonProps) {
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()
  const localItems = useLocalWatchlist()
  const localItem = useMemo<SearchResult>(() => item ?? ({
    id: mediaRef.localId,
    title: mediaRef.title,
    type: mediaType,
    year: mediaRef.year,
    provider: 'local',
    imdbId: mediaRef.imdbId,
    tmdbId: mediaRef.tmdbId,
    tvdbId,
    malId,
    anilistId,
    isAnime: isAnime || mediaRef.type === 'anime',
  }), [anilistId, isAnime, item, malId, mediaRef, mediaType, tvdbId])
  const localKey = localWatchlistKey(localItem)
  const localInList = localItems.some((entry) => localWatchlistKey(entry) === localKey)

  const [animeIds, setAnimeIds] = useState<{ anilistId?: number; malId?: number }>({
    anilistId: anilistId ? Number(anilistId) : undefined,
    malId: malId ? Number(malId) : undefined,
  })
  const [animeDetected, setAnimeDetected] = useState(isAnime || Boolean(anilistId || malId))
  const [animeCandidates, setAnimeCandidates] = useState<{ anilistId?: number; malId?: number; simklId?: number }[]>(
    anilistId || malId ? [{ anilistId: anilistId ? Number(anilistId) : undefined, malId: malId ? Number(malId) : undefined }] : [],
  )
  const anilistActive = animeDetected && isAniListConnected() && (animeCandidates.length > 0 || !!(animeIds.anilistId || animeIds.malId))
  // Callers commonly construct mediaRef inline. Depending on that object by
  // identity makes the provider-check effect run after every state update and
  // can create an infinite render loop (notably in the rotating Discover hero).
  const simklMediaRef = useMemo<MediaRef>(() => ({
    localId: mediaRef.localId,
    title: mediaRef.title,
    year: mediaRef.year,
    type: mediaRef.type,
    contentType: mediaRef.contentType,
    isAnime: mediaRef.isAnime,
    imdbId: mediaRef.imdbId,
    tmdbId: mediaRef.tmdbId,
    tvdbId: mediaRef.tvdbId,
    malId: mediaRef.malId,
    anilistId: mediaRef.anilistId,
    simklId: mediaRef.simklId,
    simklIds: animeCandidates.map((candidate) => candidate.simklId).filter((id): id is number => id != null),
  }), [
    animeCandidates,
    mediaRef.anilistId,
    mediaRef.contentType,
    mediaRef.imdbId,
    mediaRef.isAnime,
    mediaRef.localId,
    mediaRef.malId,
    mediaRef.simklId,
    mediaRef.title,
    mediaRef.tmdbId,
    mediaRef.tvdbId,
    mediaRef.type,
    mediaRef.year,
  ])

  const [open, setOpen] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<'simkl' | 'anilist' | null>(null)
  const [states, setStates] = useState<Record<Provider, ProviderState>>({
    local: { inList: localInList, loading: false, checking: false },
    trakt: { inList: false, loading: false, checking: true },
    simkl: { inList: false, loading: false, checking: true },
    pmdb: { inList: false, loading: false, checking: true },
    mdblist: { inList: false, loading: false, checking: true },
    anilist: { inList: false, loading: false, checking: true },
  })
  const menuRef = useRef<HTMLDivElement>(null)

  const connectedProviders: Provider[] = ['local']
  if (traktConnected) connectedProviders.push('trakt')
  if (simklConnected) connectedProviders.push('simkl')
  if (pmdbApiKey) connectedProviders.push('pmdb')
  if (mdblistApiKey) connectedProviders.push('mdblist')
  if (anilistActive) connectedProviders.push('anilist')

  const anyInList = connectedProviders.some((p) => states[p].inList)

  useEffect(() => {
    setStates((previous) => ({
      ...previous,
      local: { inList: localInList, loading: false, checking: false },
    }))
  }, [localInList])

  useEffect(() => {
    setAnimeIds({
      anilistId: anilistId ? Number(anilistId) : undefined,
      malId: malId ? Number(malId) : undefined,
    })
    setAnimeDetected(isAnime || Boolean(anilistId || malId))
    if (anilistId || malId) {
      setAnimeCandidates([{ anilistId: anilistId ? Number(anilistId) : undefined, malId: malId ? Number(malId) : undefined }])
      return
    }
    if (isAnime === false) {
      setAnimeCandidates([])
      return
    }
    let cancelled = false
    ;(async () => {
      const { lookupByImdbId, lookupByTmdbId, lookupByTvdbId } = await import('../services/animeLists')
      const [tmdbMatches, tvdbMatches, imdbMatch] = await Promise.all([
        mediaRef.tmdbId ? lookupByTmdbId(mediaRef.tmdbId) : Promise.resolve([]),
        tvdbId ? lookupByTvdbId(tvdbId) : Promise.resolve([]),
        mediaRef.imdbId ? lookupByImdbId(mediaRef.imdbId) : Promise.resolve(undefined),
      ])
      const mappings = [...tmdbMatches, ...tvdbMatches, ...(imdbMatch ? [imdbMatch] : [])]
      const candidates = [...new Map(mappings.filter((entry) => entry.anilist_id || entry.mal_id || entry.simkl_id).map((entry) => [
        `${entry.anilist_id ?? ''}:${entry.mal_id ?? ''}:${entry.simkl_id ?? ''}`,
        { anilistId: entry.anilist_id, malId: entry.mal_id, simklId: entry.simkl_id },
      ])).values()]
      if (!cancelled && candidates.length) {
        setAnimeCandidates(candidates)
        setAnimeIds({ anilistId: candidates[0].anilistId, malId: candidates[0].malId })
        setAnimeDetected(true)
        return
      }
      const resolved = await resolveAnimeIds({ imdbId: mediaRef.imdbId, tmdbId: mediaRef.tmdbId, tvdbId: tvdbId ? Number(tvdbId) : undefined, contentType: mediaType })
      if (!cancelled && resolved && (resolved.anilistId || resolved.malId)) {
        const candidate = { anilistId: resolved.anilistId, malId: resolved.malId, simklId: resolved.simklId }
        setAnimeCandidates([candidate])
        setAnimeIds(candidate)
        setAnimeDetected(true)
      }
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [anilistId, malId, isAnime, mediaType, mediaRef.imdbId, mediaRef.tmdbId, tvdbId])

  useEffect(() => {
    let cancelled = false

    async function checkAll() {
      const checks: Promise<void>[] = []

      if (traktConnected) {
        checks.push((async () => {
          try {
            const traktType = mediaType === 'series' ? 'shows' : 'movies'
            const items = await getTraktWatchlist(traktType) as Record<string, unknown>[]
            const found = items.some((item) => {
              const media = (item as Record<string, Record<string, Record<string, string | number>>>)[mediaType === 'series' ? 'show' : 'movie']
              return (mediaRef.imdbId && media?.ids?.imdb === mediaRef.imdbId) ||
                (mediaRef.tmdbId && Number(media?.ids?.tmdb) === mediaRef.tmdbId)
            })
            if (!cancelled) setStates((prev) => ({ ...prev, trakt: { inList: found, loading: false, checking: false } }))
          } catch (_) {
            if (!cancelled) setStates((prev) => ({ ...prev, trakt: { inList: false, loading: false, checking: false } }))
          }
        })())
      }

      if (simklConnected) {
        checks.push((async () => {
          try {
            const status = await getSimklWatchStatus(simklMediaRef)
            if (!cancelled) setStates((prev) => ({ ...prev, simkl: { inList: Boolean(status), status, loading: false, checking: false } }))
          } catch (_) {
            if (!cancelled) setStates((prev) => ({ ...prev, simkl: { inList: false, loading: false, checking: false } }))
          }
        })())
      }

      if (pmdbApiKey) {
        checks.push((async () => {
          try {
            const items = await getPMDBWatchlistItems()
            const found = items.some((i) => i.tmdb_id === mediaRef.tmdbId && i.media_type === (mediaType === 'series' ? 'tv' : 'movie'))
            if (!cancelled) setStates((prev) => ({ ...prev, pmdb: { inList: found, loading: false, checking: false } }))
          } catch (_) {
            if (!cancelled) setStates((prev) => ({ ...prev, pmdb: { inList: false, loading: false, checking: false } }))
          }
        })())
      }

      if (mdblistApiKey) {
        checks.push((async () => {
          try {
            const items = await getMdblistWatchlistItems()
            const found = items.some((i) =>
              (mediaRef.imdbId && i.imdbId === mediaRef.imdbId) ||
              (mediaRef.tmdbId && Number(i.tmdbId) === mediaRef.tmdbId)
            )
            if (!cancelled) setStates((prev) => ({ ...prev, mdblist: { inList: found, loading: false, checking: false } }))
          } catch (_) {
            if (!cancelled) setStates((prev) => ({ ...prev, mdblist: { inList: false, loading: false, checking: false } }))
          }
        })())
      }

      // AniList checking not implemented yet — just mark done
      if (anilistActive) {
        checks.push((async () => {
          try {
            const candidates = animeCandidates.length ? animeCandidates : [animeIds]
            const progresses = await Promise.all(candidates.map(async (candidate) => ({ candidate, progress: await getAniListProgress(candidate.anilistId, candidate.malId).catch(() => null) })))
            const priority: Record<string, number> = { CURRENT: 5, PLANNING: 4, PAUSED: 3, COMPLETED: 2, DROPPED: 1, REPEATING: 5 }
            const active = progresses.filter((entry) => entry.progress).sort((left, right) => (priority[right.progress?.status ?? ''] || 0) - (priority[left.progress?.status ?? ''] || 0))[0]
            if (!cancelled) {
              if (active) setAnimeIds({ anilistId: active.candidate.anilistId, malId: active.candidate.malId })
              setStates((prev) => ({ ...prev, anilist: { inList: Boolean(active), status: active?.progress?.status ?? null, loading: false, checking: false } }))
            }
          } catch (_) {
            if (!cancelled) setStates((prev) => ({ ...prev, anilist: { inList: false, loading: false, checking: false } }))
          }
        })())
      } else if (!cancelled) {
        setStates((prev) => prev.anilist.checking
          ? { ...prev, anilist: { ...prev.anilist, checking: false } }
          : prev)
      }

      await Promise.allSettled(checks)
    }

    checkAll()
    return () => { cancelled = true }
  }, [mediaRef.localId, mediaRef.imdbId, mediaRef.tmdbId, simklMediaRef, mediaType, traktConnected, simklConnected, pmdbApiKey, mdblistApiKey, anilistActive, animeIds.anilistId, animeIds.malId, animeCandidates])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggleProvider = useCallback(async (provider: Provider) => {
    const current = states[provider]
    setStates((prev) => ({ ...prev, [provider]: { ...prev[provider], loading: true } }))

    try {
      if (provider === 'local') {
        toggleLocalWatchlist(localItem)
      } else if (provider === 'trakt') {
        const key = mediaType === 'series' ? 'shows' : 'movies'
        const ids: Record<string, string | number> = {}
        if (mediaRef.imdbId) ids.imdb = mediaRef.imdbId
        if (mediaRef.tmdbId) ids.tmdb = mediaRef.tmdbId
        const payload = { [key]: [{ title: mediaRef.title, year: mediaRef.year, ids }] }
        if (current.inList) await removeFromTraktWatchlist(payload)
        else await addToTraktWatchlist(payload)
      } else if (provider === 'simkl') {
        if (current.inList) await removeFromSimklWatchlist(mediaRef)
        else await addToSimklWatchlist(mediaRef)
      } else if (provider === 'pmdb' && mediaRef.tmdbId) {
        const pmdbType = mediaType === 'series' ? 'tv' : 'movie'
        if (current.inList) await removeFromPMDBWatchlist(mediaRef.tmdbId, pmdbType)
        else await addToPMDBWatchlist(mediaRef.tmdbId, pmdbType)
      } else if (provider === 'mdblist' && mediaRef.tmdbId) {
        if (current.inList) await removeFromMdblistWatchlist(mediaRef.tmdbId, mediaType, mediaRef.imdbId)
        else await addToMdblistWatchlist(mediaRef.tmdbId, mediaType, mediaRef.imdbId)
      } else if (provider === 'anilist') {
        if (current.inList) await removeFromAniListList(animeIds.anilistId, animeIds.malId)
        else await addToAniListPlanning(animeIds.anilistId, animeIds.malId)
      }
      setStates((prev) => ({ ...prev, [provider]: { inList: !current.inList, loading: false, checking: false } }))
    } catch (err) {
      console.error(`[WatchlistButton] toggle ${provider} failed:`, err)
      setStates((prev) => ({ ...prev, [provider]: { ...prev[provider], loading: false } }))
    }
  }, [states, localItem, mediaRef, mediaType, animeIds.anilistId, animeIds.malId])

  const setProviderStatus = useCallback(async (provider: 'simkl' | 'anilist', status: SimklWatchStatus | AniListStatus | null) => {
    setStates((prev) => ({ ...prev, [provider]: { ...prev[provider], loading: true } }))
    try {
      if (provider === 'simkl') {
        if (status) await setSimklWatchStatus(mediaRef, status as SimklWatchStatus)
        else await removeFromSimklWatchlist(mediaRef)
      } else {
        if (status) await setAniListStatus(status as AniListStatus, animeIds.anilistId, animeIds.malId)
        else await removeFromAniListList(animeIds.anilistId, animeIds.malId)
      }
      setStates((prev) => ({ ...prev, [provider]: { inList: Boolean(status), status, loading: false, checking: false } }))
      setExpandedProvider(null)
    } catch (err) {
      console.error(`[WatchlistButton] set ${provider} status failed:`, err)
      setStates((prev) => ({ ...prev, [provider]: { ...prev[provider], loading: false } }))
    }
  }, [mediaRef, animeIds.anilistId, animeIds.malId])

  const anyLoading = connectedProviders.some((p) => states[p].loading)

  const label = anyInList ? 'In Watchlist' : 'Add to Watchlist'

  return (
    <div className={`relative flex items-center gap-1.5 ${className}`} ref={menuRef}>
      <button
        type="button"
        onClick={() => toggleProvider('local')}
        disabled={states.local.loading}
        aria-label={localInList ? 'Remove from local watchlist' : 'Add to local watchlist'}
        aria-pressed={localInList}
        className={[
          `grid ${detailSize ? 'h-12 w-12' : 'h-11 w-11'} flex-shrink-0 place-items-center rounded-full border transition-[transform,background-color,border-color,color] duration-200 cursor-pointer`,
          'active:scale-95 disabled:pointer-events-none disabled:opacity-55',
          localInList
            ? 'border-accent/60 bg-accent/20 text-accent shadow-[0_6px_18px_rgba(0,0,0,0.22)]'
            : 'border-white/15 bg-[#171717] text-white/70 hover:border-white/30 hover:bg-[#242424] hover:text-white',
        ].join(' ')}
      >
        {states.local.loading ? (
          <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill={localInList ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 21s-7.2-4.35-9.55-8.4C.4 9.05 2.02 4.5 6.15 3.56A5.15 5.15 0 0 1 12 6.18a5.15 5.15 0 0 1 5.85-2.62c4.13.94 5.75 5.49 3.7 9.04C19.2 16.65 12 21 12 21Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={anyLoading}
        aria-label="Manage watchlists"
        aria-expanded={open}
        title={label}
        className={`grid ${detailSize ? 'h-10 w-8' : 'h-9 w-8'} place-items-center rounded-full border border-white/10 bg-[#171717] text-white/60 transition-colors hover:border-white/25 hover:bg-[#242424] hover:text-white disabled:opacity-45 ${open ? 'border-white/25 bg-[#242424] text-white' : ''}`}
      >
        <svg className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <div
          className="absolute left-0 bottom-full mb-2 z-50 min-w-[220px] overflow-hidden rounded-2xl border border-white/10 bg-[#111] shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
        >
          {connectedProviders.map((provider) => {
            const st = states[provider]
            const hasStatuses = provider === 'simkl' || provider === 'anilist'
            const statusOptions = provider === 'simkl' ? SIMKL_STATUSES : provider === 'anilist' ? ANILIST_STATUSES : []
            return (
              <div key={provider} className="relative border-b border-white/[0.05] last:border-b-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (hasStatuses) setExpandedProvider((current) => current === provider ? null : provider)
                    else toggleProvider(provider)
                  }}
                  disabled={st.loading}
                  className="relative w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 text-sm font-medium text-white/80 hover:bg-white/[0.10] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {st.loading ? (
                      <svg className="w-3.5 h-3.5 shrink-0 animate-spin text-white/50" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : st.inList ? (
                      <svg className="w-3.5 h-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : <div className="w-3.5 h-3.5 shrink-0 rounded-full border border-white/20" />}
                    <span>{PROVIDER_LABELS[provider]}</span>
                    {statusLabel(provider, st.status) && <span className="truncate text-meta font-normal text-white/60">{statusLabel(provider, st.status)}</span>}
                  </span>
                  {hasStatuses ? <svg className={`h-3.5 w-3.5 text-white/60 transition-transform ${expandedProvider === provider ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
                    : st.inList && <span className="text-meta text-white/50">Remove</span>}
                </button>
                {hasStatuses && expandedProvider === provider && (
                  <div className="relative grid grid-cols-2 gap-1 px-2.5 pb-2.5">
                    {statusOptions.map((option) => <button key={option.value} onClick={(event) => { event.stopPropagation(); setProviderStatus(provider, option.value) }} className={`rounded-lg border px-2 py-1.5 text-left text-label transition-colors ${st.status === option.value ? 'border-accent/40 bg-accent/15 text-white' : 'border-white/[0.07] bg-white/[0.035] text-white/60 hover:bg-white/[0.09]'}`}>{option.label}</button>)}
                    {st.inList && <button onClick={(event) => { event.stopPropagation(); setProviderStatus(provider, null) }} className="col-span-2 rounded-lg px-2 py-1.5 text-left text-label text-red-300/65 hover:bg-red-500/10">Remove from {PROVIDER_LABELS[provider]}</button>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
