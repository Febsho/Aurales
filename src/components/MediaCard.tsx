import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchResult } from '../types'
import { applySearchResultArt } from '../services/artwork'
import { getTmdbLandscapeBackdrop } from '../services/tmdb'
import { useAppStore } from '../stores/appStore'
import { getLocalWatchedStatus, isWatchedFromProviders, searchResultToLookup } from '../services/watchedStatus'

const TMDB_GENRES: Record<number, string> = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',
  18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',
  9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',
  10752:'War',37:'Western',10759:'Action & Adventure',10762:'Kids',10763:'News',
  10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics',
}

interface MediaCardProps {
  item: SearchResult
  layout?: 'poster' | 'landscape'
  disableArtOverride?: boolean
}

export default function MediaCard({ item, layout = 'poster', disableArtOverride = false }: MediaCardProps) {
  const navigate = useNavigate()
  const displayItem = disableArtOverride ? item : applySearchResultArt(item)
  const [imgError, setImgError] = useState(false)
  const [backdropError, setBackdropError] = useState(false)
  const [resolvedBackdrop, setResolvedBackdrop] = useState<string | undefined>(undefined)
  const [resolvedPoster, setResolvedPoster] = useState<string | undefined>(undefined)
  const [resolvedGenre, setResolvedGenre] = useState<string | undefined>(undefined)
  const [providerWatched, setProviderWatched] = useState(false)
  const watchProgress = useAppStore((s) => s.watchProgress)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)
  const posterSize = useAppStore((s) => s.posterSize)
  const showRatingsOnCards = useAppStore((s) => s.showRatingsOnCards)
  const addRecentlyWatched = useAppStore((s) => s.addRecentlyWatched)

  const ratingStr = useMemo(() => {
    if (!displayItem.rating) return null
    const str = String(displayItem.rating)
    return str.replace(/\/10$/, '').trim()
  }, [displayItem.rating])

  const widthClass = useMemo(() => {
    if (layout === 'landscape') {
      switch (posterSize) {
        case 'compact': return 'w-[240px]'
        case 'large': return 'w-[320px]'
        case 'huge': return 'w-[384px]'
        case 'default':
        default:
          return 'w-[288px]'
      }
    } else {
      switch (posterSize) {
        case 'compact': return 'w-[112px]'
        case 'large': return 'w-[176px]'
        case 'huge': return 'w-[208px]'
        case 'default':
        default:
          return 'w-[144px]'
      }
    }
  }, [layout, posterSize])

  // Derive watched state from local progress
  const { localCompleted, progressPct } = useMemo(() => {
    const ids = [item.id, item.imdbId].filter(Boolean) as string[]
    // Check direct movie/show match
    for (const id of ids) {
      const direct = watchProgress.get(id)
      if (direct?.completed) return { localCompleted: true, progressPct: 100 }
      if (direct && direct.durationSeconds > 0) {
        return { localCompleted: false, progressPct: (direct.progressSeconds / direct.durationSeconds) * 100 }
      }
    }
    // Check episode entries (series): look for mediaId match
    let hasAnyProgress = false
    let hasCompleted = false
    for (const [, p] of watchProgress.entries()) {
      if (ids.includes(p.mediaId)) {
        hasAnyProgress = true
        if (p.completed) hasCompleted = true
      }
    }
    if (hasCompleted) return { localCompleted: true, progressPct: 100 }
    if (hasAnyProgress) return { localCompleted: false, progressPct: null }
    return { localCompleted: false, progressPct: null }
  }, [watchProgress, item.id, item.imdbId])
  const isCompleted = localCompleted || providerWatched

  useEffect(() => {
    let cancelled = false
    const lookup = searchResultToLookup(item)
    if (watchedCheckmarkSources.length === 1 && watchedCheckmarkSources[0] === 'local') {
      setProviderWatched(getLocalWatchedStatus(lookup, watchProgress))
      return () => { cancelled = true }
    }
    isWatchedFromProviders(lookup, watchedCheckmarkSources, watchProgress)
      .then((watched) => { if (!cancelled) setProviderWatched(watched) })
      .catch(() => { if (!cancelled) setProviderWatched(false) })
    return () => { cancelled = true }
  }, [item.id, item.imdbId, item.tmdbId, item.tvdbId, item.malId, item.anilistId, item.type, item.season, item.episode, watchedCheckmarkSources, watchProgress])

  useEffect(() => {
    if (layout !== 'landscape') return
    const tmdbId = displayItem.tmdbId || (String(displayItem.id).startsWith('tmdb-') ? String(displayItem.id).replace('tmdb-', '') : undefined)
    if (!tmdbId) return

    let cancelled = false
    getTmdbLandscapeBackdrop(displayItem.type, tmdbId)
      .then((backdrop) => {
        if (!cancelled && backdrop) setResolvedBackdrop(backdrop)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [layout, displayItem.id, displayItem.tmdbId, displayItem.type])

  useEffect(() => {
    let cancelled = false
    const tmdbId = displayItem.tmdbId || (String(displayItem.id).startsWith('tmdb-') ? String(displayItem.id).replace('tmdb-', '') : undefined)
    const imdbId = displayItem.imdbId || (String(displayItem.id).startsWith('tt') ? displayItem.id : undefined)

    if (!displayItem.poster || !displayItem.backdrop) {
      (async () => {
        try {
          let resolvedTmdbId = tmdbId
          if (!resolvedTmdbId && imdbId) {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(imdbId, 'imdb_id')
            if (found.tmdbId) resolvedTmdbId = String(found.tmdbId)
          }
          if (resolvedTmdbId) {
            const isMovie = displayItem.type === 'movie'
            if (isMovie) {
              const { tmdbProvider } = await import('../services/tmdb')
              const meta = await tmdbProvider.getMovie(`tmdb-${resolvedTmdbId}`)
              if (!cancelled) {
                if (meta.poster) setResolvedPoster(meta.poster)
                if (meta.backdrop) setResolvedBackdrop(meta.backdrop)
                if (meta.genres?.[0]) setResolvedGenre(meta.genres[0])
              }
            } else {
              const { tmdbProvider } = await import('../services/tmdb')
              const meta = await tmdbProvider.getShow(`tmdb-${resolvedTmdbId}`)
              if (!cancelled) {
                if (meta.poster) setResolvedPoster(meta.poster)
                if (meta.backdrop) setResolvedBackdrop(meta.backdrop)
                if (meta.genres?.[0]) setResolvedGenre(meta.genres[0])
              }
            }
          }
        } catch { /* ignore */ }
      })()
    }
    return () => { cancelled = true }
  }, [displayItem.poster, displayItem.backdrop, displayItem.id, displayItem.tmdbId, displayItem.imdbId, displayItem.type])

  const landscapeBackdrop = resolvedBackdrop || displayItem.backdrop

  const handleClick = () => {
    addRecentlyWatched(displayItem)
    const path = item.type === 'movie' ? `/movie/${item.id}` : `/series/${item.id}`
    navigate(path, {
      state: {
        poster: resolvedPoster || displayItem.poster,
        backdrop: resolvedBackdrop || displayItem.backdrop,
        title: displayItem.title,
        year: displayItem.year,
        rating: displayItem.rating,
        overview: displayItem.overview,
        imdbId: displayItem.imdbId,
        tmdbId: displayItem.tmdbId,
        tvdbId: displayItem.tvdbId,
        malId: displayItem.malId,
        anilistId: displayItem.anilistId,
        addonUrl: displayItem.addonUrl,
        provider: displayItem.provider,
        sourceAddonId: displayItem.sourceAddonId,
        sourceAddonItemId: displayItem.sourceAddonItemId,
      },
    })
  }

  if (layout === 'landscape') {
    return (
      <button
        onClick={handleClick}
        className={`flex-shrink-0 group cursor-pointer focus-ring text-left transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${widthClass}`}
      >
        <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated border border-white/[0.04] transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)] group-hover:-translate-y-1.5 group-hover:scale-[1.03]">
          {landscapeBackdrop && !backdropError ? (
            <img
              src={landscapeBackdrop}
              alt={displayItem.title}
              className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              loading="lazy"
              onError={() => setBackdropError(true)}
            />
          ) : (resolvedPoster || displayItem.poster) && !imgError ? (
            <img
              src={resolvedPoster || displayItem.poster}
              alt={displayItem.title}
              className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              loading="lazy"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
              <span className="text-2xl font-bold text-muted/30">{displayItem.title?.charAt(0) || '?'}</span>
            </div>
          )}
          
          {/* Permanent subtle dark gradient overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent transition-opacity duration-300 group-hover:from-black/95" />
          
          {/* Watched checkmark badge (landscape) */}
          {isCompleted && (
            <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-accent flex items-center justify-center shadow-lg z-10">
              <svg className="w-3.5 h-3.5 text-black" fill="none" stroke="currentColor" strokeWidth="2.8" viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}

          {/* Rating badge (landscape) */}
          {showRatingsOnCards && ratingStr && (
            <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md border border-white/10 flex items-center gap-1 shadow-lg z-10 text-[10px] font-bold text-yellow-400">
              <svg className="w-3 h-3 fill-current text-yellow-400" viewBox="0 0 24 24">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
              <span>{ratingStr}</span>
            </div>
          )}

          {/* In-progress bar (landscape) */}
          {!isCompleted && progressPct != null && progressPct > 2 && (
            <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40 z-10">
              <div className="h-full bg-accent rounded-r-full" style={{ width: `${Math.min(progressPct, 100)}%` }} />
            </div>
          )}

          {/* Media Info Overlay */}
          <div className="absolute bottom-3 left-3 right-3 flex flex-col gap-1">
            <h3 className="text-sm md:text-base font-bold text-white tracking-wide truncate drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
              {displayItem.title}
            </h3>
            <div className="flex items-center gap-2">
              {displayItem.year && (
                <span className="text-xs text-gray-300 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {displayItem.year}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={handleClick}
      className={`flex-shrink-0 group cursor-pointer focus-ring transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${widthClass}`}
    >
      <div className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-surface-elevated mb-2.5 border border-white/[0.04] transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-white/15 group-hover:shadow-[var(--shadow-card-hover)] group-focus-visible:border-accent/50 group-focus-visible:shadow-[var(--shadow-glow)] group-hover:-translate-y-2 group-hover:scale-[1.04]">
        {(resolvedPoster || displayItem.poster) && !imgError ? (
          <img
            src={resolvedPoster || displayItem.poster}
            alt={displayItem.title}
            className="w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-elevated to-surface">
            <span className="text-3xl font-bold text-muted/30">{displayItem.title?.charAt(0) || '?'}</span>
          </div>
        )}
        {/* Bottom gradient + genre label */}
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent" />
        {(() => {
          const genre = displayItem.genres?.[0]
            || (displayItem.genreIds?.[0] ? TMDB_GENRES[displayItem.genreIds[0]] : null)
            || resolvedGenre
          return genre ? (
            <div className="absolute bottom-2.5 left-2.5 right-2.5 z-10">
              <span className="text-[10px] font-semibold text-white/70 tracking-wide">
                {genre}
              </span>
            </div>
          ) : null
        })()}
        {/* Watched checkmark badge */}
        {isCompleted && (
          <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-accent flex items-center justify-center shadow-lg z-10">
            <svg className="w-3.5 h-3.5 text-black" fill="none" stroke="currentColor" strokeWidth="2.8" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {/* Rating badge (poster) */}
        {showRatingsOnCards && ratingStr && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md border border-white/10 flex items-center gap-1 shadow-lg z-10 text-[10px] font-bold text-yellow-400">
            <svg className="w-3 h-3 fill-current text-yellow-400" viewBox="0 0 24 24">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
            </svg>
            <span>{ratingStr}</span>
          </div>
        )}
        {import.meta.env.DEV && displayItem.metadataFallback && (
          <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-amber-500/90 text-black text-[9px] font-bold z-20">metadata fallback</div>
        )}

        {/* In-progress bar */}
        {!isCompleted && progressPct != null && progressPct > 2 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40 z-10">
            <div className="h-full bg-accent rounded-r-full" style={{ width: `${Math.min(progressPct, 100)}%` }} />
          </div>
        )}
      </div>
      <h3 className="text-xs font-semibold text-gray-300 truncate group-hover:text-white transition-colors pl-1">
        {displayItem.title}
      </h3>
      {displayItem.year && (
        <p className="text-[11px] text-muted/80 pl-1 mt-0.5">{displayItem.year}</p>
      )}
    </button>
  )
}
