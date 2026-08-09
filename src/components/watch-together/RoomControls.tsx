import { useState } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Toggle from '../ui/Toggle'

export default function RoomControls() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const isHost = useWatchTogetherStore((s) => s.isHost)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)
  const [transferOpen, setTransferOpen] = useState(false)

  if (!currentRoom || !currentRoom.selectedMedia || !isHost) return null

  const handleTransferHost = (newHostUserId: string) => {
    wsClient.transferHost(newHostUserId)
    setTransferOpen(false)
  }

  const otherParticipants = currentRoom.participants.filter((p) => p.id !== currentUserId)

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
        Room Settings
      </h3>

      {/* Transfer host */}
      {otherParticipants.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setTransferOpen(!transferOpen)}
                className={[
                  'w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs',
                  'watch-together-control border',
                  'text-white/60 hover:text-white transition-all duration-200 cursor-pointer',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z" />
                  </svg>
                  <span>Transfer Host</span>
                </div>
                <svg
                  className={[
                    'w-3.5 h-3.5 text-white/30 transition-transform duration-200',
                    transferOpen ? 'rotate-180' : '',
                  ].join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {transferOpen && (
                <div className="watch-together-popover mt-1 rounded-xl backdrop-blur-xl border overflow-hidden animate-[fadeIn_150ms_ease-out]">
                  {otherParticipants.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleTransferHost(p.id)}
                      className="watch-together-control w-full flex items-center gap-2.5 px-3 py-2 text-xs text-white/60 hover:text-white transition-colors duration-150 cursor-pointer"
                    >
                      <div className="watch-together-avatar w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold text-white/50">
                        {p.name.charAt(0).toUpperCase()}
                      </div>
                      <span>{p.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
      )}

      {/* Everyone can control toggle */}
      <Toggle
        checked={currentRoom.everyoneCanControl}
        onChange={(checked) => wsClient.setRoomSettings({ everyoneCanControl: checked })}
        label="Everyone can control"
        description="Let anyone play, pause, and seek"
        size="sm"
      />

      {/* Require ready check toggle */}
      <Toggle
        checked={currentRoom.requireReadyCheck}
        onChange={(checked) => wsClient.setRoomSettings({ requireReadyCheck: checked })}
        label="Require ready check"
        description="Wait for everyone before starting playback"
        size="sm"
      />

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
