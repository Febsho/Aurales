import { useState, useRef, useEffect } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = Math.floor((now - timestamp) / 1000)
  if (diff < 10) return 'now'
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

export default function RoomChat() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)
  const [message, setMessage] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const messages = currentRoom?.chat ?? []

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleSend = () => {
    const trimmed = message.trim()
    if (!trimmed) return
    wsClient.sendChatMessage(trimmed)
    setMessage('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') {
      inputRef.current?.blur()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Chat</h3>

      {/* Messages */}
      <div
        ref={containerRef}
        className="h-48 overflow-y-auto rounded-xl bg-white/[0.02] border border-white/[0.06] p-2 flex flex-col gap-1 scrollbar-thin scrollbar-thumb-white/10"
      >
        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[11px] text-white/20">No messages yet</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.userId === currentUserId
            return (
              <div
                key={msg.id}
                className={[
                  'flex flex-col px-2.5 py-1.5 rounded-lg max-w-[85%]',
                  isMe ? 'self-end bg-accent/10' : 'self-start bg-white/[0.04]',
                ].join(' ')}
              >
                <div className="flex items-center gap-1.5">
                  <span className={[
                    'text-[10px] font-semibold',
                    isMe ? 'text-accent/80' : 'text-white/40',
                  ].join(' ')}>
                    {isMe ? 'You' : msg.userName}
                  </span>
                  <span className="text-[9px] text-white/20">{formatRelativeTime(msg.sentAt)}</span>
                </div>
                <p className="text-xs text-white/80 leading-relaxed break-words">{msg.message}</p>
              </div>
            )
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          className={[
            'flex-1 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg',
            'text-xs text-white placeholder-white/30 px-3 py-2',
            'transition-all duration-200',
            'focus:outline-none focus:bg-white/[0.1] focus:border-white/20',
          ].join(' ')}
        />
        <button
          onClick={handleSend}
          disabled={!message.trim()}
          className={[
            'w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer',
            message.trim()
              ? 'bg-accent text-black hover:bg-accent-hover'
              : 'bg-white/[0.06] text-white/20 pointer-events-none',
          ].join(' ')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  )
}
