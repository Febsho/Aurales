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
  markSimklEpisodePending,
  unmarkSimklEpisodePending,
} from '../services/simkl/history'
import { markAniListEpisodeExact, removeFromAniListList, saveAniListProgress, unmarkAniListEpisodeExact } from '../services/anilist'
import { scrobblePMDB, removePMDBWatched } from '../services/pmdb'
import { markMdblistWatched, removeMdblistWatched, hasMdblistOAuth } from '../services/mdblist'
import { cacheClearCategory } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { useAppStore } from '../stores/appStore'
import type { MediaRef } from '../services/simkl/mappings'
import { isWatchedFromProviderFresh, isWatchedFromProviders, type WatchedLookupItem } from '../services/watchedStatus'

interface MarkWatchedButtonProps {
  mediaRef: MediaRef
  mediaType: 'movie' | 'series'
  episode?: { season: number; episode: number; absoluteEpisode?: number }
  episodes?: { season: number; episode: number; absoluteEpisode?: number }[]
  imdbId?: string
  anilistId?: number | string
  malId?: number | string
  isAnime?: boolean
  compact?: boolean
  watched?: boolean
  onMarked?: () => void
  onUnmarked?: () => void
  appSeasonCounts?: { season: number; count: number }[]
  className?: string
}

type Service = 'trakt' | 'simkl' | 'pmdb' | 'mdblist' | 'anilist'

interface ServiceState {
  loading: boolean
  done: boolean
  error: boolean
  checking?: boolean
}

const SERVICE_LABELS: Record<Service, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PMDB',
  mdblist: 'MDBList',
  anilist: 'AniList',
}

