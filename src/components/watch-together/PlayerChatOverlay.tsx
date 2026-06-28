import { useState, useRef, useEffect } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import * as wsClient from '../../services/watch-together/wsClient'

export default function PlayerChatOverlay() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const currentUserId = useWatchTogetherStore((s) => s.currentUserId)
  const [message, setMessage] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const messages = currentRoom?.chat ?? []

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
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!currentRoom) return null

  return (
    <div
      className="absolute right-4 bottom-28 z-[65] flex flex-col"
      style={{ width: 320 }}
      onClick={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
    >
      {/* Toggle button */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="self-end mb-1 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white/70 hover:text-white text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {collapsed ? 'Show Chat' : 'Hide Chat'}
        {collapsed && messages.length > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-accent/80 text-black text-[9px] font-black">
            {messages.length}
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="rounded-2xl bg-black/60 backdrop-blur-xl border border-white/10 overflow-hidden flex flex-col">
          {/* Messages */}
          <div className="h-52 overflow-y-auto p-3 flex flex-col gap-1 scrollbar-thin scrollbar-thumb-white/10">
            {messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-[11px] text-white/25">No messages yet</p>
              </div>
            ) : (
              messages.map((msg) => {
                const isMe = msg.userId === currentUserId
                return (
                  <div
                    key={msg.id}
                    className={[
                      'flex flex-col px-2.5 py-1.5 rounded-lg max-w-[85%]',
                      isMe ? 'self-end bg-accent/15' : 'self-start bg-white/[0.06]',
                    ].join(' ')}
                  >
                    <span className={[
                      'text-[10px] font-semibold',
                      isMe ? 'text-accent/80' : 'text-white/40',
                    ].join(' ')}>
                      {isMe ? 'You' : msg.userName}
                    </span>
                    <p className="text-xs text-white/85 leading-relaxed break-words">{msg.message}</p>
                  </div>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="flex items-center gap-2 p-2 border-t border-white/[0.06]">
            <input
              ref={inputRef}
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={(e) => e.stopPropagation()}
              placeholder="Type a message..."
              className="flex-1 bg-white/[0.06] border border-white/[0.08] rounded-lg text-xs text-white placeholder-white/30 px-3 py-2 focus:outline-none focus:bg-white/[0.1] focus:border-white/20 transition-all"
            />
            <button
              onClick={handleSend}
              disabled={!message.trim()}
              className={[
                'w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer',
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
      )}
    </div>
  )
}
