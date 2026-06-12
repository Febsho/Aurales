import { useState, useRef, useEffect } from 'react'
import { isAuthenticated as isTraktConnected } from '../services/trakt/auth'
import { getStoredSimklToken } from '../services/simkl/auth'
import { isAniListConnected } from '../services/anilist'
import {
  markMovieWatched as traktMarkMovie,
  markEpisodeWatched as traktMarkEpisode,
  markMovieUnwatched as traktUnmarkMovie,
  markEpisodeUnwatched as traktUnmarkEpisode,
  markShowUnwatched as traktUnmarkShow,
} from '../services/trakt/sync'
import {
  markMovieWatchedOnSimkl,
  markEpisodeWatchedOnSimkl,
  removeWatchedFromSimkl,
  removeEpisodeWatchedOnSimkl,
} from '../services/simkl/history'
import { saveAniListProgress } from '../services/anilist'
import type { MediaRef } from '../services/simkl/mappings'

interface MarkWatchedButtonProps {
  mediaRef: MediaRef
  mediaType: 'movie' | 'series'
  episode?: { season: number; episode: number }
  episodes?: { season: number; episode: number }[]
  imdbId?: string
  anilistId?: number | string
  malId?: number | string
  compact?: boolean
  watched?: boolean
  onMarked?: () => void
  onUnmarked?: () => void
  appSeasonCounts?: { season: number; count: number }[]
}

type Service = 'trakt' | 'simkl' | 'anilist'

interface ServiceState {
  loading: boolean
  done: boolean
  error: boolean
}

const SERVICE_LABELS: Record<Service, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  anilist: 'AniList',
}

