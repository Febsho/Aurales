import { useEffect, useRef, type ReactNode } from 'react'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  side?: 'right' | 'bottom'
  className?: string
}

export default function Sheet({
  open,
  onClose,
  title,
  children,
  side = 'right',
  className = '',
}: SheetProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  const isRight = side === 'right'

  return (
    <div
      ref={overlayRef}
      className={[
        'fixed inset-0 z-[100] transition-opacity duration-300',
        open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
      ].join(' ')}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        className={[
          'absolute bg-surface-elevated/95 backdrop-blur-3xl border-white/8',
          'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isRight
            ? `top-0 right-0 bottom-0 w-full max-w-md border-l ${open ? 'translate-x-0' : 'translate-x-full'}`
            : `bottom-0 left-0 right-0 max-h-[80vh] border-t rounded-t-2xl ${open ? 'translate-y-0' : 'translate-y-full'}`,
          className,
        ].join(' ')}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
            <h2 className="text-base font-bold text-white">{title}</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center
                bg-white/5 hover:bg-white/10 text-white/40 hover:text-white
                transition-colors duration-200 cursor-pointer"
              aria-label="Close"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1 p-6">{children}</div>
      </div>
    </div>
  )
}
