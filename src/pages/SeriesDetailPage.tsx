import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import type { ShowDetails, SeasonDetails, StreamResult } from '../types'
import { MOCK_SHOW, MOCK_SEASON, MOCK_POPULAR_SHOWS } from '../data/mock'
import { tmdbProvider } from '../services/tmdb'
import { getInstalledAddons, getAddonStreams } from '../services/addons'
import { launchPlayer } from '../services/player'
import TrailerRow from '../components/TrailerRow'
import CastRow from '../components/CastRow'
import MediaRow from '../components/MediaRow'

export default function SeriesDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [show, setShow] = useState<ShowDetails | null>(null)
  const [selectedSeason, setSelectedSeason] = useState(1)
  const [seasonData, setSeasonData] = useState<SeasonDetails | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        if (id?.startsWith('tmdb-')) {
          const data = await tmdbProvider.getShow(id)
          setShow(data)
          if (data.seasons.length > 0) {
            setSelectedSeason(data.seasons[0].seasonNumber)
          }
        } else {
          setShow({ ...MOCK_SHOW, id: id || 'mock-show-1' })
        }
      } catch {
        setShow({ ...MOCK_SHOW, id: id || 'mock-show-1' })
      }
      setLoading(false)
    }
    load()
  }, [id])

  useEffect(() => {
    async function loadSeason() {
      if (!show || !id) return
      try {
        if (id.startsWith('tmdb-')) {
          const data = await tmdbProvider.getSeason(id, selectedSeason)
          setSeasonData(data)
        } else {
          setSeasonData(MOCK_SEASON)
        }
      } catch {
        setSeasonData(MOCK_SEASON)
      }
    }
    loadSeason()
  }, [show, id, selectedSeason])

  if (loading || !show) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const handlePlayEpisode = async (seasonNum: number, episodeNum: number) => {
    const addons = getInstalledAddons()
    for (const addon of addons) {
      if (addon.manifest.resources.includes('stream')) {
        try {
          const streams = await getAddonStreams(addon.url, 'series', `${id}:${seasonNum}:${episodeNum}`)
          if (streams.length > 0 && streams[0].url) {
            launchPlayer({
              url: streams[0].url,
              title: `${show.title} S${seasonNum}E${episodeNum}`,
            })
            return
          }
        } catch { /* skip */ }
      }
    }
    console.log(`Play S${seasonNum}E${episodeNum} — no stream found`)
  }

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

      <TrailerRow title="Videos & Trailers" videos={show.trailers} />
      <CastRow cast={show.cast} />

      {show.recommendations.length > 0 ? (
        <MediaRow title="More Like This" items={show.recommendations} layout="poster" />
      ) : (
        <MediaRow title="You May Also Like" items={MOCK_POPULAR_SHOWS.filter((s) => s.id !== show.id)} layout="poster" />
      )}
    </div>
  )
}