export default function MarkWatchedButton({ mediaRef, mediaType, episode, episodes = [], imdbId, anilistId, malId, compact, watched = false, onMarked, onUnmarked, appSeasonCounts }: MarkWatchedButtonProps) {
  const [open, setOpen] = useState(false)
  const [allDone, setAllDone] = useState(watched)
  const [states, setStates] = useState<Record<Service, ServiceState>>({
    trakt: { loading: false, done: false, error: false },
    simkl: { loading: false, done: false, error: false },
    anilist: { loading: false, done: false, error: false },
  })
  const menuRef = useRef<HTMLDivElement>(null)

  const traktConnected = isTraktConnected()
  const simklConnected = !!getStoredSimklToken()?.accessToken
  const anilistConnected = isAniListConnected()

  const connectedServices: Service[] = []
  if (traktConnected) connectedServices.push('trakt')
  if (simklConnected) connectedServices.push('simkl')
  if (anilistConnected && (anilistId || malId)) connectedServices.push('anilist')

  useEffect(() => setAllDone(watched), [watched])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function markOn(service: Service) {
    setStates((prev) => ({ ...prev, [service]: { loading: true, done: false, error: false } }))
    try {
      if (service === 'trakt') {
        if (mediaType === 'movie' && imdbId) {
          await traktMarkMovie(imdbId)
        } else if (episode && imdbId) {
          await traktMarkEpisode(imdbId, episode.season, episode.episode, appSeasonCounts)
        } else if (imdbId && episodes.length > 0) {
          await Promise.all(episodes.map((item) => traktMarkEpisode(imdbId, item.season, item.episode, appSeasonCounts)))
        }
      } else if (service === 'simkl') {
        if (mediaType === 'movie') {
          await markMovieWatchedOnSimkl(mediaRef)
        } else if (episode) {
          await markEpisodeWatchedOnSimkl(mediaRef, episode)
        } else if (episodes.length > 0) {
          await Promise.all(episodes.map((item) => markEpisodeWatchedOnSimkl(mediaRef, item)))
        }
      } else if (service === 'anilist') {
        const ep = episode?.episode ?? Math.max(1, ...episodes.map((item) => item.episode))
        await saveAniListProgress(
          { anilistId: anilistId ? Number(anilistId) : undefined, malId: malId ? Number(malId) : undefined, episode: ep } as never,
          1.0,
        )
      }
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: true, error: false } }))
      return true
    } catch {
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: false, error: true } }))
      return false
    }
  }

  async function unmarkOn(service: Service) {
    setStates((prev) => ({ ...prev, [service]: { loading: true, done: false, error: false } }))
    try {
      if (service === 'trakt') {
        if (mediaType === 'movie' && imdbId) await traktUnmarkMovie(imdbId)
        else if (episode && imdbId) await traktUnmarkEpisode(imdbId, episode.season, episode.episode, appSeasonCounts)
        else if (imdbId) await traktUnmarkShow(imdbId)
      } else if (service === 'simkl') {
        if (mediaType === 'movie') await removeWatchedFromSimkl(mediaRef, 'movie')
        else if (episode) await removeEpisodeWatchedOnSimkl(mediaRef, episode)
        else await removeWatchedFromSimkl(mediaRef, 'show')
      } else if (service === 'anilist') {
        await saveAniListProgress(
          { anilistId: anilistId ? Number(anilistId) : undefined, malId: malId ? Number(malId) : undefined, episode: 0 } as never,
          0,
        )
      }
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: true, error: false } }))
      return true
    } catch {
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: false, error: true } }))
      return false
    }
  }

  async function markAll() {
    if (connectedServices.length === 0) {
      const next = !allDone
      setAllDone(next)
      if (next) onMarked?.()
      else onUnmarked?.()
      return
    }
    const results = await Promise.allSettled(connectedServices.map((s) => allDone ? unmarkOn(s) : markOn(s)))
    const anySuccess = results.some((r) => r.status === 'fulfilled' && r.value)
    if (anySuccess) {
      const next = !allDone
      setAllDone(next)
      setOpen(false)
      if (next) onMarked?.()
      else onUnmarked?.()
    }
  }

  async function markSingle(service: Service) {
    const success = await (allDone ? unmarkOn(service) : markOn(service))
    if (success) {
      if (allDone) onUnmarked?.()
      else onMarked?.()
    }
  }

  if (compact) {
    return (
      <div className="relative">
        <button
          onClick={(e) => { e.stopPropagation(); void markAll() }}
          className={`flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${allDone ? 'text-accent hover:text-accent-hover' : 'text-white/50 hover:text-white'}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {allDone ? 'Watched' : 'Mark watched'}
        </button>
      </div>
    )
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => connectedServices.length > 0 ? setOpen(!open) : void markAll()}
        title={allDone ? 'Mark as unwatched' : 'Mark as watched'}
        className={[
          'min-w-13 h-13 px-4 rounded-full flex items-center justify-center gap-2 transition-all duration-200 cursor-pointer',
          'border backdrop-blur-md',
          allDone
            ? 'bg-accent/20 border-accent/35 text-accent hover:bg-accent/30'
            : 'bg-white/[0.08] border-white/[0.12] text-white/70 hover:text-white hover:bg-white/[0.15] hover:border-white/25',
        ].join(' ')}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-semibold whitespace-nowrap">{allDone ? 'Watched' : 'Mark watched'}</span>
      </button>
      {open && connectedServices.length > 0 && <DropdownMenu connectedServices={connectedServices} states={states} markAll={markAll} markSingle={markSingle} watched={allDone} above />}
    </div>
  )
}

function DropdownMenu({ connectedServices, states, markAll, markSingle, watched, above }: {
  connectedServices: Service[]
  states: Record<Service, ServiceState>
  markAll: () => void
  markSingle: (s: Service) => void
  watched: boolean
  above?: boolean
}) {
  return (
    <div className={[
      'absolute left-0 z-50 min-w-[200px] rounded-xl bg-neutral-900/95 backdrop-blur-2xl border border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.6)] overflow-hidden',
      above ? 'bottom-full mb-2' : 'top-full mt-2',
    ].join(' ')}>
      <button
        onClick={(e) => { e.stopPropagation(); markAll() }}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-semibold text-white hover:bg-white/[0.08] transition-colors cursor-pointer border-b border-white/[0.06]"
      >
        <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {watched ? 'Mark unwatched everywhere' : 'Mark watched everywhere'}
      </button>
      {connectedServices.map((service) => {
        const st = states[service]
        return (
          <button
            key={service}
            onClick={(e) => { e.stopPropagation(); markSingle(service) }}
            disabled={st.loading || st.done}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-medium text-white/70 hover:bg-white/[0.06] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {st.loading ? (
              <svg className="w-3.5 h-3.5 animate-spin text-white/50" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : st.done ? (
              <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : st.error ? (
              <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <div className="w-3.5 h-3.5 rounded-full border border-white/20" />
            )}
            {SERVICE_LABELS[service]}
          </button>
        )
      })}
    </div>
  )
}
