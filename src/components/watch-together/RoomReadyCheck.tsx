import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Button from '../ui/Button'

export default function RoomReadyCheck() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const isHost = useWatchTogetherStore((s) => s.isHost)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)

  if (!currentRoom || !currentRoom.selectedMedia) return null
  if (currentRoom.playback.status === 'playing' || currentRoom.playback.status === 'paused') return null

  const participants = currentRoom.participants
  const readyCount = participants.filter((p) => p.isReady).length
  const totalCount = participants.length
  const allReady = readyCount === totalCount
  const me = participants.find((p) => p.id === currentUserId)
  const myReady = me?.isReady ?? false

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Ready Check</h3>
        <span className={[
          'text-xs font-semibold px-2 py-0.5 rounded-md',
          allReady ? 'bg-success/15 text-success' : 'bg-white/[0.06] text-white/50',
        ].join(' ')}>
          {readyCount}/{totalCount}
        </span>
      </div>

      {/* Participant ready list */}
      <div className="flex flex-col gap-1">
        {participants.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between px-3 py-1.5 rounded-lg"
          >
            <span className="text-xs text-white/60 truncate">
              {p.name}
              {p.id === currentUserId && <span className="text-white/25"> (you)</span>}
            </span>
            <div className="flex items-center gap-1.5">
              {p.isReady ? (
                <svg className="w-4 h-4 text-success" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-white/20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {isHost ? (
          <>
            <Button
              variant="primary"
              size="sm"
              fullWidth
              disabled={!allReady && totalCount > 1}
              onClick={() => wsClient.play(0)}
              icon={
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              }
            >
              Start Playback
            </Button>
            {!allReady && totalCount > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => wsClient.play(0)}
                className="flex-shrink-0 text-white/40"
              >
                Force Start
              </Button>
            )}
          </>
        ) : (
          <Button
            variant={myReady ? 'ghost' : 'success'}
            size="sm"
            fullWidth
            onClick={() => wsClient.setReady(!myReady)}
            icon={
              myReady ? (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )
            }
          >
            {myReady ? 'Unready' : 'Ready Up'}
          </Button>
        )}
      </div>
    </div>
  )
}
