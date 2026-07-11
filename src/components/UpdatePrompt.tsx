import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  checkForUpdate,
  downloadAndInstall,
  getAppVersion,
  getLatestReleaseNotes,
  type UpdateInfo,
} from '../services/updater'

// Auto-update prompt: checks for an update shortly after launch and, when one
// exists, shows a liquid-glass dialog with the GitHub release patch notes.

const CHECK_DELAY_MS = 3000

type Phase = 'hidden' | 'available' | 'downloading' | 'error'

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // **bold** and `code` inline formatting
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} className="font-semibold text-white/90">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} className="rounded bg-white/10 px-1.5 py-0.5 text-[0.85em] font-mono text-white/85">{part.slice(1, -1)}</code>
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>
  })
}

function renderMarkdown(markdown: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let bullets: string[] = []

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return
    nodes.push(
      <ul key={key} className="mb-3 space-y-1.5">
        {bullets.map((item, i) => (
          <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-white/60">
            <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-white/40" />
            <span>{renderInline(item, `${key}-${i}`)}</span>
          </li>
        ))}
      </ul>,
    )
    bullets = []
  }

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    const bullet = line.match(/^[-*+]\s+(.*)/)
    if (bullet) {
      bullets.push(bullet[1])
      return
    }
    flushBullets(`ul-${index}`)
    if (!line) return
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) {
      nodes.push(
        <h4 key={`h-${index}`} className="mb-2 mt-4 text-[11px] font-extrabold uppercase tracking-[0.14em] text-white/45 first:mt-0">
          {renderInline(heading[2], `h-${index}`)}
        </h4>,
      )
      return
    }
    nodes.push(
      <p key={`p-${index}`} className="mb-3 text-sm leading-relaxed text-white/60">
        {renderInline(line, `p-${index}`)}
      </p>,
    )
  })
  flushBullets('ul-end')
  return nodes
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export default function UpdatePrompt() {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [notes, setNotes] = useState<string>('')
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null })
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const found = await checkForUpdate()
        if (cancelled || !found) return
        const release = await getLatestReleaseNotes()
        if (cancelled) return
        setUpdate(found)
        setNotes(release?.body || found.body || '')
        setPhase('available')
      } catch (_) {
        // Silent: no network, dev build without update token, etc.
      }
    }, CHECK_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const notesNodes = useMemo(() => (notes ? renderMarkdown(notes) : []), [notes])

  if (phase === 'hidden' || !update) return null

  const percent = progress.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null

  const startUpdate = async () => {
    setPhase('downloading')
    setError('')
    let total: number | null = null
    try {
      await downloadAndInstall((p) => {
        if (p.total != null) total = p.total
        setProgress({ downloaded: p.downloaded, total })
      })
      // downloadAndInstall relaunches the app on success.
    } catch (e) {
      setError(String(e))
      setPhase('error')
    }
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-6">
      {/* Dimmed, blurred backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[6px] transition-opacity"
        onClick={phase === 'downloading' ? undefined : () => setPhase('hidden')}
      />

      {/* Liquid glass panel */}
      <div className="relative w-full max-w-lg overflow-hidden rounded-[1.75rem] border border-white/[0.14] shadow-[0_32px_90px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(255,255,255,0.05)] backdrop-blur-2xl backdrop-saturate-[1.6]"
        style={{ background: 'linear-gradient(155deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.055) 38%, rgba(255,255,255,0.03) 100%)' }}
      >
        {/* Specular highlight sweep */}
        <div className="pointer-events-none absolute -top-1/2 left-[-20%] h-full w-[70%] rotate-[18deg] bg-gradient-to-b from-white/[0.13] to-transparent blur-2xl" />
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/45 to-transparent" />

        <div className="relative p-7">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/15 bg-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]">
                <svg className="h-5 w-5 text-white/85" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M12 3v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-black tracking-tight text-white">Update available</h2>
                <p className="mt-0.5 text-xs font-medium text-white/45">
                  {getAppVersion()} <span className="mx-1 text-white/25">→</span> <span className="text-white/75">{update.version}</span>
                </p>
              </div>
            </div>
            {phase !== 'downloading' && (
              <button
                onClick={() => setPhase('hidden')}
                className="flex h-8 w-8 items-center justify-center rounded-full text-white/35 transition-colors hover:bg-white/10 hover:text-white/80 cursor-pointer"
                aria-label="Dismiss"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          {notesNodes.length > 0 && (
            <div className="mb-6 max-h-[42vh] overflow-y-auto rounded-2xl border border-white/[0.08] bg-black/25 p-5 [scrollbar-width:thin]">
              {notesNodes}
            </div>
          )}

          {phase === 'error' && (
            <p className="mb-4 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-xs text-red-200/90">
              Update failed: {error}
            </p>
          )}

          {phase === 'downloading' ? (
            <div>
              <div className="mb-2 flex items-center justify-between text-xs font-semibold text-white/55">
                <span>Downloading update…</span>
                <span>{percent != null ? `${percent}%` : formatBytes(progress.downloaded)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full bg-gradient-to-r from-white/70 to-white/90 transition-[width] duration-200 ${percent == null ? 'w-1/3 animate-pulse' : ''}`}
                  style={percent != null ? { width: `${percent}%` } : undefined}
                />
              </div>
              <p className="mt-3 text-center text-[11px] text-white/35">The app restarts automatically when the update is installed.</p>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setPhase('hidden')}
                className="rounded-full px-5 py-2.5 text-sm font-bold text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/85 cursor-pointer"
              >
                Later
              </button>
              <button
                onClick={startUpdate}
                className="rounded-full border border-white/25 bg-white/90 px-6 py-2.5 text-sm font-black text-black shadow-[0_8px_28px_rgba(255,255,255,0.18),inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white cursor-pointer"
              >
                {phase === 'error' ? 'Try again' : 'Update now'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