export default function MarkWatchedButton({ mediaRef, mediaType, episode, episodes = [], imdbId, anilistId, malId, isAnime = false, compact, watched = false, onMarked, onUnmarked, appSeasonCounts, className = '' }: MarkWatchedButtonProps) {
  const [open, setOpen] = useState(false)
  const [allDone, setAllDone] = useState(watched)
  const [states, setStates] = useState<Record<Service, ServiceState>>({
    trakt: { loading: false, done: false, error: false },
    simkl: { loading: false, done: false, error: false },
    pmdb: { loading: false, done: false, error: false },
    mdblist: { loading: false, done: false, error: false },
    anilist: { loading: false, done: false, error: false },
  })
  const menuRef = useRef<HTMLDivElement>(null)

  const traktConnected = isTraktConnected()
  const simklConnected = !!getStoredSimklToken()?.accessToken
  const pmdbConnected = !!useAppStore((s) => s.pmdbApiKey)
  const mdblistConnected = !!useAppStore((s) => s.mdblistApiKey) || hasMdblistOAuth()
  const anilistConnected = isAniListConnected()
  const tmdbId = mediaRef.tmdbId != null ? Number(mediaRef.tmdbId) : undefined
  const trackingMediaRef: MediaRef = {
    ...mediaRef,
    contentType: mediaType,
    isAnime,
    type: isAnime ? 'anime' : mediaType === 'series' ? 'show' : 'movie',
    anilistId: anilistId != null ? Number(anilistId) : mediaRef.anilistId,
    malId: malId != null ? Number(malId) : mediaRef.malId,
  }

  const connectedServices: Service[] = []
  if (traktConnected) connectedServices.push('trakt')
  if (simklConnected) connectedServices.push('simkl')
  if (pmdbConnected && Number.isFinite(tmdbId)) connectedServices.push('pmdb')
  if (mdblistConnected && (Number.isFinite(tmdbId) || imdbId)) connectedServices.push('mdblist')
  if (anilistConnected && isAnime && (anilistId || malId)) connectedServices.push('anilist')
  const connectedServicesKey = connectedServices.join(',')
  const episodesSnapshot = JSON.stringify(episodes)

  useEffect(() => setAllDone(watched), [watched])

  // The menu reflects each provider's real history instead of assuming every
  // connected service is unwatched. Refresh once when the menu opens, then use
  // the refreshed snapshot for the remaining episodes in a whole-show check.
  useEffect(() => {
    if (!open || compact || connectedServicesKey.length === 0) return
    let cancelled = false
    const services = connectedServicesKey.split(',') as Service[]
    const episodeItems = JSON.parse(episodesSnapshot) as { season: number; episode: number; absoluteEpisode?: number }[]
    const baseLookup: WatchedLookupItem = {
      id: mediaRef.localId,
      type: mediaType,
      title: mediaRef.title,
      year: mediaRef.year,
      imdbId: imdbId || mediaRef.imdbId,
      tmdbId: mediaRef.tmdbId,
      tvdbId: mediaRef.tvdbId,
      malId: malId || mediaRef.malId,
      anilistId: anilistId || mediaRef.anilistId,
      isAnime,
      appSeasonEpCounts: appSeasonCounts,
    }
    const lookups = mediaType === 'movie'
      ? [baseLookup]
      : episode
        ? [{ ...baseLookup, season: episode.season, episode: episode.episode, absoluteEpisode: episode.absoluteEpisode }]
        : episodeItems.map((item) => ({ ...baseLookup, season: item.season, episode: item.episode, absoluteEpisode: item.absoluteEpisode }))

    services.forEach((service) => {
      setStates((previous) => ({
        ...previous,
        [service]: { ...previous[service], checking: true, error: false },
      }))
      ;(async () => {
        if (lookups.length === 0) return false
        const firstWatched = await isWatchedFromProviderFresh(lookups[0], service)
        if (!firstWatched || lookups.length === 1) return firstWatched
        const remaining = await Promise.all(lookups.slice(1).map((lookup) =>
          isWatchedFromProviders(lookup, [service], new Map()).catch(() => false)
        ))
        return remaining.every(Boolean)
      })().then((done) => {
        if (cancelled) return
        setStates((previous) => ({
          ...previous,
          [service]: { loading: false, done, error: false, checking: false },
        }))
      }).catch(() => {
        if (cancelled) return
        setStates((previous) => ({
          ...previous,
          [service]: { ...previous[service], loading: false, error: true, checking: false },
        }))
      })
    })

    return () => { cancelled = true }
  }, [anilistId, appSeasonCounts, compact, connectedServicesKey, episode, episodesSnapshot, imdbId, isAnime, malId, mediaRef, mediaType, open])

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
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, episode) : null
          if (mapped?.traktId) {
            const { addToHistory } = await import('../services/trakt/sync')
            await addToHistory({
              shows: [{
                ids: { trakt: mapped.traktId },
                seasons: [{ number: mapped.traktSeason ?? mapped.season, episodes: [{ number: mapped.traktEpisode ?? mapped.episode, watched_at: new Date().toISOString() }] }],
              }],
            })
          } else {
            await traktMarkEpisode(imdbId, episode.season, episode.episode, appSeasonCounts)
          }
        } else if (imdbId && episodes.length > 0) {
          await Promise.all(episodes.map(async (item) => {
            const mapped = isAnime ? await resolveAnimeProviders(mediaRef, item) : null
            if (mapped?.traktId) {
              const { addToHistory } = await import('../services/trakt/sync')
              await addToHistory({
                shows: [{
                  ids: { trakt: mapped.traktId },
                  seasons: [{ number: mapped.traktSeason ?? mapped.season, episodes: [{ number: mapped.traktEpisode ?? mapped.episode, watched_at: new Date().toISOString() }] }],
                }],
              })
            } else {
              await traktMarkEpisode(imdbId, item.season, item.episode, appSeasonCounts)
            }
          }))
        }
      } else if (service === 'simkl') {
        if (mediaType === 'movie') {
          await markMovieWatchedOnSimkl(trackingMediaRef)
        } else if (episode) {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, episode) : null
          const mappedRef = mapped?.simklId ? { ...trackingMediaRef, simklId: mapped.simklId, malId: mapped.malId ?? trackingMediaRef.malId } : trackingMediaRef
          await markEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(episode, isAnime, appSeasonCounts))
          markSimklEpisodePending(trackingMediaRef.localId, episode.season, episode.episode)
        } else if (episodes.length > 0) {
          await Promise.all(episodes.map(async (item) => {
            const mapped = isAnime ? await resolveAnimeProviders(mediaRef, item) : null
            const mappedRef = mapped?.simklId ? { ...trackingMediaRef, simklId: mapped.simklId, malId: mapped.malId ?? trackingMediaRef.malId } : trackingMediaRef
            await markEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(item, isAnime, appSeasonCounts))
            markSimklEpisodePending(trackingMediaRef.localId, item.season, item.episode)
          }))
        }
      } else if (service === 'anilist') {
        const resolved = episode
          ? await resolveAniListEpisode(mediaRef, episode, anilistId, malId, appSeasonCounts)
          : null
        const ep = resolved?.episode
          ?? Math.max(1, ...episodes.map((item) => aniListEpisode(item, appSeasonCounts)))
        await saveAniListProgress(
          {
            anilistId: resolved?.anilistId ?? (anilistId ? Number(anilistId) : undefined),
            malId: resolved?.malId ?? (malId ? Number(malId) : undefined),
            episode: ep,
          } as never,
          1.0,
        )
        if (episode) {
          for (const id of aniListExactMarkIds(mediaRef, anilistId, malId)) {
            markAniListEpisodeExact(id, episode.season, episode.episode, ep)
          }
        } else {
          for (const item of episodes) {
            for (const id of aniListExactMarkIds(mediaRef, anilistId, malId)) {
              markAniListEpisodeExact(id, item.season, item.episode, aniListEpisode(item, appSeasonCounts))
            }
          }
        }
      } else if (service === 'pmdb' && tmdbId) {
        if (mediaType === 'movie') {
          await scrobblePMDB(tmdbId, 'movie')
        } else if (episode) {
          const providerEp = await resolvePmdbProviderEpisode(mediaRef, episode, tmdbId, isAnime, appSeasonCounts)
          await scrobblePMDB(providerEp.tmdbId, 'tv', providerEp.season, providerEp.episode)
          if (providerEp.season !== episode.season || providerEp.episode !== episode.episode) {
            await removePMDBWatched(providerEp.tmdbId, 'tv', episode.season, episode.episode)
          }
        } else if (episodes.length > 0) {
          await Promise.all(episodes.map(async (item) => {
            const providerEp = await resolvePmdbProviderEpisode(mediaRef, item, tmdbId, isAnime, appSeasonCounts)
            if (providerEp.season !== item.season || providerEp.episode !== item.episode) {
              await removePMDBWatched(providerEp.tmdbId, 'tv', item.season, item.episode)
            }
            return scrobblePMDB(providerEp.tmdbId, 'tv', providerEp.season, providerEp.episode)
          }))
        }
      } else if (service === 'mdblist') {
        if (mediaType === 'movie') {
          await markMdblistWatched(tmdbId, 'movie', undefined, undefined, imdbId, mediaRef.tvdbId ? Number(mediaRef.tvdbId) : undefined)
        } else if (episode) {
          await markMdblistWatched(tmdbId, 'series', episode.season, episode.episode, imdbId, mediaRef.tvdbId ? Number(mediaRef.tvdbId) : undefined)
        } else if (episodes.length > 0) {
          await Promise.all(episodes.map((item) =>
            markMdblistWatched(tmdbId, 'series', item.season, item.episode, imdbId, mediaRef.tvdbId ? Number(mediaRef.tvdbId) : undefined)
          ))
        }
      }
      await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: true, error: false, checking: false } }))
      return true
    } catch (_) {
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: false, error: true } }))
      return false
    }
  }

  async function unmarkOn(service: Service) {
    setStates((prev) => ({ ...prev, [service]: { loading: true, done: false, error: false } }))
    try {
      if (service === 'trakt') {
        if (mediaType === 'movie' && imdbId) await traktUnmarkMovie(imdbId)
        else if (episode && imdbId) {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, episode) : null
          if (mapped?.traktId) {
            const { removeFromHistory } = await import('../services/trakt/sync')
            await removeFromHistory({
              shows: [{
                ids: { trakt: mapped.traktId },
                seasons: [{ number: mapped.traktSeason ?? mapped.season, episodes: [{ number: mapped.traktEpisode ?? mapped.episode }] }],
              }],
            })
          } else {
            await traktUnmarkEpisode(imdbId, episode.season, episode.episode, appSeasonCounts)
          }
        }
        else if (imdbId && episodes.length > 0) await Promise.all(episodes.map(async (item) => {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, item) : null
          if (mapped?.traktId) {
            const { removeFromHistory } = await import('../services/trakt/sync')
            await removeFromHistory({
              shows: [{
                ids: { trakt: mapped.traktId },
                seasons: [{ number: mapped.traktSeason ?? mapped.season, episodes: [{ number: mapped.traktEpisode ?? mapped.episode }] }],
              }],
            })
          } else {
            await traktUnmarkEpisode(imdbId, item.season, item.episode, appSeasonCounts)
          }
        }))
        else if (imdbId) await traktUnmarkShow(imdbId)
      } else if (service === 'simkl') {
        if (mediaType === 'movie') await removeWatchedFromSimkl(trackingMediaRef, 'movie')
        else if (episode) {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, episode) : null
          const mappedRef = mapped?.simklId ? { ...trackingMediaRef, simklId: mapped.simklId, malId: mapped.malId ?? trackingMediaRef.malId } : trackingMediaRef
          await removeEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(episode, isAnime, appSeasonCounts))
          unmarkSimklEpisodePending(trackingMediaRef.localId, episode.season, episode.episode)
        }
        else await Promise.all(episodes.map(async (item) => {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, item) : null
          const mappedRef = mapped?.simklId ? { ...trackingMediaRef, simklId: mapped.simklId, malId: mapped.malId ?? trackingMediaRef.malId } : trackingMediaRef
          await removeEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(item, isAnime, appSeasonCounts))
          unmarkSimklEpisodePending(trackingMediaRef.localId, item.season, item.episode)
        }))
      } else if (service === 'anilist') {
        const resolved = episode
          ? await resolveAniListEpisode(mediaRef, episode, anilistId, malId, appSeasonCounts)
          : null
        const previous = resolved
          ? resolved.episode - 1
          : Math.min(...episodes.map((item) => aniListEpisode(item, appSeasonCounts))) - 1
        if (episode) {
          for (const id of aniListExactMarkIds(mediaRef, anilistId, malId)) {
            unmarkAniListEpisodeExact(id, episode.season, episode.episode)
          }
        } else {
          for (const item of episodes) {
            for (const id of aniListExactMarkIds(mediaRef, anilistId, malId)) {
              unmarkAniListEpisodeExact(id, item.season, item.episode)
            }
          }
        }
        if (previous > 0) {
          await saveAniListProgress(
            {
              anilistId: resolved?.anilistId ?? (anilistId ? Number(anilistId) : undefined),
              malId: resolved?.malId ?? (malId ? Number(malId) : undefined),
              episode: previous,
            } as never,
            0.5,
          )
        } else {
          await removeFromAniListList(
            resolved?.anilistId ?? (anilistId ? Number(anilistId) : undefined),
            resolved?.malId ?? (malId ? Number(malId) : undefined),
          )
        }
      } else if (service === 'pmdb' && tmdbId) {
        if (mediaType === 'movie') await removePMDBWatched(tmdbId, 'movie')
        else if (episode) {
          const providerEp = await resolvePmdbProviderEpisode(mediaRef, episode, tmdbId, isAnime, appSeasonCounts)
          await removePMDBWatched(providerEp.tmdbId, 'tv', providerEp.season, providerEp.episode)
          if (providerEp.season !== episode.season || providerEp.episode !== episode.episode) {
            await removePMDBWatched(providerEp.tmdbId, 'tv', episode.season, episode.episode)
          }
        } else {
          await Promise.all(episodes.map(async (item) => {
            const providerEp = await resolvePmdbProviderEpisode(mediaRef, item, tmdbId, isAnime, appSeasonCounts)
            await removePMDBWatched(providerEp.tmdbId, 'tv', providerEp.season, providerEp.episode)
            if (providerEp.season !== item.season || providerEp.episode !== item.episode) {
              await removePMDBWatched(providerEp.tmdbId, 'tv', item.season, item.episode)
            }
          }))
        }
      } else if (service === 'mdblist') {
        if (mediaType === 'movie') {
          await removeMdblistWatched(tmdbId, 'movie', undefined, undefined, imdbId, mediaRef.tvdbId ? Number(mediaRef.tvdbId) : undefined)
        } else if (episode) {
          await removeMdblistWatched(tmdbId, 'series', episode.season, episode.episode, imdbId, mediaRef.tvdbId ? Number(mediaRef.tvdbId) : undefined)
        } else {
          await Promise.all(episodes.map((item) =>
            removeMdblistWatched(tmdbId, 'series', item.season, item.episode, imdbId, mediaRef.tvdbId ? Number(mediaRef.tvdbId) : undefined)
          ))
        }
      }
      await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: false, error: false, checking: false } }))
      return true
    } catch (_) {
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
    const wasWatched = states[service].done
    const success = await (wasWatched ? unmarkOn(service) : markOn(service))
    if (success) {
      if (wasWatched) {
        const anotherProviderStillWatched = connectedServices.some((candidate) => candidate !== service && states[candidate].done)
        setAllDone(anotherProviderStillWatched)
        if (!anotherProviderStillWatched) onUnmarked?.()
      } else {
        setAllDone(true)
        onMarked?.()
      }
    }
  }

  if (compact) {
    return (
      <div className="relative">
        <button
          onClick={(e) => { e.stopPropagation(); void markAll() }}
          // The label is deliberately small and quiet, but a 17px-tall target
          // is not reliably clickable. A transparent vertical outset lifts the
          // hit area to the 44px guideline without changing how it looks.
          className={`relative flex items-center gap-1.5 text-xs transition-colors cursor-pointer after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] ${allDone ? 'text-accent hover:text-accent-hover' : 'text-white/60 hover:text-white'}`}
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
    <div className={`relative ${className}`} ref={menuRef}>
      <button
        onClick={() => connectedServices.length > 0 ? setOpen(!open) : void markAll()}
        title={allDone ? 'Mark as unwatched' : 'Mark as watched'}
        className={[
          'h-12 px-3.5 rounded-full flex items-center justify-center gap-2 transition-[transform,background-color,border-color,color] duration-200 cursor-pointer active:scale-[0.97]',
          'border',
          allDone
            ? 'border-accent/45 bg-accent/15 text-white hover:border-accent/70 hover:bg-accent/22'
            : 'border-white/15 bg-[#171717]/95 text-white/80 hover:border-white/30 hover:bg-[#242424] hover:text-white',
        ].join(' ')}
      >
        <span className={`grid h-5 w-5 place-items-center rounded-full ${allDone ? 'bg-accent/25 text-accent ring-1 ring-accent/40' : 'border border-white/30 text-white/80'}`}>
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.7" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="whitespace-nowrap text-sm font-semibold">{allDone ? 'Watched' : 'Mark watched'}</span>
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
      'absolute left-0 z-50 min-w-[210px] overflow-hidden rounded-2xl border border-white/10 bg-[#111] shadow-[0_18px_44px_rgba(0,0,0,0.55)]',
      above ? 'bottom-full mb-2' : 'top-full mt-2',
    ].join(' ')}>
      <button
        onClick={(e) => { e.stopPropagation(); markAll() }}
        className="flex w-full items-center gap-2.5 border-b border-white/[0.06] px-3.5 py-3 text-xs font-semibold text-white/85 transition-colors cursor-pointer hover:bg-white/[0.07]"
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
            disabled={st.loading || st.checking}
            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-xs font-medium text-white/60 transition-colors cursor-pointer hover:bg-white/[0.05] hover:text-white disabled:cursor-default disabled:opacity-40"
          >
            {st.loading || st.checking ? (
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
            <span className="flex-1 text-left">{SERVICE_LABELS[service]}</span>
            {!st.loading && !st.checking && st.done && <span className="text-tag font-semibold uppercase tracking-wider text-white/50">Watched</span>}
          </button>
        )
      })}
    </div>
  )
}

