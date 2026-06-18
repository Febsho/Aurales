import { useWatchTogetherStore } from '../../stores/watchTogetherStore'

export default function RoomStreamStatus() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)

  if (!currentRoom || !currentRoom.selectedMedia) return null

  const participants = currentRoom.participants

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Stream Status</h3>

      <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
        {participants.map((p, i) => {
          let statusText: string
          let statusColor: string
          let statusIcon: React.ReactNode

          if (p.status === 'choosing_stream') {
            statusText = 'Choosing...'
            statusColor = 'text-warning'
            statusIcon = (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )
          } else if (p.hasSelectedStream) {
            statusText = 'Ready'
            statusColor = 'text-success'
            statusIcon = (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )
          } else {
            statusText = 'No stream'
            statusColor = 'text-white/30'
            statusIcon = (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            )
          }

          return (
            <div
              key={p.id}
              className={[
                'flex items-center justify-between px-3 py-2',
                i < participants.length - 1 ? 'border-b border-white/[0.04]' : '',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-md bg-white/[0.08] flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-white/50">
                  {p.name.charAt(0).toUpperCase()}
                </div>
                <span className="text-xs text-white/60 truncate">
                  {p.name}
                  {p.id === currentUserId && <span className="text-white/25"> (you)</span>}
                </span>
              </div>
              <div className={`flex items-center gap-1.5 ${statusColor}`}>
                {statusIcon}
                <span className="text-[11px] font-medium">{statusText}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
