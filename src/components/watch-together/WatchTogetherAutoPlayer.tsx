import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import NativeMpvPlayer from '../NativeMpvPlayer'
import InAppPlayer from '../InAppPlayer'
import type { PlaybackItem } from '../../services/simkl/playback'
import { getPlayableStreamUrl } from '../../services/streams/playableUrl'

export default function WatchTogetherAutoPlayer() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const selectedLocalStream = useWatchTogetherStore((s) => s.selectedLocalStream)
  const [active, setActive] = useState(false)

  const media = currentRoom?.selectedMedia
  const episode = currentRoom?.selectedEpisode
  const playback = currentRoom?.playback

  useEffect(() => {
    if (!media || !selectedLocalStream) return
    if (!playback || playback.status === 'idle' || playback.status === 'stopped') return

    if (playback.status === 'playing' || playback.status === 'paused' || playback.status === 'waiting_for_ready') {
      setActive(true)
    }
  }, [media, selectedLocalStream, playback?.status])

  useEffect(() => {
    if (!currentRoom) setActive(false)
  }, [currentRoom])

  if (!active || !media || !selectedLocalStream) return null

  const stream = selectedLocalStream.stream
  const url = getPlayableStreamUrl(stream)
  if (!url) return null

  const mediaType = media.type === 'movie' ? 'movie' : 'series'
  const simklType: 'movie' | 'show' | 'anime' = media.anilistId ? 'anime' : media.type === 'movie' ? 'movie' : 'show'

  const playbackItem: PlaybackItem = {
    localId: media.localMediaId,
    title: media.title,
    type: simklType,
    mediaType: simklType,
    imdbId: media.imdbId,
    tmdbId: media.tmdbId,
    season: episode?.seasonNumber,
    episode: episode?.episodeNumber,
  }

  const startTime = playback?.currentTime ?? 0
  const isTauri = !!(window as any).__TAURI_INTERNALS__
  const PlayerComponent = isTauri ? NativeMpvPlayer : InAppPlayer

  const subtitle = episode
    ? `S${episode.seasonNumber}E${episode.episodeNumber} - ${episode.title}`
    : undefined

  return createPortal(
    <PlayerComponent
      url={url}
      title={media.title}
      subtitle={subtitle}
      subtitles={[]}
      playbackItem={playbackItem}
      startTime={startTime}
      poster={media.poster}
      backdrop={media.backdrop}
      onClose={() => setActive(false)}
      onPickAnother={() => setActive(false)}
    />,
    document.body,
  )
}