function aniListEpisode(
  episode: { season: number; episode: number; absoluteEpisode?: number },
  appSeasonCounts?: { season: number; count: number }[],
): number {
  return episode.absoluteEpisode ?? seasonEpToAbsolute(episode.season, episode.episode, appSeasonCounts) ?? episode.episode
}

function aniListExactMarkIds(mediaRef: MediaRef, anilistId?: number | string, malId?: number | string): string[] {
  const ids = [
    mediaRef.localId,
    mediaRef.imdbId,
    mediaRef.tmdbId,
    mediaRef.tmdbId ? `tmdb-${mediaRef.tmdbId}` : undefined,
    mediaRef.tvdbId,
    mediaRef.tvdbId ? `tvdb-${mediaRef.tvdbId}` : undefined,
    malId ?? mediaRef.malId,
    malId || mediaRef.malId ? `mal-${malId ?? mediaRef.malId}` : undefined,
    anilistId ?? mediaRef.anilistId,
    anilistId || mediaRef.anilistId ? `anilist-${anilistId ?? mediaRef.anilistId}` : undefined,
  ].filter((id): id is string | number => id != null && id !== '')
  return [...new Set(ids.map(String))]
}

async function resolveAniListEpisode(
  mediaRef: MediaRef,
  episode: { season: number; episode: number; absoluteEpisode?: number },
  anilistId?: number | string,
  malId?: number | string,
  appSeasonCounts?: { season: number; count: number }[],
): Promise<{ anilistId?: number; malId?: number; episode: number } | null> {
  if (!mediaRef.tvdbId) {
    return {
      anilistId: anilistId ? Number(anilistId) : undefined,
      malId: malId ? Number(malId) : undefined,
      episode: aniListEpisode(episode, appSeasonCounts),
    }
  }

  try {
    const { mapEpisodeToProviders, isConfidenceSufficient } = await import('../services/anime-mapping')
    const mapping = await mapEpisodeToProviders({
      localMediaId: mediaRef.localId,
      tvdbSeriesId: mediaRef.tvdbId,
      tvdbSeasonNumber: episode.season,
      tvdbEpisodeNumber: episode.episode,
    })
    if (mapping && isConfidenceSufficient(mapping)) {
      if (mapping.anilist?.mediaId && mapping.anilist.episodeNumber) {
        return {
          anilistId: mapping.anilist.mediaId,
          malId: mapping.mal?.id ?? (malId ? Number(malId) : undefined),
          episode: mapping.anilist.episodeNumber,
        }
      }
      if (mapping.mal?.id && mapping.mal.episodeNumber) {
        return {
          anilistId: anilistId ? Number(anilistId) : undefined,
          malId: mapping.mal.id,
          episode: mapping.mal.episodeNumber,
        }
      }
    }
  } catch (_) {
    // Fall back to the local anime-list mapping.
  }

  try {
    const { mapTvdbEpisodeToAnimeProviders } = await import('../services/animeLists')
    const mapped = await mapTvdbEpisodeToAnimeProviders(mediaRef.tvdbId, episode.season, episode.episode)
    if ((mapped?.anilistId || mapped?.malId) && mapped.episode) {
      return {
        anilistId: mapped.anilistId ?? (anilistId ? Number(anilistId) : undefined),
        malId: mapped.malId ?? (malId ? Number(malId) : undefined),
        episode: mapped.episode,
      }
    }
  } catch (_) {
    // Fall back below.
  }

  return {
    anilistId: anilistId ? Number(anilistId) : undefined,
    malId: malId ? Number(malId) : undefined,
    episode: aniListEpisode(episode, appSeasonCounts),
  }
}

