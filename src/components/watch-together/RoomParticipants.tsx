import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Badge from '../ui/Badge'
import type { ParticipantStatus } from '../../services/watch-together/types'
import WatchTogetherAvatar from './WatchTogetherAvatar'

const statusDotColor: Record<ParticipantStatus, string> = {
  connected: 'bg-success',
  watching: 'bg-success',
  buffering: 'bg-warning animate-pulse',
  choosing_stream: 'bg-warning',
  disconnected: 'bg-danger',
}

const statusLabel: Record<ParticipantStatus, string> = {
  connected: 'Connected',
  watching: 'Watching',
  buffering: 'Buffering',
  choosing_stream: 'Choosing...',
  disconnected: 'Disconnected',
}

export default function RoomParticipants() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const isHost = useWatchTogetherStore((s) => s.isHost)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)

  if (!currentRoom) return null

  const participants = currentRoom.participants

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wider">
          Participants ({participants.length})
        </h3>
      </div>

      <div className="flex flex-col gap-1">
        {participants.map((p) => (
          <div
            key={p.id}
            className={[
              'flex items-center gap-3 px-3 py-2 rounded-xl transition-colors duration-150',
              p.id === currentUserId ? 'bg-accent/5 border border-accent/10' : 'watch-together-surface--subtle',
            ].join(' ')}
          >
            {/* Avatar / initial */}
            <div className="watch-together-avatar h-7 w-7 shrink-0 overflow-hidden rounded-lg text-xs font-bold text-white/60">
              <WatchTogetherAvatar participant={p} name={p.name} isCurrentUser={p.id === currentUserId} />
            </div>

            {/* Name + status */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-white truncate">
                  {p.name}
                  {p.id === currentUserId && (
                    <span className="text-white/50 font-normal"> (you)</span>
                  )}
                </span>
                {p.isHost && (
                  <Badge variant="warning" size="sm">
                    <svg className="w-2.5 h-2.5 mr-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z" />
                    </svg>
                    Host
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDotColor[p.status]}`} />
                <span className="text-meta text-white/50">{statusLabel[p.status]}</span>
                {p.isReady && (
                  <svg className="w-3 h-3 text-success ml-0.5" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {p.hasSelectedStream && (
                  <svg className="w-3 h-3 text-info ml-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                )}
              </div>
            </div>

            {/* Host actions */}
            {isHost && p.id !== currentUserId && (
              <button
                onClick={() => wsClient.transferHost(p.id)}
                className="watch-together-control p-1.5 rounded-lg text-white/20 hover:text-white/60 transition-all duration-200 cursor-pointer"
                title="Transfer host to this user"
              >
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
