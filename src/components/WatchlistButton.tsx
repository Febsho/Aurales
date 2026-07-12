import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
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

type Provider = 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist'

interface ProviderState {
  inList: boolean
  loading: boolean
  checking: boolean
  status?: string | null
}

const PROVIDER_LABELS: Record<Provider, string> = {
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
  mediaType?: 'movie' | 'series'
  anilistId?: number | string
  malId?: number | string
  tvdbId?: number | string
  isAnime?: boolean
  className?: string
}

export default function WatchlistButton({ mediaRef, mediaType = 'movie', isAnime = false, anilistId, malId, tvdbId, className = '' }: WatchlistButtonProps) {
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)
  const mdblistApiKey = useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()

  const [animeIds, setAnimeIds] = useState<{ anilistId?: number; malId?: number }>({
    anilistId: anilistId ? Number(anilistId) : undefined,
    malId: malId ? Number(malId) : undefined,
  })
  const [animeDetected, setAnimeDetected] = useState(isAnime || Boolean(anilistId || malId))
  const [animeCandidates, setAnimeCandidates] = useState<{ anilistId?: number; malId?: number; simklId?: number }[]>(
    anilistId || malId ? [{ anilistId: anilistId ? Number(anilistId) : undefined, malId: malId ? Number(malId) : undefined }] : [],
  )
  const anilistActive = animeDetected && isAniListConnected() && (animeCandidates.length > 0 || !!(animeIds.anilistId || animeIds.malId))
  const simklMediaRef = useMemo(() => ({ ...mediaRef, simklIds: animeCandidates.map((candidate) => candidate.simklId).filter((id): id is number => id != null) }), [mediaRef, animeCandidates])

  const [open, setOpen] = useState(false)
  const [expandedProvider, setExpandedProvider] = useState<'simkl' | 'anilist' | null>(null)
  const [states, setStates] = useState<Record<Provider, ProviderState>>({
    trakt: { inList: false, loading: false, checking: true },
    simkl: { inList: false, loading: false, checking: true },
    pmdb: { inList: false, loading: false, checking: true },
    mdblist: { inList: false, loading: false, checking: true },
    anilist: { inList: false, loading: false, checking: true },
  })
  const menuRef = useRef<HTMLDivElement>(null)

  const connectedProviders: Provider[] = []
  if (traktConnected) connectedProviders.push('trakt')
  if (simklConnected) connectedProviders.push('simkl')
  if (pmdbApiKey) connectedProviders.push('pmdb')
  if (mdblistApiKey) connectedProviders.push('mdblist')
  if (anilistActive) connectedProviders.push('anilist')

  const anyInList = connectedProviders.some((p) => states[p].inList)

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
        setStates((prev) => ({ ...prev, anilist: { ...prev.anilist, checking: false } }))
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
      if (provider === 'trakt') {
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
  }, [states, mediaRef, mediaType, animeIds.anilistId, animeIds.malId])

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

  if (connectedProviders.length === 0) return null

  const anyLoading = connectedProviders.some((p) => states[p].loading)

  const label = anyInList ? 'In Watchlist' : 'Add to Watchlist'

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        disabled={anyLoading}
        className={[
          'group/wb h-11 rounded-full flex items-center justify-center transition-all duration-300 ease-out cursor-pointer overflow-hidden',
          'border backdrop-blur-xl shadow-2xl',
          'w-11 hover:w-auto hover:px-5 hover:gap-2',
          anyInList
            ? 'bg-white/20 border-white/30 text-white'
            : 'bg-black/30 border-white/10 text-white/70 hover:text-white hover:bg-white/10 hover:border-white/20',
          anyLoading && 'opacity-50 pointer-events-none',
          className,
        ].join(' ')}
      >
        {anyLoading ? (
          <svg className="w-5 h-5 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : anyInList ? (
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="text-sm font-semibold whitespace-nowrap max-w-0 opacity-0 group-hover/wb:max-w-[150px] group-hover/wb:opacity-100 transition-all duration-300 ease-out overflow-hidden">
          {label}
        </span>
      </button>

      {open && (
        <div
          className="absolute left-0 bottom-full mb-2 z-50 min-w-[200px] overflow-hidden rounded-2xl border border-white/[0.10]"
          style={{
            background: 'rgba(10, 10, 12, 0.45)',
            backdropFilter: 'blur(40px) saturate(220%)',
            WebkitBackdropFilter: 'blur(40px) saturate(220%)',
            boxShadow: '0 24px 56px rgba(0,0,0,0.62), inset 0 1px 1px rgba(255,255,255,0.12)',
          }}
        >
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.09] to-white/[0.02]" />
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
                  className="relative w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 text-[13px] font-medium text-white/80 hover:bg-white/[0.10] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
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
                    {statusLabel(provider, st.status) && <span className="truncate text-[10px] font-normal text-white/35">{statusLabel(provider, st.status)}</span>}
                  </span>
                  {hasStatuses ? <svg className={`h-3.5 w-3.5 text-white/35 transition-transform ${expandedProvider === provider ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>
                    : st.inList && <span className="text-[10px] text-white/30">Remove</span>}
                </button>
                {hasStatuses && expandedProvider === provider && (
                  <div className="relative grid grid-cols-2 gap-1 px-2.5 pb-2.5">
                    {statusOptions.map((option) => <button key={option.value} onClick={(event) => { event.stopPropagation(); setProviderStatus(provider, option.value) }} className={`rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors ${st.status === option.value ? 'border-accent/40 bg-accent/15 text-white' : 'border-white/[0.07] bg-white/[0.035] text-white/55 hover:bg-white/[0.09]'}`}>{option.label}</button>)}
                    {st.inList && <button onClick={(event) => { event.stopPropagation(); setProviderStatus(provider, null) }} className="col-span-2 rounded-lg px-2 py-1.5 text-left text-[11px] text-red-300/65 hover:bg-red-500/10">Remove from {PROVIDER_LABELS[provider]}</button>}
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
