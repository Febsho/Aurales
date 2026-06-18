import { useState, useRef, useEffect } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Modal from '../ui/Modal'
import Input from '../ui/Input'
import Button from '../ui/Button'

const DEFAULT_SERVER_URL = 'ws://localhost:9876'

interface JoinRoomModalProps {
  open: boolean
  onClose: () => void
}

export default function JoinRoomModal({ open, onClose }: JoinRoomModalProps) {
  const connectionStatus = useWatchTogetherStore((s) => s.connectionStatus)
  const setRoomPanelOpen = useWatchTogetherStore((s) => s.setRoomPanelOpen)
  const [roomCode, setRoomCode] = useState('')
  const [nickname, setNickname] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const codeInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setRoomCode('')
      setNickname(localStorage.getItem('aurales_wt_nickname') || '')
      setError('')
      setTimeout(() => codeInputRef.current?.focus(), 100)
    }
  }, [open])

  const handleRoomCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    setRoomCode(val)
  }

  const handleJoin = async () => {
    if (roomCode.length < 6) {
      setError('Room code must be 6 characters')
      return
    }
    const trimmedName = nickname.trim()
    if (!trimmedName) {
      setError('Please enter a nickname')
      return
    }
    setLoading(true)
    setError('')
    try {
      if (connectionStatus === 'disconnected') {
        const serverUrl = localStorage.getItem('aurales_wt_server') || DEFAULT_SERVER_URL
        await wsClient.connect(serverUrl)
      }
      localStorage.setItem('aurales_wt_nickname', trimmedName)
      await wsClient.joinRoom(roomCode, trimmedName)
      onClose()
      setRoomPanelOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join room')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleJoin()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Join Watch Room"
      description="Enter a room code to watch with friends"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <Input
          ref={codeInputRef}
          label="Room code"
          placeholder="ABCDEF"
          value={roomCode}
          onChange={handleRoomCodeChange}
          onKeyDown={handleKeyDown}
          maxLength={6}
          className="tracking-[0.3em] text-center font-mono text-lg uppercase"
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          }
        />

        <Input
          label="Your nickname"
          placeholder="Enter your name..."
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={handleKeyDown}
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          }
        />

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20">
            <svg className="w-3.5 h-3.5 text-danger flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        <Button
          variant="primary"
          fullWidth
          loading={loading}
          disabled={roomCode.length < 6}
          onClick={handleJoin}
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <polyline points="10 17 15 12 10 7" />
              <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
          }
        >
          Join Room
        </Button>
      </div>
    </Modal>
  )
}
