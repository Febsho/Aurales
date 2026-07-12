import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import type { PlaybackItem } from '../../services/simkl/playback'
import { getPlayableStreamUrl } from '../../services/streams/playableUrl'
import NativeMpvPlayer from '../NativeMpvPlayer'

// Lazy: keeps the heavy player stack out of the startup bundle — it only loads
// once a watch-together playback actually starts.
const InAppPlayer = lazy(() => import('../InAppPlayer'))

const ACTIVE_STATUSES = new Set(['playing', 'paused', 'buffering', 'waiting_for_ready'])

export default function WatchTogetherAutoPlayer() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const selectedLocalStream = useWatchTogetherStore((s) => s.selectedLocalStream)
  const [active, setActive] = useState(false)
  // Set when the user closes the player while the room is still playing, so a
  // pause/resume status change doesn't instantly remount it in their face.
  const dismissedRef = useRef(false)
  // Freeze the start time at activation — playback.currentTime updates on every
  // sync event and must not feed a live prop into the player.
  const startTimeRef = useRef(0)

  const media = currentRoom?.selectedMedia
  const episode = currentRoom?.selectedEpisode
  const playback = currentRoom?.playback
  const mediaKey = media
    ? `${media.localMediaId}:${episode?.seasonNumber ?? ''}:${episode?.episodeNumber ?? ''}`
    : ''

  // New media/episode clears a previous dismissal.
  useEffect(() => {
    dismissedRef.current = false
  }, [mediaKey])

  useEffect(() => {
    const status = playback?.status
    if (!status || status === 'idle' || status === 'stopped' || status === 'ended' || status === 'selecting') {
      dismissedRef.current = false
      setActive(false)
      return
    }
    if (!media || !selectedLocalStream) return
    if (dismissedRef.current) return

    if (ACTIVE_STATUSES.has(status)) {
      setActive((prev) => {
        if (!prev) {
          const pb = playback!
          const elapsed = pb.isPlaying && Number.isFinite(pb.lastUpdatedAt)
            ? Math.max(0, (Date.now() - pb.lastUpdatedAt) / 1000)
            : 0
          startTimeRef.current = Math.max(0, (pb.currentTime ?? 0) + elapsed)
        }
        return true
      })
    }
  }, [media, selectedLocalStream, playback?.status])

  useEffect(() => {
    if (!currentRoom) {
      dismissedRef.current = false
      setActive(false)
    }
  }, [currentRoom])

  // Stable identity: room state updates arrive every few seconds and would
  // otherwise hand the player a brand-new playbackItem prop each time.
  const playbackItem = useMemo<PlaybackItem | null>(() => {
    if (!media) return null
    const simklType: 'movie' | 'show' | 'anime' = media.anilistId ? 'anime' : media.type === 'movie' ? 'movie' : 'show'
    return {
      localId: media.localMediaId,
      title: media.title,
      type: simklType,
      mediaType: simklType,
      contentType: media.type === 'movie' ? 'movie' : 'series',
      isAnime: Boolean(media.anilistId),
      imdbId: media.imdbId,
      tmdbId: media.tmdbId,
      season: episode?.seasonNumber,
      episode: episode?.episodeNumber,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey, media?.localMediaId])

  if (!active || !media || !selectedLocalStream || !playbackItem) return null

  const stream = selectedLocalStream.stream
  const url = getPlayableStreamUrl(stream)
  if (!url) return null

  const isTauri = !!(window as any).__TAURI_INTERNALS__
  const PlayerComponent = isTauri ? NativeMpvPlayer : InAppPlayer

  const subtitle = episode
    ? `S${episode.seasonNumber}E${episode.episodeNumber} - ${episode.title}`
    : undefined

  const handleClose = () => {
    const wt = useWatchTogetherStore.getState()
    dismissedRef.current = true
    setActive(false)
    // The host leaving playback stops the room; a guest just steps out.
    if (wt.isHost) wsClient.stop()
  }

  return createPortal(
    <Suspense fallback={null}>
      <PlayerComponent
        url={url}
        title={media.title}
        subtitle={subtitle}
        subtitles={[]}
        playbackItem={playbackItem}
        startTime={startTimeRef.current}
        poster={media.poster}
        backdrop={media.backdrop}
        onClose={handleClose}
        onPickAnother={handleClose}
      />
    </Suspense>,
    document.body,
  )
}
