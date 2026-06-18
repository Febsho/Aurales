import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Button from '../ui/Button'

export default function RoomMediaPreview() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const isHost = useWatchTogetherStore((s) => s.isHost)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)
  const selectedLocalStream = useWatchTogetherStore((s) => s.selectedLocalStream)

  if (!currentRoom) return null

  const media = currentRoom.selectedMedia
  const episode = currentRoom.selectedEpisode
  const me = currentRoom.participants.find((p) => p.id === currentUserId)

  if (!media) {
    return (
      <div className="flex flex-col items-center py-6 px-4 rounded-xl bg-white/[0.02] border border-dashed border-white/[0.06] text-center">
        <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
          <svg className="w-5 h-5 text-white/20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
            <line x1="7" y1="2" x2="7" y2="22" />
            <line x1="17" y1="2" x2="17" y2="22" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <line x1="2" y1="7" x2="7" y2="7" />
            <line x1="2" y1="17" x2="7" y2="17" />
            <line x1="17" y1="7" x2="22" y2="7" />
            <line x1="17" y1="17" x2="22" y2="17" />
          </svg>
        </div>
        <p className="text-xs text-white/30 leading-relaxed">
          {isHost
            ? 'Browse and pick something to watch. It will appear here for everyone.'
            : 'Waiting for host to select something to watch...'}
        </p>
      </div>
    )
  }

  const thumb = episode?.still || media.backdrop || media.poster

  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Now Watching</h3>
      <div className="rounded-xl overflow-hidden bg-white/[0.04] border border-white/[0.06]">
        {/* Thumbnail */}
        {thumb && (
          <div className="relative aspect-video bg-black/40">
            <img
              src={thumb}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
          </div>
        )}

        {/* Info */}
        <div className="px-3 py-2.5">
          <div className="flex items-start gap-2">
            {/* Poster (small) — only if we showed a still/backdrop above */}
            {media.poster && thumb !== media.poster && (
              <img
                src={media.poster}
                alt=""
                className="w-8 h-12 rounded-md object-cover flex-shrink-0"
                loading="lazy"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-white truncate">{media.title}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {media.year && <span className="text-[11px] text-white/40">{media.year}</span>}
                <span className="text-[11px] text-white/20 capitalize">{media.type}</span>
              </div>
              {episode && (
                <p className="text-[11px] text-white/50 mt-1 truncate">
                  S{String(episode.seasonNumber).padStart(2, '0')}E{String(episode.episodeNumber).padStart(2, '0')} - {episode.title}
                </p>
              )}
            </div>
          </div>

          {/* Stream selection for guests */}
          {!isHost && (
            <div className="flex items-center gap-2 mt-3">
              {selectedLocalStream ? (
                <div className="flex items-center gap-2 flex-1">
                  <svg className="w-3.5 h-3.5 text-success flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-xs text-white/50 truncate">Stream selected</span>
                </div>
              ) : (
                <span className="text-xs text-warning/80">Choose a stream to continue</span>
              )}
              {!me?.isReady && (
                <Button
                  variant="success"
                  size="sm"
                  onClick={() => wsClient.setReady(true)}
                  icon={
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  }
                >
                  Ready
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
