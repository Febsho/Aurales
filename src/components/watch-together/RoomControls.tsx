import { useState } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Button from '../ui/Button'
import Toggle from '../ui/Toggle'

export default function RoomControls() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const isHost = useWatchTogetherStore((s) => s.isHost)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)
  const selectedLocalStream = useWatchTogetherStore((s) => s.selectedLocalStream)
  const [transferOpen, setTransferOpen] = useState(false)
  const [resolving, setResolving] = useState(false)

  if (!currentRoom || !currentRoom.selectedMedia) return null

  const canControl = isHost || currentRoom.everyoneCanControl
  if (!canControl) return null

  const playback = currentRoom.playback
  const isPlaying = playback.isPlaying

  const handlePlayPause = async () => {
    const time = wsClient.getBestKnownTime()
    if (isPlaying) {
      wsClient.pause(time)
    } else {
      if (!selectedLocalStream) {
        setResolving(true)
        const found = await wsClient.autoResolveStream()
        setResolving(false)
        if (!found) return
      }
      wsClient.play(time)
    }
  }

  const handleStop = () => {
    wsClient.stop()
  }

  const handleTransferHost = (newHostUserId: string) => {
    wsClient.transferHost(newHostUserId)
    setTransferOpen(false)
  }

  const otherParticipants = currentRoom.participants.filter((p) => p.id !== currentUserId)

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
        {isHost ? 'Host Controls' : 'Playback Controls'}
      </h3>

      {/* Playback buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="glass"
          size="sm"
          onClick={handlePlayPause}
          disabled={resolving}
          className="flex-1"
          icon={
            resolving ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : isPlaying ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )
          }
        >
          {resolving ? 'Finding...' : isPlaying ? 'Pause' : 'Play'}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleStop}
          icon={
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          }
        >
          Stop
        </Button>
      </div>

      {/* Host-only options */}
      {isHost && (
        <>
          {/* Transfer host */}
          {otherParticipants.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setTransferOpen(!transferOpen)}
                className={[
                  'w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs',
                  'bg-white/[0.04] hover:bg-white/[0.06] border border-white/[0.06]',
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
                <div className="mt-1 rounded-xl bg-surface-elevated/95 backdrop-blur-xl border border-white/[0.08] overflow-hidden animate-[fadeIn_150ms_ease-out]">
                  {otherParticipants.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleTransferHost(p.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors duration-150 cursor-pointer"
                    >
                      <div className="w-5 h-5 rounded-md bg-white/[0.08] flex items-center justify-center text-[10px] font-bold text-white/50">
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
        </>
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
