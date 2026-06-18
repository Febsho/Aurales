import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Button from '../ui/Button'

interface StartInRoomButtonProps {
  media: {
    id: string
    type: 'movie' | 'series'
    title: string
    year?: number
    poster?: string
    backdrop?: string
    overview?: string
    imdbId?: string
    tmdbId?: number
    tvdbId?: number
    anilistId?: number
  }
  episode?: {
    id: string
    seasonNumber: number
    episodeNumber: number
    absoluteEpisodeNumber?: number
    title: string
    overview?: string
    still?: string
  }
  className?: string
}

export default function StartInRoomButton({ media, episode, className = '' }: StartInRoomButtonProps) {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const isHost = useWatchTogetherStore((s) => s.isHost)

  const handleSelect = () => {
    if (!currentRoom || !isHost) return

    const roomMedia = {
      localMediaId: media.id,
      type: media.type === 'series' ? ('show' as const) : ('movie' as const),
      title: media.title,
      year: media.year,
      poster: media.poster,
      backdrop: media.backdrop,
      overview: media.overview,
      imdbId: media.imdbId,
      tmdbId: media.tmdbId,
      tvdbId: media.tvdbId,
      anilistId: media.anilistId,
    }

    const roomEpisode = episode
      ? {
          localEpisodeId: episode.id,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          absoluteEpisodeNumber: episode.absoluteEpisodeNumber,
          title: episode.title,
          overview: episode.overview,
          still: episode.still,
        }
      : undefined

    wsClient.selectMedia(roomMedia, roomEpisode)
  }

  // No room — disabled state
  if (!currentRoom) {
    return (
      <Button
        variant="glass"
        size="sm"
        disabled
        className={className}
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        }
      >
        Create Room First
      </Button>
    )
  }

  // Guest — disabled with tooltip info
  if (!isHost) {
    return (
      <Button
        variant="glass"
        size="sm"
        disabled
        className={className}
        title="Only the host can select media"
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        }
      >
        Host Only
      </Button>
    )
  }

  // Host — active button
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleSelect}
      className={className}
      icon={
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
          <line x1="2" y1="20" x2="2.01" y2="20" />
        </svg>
      }
    >
      Watch in Room
    </Button>
  )
}
