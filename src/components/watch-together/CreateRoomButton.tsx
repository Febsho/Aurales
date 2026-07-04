import { useState } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Modal from '../ui/Modal'
import Input from '../ui/Input'
import Button from '../ui/Button'

export default function CreateRoomButton() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const connectionStatus = useWatchTogetherStore((s) => s.connectionStatus)
  const setRoomPanelOpen = useWatchTogetherStore((s) => s.setRoomPanelOpen)
  const serverUrl = useWatchTogetherStore((s) => s.serverUrl)
  const defaultNickname = useWatchTogetherStore((s) => s.defaultNickname)
  const setDefaultNickname = useWatchTogetherStore((s) => s.setDefaultNickname)
  const [showModal, setShowModal] = useState(false)
  const [nickname, setNickname] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleClick = () => {
    if (currentRoom) {
      setRoomPanelOpen(true)
      return
    }
    setNickname(defaultNickname)
    setError('')
    setShowModal(true)
  }

  const handleCreate = async () => {
    const trimmed = nickname.trim()
    if (!trimmed) {
      setError('Please enter a nickname')
      return
    }
    setLoading(true)
    setError('')
    try {
      if (connectionStatus === 'disconnected') {
        await wsClient.connect(serverUrl)
      }
      setDefaultNickname(trimmed)
      await wsClient.createRoom(trimmed)
      setShowModal(false)
      setRoomPanelOpen(true)
      // Honor the "Auto-copy invite link" setting from Watch Together settings.
      const wt = useWatchTogetherStore.getState()
      if (wt.autoCopyInvite && wt.currentRoom) {
        navigator.clipboard.writeText(`aurales://watch/${wt.currentRoom.code}`).catch(() => {})
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create room'
      if (msg.includes('timed out') || msg.includes('Failed to connect')) {
        setError(`Cannot reach server at ${serverUrl}. Make sure the Watch Together server is running.`)
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreate()
  }

  return (
    <>
      <button
        onClick={handleClick}
        className={[
          'flex items-center gap-3 rounded-xl transition-all duration-200 group cursor-pointer px-3 py-2.5 w-full',
          currentRoom
            ? 'bg-accent/10 text-accent hover:bg-accent/15'
            : 'text-white/50 hover:text-white hover:bg-white/[0.06]',
        ].join(' ')}
      >
        <div className="w-[18px] h-[18px] flex items-center justify-center flex-shrink-0">
          {currentRoom ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent" />
            </span>
          ) : (
            <svg
              className="w-[18px] h-[18px] text-white/50 group-hover:text-white transition-colors duration-200"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          )}
        </div>
        <span className={`text-[13px] tracking-wide whitespace-nowrap ${currentRoom ? 'font-semibold' : 'font-medium'}`}>
          {currentRoom ? 'Watch Together' : 'Watch Together'}
        </span>
        {currentRoom && (
          <span className="ml-auto text-[10px] font-bold text-accent bg-accent/15 px-1.5 py-0.5 rounded-md">
            {currentRoom.participants.length}
          </span>
        )}
      </button>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title="Create Watch Room"
        description="Start a room and invite friends to watch together"
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Your nickname"
            placeholder="Enter your name..."
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            }
          />
          {error && (
            <p className="text-xs text-danger">{error}</p>
          )}
          <Button
            variant="primary"
            fullWidth
            loading={loading}
            onClick={handleCreate}
            icon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            }
          >
            Create Room
          </Button>
        </div>
      </Modal>
    </>
  )
}
