import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import type { PlaybackItem } from '../../services/simkl/playback'
import { getPlayableStreamUrl } from '../../services/streams/playableUrl'
import { recordReliabilityEvent, streamFingerprint } from '../../services/streams/reliabilityHistory'
import { estimateRoomPosition, serverTimestampToLocal } from '../../services/watch-together/clockSync'
import { createRoomStream } from '../../services/watch-together/streamMatcher'
import { useNativePlayerSupported } from '../../hooks/useNativePlayerSupported'
import NativeMpvPlayer from '../NativeMpvPlayer'

// Lazy: keeps the heavy player stack out of the startup bundle — it only loads
// once a watch-together playback actually starts.
const InAppPlayer = lazy(() => import('../InAppPlayer'))

const ACTIVE_STATUSES = new Set(['playing', 'paused', 'buffering', 'waiting_for_ready'])

export default function WatchTogetherAutoPlayer() {
  const nativePlayerAvailable = useNativePlayerSupported()
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const selectedLocalStream = useWatchTogetherStore((s) => s.selectedLocalStream)
  const localSourceCandidates = useWatchTogetherStore((s) => s.localSourceCandidates)
  const activeSourceIndex = useWatchTogetherStore((s) => s.activeSourceIndex)
  const pendingSync = useWatchTogetherStore((s) => s.pendingSync)
  const serverClockOffsetMs = useWatchTogetherStore((s) => s.serverClockOffsetMs)
  const [active, setActive] = useState(false)
  // Set when the user closes the player while the room is still playing, so a
  // pause/resume status change doesn't instantly remount it in their face.
  const dismissedRef = useRef(false)
  // Freeze the start time at activation — playback.currentTime updates on every
  // sync event and must not feed a live prop into the player.
  const startTimeRef = useRef(0)
  const failedCandidateRef = useRef<string | null>(null)

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
          const anchorTime = pendingSync?.time ?? pb.currentTime ?? 0
          const anchorServerTime = pendingSync?.serverTime ?? pb.serverTime ?? pb.lastUpdatedAt
          startTimeRef.current = estimateRoomPosition(
            anchorTime,
            pendingSync?.isPlaying ?? pb.isPlaying,
            anchorServerTime,
            serverClockOffsetMs,
          )
          wsClient.sendLocalSourceStatus('starting')
        }
        return true
      })
    }
  }, [media, selectedLocalStream, playback, pendingSync, serverClockOffsetMs])

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

  if (!active || !media || !selectedLocalStream || !playbackItem || nativePlayerAvailable === undefined) return null

  const stream = selectedLocalStream.stream
  const activeCandidate = localSourceCandidates[activeSourceIndex]
  const url = activeCandidate?.playableUrl || getPlayableStreamUrl(stream)
  if (!url) return null

  const PlayerComponent = nativePlayerAvailable ? NativeMpvPlayer : InAppPlayer

  const subtitle = episode
    ? `S${episode.seasonNumber}E${episode.episodeNumber} - ${episode.title}`
    : undefined

  const handleClose = () => {
    const wt = useWatchTogetherStore.getState()
    dismissedRef.current = true
    setActive(false)
    // The host leaving playback stops the room; a guest just steps out.
    if (wt.isHost) wsClient.stop()
    else wsClient.sendLocalSourceStatus('ready')
  }

  const handlePlaybackStarted = () => {
    failedCandidateRef.current = null
    recordReliabilityEvent(stream, 'success')
    wsClient.sendLocalSourceStatus('playing')
    const sync = useWatchTogetherStore.getState().pendingSync
    if (sync) {
      const timing = useWatchTogetherStore.getState()
      window.dispatchEvent(new CustomEvent('wt:sync_request', {
        detail: {
          time: sync.time,
          isPlaying: sync.isPlaying,
          sentAt: serverTimestampToLocal(sync.serverTime, timing.serverClockOffsetMs),
          sequence: sync.sequence,
        },
      }))
    }
  }

  const handlePlaybackError = (message: string) => {
    const candidateKey = `${activeSourceIndex}:${streamFingerprint(stream)}`
    if (failedCandidateRef.current === candidateKey) return
    failedCandidateRef.current = candidateKey
    recordReliabilityEvent(stream, 'failed_start')
    const next = useWatchTogetherStore.getState().advanceLocalSource()
    if (next) {
      if (useWatchTogetherStore.getState().isHost) {
        wsClient.selectStream(createRoomStream({ ...next.stream, addonId: next.addonId }))
      }
      wsClient.sendLocalSourceStatus('starting')
      startTimeRef.current = wsClient.getBestKnownTime()
    } else {
      wsClient.sendLocalSourceStatus('failed', 'ALL_SOURCES_FAILED')
      console.warn('[WatchTogether] Local playback sources exhausted:', message)
    }
  }

  return createPortal(
    <Suspense fallback={null}>
      <PlayerComponent
        key={`${mediaKey}:${activeSourceIndex}:${url}`}
        url={url}
        title={media.title}
        subtitle={subtitle}
        subtitles={[]}
        playbackItem={playbackItem}
        startTime={startTimeRef.current}
        poster={media.poster}
        backdrop={media.backdrop}
        onClose={handleClose}
        onPickAnother={() => handlePlaybackError('User requested another source')}
        onPlaybackStarted={handlePlaybackStarted}
        onPlaybackError={handlePlaybackError}
      />
    </Suspense>,
    document.body,
  )
}
