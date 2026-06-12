import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import type { ShowDetails, SeasonDetails } from '../types'
import { MOCK_SHOW, MOCK_SEASON, MOCK_POPULAR_SHOWS } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { tvdbProvider } from '../services/tvdb'
import { getAddonMeta, getMetaAddons } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'
import StreamSelector from '../components/StreamSelector'
import WatchlistButton from '../components/WatchlistButton'
import RatingsStrip from '../components/RatingsStrip'
import DetailHero from '../components/media/DetailHero'
import DetailContentShell from '../components/media/DetailContentShell'
import { Button } from '../components/ui'
import MarkWatchedButton from '../components/MarkWatchedButton'
import { applyEpisodeArt, applySearchResultArt, applyShowArt } from '../services/artwork'
import { isWatchedFromProviders } from '../services/watchedStatus'
import { resolveAppMetadata, type AppMediaItem } from '../services/metadata'
import { debugAnimeMapping, validateAnimeTvdbStructure } from '../services/metadata/animeStructureValidator'
import { isLikelyJapaneseOnly } from '../services/metadata/animeTitleResolver'

interface LocationState {
  poster?: string
  backdrop?: string
  title?: string
  year?: number
  rating?: number
  overview?: string
  imdbId?: string
  tmdbId?: string | number
  tvdbId?: string | number
  malId?: string | number
  anilistId?: string | number
  addonUrl?: string
  provider?: string
  sourceAddonId?: string
  sourceAddonItemId?: string
}

function addonMetaToShow(meta: Record<string, unknown>, id: string): ShowDetails {
  const genres = Array.isArray(meta.genres) ? meta.genres as string[] :
    (typeof meta.genre === 'string' ? (meta.genre as string).split(',').map(g => g.trim()) :
    (Array.isArray(meta.genre) ? meta.genre as string[] : []))

  const videos = Array.isArray(meta.videos) ? meta.videos as Record<string, unknown>[] : []
  const seasons: { seasonNumber: number; name: string; episodeCount: number }[] = []

  if (Array.isArray(meta.videos)) {
    const seasonNums = new Set<number>()
    for (const v of videos) {
      const s = Number(v.season)
      if (!isNaN(s) && s > 0) seasonNums.add(s)
    }
    for (const num of Array.from(seasonNums).sort((a, b) => a - b)) {
      const eps = videos.filter(v => Number(v.season) === num)
      seasons.push({ seasonNumber: num, name: `Season ${num}`, episodeCount: eps.length })
    }
  }

  if (seasons.length === 0) {
    const numSeasons = meta.seasons ? Number(meta.seasons) : (meta.numberOfSeasons ? Number(meta.numberOfSeasons) : 1)
    for (let i = 1; i <= numSeasons; i++) {
      seasons.push({ seasonNumber: i, name: `Season ${i}`, episodeCount: 0 })
    }
  }

  return {
    id,
    title: (meta.name || meta.title || 'Unknown') as string,
    year: meta.releaseInfo ? parseInt(String(meta.releaseInfo)) : (meta.year ? Number(meta.year) : undefined),
    overview: (meta.description || meta.overview) as string | undefined,
    rating: meta.imdbRating ? parseFloat(String(meta.imdbRating)) : undefined,
    voteCount: meta.imdbVotes ? parseInt(String(meta.imdbVotes).replace(/,/g, '')) : undefined,
    genres,
    poster: meta.poster as string | undefined,
    backdrop: (meta.background || meta.banner) as string | undefined,
    logo: meta.logo as string | undefined,
    certification: meta.certification as string | undefined,
    status: meta.status as string | undefined,
    numberOfSeasons: seasons.length,
    numberOfEpisodes: meta.episodes ? Number(meta.episodes) : undefined,
    seasons,
    cast: Array.isArray(meta.cast) ? (meta.cast as string[]).map((name, i) => ({
      id: `cast-${i}`, name, character: '', profilePath: undefined,
    })) : [],
    crew: [],
    recommendations: [],
    trailers: Array.isArray(meta.trailers) ? (meta.trailers as Record<string, string>[]).map((t, i) => ({
      id: `trailer-${i}`,
      name: t.title || t.name || `Trailer ${i + 1}`,
      key: t.source || t.key || '',
      site: t.site || 'YouTube',
      type: t.type || 'Trailer',
      thumbnail: (t.source || t.key) ? `https://img.youtube.com/vi/${t.source || t.key}/hqdefault.jpg` : undefined,
    })) : [],
    imdbId: (meta.imdb_id || meta.imdbId || (typeof meta.id === 'string' && (meta.id as string).startsWith('tt') ? meta.id : undefined)) as string | undefined,
    tmdbId: getMetaId(meta, 'tmdb', 'tmdb_id', 'tmdbId'),
    tvdbId: getMetaId(meta, 'tvdb', 'tvdb_id', 'tvdbId'),
    malId: getMetaId(meta, 'mal', 'mal_id', 'malId'),
    anilistId: getMetaId(meta, 'anilist', 'anilist_id', 'anilistId'),
    provider: 'addon',
  }
}

function appMediaToShow(item: AppMediaItem): ShowDetails {
  return {
    id: item.id, title: item.title, originalTitle: item.originalTitle, year: item.year,
    overview: item.overview, rating: item.rating, genres: item.genres, poster: item.poster,
    backdrop: item.backdrop, logo: item.logo, certification: item.ageRating,
    numberOfSeasons: item.seasons?.filter((season) => season.seasonNumber > 0).length,
    numberOfEpisodes: item.seasons?.reduce((sum, season) => sum + season.episodeCount, 0),
    seasons: (item.seasons || []).map((season) => ({ seasonNumber: season.seasonNumber,
      name: season.title || (season.seasonNumber === 0 ? 'Specials' : `Season ${season.seasonNumber}`),
      episodeCount: season.episodeCount, poster: season.poster, overview: season.overview })),
    cast: [], crew: [], recommendations: [], trailers: [], imdbId: item.imdbId,
    tmdbId: item.tmdbId, tvdbId: item.tvdbId, malId: item.malId, anilistId: item.anilistId,
    provider: item.sourceMetadataProvider,
  }
}

