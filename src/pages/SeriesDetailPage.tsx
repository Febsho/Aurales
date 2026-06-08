import { useState, useEffect } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import type { ShowDetails, SeasonDetails } from '../types'
import { MOCK_SHOW, MOCK_SEASON, MOCK_POPULAR_SHOWS } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { getAddonMeta, getMetaAddons } from '../services/addons'
import { useAppStore } from '../stores/appStore'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'
import StreamSelector from '../components/StreamSelector'

interface LocationState {
  poster?: string
  backdrop?: string
  title?: string
  year?: number
  rating?: number
  overview?: string
  imdbId?: string
  addonUrl?: string
  provider?: string
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
      id: `trailer-${i}`, name: t.title || `Trailer ${i + 1}`,
      key: t.source || '', site: t.type || 'YouTube', type: 'Trailer',
    })) : [],
    imdbId: (meta.imdb_id || meta.imdbId || (typeof meta.id === 'string' && (meta.id as string).startsWith('tt') ? meta.id : undefined)) as string | undefined,
  }
}

function addonVideosToSeason(meta: Record<string, unknown>, seasonNum: number): SeasonDetails {
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

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const state = (location.state || {}) as LocationState
  const [show, setShow] = useState<ShowDetails | null>(null)
  const [addonMeta, setAddonMeta] = useState<Record<string, unknown> | null>(null)
  const [selectedSeason, setSelectedSeason] = useState(1)
  const [seasonData, setSeasonData] = useState<SeasonDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [streamOpen, setStreamOpen] = useState(false)
  const [streamEpisode, setStreamEpisode] = useState<{ season: number; episode: number } | null>(null)
  const addons = useAppStore((s) => s.addons)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setAddonMeta(null)

      // Try TMDB
      if (id?.startsWith('tmdb-')) {
        try {
          const data = await tmdbProvider.getShow(id)
          setShow(data)
          if (data.seasons.length > 0) setSelectedSeason(data.seasons[0].seasonNumber)
          setLoading(false)
          return
        } catch { /* fall through */ }
      }

      // Try addon meta
      if (state.addonUrl || id?.startsWith('tt') || state.provider === 'addon') {
        const tryAddonMeta = async (addonUrl: string): Promise<boolean> => {
          try {
            const meta = await getAddonMeta(addonUrl, 'series', id || '')
            if (meta) {
              setAddonMeta(meta)
              const showData = addonMetaToShow(meta, id || '')
              setShow(showData)
              if (showData.seasons.length > 0) setSelectedSeason(showData.seasons[0].seasonNumber)
              return true
            }
          } catch { /* continue */ }
          return false
        }

        if (state.addonUrl && await tryAddonMeta(state.addonUrl)) {
          setLoading(false)
          return
        }

        const metaAddons = getMetaAddons('series')
        const storeAddons = addons.filter((a) => a.enabled)
        const allMeta = metaAddons.length > 0 ? metaAddons : storeAddons

        for (const addon of allMeta) {
          if (await tryAddonMeta(addon.url)) {
            setLoading(false)
            return
          }
        }
      }

      // Route state fallback
      if (state.title) {
        setShow({
          id: id || 'unknown',
          title: state.title,
          year: state.year,
          overview: state.overview,
          rating: state.rating,
          poster: state.poster,
          backdrop: state.backdrop,
          imdbId: state.imdbId,
          genres: [],
          seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 0 }],
          cast: [],
          crew: [],
          recommendations: [],
          trailers: [],
        })
        setSelectedSeason(1)
        setLoading(false)
        return
      }

      // Mock fallback
      setShow({ ...MOCK_SHOW, id: id || 'mock-show-1' })
      setLoading(false)
    }
    load()
  }, [id, state.addonUrl, state.provider, state.title, addons])

  useEffect(() => {
    async function loadSeason() {
      if (!show || !id) return

      // If we have addon meta with episodes, use that
      if (addonMeta && Array.isArray(addonMeta.videos)) {
        setSeasonData(addonVideosToSeason(addonMeta, selectedSeason))
        return
      }

      // TMDB seasons
      if (id.startsWith('tmdb-')) {
        try {
          const data = await tmdbProvider.getSeason(id, selectedSeason)
          setSeasonData(data)
          return
        } catch { /* fall through */ }
      }

      // Generate placeholder episodes from season info
      const seasonInfo = show.seasons.find(s => s.seasonNumber === selectedSeason)
      if (seasonInfo && seasonInfo.episodeCount > 0) {
        setSeasonData({
          seasonNumber: selectedSeason,
          name: seasonInfo.name,
          episodes: Array.from({ length: seasonInfo.episodeCount }, (_, i) => ({
            id: `${selectedSeason}-${i + 1}`,
            episodeNumber: i + 1,
            seasonNumber: selectedSeason,
            name: `Episode ${i + 1}`,
          })),
        })
        return
      }

      setSeasonData(MOCK_SEASON)
    }
    loadSeason()
  }, [show, id, selectedSeason, addonMeta])

  if (loading || !show) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const handlePlayEpisode = (seasonNum: number, episodeNum: number) => {
    setStreamEpisode({ season: seasonNum, episode: episodeNum })
    setStreamOpen(true)
  }

  const streamId = show.imdbId || id || ''

  return (
    <div className="pb-12">
      <div className="relative w-full h-[420px] overflow-hidden">
        {show.backdrop && (
          <img src={show.backdrop} alt="" className="absolute inset-0 w-full h-full object-cover" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-surface/80 via-transparent to-transparent" />

        <div className="absolute bottom-0 left-0 right-0 p-8">
          <div className="max-w-2xl">
            {show.logo ? (
              <img src={show.logo} alt={show.title} className="h-14 mb-4 drop-shadow-lg" />
            ) : (
              <h1 className="text-4xl font-bold mb-3">{show.title}</h1>
            )}

            <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
              {show.rating && (
                <span className="flex items-center gap-1 text-accent font-semibold">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {show.rating.toFixed(1)}
                </span>
              )}
              {show.voteCount && <span className="text-muted">{show.voteCount.toLocaleString()} votes</span>}
              {show.year && <span className="text-muted">{show.year}</span>}
              {show.genres.length > 0 && <span className="text-muted">{show.genres.join(' · ')}</span>}
              {show.certification && (
                <span className="px-1.5 py-0.5 border border-muted rounded text-xs text-muted">{show.certification}</span>
              )}
              {show.status && <span className="text-muted">{show.status}</span>}
              {show.numberOfSeasons && <span className="text-muted">{show.numberOfSeasons} Seasons</span>}
            </div>

            {show.overview && (
              <p className="text-sm text-gray-300 line-clamp-3 mb-4 leading-relaxed max-w-xl">{show.overview}</p>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 mt-6">
        <div className="flex items-center gap-2 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {show.seasons.map((season) => (
            <button
              key={season.seasonNumber}
              onClick={() => setSelectedSeason(season.seasonNumber)}
              className={`flex-shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                selectedSeason === season.seasonNumber
                  ? 'bg-accent text-black'
                  : 'bg-surface-elevated text-gray-300 hover:bg-surface-hover'
              }`}
            >
              {season.name}
            </button>
          ))}
        </div>

        {seasonData && (
          <div className="space-y-2 mb-8">
            {seasonData.episodes.map((ep) => (
              <button
                key={ep.id}
                onClick={() => handlePlayEpisode(ep.seasonNumber, ep.episodeNumber)}
                className="w-full flex items-start gap-4 p-3 bg-surface-elevated hover:bg-surface-hover rounded-xl transition-colors text-left group"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-surface flex items-center justify-center text-muted group-hover:text-accent transition-colors">
                  <span className="text-sm font-semibold">{ep.episodeNumber}</span>
                </div>

                {ep.still && (
                  <div className="flex-shrink-0 w-32 aspect-video rounded-lg overflow-hidden bg-surface">
                    <img src={ep.still} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-medium truncate">{ep.name}</h3>
                    {ep.runtime && <span className="text-xs text-muted flex-shrink-0">{ep.runtime}m</span>}
                  </div>
                  {ep.overview && (
                    <p className="text-xs text-muted line-clamp-2">{ep.overview}</p>
                  )}
                  {ep.airDate && (
                    <p className="text-xs text-muted mt-1">{ep.airDate}</p>
                  )}
                </div>

                <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg className="w-5 h-5 text-accent" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </button>
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
        seasonEpisode={streamEpisode || undefined}
      />

      {show.trailers.length > 0 && <TrailerRow title="Videos & Trailers" videos={show.trailers} />}
      {show.cast.length > 0 && <CastRow cast={show.cast} />}

      {show.recommendations.length > 0 ? (
        <MediaRow title="More Like This" items={show.recommendations} layout="poster" />
      ) : (
        <MediaRow title="You May Also Like" items={MOCK_POPULAR_SHOWS.filter((s) => s.id !== show.id)} layout="poster" />
      )}
    </div>
  )
}
