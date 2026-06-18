import { useEffect, useRef } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Button from '../ui/Button'
import InviteLinkBox from './InviteLinkBox'
import RoomMediaPreview from './RoomMediaPreview'
import RoomParticipants from './RoomParticipants'
import RoomReadyCheck from './RoomReadyCheck'
import RoomControls from './RoomControls'
import RoomChat from './RoomChat'

interface WatchTogetherPanelProps {
  open: boolean
  onClose: () => void
}

export default function WatchTogetherPanel({ open, onClose }: WatchTogetherPanelProps) {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const connectionStatus = useWatchTogetherStore((s) => s.connectionStatus)
  const showChat = useWatchTogetherStore((s) => s.showChat)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  const handleLeaveRoom = () => {
    wsClient.leaveRoom()
    onClose()
  }

  return (
    <div
      ref={panelRef}
      className={[
        'fixed top-0 right-0 bottom-0 z-50 w-[380px] flex flex-col',
        'bg-black/80 backdrop-blur-2xl border-l border-white/[0.08]',
        'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
        open ? 'translate-x-0' : 'translate-x-full',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-white truncate">
              {currentRoom?.title || 'Watch Together'}
            </h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className={[
                  'w-1.5 h-1.5 rounded-full flex-shrink-0',
                  connectionStatus === 'connected'
                    ? 'bg-success'
                    : connectionStatus === 'connecting' || connectionStatus === 'reconnecting'
                      ? 'bg-warning animate-pulse'
                      : 'bg-white/30',
                ].join(' ')}
              />
              <span className="text-[11px] text-white/40 capitalize">{connectionStatus}</span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-all duration-200 cursor-pointer"
          aria-label="Close panel"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/10">
        {currentRoom ? (
          <div className="flex flex-col gap-0">
            {/* Invite link */}
            <div className="px-4 pt-4 pb-2">
              <InviteLinkBox />
            </div>

            {/* Media preview */}
            <div className="px-4 py-2">
              <RoomMediaPreview />
            </div>

            {/* Participants */}
            <div className="px-4 py-2">
              <RoomParticipants />
            </div>

            {/* Ready check */}
            <div className="px-4 py-2">
              <RoomReadyCheck />
            </div>

            {/* Host controls */}
            <div className="px-4 py-2">
              <RoomControls />
            </div>

            {/* Chat */}
            {showChat && (
              <div className="px-4 py-2 flex-1 min-h-0">
                <RoomChat />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full px-6 py-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-white/20" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <p className="text-sm text-white/40 leading-relaxed">
              No room active. Create or join a room to watch together with friends.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      {currentRoom && (
        <div className="px-4 py-3 border-t border-white/[0.06]">
          <Button
            variant="danger"
            size="sm"
            fullWidth
            onClick={handleLeaveRoom}
            icon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            }
          >
            Leave Room
          </Button>
        </div>
      )}

      <style>{`
        @keyframes panelSlideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