function getMetaId(meta: Record<string, unknown>, ...keys: string[]): string | number | undefined {
  const ids = meta.ids && typeof meta.ids === 'object' ? meta.ids as Record<string, unknown> : {}
  for (const key of keys) {
    const value = meta[key] ?? ids[key]
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return undefined
}

function addonVideosToSeason(meta: Record<string, unknown>, seasonNum: number, isAnime?: boolean): SeasonDetails {
  if (isAnime) {
    console.warn("Blocked Stremio addon episode metadata for anime display");
    return { seasonNumber: seasonNum, name: `Season ${seasonNum}`, episodes: [] }
  }
  const videos = Array.isArray(meta.videos) ? meta.videos as Record<string, unknown>[] : []
  const seasonEps = videos
    .filter(v => Number(v.season) === seasonNum)
    .sort((a, b) => Number(a.episode) - Number(b.episode))

  return {
    seasonNumber: seasonNum,
    name: `Season ${seasonNum}`,
    episodes: seasonEps.map((ep) => ({
      id: `${seasonNum}-${ep.episode}`,
      episodeNumber: Number(ep.episode) || 0,
      seasonNumber: seasonNum,
      name: (ep.name || ep.title || `Episode ${ep.episode}`) as string,
      overview: (ep.description || ep.overview) as string | undefined,
      airDate: ep.released as string | undefined,
      runtime: ep.runtime ? parseInt(String(ep.runtime)) : undefined,
      still: (ep.thumbnail || ep.still) as string | undefined,
    })),
  }
}

function processSeasons(seasons: ShowDetails['seasons']): ShowDetails['seasons'] {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const cutoff = new Date(now.getFullYear(), now.getMonth() + 3, now.getDate())

  const hasEpisodeCounts = seasons.some((s) => s.episodeCount > 0)

  return seasons
    .filter((s) => {
      if (hasEpisodeCounts && s.episodeCount === 0) return false
      if (s.airDate) {
        const airDate = new Date(s.airDate)
        if (airDate > cutoff) return false
        if (s.airDate.slice(0, 10) > today && s.episodeCount === 0) return false
      }
      return true
    })
    .map((s) => {
      if (s.seasonNumber === 0) return { ...s, name: 'Specials' }
      return s
    })
    .sort((a, b) => {
      // Season 0 (Specials) goes to the end
      if (a.seasonNumber === 0) return 1
      if (b.seasonNumber === 0) return -1
      return a.seasonNumber - b.seasonNumber
    })
}

function rotateFallback<T>(items: T[], seed: string): T[] {
  if (items.length === 0) return []
  const offset = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function formatEpisodeAirDate(dateStr?: string): string {
  if (!dateStr) return ''
  try {
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr
    const parts = cleanDate.split('-')
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10)
      const month = parseInt(parts[1], 10) - 1
      const day = parseInt(parts[2], 10)
      const d = new Date(year, month, day)
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      }
    }
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    }
    return dateStr
  } catch {
    return dateStr
  }
}

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const state = (location.state || {}) as LocationState
  const [show, setShow] = useState<ShowDetails | null>(null)
  const [malRating, setMalRating] = useState<number | null>(null)
  const [fallbackRecommendations, setFallbackRecommendations] = useState(MOCK_POPULAR_SHOWS)
  const [addonMeta, setAddonMeta] = useState<Record<string, unknown> | null>(null)
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const [seasonCache, setSeasonCache] = useState<Record<number, SeasonDetails>>({})
  const seasonData = selectedSeason !== null ? (seasonCache[selectedSeason] || null) : null
  const [loading, setLoading] = useState(true)
  const [metadataStatus, setMetadataStatus] = useState<'idle' | 'resolving' | 'resolved' | 'fallback' | 'error'>('idle')
  const [suspiciousStructure, setSuspiciousStructure] = useState(false)
  const tvdbMappedEpisodesRef = useRef<Record<number, SeasonDetails['episodes']>>({})
  const [streamOpen, setStreamOpen] = useState(false)
  const [streamEpisode, setStreamEpisode] = useState<{ season: number; episode: number } | null>(null)
  const [watchedEpisodes, setWatchedEpisodes] = useState<Set<string>>(new Set())
  const fetchedSeasonRef = useRef<string | null>(null)
  const episodeScrollRef = useRef<HTMLDivElement>(null)
  const seasonScrollRef = useRef<HTMLDivElement>(null)
  const addons = useAppStore((s) => s.addons)
  const watchedProgress = useAppStore((s) => s.watchProgress)
  const setWatchProgress = useAppStore((s) => s.setWatchProgress)
  const removeWatchProgress = useAppStore((s) => s.removeWatchProgress)
  const watchedCheckmarkSources = useAppStore((s) => s.watchedCheckmarkSources)
  const blurSpoilers = useAppStore((s) => s.blurSpoilers)
  const blurThumbnails = useAppStore((s) => s.blurThumbnails)
  const blurTitles = useAppStore((s) => s.blurTitles)
  const blurDescriptions = useAppStore((s) => s.blurDescriptions)
  const keepNextEpisodeVisible = useAppStore((s) => s.keepNextEpisodeVisible)

  const isAnime = !!(
    show?.anilistId ||
    show?.malId ||
    state.anilistId ||
    state.malId ||
    (id && (id.startsWith('mal-') || id.startsWith('anilist-')))
  )

  useEffect(() => {
    async function load() {
      setLoading(true)
      setMetadataStatus('resolving')
      setAddonMeta(null)
      setSeasonCache({})
      setSelectedSeason(null)
      setMalRating(null)
      fetchedSeasonRef.current = null
      tvdbMappedEpisodesRef.current = {}
      let result: ShowDetails | null = null
      let appResult: ShowDetails | null = null

      // Collect all known IDs from route state
      const knownIds = {
        imdbId: state.imdbId || (id?.startsWith('tt') ? id : undefined),
        tmdbId: state.tmdbId || (id?.startsWith('tmdb-') ? id.replace('tmdb-', '') : undefined),
        tvdbId: state.tvdbId || (id?.startsWith('tvdb-') ? id.replace('tvdb-', '') : undefined),
        malId: state.malId || (id?.startsWith('mal-') ? id.replace('mal-', '') : undefined),
        anilistId: state.anilistId || (id?.startsWith('anilist-') ? id.replace('anilist-', '') : undefined),
      }

      // Early resolve anime IDs if they are AniList / MAL but we don't have TVDB ID
      if ((knownIds.anilistId || knownIds.malId) && !knownIds.tvdbId) {
        try {
          const { resolveAnimeIds } = await import('../services/animeLists')
          const resolved = await resolveAnimeIds({
            anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
            malId: knownIds.malId ? Number(knownIds.malId) : undefined,
          })
          if (resolved) {
            if (resolved.tvdbId) knownIds.tvdbId = String(resolved.tvdbId)
            if (resolved.tmdbId) knownIds.tmdbId = String(resolved.tmdbId)
            if (resolved.imdbId) knownIds.imdbId = resolved.imdbId
            if (resolved.anilistId) knownIds.anilistId = String(resolved.anilistId)
            if (resolved.malId) knownIds.malId = String(resolved.malId)
          }
        } catch (e) {
          console.error('[SeriesDetailPage] Failed early anime resolution:', e)
        }
      }

      const isAnimeLocal = !!(
        knownIds.anilistId ||
        knownIds.malId ||
        (id && (id.startsWith('mal-') || id.startsWith('anilist-')))
      )

      if (state.sourceAddonId && state.sourceAddonItemId) {
        const normalized = await resolveAppMetadata({
          addonId: state.sourceAddonId, addonUrl: state.addonUrl, addonType: 'series', id: state.sourceAddonItemId,
          title: state.title, year: state.year, imdbId: knownIds.imdbId, tmdbId: Number(knownIds.tmdbId) || undefined,
          tvdbId: Number(knownIds.tvdbId) || undefined, anilistId: Number(knownIds.anilistId) || undefined,
          malId: Number(knownIds.malId) || undefined,
        }).catch(() => null)
        if (normalized && normalized.sourceMetadataProvider !== 'fallback_addon') {
          result = appMediaToShow(normalized)
          knownIds.imdbId ||= normalized.imdbId
          knownIds.tmdbId ||= normalized.tmdbId
          knownIds.tvdbId ||= normalized.tvdbId
          knownIds.anilistId ||= normalized.anilistId
          knownIds.malId ||= normalized.malId
        }
      }

      // If addon item, get IDs from addon meta first
      if (state.addonUrl || state.provider === 'addon' || (id?.startsWith('tt') && !knownIds.tmdbId)) {
        const tryAddonMeta = async (addonUrl: string) => {
          try {
            const meta = await getAddonMeta(addonUrl, 'series', id || '')
            if (meta) {
              setAddonMeta(meta)
              const parsed = addonMetaToShow(meta, id || '')
              if (parsed.imdbId) knownIds.imdbId = knownIds.imdbId || parsed.imdbId
              if (parsed.tmdbId) knownIds.tmdbId = knownIds.tmdbId || parsed.tmdbId
              if (parsed.tvdbId) knownIds.tvdbId = knownIds.tvdbId || parsed.tvdbId
              if (parsed.malId) knownIds.malId = knownIds.malId || parsed.malId
              if (parsed.anilistId) knownIds.anilistId = knownIds.anilistId || parsed.anilistId
              return parsed
            }
          } catch { /* continue */ }
          return null
        }

        let addonResult: ShowDetails | null = null
        if (state.addonUrl) {
          addonResult = await tryAddonMeta(state.addonUrl)
        }
        if (!addonResult) {
          const metaAddons = getMetaAddons('series')
          const storeAddons = addons.filter((a) => a.enabled)
          for (const addon of metaAddons.length > 0 ? metaAddons : storeAddons) {
            addonResult = await tryAddonMeta(addon.url)
            if (addonResult) break
          }
        }
        // Keep addon result only as fallback — prefer app metadata below
        // For anime, skip addon metadata for display (addons often have wrong season structure)
        const isLikelyAnime = !!(knownIds.anilistId || knownIds.malId)
        const skipAddonDisplay = isLikelyAnime && useAppStore.getState().ignoreAddonMetadataForAnime
        if (skipAddonDisplay) {
          console.log('[SeriesDetailPage] Skipping addon metadata for anime display — addon only provides IDs')
          // Keep addon IDs but don't use addon for display
        } else if (addonResult && !result && useAppStore.getState().useAddonMetadataFallback) {
          result = addonResult
        }
      }

      // Show quick placeholder from route state while fetching real metadata
      const placeholder: ShowDetails | null = (state.title || result) ? {
        id: id || 'unknown',
        title: state.title || result?.title || '',
        year: state.year || result?.year,
        overview: state.overview || result?.overview,
        rating: state.rating || result?.rating,
        poster: state.poster || result?.poster,
        backdrop: state.backdrop || result?.backdrop,
        imdbId: knownIds.imdbId as string | undefined,
        tmdbId: knownIds.tmdbId,
        tvdbId: knownIds.tvdbId,
        malId: knownIds.malId,
        anilistId: knownIds.anilistId,
        genres: result?.genres || [],
        seasons: isAnimeLocal ? [] : (result?.seasons || []),
        cast: result?.cast || [],
        crew: result?.crew || [],
        recommendations: result?.recommendations || [],
        trailers: result?.trailers || [],
        provider: result?.provider,
      } : null

      if (placeholder) {
        const art = applyShowArt({ ...placeholder, seasons: processSeasons(placeholder.seasons) })
        setShow(art)
        if (!isAnimeLocal) {
          if (art.seasons.length > 0) setSelectedSeason(art.seasons[0].seasonNumber)
          setLoading(false)
        }
      }

      // Early anime detection — route to TVDB first for anime
      const isAnimeEarly = !!(knownIds.anilistId || knownIds.malId)

      if (isAnimeEarly) {
        console.log('[SeriesDetailPage] Anime detected early, using TVDB-first flow')

        // Resolve TVDB ID if missing
        let tvdbId = knownIds.tvdbId ? String(knownIds.tvdbId).replace('tvdb-', '') : undefined
        let tmdbId = knownIds.tmdbId ? String(knownIds.tmdbId).replace('tmdb-', '') : undefined

        if (!tvdbId) {
          try {
            const { resolveAnimeIds } = await import('../services/animeLists')
            const resolved = await resolveAnimeIds({
              anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
              malId: knownIds.malId ? Number(knownIds.malId) : undefined,
              imdbId: knownIds.imdbId,
              tmdbId: tmdbId ? Number(tmdbId) : undefined,
            })
            if (resolved?.tvdbId) tvdbId = String(resolved.tvdbId)
            if (resolved?.tmdbId) tmdbId = tmdbId || String(resolved.tmdbId)
            if (resolved?.imdbId) knownIds.imdbId = knownIds.imdbId || resolved.imdbId
            if (resolved?.anilistId) knownIds.anilistId = knownIds.anilistId || String(resolved.anilistId)
            if (resolved?.malId) knownIds.malId = knownIds.malId || String(resolved.malId)
          } catch { /* continue */ }
        }

        // Resolve TMDB ID if missing (needed for artwork)
        if (!tmdbId && knownIds.imdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
            if (found.tmdbId) tmdbId = String(found.tmdbId)
          } catch { /* continue */ }
        }

        // TVDB is source of truth for anime season/episode structure
        if (tvdbId) {
          try {
            const tvdbData = await tvdbProvider.getShow(`tvdb-${tvdbId}`)
            console.log('[SeriesDetailPage] TVDB anime data:', {
              title: tvdbData.title,
              seasons: tvdbData.seasons.map(s => ({ num: s.seasonNumber, eps: s.episodeCount })),
            })

            if (tvdbData.seasons.length > 0) {
              const { mapTvdbSeasons } = await import('../services/metadata/tvdbSeasonMapper')
              const animeSettings = useAppStore.getState()
              const normalizedSeasons = tvdbData.seasons.map((s) => ({
                id: `tvdb_${tvdbId}_s${s.seasonNumber}`,
                seasonNumber: s.seasonNumber,
                title: s.name,
                overview: s.overview,
                poster: s.poster,
                episodeCount: s.episodeCount || 0,
                episodes: [],
                airDate: s.airDate,
              }))
              const mappedSeasons = await mapTvdbSeasons(Number(tvdbId), normalizedSeasons, {
                hideUnairedSeasons: animeSettings.hideUnairedAnimeSeasons,
                hideUnairedEpisodes: animeSettings.hideUnairedAnimeEpisodes,
                includeSpecials: animeSettings.includeAnimeSpecials,
              })

              console.log('[SeriesDetailPage] Mapped TVDB anime seasons:', mappedSeasons.map(s => ({
                seasonNumber: s.seasonNumber, episodeCount: s.episodeCount, title: s.title,
              })))

              // Validate structure
              const validation = validateAnimeTvdbStructure(mappedSeasons)
              if (validation.suspiciousSingleSeasonFlattening) {
                console.warn('[SeriesDetailPage] Suspicious anime structure:', validation.reason)
                setSuspiciousStructure(true)
              }

              // Debug logging
              debugAnimeMapping({
                localMediaId: id,
                title: tvdbData.title,
                year: tvdbData.year,
                anilistId: knownIds.anilistId ? Number(knownIds.anilistId) : undefined,
                malId: knownIds.malId ? Number(knownIds.malId) : undefined,
                tvdbId: Number(tvdbId),
                tmdbId: tmdbId ? Number(tmdbId) : undefined,
                imdbId: knownIds.imdbId,
                matchedTvdbSeriesId: Number(tvdbId),
                matchedTvdbSeriesName: tvdbData.title,
                seasons: mappedSeasons,
              })

              // Cache the mapper's deduplicated episodes so fetchSeason uses them
              // instead of re-fetching raw (inflated) data from TVDB
              const episodeMap: Record<number, SeasonDetails['episodes']> = {}
              for (const s of mappedSeasons) {
                if (s.episodes && s.episodes.length > 0) {
                  episodeMap[s.seasonNumber] = s.episodes.map((ep) => ({
                    id: ep.id,
                    episodeNumber: ep.episodeNumber,
                    seasonNumber: ep.seasonNumber,
                    name: ep.title || `Episode ${ep.episodeNumber}`,
                    overview: ep.overview,
                    airDate: ep.airDate,
                    runtime: ep.runtime,
                    still: ep.still,
                    rating: undefined,
                    voteCount: undefined,
                    debugSource: ep.debugSource || 'tvdb',
                    debugResolverStep: ep.debugResolverStep || 'tvdbSeasonMapper.mapTvdbSeasons',
                  }))
                }
              }
              tvdbMappedEpisodesRef.current = episodeMap

              appResult = {
                ...tvdbData,
                id: id || tvdbData.id,
                seasons: mappedSeasons.map((s) => {
                  const rawName = s.title || (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`)
                  const displayName = (rawName && isLikelyJapaneseOnly(rawName) && animeSettings.avoidJapaneseSeasonNames)
                    ? `Season ${s.seasonNumber}`
                    : rawName
                  return {
                    seasonNumber: s.seasonNumber,
                    name: s.seasonNumber === 0 ? 'Specials' : displayName,
                    episodeCount: s.episodeCount,
                    poster: s.poster,
                    overview: s.overview,
                    airDate: s.airDate,
                  }
                }),
                numberOfSeasons: mappedSeasons.filter(s => s.seasonNumber > 0).length,
                numberOfEpisodes: tvdbData.numberOfEpisodes,
                tvdbId: tvdbId,
                malId: knownIds.malId,
                anilistId: knownIds.anilistId,
              }
            }
          } catch (e) {
            console.warn('[SeriesDetailPage] TVDB fetch failed for anime:', e)
          }
        }

        // Enrich with TMDB artwork (poster, backdrop, logo) — never for seasons
        if (tmdbId) {
          try {
            const tmdbData = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
            if (appResult) {
              // Only take artwork and supplementary data from TMDB, never seasons
              appResult = {
                ...appResult,
                poster: tmdbData.poster || appResult.poster,
                backdrop: tmdbData.backdrop || appResult.backdrop,
                logo: tmdbData.logo || appResult.logo,
                overview: appResult.overview || tmdbData.overview,
                rating: tmdbData.rating || appResult.rating,
                cast: appResult.cast.length > 0 ? appResult.cast : tmdbData.cast,
                recommendations: tmdbData.recommendations.length > 0 ? tmdbData.recommendations : appResult.recommendations,
                trailers: tmdbData.trailers.length > 0 ? tmdbData.trailers : appResult.trailers,
                imdbId: appResult.imdbId || tmdbData.imdbId,
              }
            } else {
              // No TVDB data at all — use TMDB as fallback but log warning
              console.warn('[SeriesDetailPage] No TVDB data for anime, falling back to TMDB (seasons may be wrong)')
              appResult = {
                ...tmdbData,
                id: id || tmdbData.id,
                malId: knownIds.malId,
                anilistId: knownIds.anilistId,
              }
            }
          } catch { /* continue */ }
        }

        // Preserve IDs
        if (appResult) {
          appResult = {
            ...appResult,
            id: id || appResult.id,
            malId: appResult.malId || knownIds.malId,
            anilistId: appResult.anilistId || knownIds.anilistId,
          }
        }
      } else {
        // Non-anime: TMDB first (existing flow)

        // Resolve TMDB ID if we don't have one
        let tmdbId = knownIds.tmdbId ? String(knownIds.tmdbId).replace('tmdb-', '') : undefined
        if (!tmdbId && knownIds.imdbId) {
          try {
            const { tmdbFindByExternalId } = await import('../services/metadataEnrich')
            const found = await tmdbFindByExternalId(knownIds.imdbId as string, 'imdb_id')
            if (found.tmdbId) tmdbId = String(found.tmdbId)
          } catch { /* continue */ }
        }

        // Fetch from TMDB (primary for non-anime)
        if (tmdbId) {
          try {
            appResult = await tmdbProvider.getShow(`tmdb-${tmdbId}`)
          } catch { /* continue */ }
        }

        // Detect anime late (via anime-lists) and apply TVDB override
        if (appResult) {
          const isAnimeLate =
            (appResult.imdbId && await import('../services/animeLists').then(m => m.lookupByImdbId(appResult!.imdbId!)).then(e => !!e).catch(() => false)) ||
            (appResult.tvdbId && await import('../services/animeLists').then(m => m.lookupByTvdbId(Number(String(appResult!.tvdbId).replace('tvdb-', '')))).then(e => e.length > 0).catch(() => false))

          if (isAnimeLate) {
            console.log('[SeriesDetailPage] Late anime detection — applying TVDB season override')
            let tvdbId = appResult.tvdbId ? String(appResult.tvdbId).replace('tvdb-', '') : undefined
            if (!tvdbId) {
              try {
                const { resolveAnimeIds } = await import('../services/animeLists')
                const resolved = await resolveAnimeIds({
                  imdbId: appResult.imdbId,
                  tmdbId: tmdbId ? Number(tmdbId) : undefined,
                })
                if (resolved?.tvdbId) tvdbId = String(resolved.tvdbId)
                if (resolved?.anilistId) appResult = { ...appResult, anilistId: appResult.anilistId || resolved.anilistId }
                if (resolved?.malId) appResult = { ...appResult, malId: appResult.malId || resolved.malId }
              } catch { /* continue */ }
            }
            if (tvdbId) {
              try {
                const tvdbData = await tvdbProvider.getShow(`tvdb-${tvdbId}`)
                if (tvdbData.seasons.length > 0) {
                  const { mapTvdbSeasons } = await import('../services/metadata/tvdbSeasonMapper')
                  const animeSettings = useAppStore.getState()
                  const normalizedSeasons = tvdbData.seasons.map((s) => ({
                    id: `tvdb_${tvdbId}_s${s.seasonNumber}`,
                    seasonNumber: s.seasonNumber,
                    title: s.name,
                    overview: s.overview,
                    poster: s.poster,
                    episodeCount: s.episodeCount || 0,
                    episodes: [],
                    airDate: s.airDate,
                  }))
                  const mappedSeasons = await mapTvdbSeasons(Number(tvdbId), normalizedSeasons, {
                    hideUnairedSeasons: animeSettings.hideUnairedAnimeSeasons,
                    hideUnairedEpisodes: animeSettings.hideUnairedAnimeEpisodes,
                    includeSpecials: animeSettings.includeAnimeSpecials,
                  })
                  const lateValidation = validateAnimeTvdbStructure(mappedSeasons)
                  if (lateValidation.suspiciousSingleSeasonFlattening) {
                    console.warn('[SeriesDetailPage] Late anime — suspicious structure:', lateValidation.reason)
                    setSuspiciousStructure(true)
                  }

                  // Cache mapper's deduplicated episodes for late anime detection
                  const lateEpisodeMap: Record<number, SeasonDetails['episodes']> = {}
                  for (const s of mappedSeasons) {
                    if (s.episodes && s.episodes.length > 0) {
                      lateEpisodeMap[s.seasonNumber] = s.episodes.map((ep) => ({
                        id: ep.id,
                        episodeNumber: ep.episodeNumber,
                        seasonNumber: ep.seasonNumber,
                        name: ep.title || `Episode ${ep.episodeNumber}`,
                        overview: ep.overview,
                        airDate: ep.airDate,
                        runtime: ep.runtime,
                        still: ep.still,
                        rating: undefined,
                        voteCount: undefined,
                        debugSource: ep.debugSource || 'tvdb',
                        debugResolverStep: ep.debugResolverStep || 'tvdbSeasonMapper.mapTvdbSeasons',
                      }))
                    }
                  }
                  tvdbMappedEpisodesRef.current = lateEpisodeMap

                  appResult = {
                    ...appResult,
                    seasons: mappedSeasons.map((s) => {
                      const rawName = s.title || (s.seasonNumber === 0 ? 'Specials' : `Season ${s.seasonNumber}`)
                      const displayName = (rawName && isLikelyJapaneseOnly(rawName) && animeSettings.avoidJapaneseSeasonNames)
                        ? `Season ${s.seasonNumber}`
                        : rawName
                      return {
                        seasonNumber: s.seasonNumber,
                        name: s.seasonNumber === 0 ? 'Specials' : displayName,
                        episodeCount: s.episodeCount,
                        poster: s.poster,
                        overview: s.overview,
                        airDate: s.airDate,
                      }
                    }),
                    numberOfSeasons: mappedSeasons.filter(s => s.seasonNumber > 0).length,
                    numberOfEpisodes: tvdbData.numberOfEpisodes || appResult.numberOfEpisodes,
                    tvdbId: tvdbId,
                    cast: appResult.cast.length > 0 ? appResult.cast : tvdbData.cast,
                  }
                }
              } catch { /* continue */ }
            }
          }

          // Preserve original ID and merge any extra addon IDs
          appResult = {
            ...appResult,
            id: id || appResult.id,
            malId: appResult.malId || knownIds.malId,
            anilistId: appResult.anilistId || knownIds.anilistId,
          }
        }

        // If no TMDB data, try TVDB directly
        if (!appResult && knownIds.tvdbId) {
          try {
            appResult = await tvdbProvider.getShow(`tvdb-${String(knownIds.tvdbId).replace('tvdb-', '')}`)
            appResult = { ...appResult, id: id || appResult.id, malId: knownIds.malId, anilistId: knownIds.anilistId }
          } catch { /* continue */ }
        }
      }

      // Use app result if available, otherwise keep addon/placeholder
      const finalResult = appResult || result || (placeholder ? placeholder : { ...MOCK_SHOW, id: id || 'mock-show-1' })
      finalResult.seasons = processSeasons(finalResult.seasons)
      const artApplied = applyShowArt(finalResult)

      // Resolve IMDb ID if still missing (needed for posters/ratings)
      if (!artApplied.imdbId && (artApplied.tmdbId || artApplied.tvdbId)) {
        try {
          const { resolveImdbId } = await import('../services/metadataEnrich')
          const imdbId = await resolveImdbId(artApplied, 'series')
          if (imdbId) artApplied.imdbId = imdbId
        } catch { /* continue */ }
      }

      const finalArt = applyShowArt(artApplied)

      if (isAnimeLocal) {
        console.log("[AnimeDetail] setting seasons", {
          source: appResult ? 'app_metadata' : (result ? 'addon_metadata' : 'fallback'),
          seasonNumbers: finalArt.seasons.map(s => s.seasonNumber),
          episodeCounts: finalArt.seasons.map(s => ({
            seasonNumber: s.seasonNumber,
            count: s.episodeCount,
          })),
        });
      }

      setSeasonCache({})
      setShow(finalArt)
      if (finalArt.seasons.length > 0) {
        const firstNormalSeason = finalArt.seasons.find(s => s.seasonNumber > 0)
        setSelectedSeason(firstNormalSeason?.seasonNumber ?? finalArt.seasons[0].seasonNumber)
      } else {
        setSelectedSeason(null)
      }

      let status: 'resolved' | 'fallback' | 'error' = 'resolved'
      if (appResult) {
        status = 'resolved'
      } else if (result) {
        status = 'fallback'
      } else {
        status = 'error'
      }
      setMetadataStatus(status)
      setLoading(false)
    }
    load()
  }, [id, state.addonUrl, state.provider, state.title, addons])

  useEffect(() => {
    if (!show) return
    const isAnime = !!(show.malId || show.anilistId)
    if (!isAnime) return

    let cancelled = false
    import('../services/mdblist').then(({ getMdblistRatings }) => {
      return getMdblistRatings({
        mediaType: 'series',
        imdbId: show.imdbId,
        tmdbId: show.tmdbId,
        tvdbId: show.tvdbId,
      })
    }).then((ratings) => {
      if (cancelled || !ratings) return
      const mal = ratings.find((r) => r.source === 'myanimelist')
      if (mal) {
        const val = parseFloat(mal.value)
        if (!isNaN(val)) setMalRating(val)
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [show])

  const fetchSeason = async (seasonNum: number): Promise<SeasonDetails | null> => {
    if (!show || !id) return null

    const applyArt = (data: SeasonDetails) => ({
      ...data,
      episodes: data.episodes.map((episode) => applyEpisodeArt(episode, { ...show, season: seasonNum })),
    })

    const tmdbId = show.tmdbId ? String(show.tmdbId).replace('tmdb-', '') : (id.startsWith('tmdb-') ? id.replace('tmdb-', '') : null)
    const tvdbId = show.tvdbId ? String(show.tvdbId).replace('tvdb-', '') : (id.startsWith('tvdb-') ? id.replace('tvdb-', '') : null)

    const tryTmdb = async (): Promise<SeasonDetails | null> => {
      if (!tmdbId) return null
      try {
        const data = await tmdbProvider.getSeason(`tmdb-${tmdbId}`, seasonNum)
        if (data.episodes.length > 0) {
          const tagged = {
            ...data,
            debugSource: 'tmdb',
            debugResolverStep: 'fetchSeason.tryTmdb',
            episodes: data.episodes.map(e => ({
              ...e,
              debugSource: e.debugSource || 'tmdb',
              debugResolverStep: e.debugResolverStep || 'fetchSeason.tryTmdb',
            }))
          }
          return applyArt(tagged)
        }
      } catch { /* fall through */ }
      return null
    }

    const isAnimeShow = isAnime

    const tryTvdb = async (): Promise<SeasonDetails | null> => {
      if (!tvdbId) return null

      // Use mapper-cached episodes if available — they're already deduplicated
      const cachedEpisodes = tvdbMappedEpisodesRef.current[seasonNum]
      if (isAnimeShow && cachedEpisodes && cachedEpisodes.length > 0) {
        console.log('[fetchSeason] Using mapper-cached episodes for season', seasonNum, ':', cachedEpisodes.length, 'episodes')
        const seasonInfo = show?.seasons.find((s) => s.seasonNumber === seasonNum)
        return applyArt({
          seasonNumber: seasonNum,
          name: seasonInfo?.name || `Season ${seasonNum}`,
          episodes: cachedEpisodes,
        })
      }

      try {
        const data = await tvdbProvider.getSeason(`tvdb-${tvdbId}`, seasonNum)
        if (data.episodes.length === 0) return null
        if (isAnimeShow) {
          const today = new Date().toISOString().slice(0, 10)
          const settings = useAppStore.getState()

          // Filter episodes that don't belong to this season (TVDB sometimes
          // returns all episodes in the Season 1 response)
          data.episodes = data.episodes.filter((ep) => {
            if (ep.seasonNumber != null && ep.seasonNumber !== seasonNum) return false
            return true
          })

          if (settings.hideUnairedAnimeEpisodes) {
            data.episodes = data.episodes.filter((ep) => {
              if (!ep.airDate) return !!(ep.name || ep.overview)
              return ep.airDate.slice(0, 10) <= today
            })
          }

          // If Season 1 has way more episodes than the summary says, trim to
          // match the episode count from the initial mapping (which already
          // de-duplicated via tvdbSeasonMapper).
          if (seasonNum === 1 && show) {
            const seasonSummary = show.seasons.find((s) => s.seasonNumber === 1)
            if (seasonSummary && seasonSummary.episodeCount > 0 && data.episodes.length > seasonSummary.episodeCount * 1.3) {
              console.log('[fetchSeason] Trimming S1 episodes from', data.episodes.length, 'to', seasonSummary.episodeCount)
              data.episodes = data.episodes.slice(0, seasonSummary.episodeCount)
            }
          }
        }
        if (data.episodes.length > 0) {
          const tagged = {
            ...data,
            debugSource: 'tvdb',
            debugResolverStep: 'fetchSeason.tryTvdb',
            episodes: data.episodes.map(e => ({
              ...e,
              debugSource: e.debugSource || 'tvdb',
              debugResolverStep: e.debugResolverStep || 'fetchSeason.tryTvdb',
            }))
          }
          return applyArt(tagged)
        }
      } catch { /* fall through */ }
      return null
    }

    // Anime: TVDB first (correct per-season episode mapping — TMDB lumps all eps into season 1)
    // Regular: TMDB first (better English titles/images)
    if (isAnimeShow) {
      const tvdbResult = await tryTvdb()
      if (tvdbResult) return tvdbResult
      const tmdbResult = await tryTmdb()
      if (tmdbResult) return tmdbResult
    } else {
      const tmdbResult = await tryTmdb()
      if (tmdbResult) return tmdbResult
      const tvdbResult = await tryTvdb()
      if (tvdbResult) return tvdbResult
    }

    if (isAnimeShow) {
      console.warn("Blocked anime fallback Season 1 generation");
      return null;
    }

    if (addonMeta && Array.isArray(addonMeta.videos) && !isAnimeShow) {
      return applyArt(addonVideosToSeason(addonMeta, seasonNum, isAnimeShow))
    }

    const seasonInfo = show.seasons.find(s => s.seasonNumber === seasonNum)
    if (seasonInfo && seasonInfo.episodeCount > 0) {
      const episodes = Array.from({ length: seasonInfo.episodeCount }, (_, i) => ({
        id: `${seasonNum}-${i + 1}`,
        episodeNumber: i + 1,
        seasonNumber: seasonNum,
        name: `Episode ${i + 1}`,
        debugSource: 'ui-generated',
        debugResolverStep: 'fetchSeason.seasonInfoFallback',
      }))
      return applyArt({ seasonNumber: seasonNum, name: seasonInfo.name, episodes })
    }

    return applyArt(MOCK_SEASON)
  }

  const isCached = selectedSeason !== null && seasonCache[selectedSeason] !== undefined
  useEffect(() => {
    if (!show || !id || selectedSeason === null || isCached) return

    let cancelled = false
    fetchSeason(selectedSeason).then((data) => {
      if (cancelled || !data) return
      setSeasonCache(prev => ({ ...prev, [selectedSeason]: data }))
    })

    return () => { cancelled = true }
  }, [show, id, selectedSeason, addonMeta, isCached])

  // Prefetch other seasons in the background
  useEffect(() => {
    if (!show || !id || selectedSeason === null || !seasonCache[selectedSeason]) return

    const uncachedSeasons = show.seasons
      .map(s => s.seasonNumber)
      .filter(num => seasonCache[num] === undefined)

    if (uncachedSeasons.length === 0) return

    let cancelled = false
    const prefetch = async () => {
      for (const num of uncachedSeasons) {
        if (cancelled) break
        const data = await fetchSeason(num)
        if (data && !cancelled) {
          setSeasonCache(prev => ({ ...prev, [num]: data }))
        }
      }
    }
    prefetch()

    return () => { cancelled = true }
  }, [show, id, seasonCache, selectedSeason, addonMeta])

  useEffect(() => {
    if (!show || !seasonData || seasonData.seasonNumber !== selectedSeason) return

    const cacheKey = `${show.id}:${selectedSeason}`
    if (fetchedSeasonRef.current === cacheKey) return

    const hasImdbRatings = seasonData.episodes.some(ep => ep.imdbRating !== undefined)
    if (hasImdbRatings) {
      fetchedSeasonRef.current = cacheKey
      return
    }

    fetchedSeasonRef.current = cacheKey
    let cancelled = false

    const fetchOMDb = (url: string) => {
      fetch(url)
        .then(res => res.json())
        .then(omdbData => {
          if (cancelled) return
          if (omdbData.Response === 'True' && Array.isArray(omdbData.Episodes)) {
            const ratingsMap = new Map()
            for (const ep of omdbData.Episodes) {
              const epNum = parseInt(ep.Episode)
              const ratingVal = ep.imdbRating
              const imdbIdVal = ep.imdbID
              if (!isNaN(epNum)) {
                ratingsMap.set(epNum, {
                  rating: (ratingVal && ratingVal !== 'N/A') ? ratingVal : undefined,
                  imdbId: (imdbIdVal && imdbIdVal !== 'N/A') ? imdbIdVal : undefined
                })
              }
            }

            setSeasonCache(prev => {
              const cached = prev[selectedSeason]
              if (!cached) return prev
              const updatedEpisodes = cached.episodes.map(ep => {
                const info = ratingsMap.get(ep.episodeNumber)
                if (info) {
                  return {
                    ...ep,
                    imdbRating: info.rating || ep.imdbRating,
                    imdbId: info.imdbId || ep.imdbId
                  }
                }
                return ep
              })
              return {
                ...prev,
                [selectedSeason]: {
                  ...cached,
                  episodes: updatedEpisodes
                }
              }
            })
          } else if (omdbData.Response === 'False' && url.includes('?i=')) {
            const fallbackUrl = `https://www.omdbapi.com/?t=${encodeURIComponent(show.title)}&Season=${selectedSeason}&apikey=thewdb`
            fetchOMDb(fallbackUrl)
          }
        })
        .catch(() => {})
    }

    if (show.imdbId) {
      fetchOMDb(`https://www.omdbapi.com/?i=${show.imdbId}&Season=${selectedSeason}&apikey=thewdb`)
    } else {
      fetchOMDb(`https://www.omdbapi.com/?t=${encodeURIComponent(show.title)}&Season=${selectedSeason}&apikey=thewdb`)
    }

    return () => { cancelled = true }
  }, [show, selectedSeason, seasonData])

  useEffect(() => {
    if (!show) {
      setWatchedEpisodes(new Set())
      return
    }
    const episodes = Object.values(seasonCache).flatMap((season) => season.episodes)
    if (episodes.length === 0) return
    let cancelled = false
    Promise.all(
      episodes.map(async (episode) => {
        const watched = await isWatchedFromProviders({
          id: show.id,
          type: 'series',
          imdbId: show.imdbId,
          tmdbId: show.tmdbId ?? episode.tmdbId,
          tvdbId: show.tvdbId ?? episode.tvdbId,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
        }, watchedCheckmarkSources, watchedProgress)
        return watched ? `${episode.seasonNumber}:${episode.episodeNumber}` : null
      })
    ).then((keys) => {
      if (!cancelled) setWatchedEpisodes(new Set(keys.filter((key): key is string => Boolean(key))))
    }).catch(() => {
      if (!cancelled) setWatchedEpisodes(new Set())
    })
    return () => { cancelled = true }
  }, [show, seasonCache, watchedCheckmarkSources, watchedProgress])

  useEffect(() => {
    if (!show || show.recommendations.length > 0) return
    const query = show.genres[0] || show.title
    tmdbProvider.recommendationsForText?.(query, 'series')
      .then((results) => {
        const filtered = results.filter((item) => item.id !== show.id && item.title !== show.title)
        setFallbackRecommendations((filtered.length ? filtered : rotateFallback(MOCK_POPULAR_SHOWS, show.id)).map(applySearchResultArt))
      })
      .catch(() => setFallbackRecommendations(rotateFallback(MOCK_POPULAR_SHOWS, show.id).map(applySearchResultArt)))
  }, [show])

  if (isAnime) {
    console.log("[AnimeDetail] initial render", {
      mediaId: id,
      mediaType: 'series',
      metadataStatus,
      seasonsCount: show?.seasons?.length,
      seasonNumbers: show?.seasons?.map(s => s.seasonNumber),
    });
  }



  if (isAnime && metadataStatus === 'resolving') {
    return (
      <div className="pb-12 animate-pulse">
        {/* Hero Skeleton / Image */}
        <div className="relative w-full overflow-hidden bg-surface-elevated/40" style={{ height: 'clamp(550px, 70vh, 850px)' }}>
          {show?.backdrop ? (
            <img
              src={show.backdrop}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-25"
              style={{ objectPosition: 'center 15%' }}
              draggable={false}
            />
          ) : show?.poster ? (
            <img
              src={show.poster}
              alt=""
              className="absolute inset-0 w-full h-full object-cover blur-3xl scale-125 opacity-25"
              draggable={false}
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent z-10" />
          <div className="absolute inset-x-8 bottom-12 z-20 max-w-4xl flex gap-8 items-end">
            {/* Poster Skeleton */}
            {show?.poster ? (
              <img
                src={show.poster}
                alt=""
                className="w-48 aspect-[2/3] rounded-2xl object-cover shadow-2xl ring-1 ring-white/10 hidden md:block"
                draggable={false}
              />
            ) : (
              <div className="w-48 aspect-[2/3] rounded-2xl bg-white/[0.04] hidden md:block" />
            )}
            <div className="flex-1 flex flex-col gap-4">
              {/* Title Skeleton */}
              {show?.title ? (
                <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white/90">{show.title}</h1>
              ) : (
                <div className="h-10 w-3/4 bg-white/[0.06] rounded-xl" />
              )}
              <div className="flex gap-2">
                <div className="h-4 w-16 bg-white/[0.04] rounded-md" />
                <div className="h-4 w-12 bg-white/[0.04] rounded-md" />
                <div className="h-4 w-24 bg-white/[0.04] rounded-md" />
              </div>
              {/* Overview Skeleton */}
              <div className="space-y-2.5 mt-2">
                <div className="h-4 w-full bg-white/[0.04] rounded-md" />
                <div className="h-4 w-5/6 bg-white/[0.04] rounded-md" />
                <div className="h-4 w-2/3 bg-white/[0.04] rounded-md" />
              </div>
              <div className="h-12 w-48 bg-white/[0.06] rounded-xl mt-4" />
            </div>
          </div>
        </div>

        {/* Season & Episode Skeleton */}
        <div className="px-8 mt-8">
          <div className="flex gap-3 mb-6">
            <div className="h-10 w-28 bg-white/[0.06] rounded-xl" />
            <div className="h-10 w-28 bg-white/[0.04] rounded-xl" />
            <div className="h-10 w-28 bg-white/[0.04] rounded-xl" />
          </div>
          <div className="flex gap-6 overflow-x-hidden pb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-[320px] flex flex-col gap-3">
                <div className="aspect-video rounded-2xl bg-white/[0.06]" />
                <div className="h-4 w-16 bg-white/[0.04] rounded-md" />
                <div className="h-5 w-48 bg-white/[0.06] rounded-md" />
                <div className="h-4 w-full bg-white/[0.04] rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (loading || !show) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const getEpisodeProgress = (seasonNum: number, episodeNum: number) => {
    if (!show) return null
    const candidateIds = [show.id, show.imdbId, String(show.tmdbId || '')].filter(Boolean)
    for (const progress of watchedProgress.values()) {
      if (progress.season !== seasonNum || progress.episode !== episodeNum || progress.completed) continue
      const matchesShow = candidateIds.includes(progress.mediaId)
        || candidateIds.some((candidate) => progress.id === `${candidate}:${seasonNum}:${episodeNum}`)
      if (matchesShow && progress.progressSeconds > 0) return progress
    }
    return null
  }

  const handlePlayEpisode = (seasonNum: number, episodeNum: number) => {
    setStreamEpisode({ season: seasonNum, episode: episodeNum })
    setStreamOpen(true)
  }

  const selectSeason = (seasonNumber: number) => {
    setSelectedSeason(seasonNumber)
    episodeScrollRef.current?.scrollTo({ left: 0, behavior: 'auto' })
    window.requestAnimationFrame(() => {
      const selected = seasonScrollRef.current?.querySelector<HTMLElement>(`[data-season="${seasonNumber}"]`)
      selected?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    })
  }

  const scrollSeasons = (direction: 'left' | 'right') => {
    const container = seasonScrollRef.current
    if (!container) return
    const amount = Math.max(320, container.clientWidth * 0.7)
    container.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' })
  }

  const handleSeasonWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    const amount = Math.abs(event.deltaY) >= 1 ? event.deltaY : event.deltaX
    if (Math.abs(amount) < 1) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: amount, behavior: 'smooth' })
  }

  const handleEpisodeWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    const amount = Math.abs(event.deltaY) >= 1 ? event.deltaY : event.deltaX
    if (Math.abs(amount) < 1) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: amount, behavior: 'smooth' })
  }

  const highQualityEpisodeStill = (url?: string) => {
    if (!url) return undefined
    return url.replace(/\/t\/p\/(w300|w500|w780|w1280)\//, '/t/p/original/')
  }

  const streamId = show.imdbId || state.sourceAddonItemId || id || ''
  const streamTmdbId = show.tmdbId ? Number(show.tmdbId) : (id?.startsWith('tmdb-') ? Number(id.replace('tmdb-', '')) : undefined)
  const showIds = [show.id, show.imdbId, String(show.tmdbId || '')].filter(Boolean)
  const resumeProgress = [...watchedProgress.values()]
    .filter((progress) => !progress.completed && progress.season != null && progress.episode != null)
    .filter((progress) => showIds.includes(progress.mediaId) || showIds.some((showId) => progress.id === `${showId}:${progress.season}:${progress.episode}`))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0]
  const defaultEpisode = resumeProgress
    ? { season: resumeProgress.season!, episode: resumeProgress.episode! }
    : seasonData?.episodes[0]
      ? { season: seasonData.episodes[0].seasonNumber, episode: seasonData.episodes[0].episodeNumber }
      : null
  const allEpisodes = Object.values(seasonCache).flatMap((season) => season.episodes)
  const allEpisodesWatched = allEpisodes.length > 0
    && show.seasons.every((season) => seasonCache[season.seasonNumber] !== undefined)
    && allEpisodes.every((episode) => watchedEpisodes.has(`${episode.seasonNumber}:${episode.episodeNumber}`))

  return (
    <div className="pb-12">
      <DetailHero
        title={show.title}
        year={show.year}
        overview={show.overview}
        rating={malRating ?? show.rating}
        genres={show.genres}
        certification={show.certification}
        poster={show.poster}
        backdrop={show.backdrop}
        logo={show.logo}
        imdbId={show.imdbId}
        type="series"
        status={show.status}
        numberOfSeasons={show.numberOfSeasons}
        cast={show.cast}
        crew={show.crew}
        ratingsStrip={
          <div className="flex flex-col gap-3">
            <RatingsStrip
              mediaType="series"
              imdbId={show.imdbId}
              tmdbId={show.tmdbId}
              tvdbId={show.tvdbId}
              className="mb-4"
            />
            {metadataStatus === 'fallback' && (
              <div className="inline-flex items-center self-start px-2.5 py-1 bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold rounded-lg uppercase tracking-wider mb-2">
                Addon metadata fallback
              </div>
            )}
            {isAnime && suspiciousStructure && (
              <div className="inline-flex items-center self-start px-2.5 py-1 bg-orange-500/15 border border-orange-500/30 text-orange-400 text-xs font-bold rounded-lg mb-2">
                Anime season structure looks suspicious. Manual mapping may be required.
              </div>
            )}
          </div>
        }
        actions={
          <div className="flex items-center gap-3 flex-wrap">
            {defaultEpisode && (
              <Button
                variant="white"
                size="xl"
                icon={
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                }
                onClick={() => handlePlayEpisode(defaultEpisode.season, defaultEpisode.episode)}
              >
                {allEpisodesWatched
                  ? 'Rewatch'
                  : resumeProgress
                    ? `Resume S${resumeProgress.season} E${resumeProgress.episode}`
                    : 'Play'}
              </Button>
            )}
            <WatchlistButton
              mediaRef={{
                localId: show.id,
                title: show.title,
                year: show.year,
                type: 'show',
                imdbId: show.imdbId,
                tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
              }}
              mediaType="series"
              anilistId={show.anilistId}
              malId={show.malId}
              tvdbId={show.tvdbId}
              className="!h-13 !min-w-13"
            />
            <MarkWatchedButton
              mediaRef={{
                localId: show.id,
                title: show.title,
                year: show.year,
                type: 'show',
                imdbId: show.imdbId,
                tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
              }}
              mediaType="series"
              imdbId={show.imdbId}
              anilistId={show.anilistId}
              malId={show.malId}
              episodes={allEpisodes.map((episode) => ({ season: episode.seasonNumber, episode: episode.episodeNumber }))}
              watched={allEpisodesWatched}
              onMarked={() => {
                setWatchedEpisodes(new Set(allEpisodes.map((episode) => `${episode.seasonNumber}:${episode.episodeNumber}`)))
                allEpisodes.forEach((episode) => setWatchProgress(`${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`, {
                  id: `${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`,
                  mediaType: 'series',
                  mediaId: show.id,
                  season: episode.seasonNumber,
                  episode: episode.episodeNumber,
                  progressSeconds: episode.runtime ? episode.runtime * 60 : 1,
                  durationSeconds: episode.runtime ? episode.runtime * 60 : 1,
                  completed: true,
                  title: show.title,
                  poster: show.poster,
                  backdrop: episode.still || show.backdrop,
                  imdbId: show.imdbId,
                  tmdbId: show.tmdbId,
                  updatedAt: new Date().toISOString(),
                }))
              }}
              onUnmarked={() => {
                setWatchedEpisodes(new Set())
                removeWatchProgress([show.id, show.imdbId || '', String(show.tmdbId || ''), show.tmdbId ? `tmdb-${show.tmdbId}` : ''])
              }}
            />
            {isAnime && (
              <button
                className="px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/[0.08] text-white/50 hover:text-white rounded-xl text-[11px] font-semibold transition-all"
                onClick={() => {
                  const allSeasonEps = Object.values(seasonCache)
                  const seasonsWithEps = allSeasonEps.map((sd) => ({
                    id: `debug_s${sd.seasonNumber}`,
                    seasonNumber: sd.seasonNumber,
                    title: sd.name,
                    episodeCount: sd.episodes.length,
                    episodes: sd.episodes.map((e) => ({
                      id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber,
                      absoluteEpisodeNumber: (e as any).absoluteEpisodeNumber, title: e.name || '',
                      airDate: e.airDate, debugSource: (e as any).debugSource,
                    })),
                  }))
                  debugAnimeMapping({
                    localMediaId: show.id, title: show.title, originalTitle: show.originalTitle,
                    year: show.year,
                    anilistId: show.anilistId ? Number(show.anilistId) : undefined,
                    malId: show.malId ? Number(show.malId) : undefined,
                    tvdbId: show.tvdbId ? Number(String(show.tvdbId).replace('tvdb-', '')) : undefined,
                    tmdbId: show.tmdbId ? Number(String(show.tmdbId).replace('tmdb-', '')) : undefined,
                    imdbId: show.imdbId,
                    matchedTvdbSeriesName: show.title,
                    seasons: seasonsWithEps as any,
                  })
                  console.log('[ANIME DEBUG] Open browser DevTools → Console to see debug output')
                }}
              >
                Debug Anime Mapping
              </button>
            )}
          </div>
        }
      />

      <DetailContentShell
        title={show.title}
        logo={show.logo}
        imdbId={show.imdbId}
        backdrop={show.backdrop}
      >
      <div className="px-8 relative z-10">
        <div className="relative mb-7 px-12">
          <button
            type="button"
            onClick={() => scrollSeasons('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/55 border border-white/15 text-white/70 hover:text-white hover:bg-black/80 flex items-center justify-center"
            aria-label="Previous seasons"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <div
            ref={seasonScrollRef}
            onWheel={handleSeasonWheel}
            className="season-scroll flex items-center justify-start gap-3 overflow-x-auto pb-4"
          >
            {show.seasons.map((season) => (
              <button
                key={season.seasonNumber}
                data-season={season.seasonNumber}
                onClick={() => selectSeason(season.seasonNumber)}
                className={[
                  'flex-shrink-0 px-6 py-3 rounded-xl text-base font-semibold transition-all duration-300 cursor-pointer focus-ring',
                  selectedSeason === season.seasonNumber
                    ? 'bg-white/15 text-white border border-white/25'
                    : 'text-white/55 hover:text-white hover:bg-white/[0.08] border border-transparent',
                ].join(' ')}
              >
                {season.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => scrollSeasons('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/55 border border-white/15 text-white/70 hover:text-white hover:bg-black/80 flex items-center justify-center"
            aria-label="Next seasons"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>

        {seasonData && (
          <div
            ref={episodeScrollRef}
            onWheel={handleEpisodeWheel}
            className="episode-scroll flex items-stretch gap-7 overflow-x-auto pb-6"
          >
            {(() => {
              const nextUnwatchedEpisode = keepNextEpisodeVisible
                ? seasonData.episodes.find((ep) => !watchedEpisodes.has(`${ep.seasonNumber}:${ep.episodeNumber}`))
                : null;
              return seasonData.episodes.map((ep) => {
                const isWatched = watchedEpisodes.has(`${ep.seasonNumber}:${ep.episodeNumber}`);
                const episodeProgress = getEpisodeProgress(ep.seasonNumber, ep.episodeNumber)
                const progressPercent = episodeProgress && episodeProgress.durationSeconds > 0
                  ? Math.min(100, (episodeProgress.progressSeconds / episodeProgress.durationSeconds) * 100)
                  : 0
                const isNextEpisode = nextUnwatchedEpisode && nextUnwatchedEpisode.id === ep.id;
                const shouldBlur = blurSpoilers && !isWatched && !episodeProgress && (!keepNextEpisodeVisible || !isNextEpisode);
                const blurThumb = shouldBlur && blurThumbnails;
                const blurTitle = shouldBlur && blurTitles;
                const blurDesc = shouldBlur && blurDescriptions;
                return (
                  <button
                    key={ep.id}
                    onClick={() => handlePlayEpisode(ep.seasonNumber, ep.episodeNumber)}
                    className="episode-showcase-card flex-shrink-0 text-left group flex flex-col"
                  >
                    <div className="relative aspect-video rounded-2xl overflow-hidden bg-surface-elevated shadow-xl mb-3 ring-1 ring-white/10 group-hover:ring-accent/50 transition-all">
                      {ep.still ? (
                        <img
                          src={highQualityEpisodeStill(ep.still)}
                          alt=""
                          className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${
                            blurThumb ? 'blur-lg group-hover:blur-none' : ''
                          }`}
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-surface-elevated to-surface flex items-center justify-center">
                          <span className="text-5xl font-bold text-white/10">{ep.episodeNumber}</span>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent opacity-80" />
                      <div className="absolute top-3 left-3 w-9 h-9 rounded-full bg-white/90 text-black flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                      {ep.runtime && (
                        <div className="absolute bottom-3 right-3 text-xs font-semibold text-white/90">{ep.runtime}m</div>
                      )}
                      {isWatched && (
                        <div className="absolute top-3 right-3 w-7 h-7 rounded-full bg-accent flex items-center justify-center shadow-lg z-10">
                          <svg className="w-4 h-4 text-black" fill="none" stroke="currentColor" strokeWidth="2.8" viewBox="0 0 24 24">
                            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      )}
                      {!isWatched && episodeProgress && progressPercent > 0 && (
                        <>
                          <div className="absolute bottom-0 inset-x-0 h-1.5 bg-black/55 z-10">
                            <div className="h-full bg-accent" style={{ width: `${progressPercent}%` }} />
                          </div>
                          <div className="absolute top-3 right-3 rounded-full bg-black/75 border border-white/10 px-2.5 py-1 text-[11px] font-bold text-white z-10">
                            Resume {Math.round(progressPercent)}%
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex-1 flex flex-col">
                      <p className="text-sm text-white/60">Episode {ep.episodeNumber}</p>
                      <h3 className={`text-lg font-bold text-white truncate group-hover:text-accent transition-colors ${
                        blurTitle ? 'blur-sm group-hover:blur-none select-none group-hover:select-text' : ''
                      }`}>
                        {ep.name}
                      </h3>
                      {ep.overview && (
                        <p className={`text-sm text-white/65 line-clamp-2 mt-1 ${
                          blurDesc ? 'blur-sm group-hover:blur-none select-none group-hover:select-text' : ''
                        }`}>
                          {ep.overview}
                        </p>
                      )}
                      <RatingsStrip
                        mediaType="series"
                        imdbId={ep.imdbId || show.imdbId}
                        tmdbId={show.tmdbId ?? ep.tmdbId}
                        tvdbId={show.tvdbId ?? ep.tvdbId}
                        season={ep.seasonNumber}
                        episode={ep.episodeNumber}
                        episodeRating={ep.imdbRating}
                        tmdbRating={ep.rating}
                        compact
                        className="mt-2"
                      />
                      {ep.airDate && <p className="text-sm text-white/45 mt-2">{formatEpisodeAirDate(ep.airDate)}</p>}
                      <div className="mt-auto pt-3 pb-1 min-h-8 overflow-visible relative z-20" onClick={(e) => e.stopPropagation()}>
                          <MarkWatchedButton
                            mediaRef={{
                              localId: show.id,
                              title: show.title,
                              year: show.year,
                              type: 'show',
                              imdbId: show.imdbId,
                              tmdbId: show.tmdbId ? Number(show.tmdbId) : undefined,
                            }}
                            mediaType="series"
                            episode={{ season: ep.seasonNumber, episode: ep.episodeNumber }}
                            imdbId={show.imdbId}
                            anilistId={show.anilistId}
                            malId={show.malId}
                            compact
                            watched={isWatched}
                            onMarked={() => {
                              setWatchedEpisodes((prev) => new Set([...prev, `${ep.seasonNumber}:${ep.episodeNumber}`]))
                              setWatchProgress(`${show.id}:${ep.seasonNumber}:${ep.episodeNumber}`, {
                                id: `${show.id}:${ep.seasonNumber}:${ep.episodeNumber}`,
                                mediaType: 'series',
                                mediaId: show.id,
                                season: ep.seasonNumber,
                                episode: ep.episodeNumber,
                                progressSeconds: ep.runtime ? ep.runtime * 60 : 1,
                                durationSeconds: ep.runtime ? ep.runtime * 60 : 1,
                                completed: true,
                                title: show.title,
                                poster: show.poster,
                                backdrop: ep.still || show.backdrop,
                                imdbId: show.imdbId,
                                tmdbId: show.tmdbId,
                                updatedAt: new Date().toISOString(),
                              })
                            }}
                            onUnmarked={() => setWatchedEpisodes((prev) => {
                              const next = new Set(prev)
                              next.delete(`${ep.seasonNumber}:${ep.episodeNumber}`)
                              removeWatchProgress(
                                [show.id, show.imdbId || '', String(show.tmdbId || ''), show.tmdbId ? `tmdb-${show.tmdbId}` : ''],
                                ep.seasonNumber,
                                ep.episodeNumber,
                              )
                              return next
                            })}
                          />
                      </div>
                    </div>
                  </button>
                );
              });
            })()}
          </div>
        )}
        {!seasonData && show && (
          <div className="flex gap-6 overflow-x-hidden pb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="episode-showcase-card flex-shrink-0 flex flex-col gap-3 animate-pulse">
                <div className="aspect-video rounded-2xl bg-white/[0.06]" />
                <div className="h-4 w-16 bg-white/[0.04] rounded-md" />
                <div className="h-5 w-48 bg-white/[0.06] rounded-md" />
                <div className="h-4 w-full bg-white/[0.04] rounded-md" />
              </div>
            ))}
          </div>
        )}
      </div>

      <StreamSelector
        open={streamOpen}
        onClose={() => { setStreamOpen(false); setStreamEpisode(null) }}
        mediaType="series"
        mediaId={streamId}
        title={show.title}
        artwork={{ poster: show.poster, backdrop: show.backdrop }}
        seasonEpisode={streamEpisode || undefined}
        startTime={streamEpisode ? getEpisodeProgress(streamEpisode.season, streamEpisode.episode)?.progressSeconds : undefined}
        tmdbId={Number.isFinite(streamTmdbId) ? streamTmdbId : undefined}
        malId={show.malId != null ? Number(show.malId) : state.malId != null ? Number(state.malId) : undefined}
        anilistId={show.anilistId != null ? Number(show.anilistId) : state.anilistId != null ? Number(state.anilistId) : undefined}
        sourceAddonId={state.sourceAddonId}
        sourceAddonItemId={state.sourceAddonItemId}
      />

      {show.trailers.length > 0 && <TrailerRow title="Videos & Trailers" videos={show.trailers} />}
      {show.cast.length > 0 && <CastRow cast={show.cast} crew={show.crew} />}

      {show.recommendations.length > 0 ? (
        <MediaRow title="More Like This" items={show.recommendations} layout="poster" disableArtOverride={false} />
      ) : (
        <MediaRow title="You May Also Like" items={fallbackRecommendations.filter((s) => s.id !== show.id)} layout="poster" disableArtOverride={false} />
      )}
      </DetailContentShell>
    </div>
  )
}