interface AnimeProviderMapping {
  anilistId?: number
  malId?: number
  simklId?: number
  traktId?: number
  tmdbId?: number
  season: number
  episode: number
  traktSeason?: number
  traktEpisode?: number
  simklSeason?: number
  simklEpisode?: number
  tmdbSeason?: number
  tmdbEpisode?: number
}

async function resolveAnimeProviders(
  mediaRef: MediaRef,
  episode: { season: number; episode: number; absoluteEpisode?: number },
): Promise<AnimeProviderMapping | null> {
  if (!mediaRef.tvdbId) return null

  // 1. Try anime-mapping API first (has per-season provider IDs)
  try {
    const { mapEpisodeToProviders, isConfidenceSufficient } = await import('../services/anime-mapping')
    const mapping = await mapEpisodeToProviders({
      localMediaId: mediaRef.localId,
      tvdbSeriesId: mediaRef.tvdbId,
      tvdbSeasonNumber: episode.season,
      tvdbEpisodeNumber: episode.episode,
    })
    if (mapping && isConfidenceSufficient(mapping)) {
      const hasProviderData = mapping.trakt?.id || mapping.simkl?.id || mapping.tmdb?.id || mapping.anilist?.mediaId
      if (hasProviderData) {
        return {
          anilistId: mapping.anilist?.mediaId,
          malId: mapping.mal?.id,
          simklId: mapping.simkl?.id,
          traktId: mapping.trakt?.id,
          tmdbId: mapping.tmdb?.id,
          season: mapping.trakt?.seasonNumber ?? mapping.tmdb?.seasonNumber ?? episode.season,
          episode: mapping.trakt?.episodeNumber ?? mapping.simkl?.episodeNumber ?? episode.episode,
          traktSeason: mapping.trakt?.seasonNumber ?? (mapping.trakt?.id ? 1 : undefined),
          traktEpisode: mapping.trakt?.episodeNumber,
          simklSeason: mapping.simkl?.seasonNumber ?? (mapping.simkl?.id ? 1 : undefined),
          simklEpisode: mapping.simkl?.episodeNumber,
          tmdbSeason: mapping.tmdb?.seasonNumber,
          tmdbEpisode: mapping.tmdb?.episodeNumber,
        }
      }
    }
  } catch (_) {
    // Fall through to anime-lists
  }

  // 2. Fallback to anime-lists
  try {
    const { mapTvdbEpisodeToAnimeProviders } = await import('../services/animeLists')
    return await mapTvdbEpisodeToAnimeProviders(mediaRef.tvdbId, episode.season, episode.episode)
  } catch (_) {
    return null
  }
}

