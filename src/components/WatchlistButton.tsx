import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import {
  addToSimklWatchlist,
  removeFromSimklWatchlist,
  isInSimklWatchlist,
} from '../services/simkl/lists'
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
  isAniListConnected,
  addToAniListPlanning,
  removeFromAniListList,
  isInAniListList,
} from '../services/anilist'
import { resolveAnimeIds } from '../services/animeLists'
import type { MediaRef } from '../services/simkl/mappings'

type Provider = 'trakt' | 'simkl' | 'pmdb' | 'anilist'

interface ProviderState {
  inList: boolean
  loading: boolean
  checking: boolean
}

const PROVIDER_LABELS: Record<Provider, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PMDB',
  anilist: 'AniList',
}

interface WatchlistButtonProps {
  mediaRef: MediaRef
  mediaType?: 'movie' | 'series'
  anilistId?: number | string
  malId?: number | string
  tvdbId?: number | string
  className?: string
}

export default function WatchlistButton({ mediaRef, mediaType = 'movie', anilistId, malId, tvdbId, className = '' }: WatchlistButtonProps) {
  const simklConnected = useAppStore((s) => s.simklConnected)
  const traktConnected = useAppStore((s) => s.traktConnected)
  const pmdbApiKey = useAppStore((s) => s.pmdbApiKey)

  const [animeIds, setAnimeIds] = useState<{ anilistId?: number; malId?: number }>({
    anilistId: anilistId ? Number(anilistId) : undefined,
    malId: malId ? Number(malId) : undefined,
  })
  const anilistActive = isAniListConnected() && !!(animeIds.anilistId || animeIds.malId)

  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<Record<Provider, ProviderState>>({
    trakt: { inList: false, loading: false, checking: true },
    simkl: { inList: false, loading: false, checking: true },
    pmdb: { inList: false, loading: false, checking: true },
    anilist: { inList: false, loading: false, checking: true },
  })
  const menuRef = useRef<HTMLDivElement>(null)

  const connectedProviders: Provider[] = []
  if (traktConnected) connectedProviders.push('trakt')
  if (simklConnected) connectedProviders.push('simkl')
  if (pmdbApiKey) connectedProviders.push('pmdb')
  if (anilistActive) connectedProviders.push('anilist')

  const anyInList = connectedProviders.some((p) => states[p].inList)

  useEffect(() => {
    setAnimeIds({
      anilistId: anilistId ? Number(anilistId) : undefined,
      malId: malId ? Number(malId) : undefined,
    })
    if (mediaType !== 'series' || anilistId || malId) return
    let cancelled = false
    resolveAnimeIds({
      imdbId: mediaRef.imdbId,
      tmdbId: mediaRef.tmdbId,
      tvdbId: tvdbId ? Number(tvdbId) : undefined,
    }).then((resolved) => {
      if (!cancelled && resolved && (resolved.anilistId || resolved.malId)) {
        setAnimeIds({ anilistId: resolved.anilistId, malId: resolved.malId })
      }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [anilistId, malId, mediaType, mediaRef.imdbId, mediaRef.tmdbId, tvdbId])

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
            const result = await isInSimklWatchlist(mediaRef)
            if (!cancelled) setStates((prev) => ({ ...prev, simkl: { inList: result, loading: false, checking: false } }))
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

      // AniList checking not implemented yet — just mark done
      if (anilistActive) {
        checks.push((async () => {
          try {
            const found = await isInAniListList(animeIds.anilistId, animeIds.malId)
            if (!cancelled) setStates((prev) => ({ ...prev, anilist: { inList: found, loading: false, checking: false } }))
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
  }, [mediaRef.localId, mediaRef.imdbId, mediaRef.tmdbId, mediaType, traktConnected, simklConnected, pmdbApiKey, anilistActive, animeIds.anilistId, animeIds.malId])

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
          'border backdrop-blur-md',
          'w-11 hover:w-auto hover:px-5 hover:gap-2',
          anyInList
            ? 'bg-white/20 border-white/30 text-white'
            : 'bg-white/[0.08] border-white/[0.12] text-white/70 hover:text-white hover:bg-white/[0.15] hover:border-white/25',
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
        <div className="absolute left-0 bottom-full mb-2 z-50 min-w-[200px] rounded-xl bg-neutral-900/95 backdrop-blur-2xl border border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.6)] overflow-hidden">
          {connectedProviders.map((provider) => {
            const st = states[provider]
            return (
              <button
                key={provider}
                onClick={(e) => { e.stopPropagation(); toggleProvider(provider) }}
                disabled={st.loading}
                className="w-full flex items-center justify-between gap-2.5 px-3.5 py-2.5 text-[13px] font-medium text-white/80 hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                <span className="flex items-center gap-2.5">
                  {st.loading ? (
                    <svg className="w-3.5 h-3.5 animate-spin text-white/50" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : st.inList ? (
                    <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border border-white/20" />
                  )}
                  {PROVIDER_LABELS[provider]}
                  {provider === 'anilist' && <span className="text-[10px] text-white/30 ml-0.5">Planning</span>}
                </span>
                {st.inList && (
                  <span className="text-[10px] text-white/30">Remove</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
