import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
  action?: { label: string; onClick: () => void }
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, opts?: { duration?: number; action?: Toast['action'] }) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

const typeStyles: Record<ToastType, { bg: string; icon: string; border: string }> = {
  success: { bg: 'bg-success/10', icon: 'text-success', border: 'border-success/20' },
  error: { bg: 'bg-danger/10', icon: 'text-danger', border: 'border-danger/20' },
  warning: { bg: 'bg-warning/10', icon: 'text-warning', border: 'border-warning/20' },
  info: { bg: 'bg-info/10', icon: 'text-info', border: 'border-info/20' },
}

const typeIcons: Record<ToastType, ReactNode> = {
  success: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  error: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  ),
  warning: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  ),
  info: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [exiting, setExiting] = useState(false)
  const styles = typeStyles[toast.type]

  useEffect(() => {
    const dur = toast.duration ?? 4000
    if (dur <= 0) return
    const timer = setTimeout(() => {
      setExiting(true)
      setTimeout(() => onDismiss(toast.id), 200)
    }, dur)
    return () => clearTimeout(timer)
  }, [toast.id, toast.duration, onDismiss])

  return (
    <div
      className={[
        'flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl',
        'shadow-lg min-w-[280px] max-w-md',
        styles.bg,
        styles.border,
        'transition-all duration-200',
        exiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0',
        'animate-[toastIn_250ms_cubic-bezier(0.16,1,0.3,1)]',
      ].join(' ')}
    >
      <span className={styles.icon}>{typeIcons[toast.type]}</span>
      <span className="text-sm font-medium text-white flex-1">{toast.message}</span>
      {toast.action && (
        <button
          onClick={toast.action.onClick}
          className="text-xs font-bold text-accent hover:text-accent-hover transition-colors cursor-pointer"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-white/30 hover:text-white/60 transition-colors cursor-pointer ml-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(20px) scale(0.95); }
          to { opacity: 1; transform: translateX(0) scale(1); }
        }
      `}</style>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (type: ToastType, message: string, opts?: { duration?: number; action?: Toast['action'] }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      setToasts((prev) => [...prev, { id, type, message, ...opts }])
    },
    [],
  )

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