async function resolvePmdbProviderEpisode(
  mediaRef: MediaRef,
  episode: { season: number; episode: number; absoluteEpisode?: number },
  fallbackTmdbId: number,
  isAnime: boolean,
  appSeasonCounts?: { season: number; count: number }[],
): Promise<{ tmdbId: number; season: number; episode: number }> {
  const fallback = { tmdbId: fallbackTmdbId, ...providerEpisode(episode, isAnime, appSeasonCounts) }
  if (!isAnime) return fallback

  const mapped = await resolveAnimeProviders(mediaRef, episode)
  if (!mapped?.tmdbId) return fallback

  // Use tmdb-specific season/episode from the mapping if available
  if (mapped.tmdbSeason != null && mapped.tmdbEpisode != null) {
    return { tmdbId: mapped.tmdbId, season: mapped.tmdbSeason, episode: mapped.tmdbEpisode }
  }

  const absoluteEpisode = episode.absoluteEpisode ?? seasonEpToAbsolute(episode.season, episode.episode, appSeasonCounts)
  if (mediaRef.tvdbId && absoluteEpisode != null) {
    try {
      const { shouldFlattenPmdbAnimeEpisodes } = await import('../services/animeLists')
      if (await shouldFlattenPmdbAnimeEpisodes(mediaRef.tvdbId, mapped.tmdbId)) {
        return { tmdbId: mapped.tmdbId, season: 1, episode: absoluteEpisode }
      }
    } catch (_) {
      // Use provider mapping below.
    }
  }

  return { tmdbId: mapped.tmdbId, season: mapped.season, episode: mapped.episode }
}

function providerEpisode(
  episode: { season: number; episode: number; absoluteEpisode?: number },
  _isAnime: boolean,
  _appSeasonCounts?: { season: number; count: number }[],
): { season: number; episode: number } {
  return { season: episode.season, episode: episode.episode }
}

function seasonEpToAbsolute(
  season: number,
  episode: number,
  seasonCounts?: { season: number; count: number }[],
): number | null {
  if (!seasonCounts?.length) return null
  let absolute = 0
  for (const s of seasonCounts) {
    if (s.season >= season) break
    absolute += s.count
  }
  return absolute + episode
}
