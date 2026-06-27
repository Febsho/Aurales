import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import { useToast } from '../ui/Toast'

export default function InviteLinkBox() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const { toast } = useToast()

  if (!currentRoom) return null

  const roomCode = currentRoom.code
  const inviteLink = `aurales://watch/${currentRoom.id}`

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('success', `${label} copied!`)
    } catch (_) {
      toast('error', 'Failed to copy')
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Room code */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06]">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-white/30">Room Code</span>
          <span className="text-base font-bold font-mono tracking-[0.25em] text-accent">{roomCode}</span>
        </div>
        <button
          onClick={() => copyToClipboard(roomCode, 'Room code')}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white/50 hover:text-white text-[11px] font-medium transition-all duration-200 cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy
        </button>
      </div>

      {/* Invite link */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06]">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-white/30">Invite Link</span>
          <span className="text-xs text-white/50 truncate font-mono">{inviteLink}</span>
        </div>
        <button
          onClick={() => copyToClipboard(inviteLink, 'Invite link')}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white/50 hover:text-white text-[11px] font-medium transition-all duration-200 cursor-pointer flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          Copy
        </button>
      </div>
    </div>
  )
}
