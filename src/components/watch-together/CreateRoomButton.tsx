import { useState } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'
import Modal from '../ui/Modal'
import Input from '../ui/Input'
import Button from '../ui/Button'
import { getActiveProfile } from '../../services/profiles'
import { UsersRound } from 'lucide-react'

export default function CreateRoomButton({ label, variant = 'nav' }: { label?: string; variant?: 'nav' | 'hero' }) {
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
    // Profile identity is the sensible room default; the editable nickname
    // remains a deliberate privacy boundary for people who prefer an alias.
    setNickname(defaultNickname || getActiveProfile().name)
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
          'watch-together-launcher',
          variant === 'hero'
            ? 'group flex min-h-28 w-full items-center gap-5 rounded-3xl border border-white/10 bg-surface-elevated px-6 py-5 text-left shadow-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[.08]'
            : 'flex items-center gap-3 rounded-xl transition-all duration-200 group cursor-pointer px-3 py-2.5 w-full',
          currentRoom
            ? variant === 'hero' ? 'text-white' : 'bg-accent/10 text-accent hover:bg-accent/15'
            : variant === 'hero' ? 'text-white' : 'text-white/50 hover:text-white hover:bg-white/[0.06]',
        ].join(' ')}
      >
        <div className={variant === 'hero' ? 'grid h-14 w-14 flex-shrink-0 place-items-center rounded-2xl bg-accent/15 text-accent' : 'w-[18px] h-[18px] flex items-center justify-center flex-shrink-0'}>
          {currentRoom ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent" />
            </span>
          ) : (
            <UsersRound
              className={variant === 'hero'
                ? 'h-6 w-6 text-accent'
                : 'h-[18px] w-[18px] text-white/50 transition-colors duration-200 group-hover:text-white'}
              strokeWidth={2.1}
              aria-hidden="true"
            />
          )}
        </div>
        {variant === 'hero' ? <span className="min-w-0 flex-1"><strong className="block text-xl font-black">{currentRoom ? 'Open your room' : (label || 'Start a room')}</strong><span className="mt-1 block text-sm text-white/60">{currentRoom ? `Room ${currentRoom.code} · ${currentRoom.participants.length} connected` : 'Create a code and invite friends to watch in sync.'}</span></span> : <span className={`text-sm tracking-wide whitespace-nowrap ${currentRoom ? 'font-semibold' : 'font-medium'}`}>{currentRoom ? 'Watch Together' : (label || 'Watch Together')}</span>}
        {variant === 'hero' && <svg className="h-6 w-6 text-white/60 transition-transform group-hover:translate-x-1 group-hover:text-white" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        {currentRoom && (
          <span className="ml-auto text-meta font-bold text-accent bg-accent/15 px-1.5 py-0.5 rounded-md">
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
        className="watch-together-modal"
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
