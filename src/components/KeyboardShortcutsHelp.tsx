import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const SECTIONS = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['/', 'Ctrl+K'], label: 'Focus search' },
      { keys: ['Alt+←'], label: 'Go back' },
      { keys: ['?'], label: 'Show keyboard shortcuts' },
    ],
  },
  {
    title: 'Player — Playback',
    shortcuts: [
      { keys: ['Space'], label: 'Play / Pause' },
      { keys: ['F'], label: 'Toggle fullscreen' },
      { keys: ['M'], label: 'Mute / Unmute' },
      { keys: ['↑ / ↓'], label: 'Volume up / down' },
    ],
  },
  {
    title: 'Player — Seeking',
    shortcuts: [
      { keys: ['← / →'], label: 'Seek back / forward 10s' },
      { keys: ['Hold ← / →'], label: 'Fast seek (accelerating)' },
    ],
  },
]

export default function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) return

      if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-[#111] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-lg font-bold text-white">Keyboard Shortcuts</h2>
          <button
            onClick={() => setOpen(false)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 max-h-[70vh] overflow-y-auto space-y-6">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-white/30 mb-3">{section.title}</h3>
              <div className="space-y-2">
                {section.shortcuts.map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center justify-between py-1">
                    <span className="text-sm text-white/70">{shortcut.label}</span>
                    <div className="flex items-center gap-1.5">
                      {shortcut.keys.map((key, i) => (
                        <span key={i} className="flex items-center gap-1.5">
                          {i > 0 && <span className="text-[10px] text-white/20">or</span>}
                          <kbd className="px-2 py-1 text-xs font-semibold text-white/60 bg-white/[0.06] border border-white/[0.08] rounded-lg min-w-[28px] text-center">
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-3 border-t border-white/[0.06] flex justify-center">
          <span className="text-[11px] text-white/25">Press <kbd className="px-1.5 py-0.5 text-[10px] font-bold bg-white/[0.06] border border-white/[0.06] rounded">?</kbd> or <kbd className="px-1.5 py-0.5 text-[10px] font-bold bg-white/[0.06] border border-white/[0.06] rounded">Esc</kbd> to close</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
