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
import { markAniListEpisodeExact, removeFromAniListList, saveAniListProgress, unmarkAniListEpisodeExact } from '../services/anilist'
import { scrobblePMDB, removePMDBWatched } from '../services/pmdb'
import { cacheClearCategory } from '../services/cache/sqliteCache'
import { CACHE_CATEGORIES } from '../services/cache/constants'
import { useAppStore } from '../stores/appStore'
import type { MediaRef } from '../services/simkl/mappings'

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
}

type Service = 'trakt' | 'simkl' | 'pmdb' | 'anilist'

interface ServiceState {
  loading: boolean
  done: boolean
  error: boolean
}

const SERVICE_LABELS: Record<Service, string> = {
  trakt: 'Trakt',
  simkl: 'Simkl',
  pmdb: 'PMDB',
  anilist: 'AniList',
}

export default function MarkWatchedButton({ mediaRef, mediaType, episode, episodes = [], imdbId, anilistId, malId, isAnime = false, compact, watched = false, onMarked, onUnmarked, appSeasonCounts }: MarkWatchedButtonProps) {
  const [open, setOpen] = useState(false)
  const [allDone, setAllDone] = useState(watched)
  const [states, setStates] = useState<Record<Service, ServiceState>>({
    trakt: { loading: false, done: false, error: false },
    simkl: { loading: false, done: false, error: false },
    pmdb: { loading: false, done: false, error: false },
    anilist: { loading: false, done: false, error: false },
  })
  const menuRef = useRef<HTMLDivElement>(null)

  const traktConnected = isTraktConnected()
  const simklConnected = !!getStoredSimklToken()?.accessToken
  const pmdbConnected = !!useAppStore((s) => s.pmdbApiKey)
  const anilistConnected = isAniListConnected()
  const tmdbId = mediaRef.tmdbId != null ? Number(mediaRef.tmdbId) : undefined

  const connectedServices: Service[] = []
  if (traktConnected) connectedServices.push('trakt')
  if (simklConnected) connectedServices.push('simkl')
  if (pmdbConnected && Number.isFinite(tmdbId)) connectedServices.push('pmdb')
  if (anilistConnected && isAnime && (anilistId || malId)) connectedServices.push('anilist')

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
          await markMovieWatchedOnSimkl(mediaRef)
        } else if (episode) {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, episode) : null
          const mappedRef = mapped?.simklId ? { ...mediaRef, simklId: mapped.simklId, malId: mapped.malId ?? mediaRef.malId } : mediaRef
          await markEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(episode, isAnime, appSeasonCounts))
        } else if (episodes.length > 0) {
          await Promise.all(episodes.map(async (item) => {
            const mapped = isAnime ? await resolveAnimeProviders(mediaRef, item) : null
            const mappedRef = mapped?.simklId ? { ...mediaRef, simklId: mapped.simklId, malId: mapped.malId ?? mediaRef.malId } : mediaRef
            return markEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(item, isAnime, appSeasonCounts))
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
      }
      await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: true, error: false } }))
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
        if (mediaType === 'movie') await removeWatchedFromSimkl(mediaRef, 'movie')
        else if (episode) {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, episode) : null
          const mappedRef = mapped?.simklId ? { ...mediaRef, simklId: mapped.simklId, malId: mapped.malId ?? mediaRef.malId } : mediaRef
          await removeEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(episode, isAnime, appSeasonCounts))
        }
        else await Promise.all(episodes.map(async (item) => {
          const mapped = isAnime ? await resolveAnimeProviders(mediaRef, item) : null
          const mappedRef = mapped?.simklId ? { ...mediaRef, simklId: mapped.simklId, malId: mapped.malId ?? mediaRef.malId } : mediaRef
          return removeEpisodeWatchedOnSimkl(mappedRef, mapped?.simklId ? { season: mapped.simklSeason ?? 1, episode: mapped.simklEpisode ?? mapped.episode } : providerEpisode(item, isAnime, appSeasonCounts))
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
      }
      await cacheClearCategory(CACHE_CATEGORIES.WATCHED_STATUS)
      setStates((prev) => ({ ...prev, [service]: { loading: false, done: true, error: false } }))
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
            disabled={st.loading}
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
