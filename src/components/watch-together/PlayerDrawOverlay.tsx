import { useState, useRef, useEffect, useCallback } from 'react'
import { useWatchTogetherStore } from '../../stores/watchTogetherStore'
import { sendDrawStroke, sendDrawClear } from '../../services/watch-together/wsClient'
import type { DrawStroke } from '../../services/watch-together/types'

const COLORS = [
  '#ff4444', '#ff8800', '#ffcc00', '#44cc44',
  '#44aaff', '#8844ff', '#ff44cc', '#ffffff',
]
const WIDTHS = [2, 4, 8]

interface RenderedStroke extends DrawStroke {
  fadeStart?: number
}

export default function PlayerDrawOverlay() {
  const currentRoom = useWatchTogetherStore((s) => s.currentRoom)
  const [active, setActive] = useState(false)
  const [color, setColor] = useState('#ff4444')
  const [width, setWidth] = useState(4)
  const [strokes, setStrokes] = useState<RenderedStroke[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const currentPointsRef = useRef<{ x: number; y: number }[]>([])
  const animFrameRef = useRef<number>(0)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const now = Date.now()

    const stillVisible: RenderedStroke[] = []
    for (const stroke of strokes) {
      const elapsed = stroke.fadeStart ? now - stroke.fadeStart : 0
      const opacity = stroke.fadeStart ? Math.max(0, 1 - elapsed / 5000) : 1
      if (opacity <= 0) continue
      stillVisible.push(stroke)

      ctx.globalAlpha = opacity
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      if (stroke.points.length > 0) {
        ctx.beginPath()
        ctx.moveTo(stroke.points[0].x * canvas.width, stroke.points[0].y * canvas.height)
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x * canvas.width, stroke.points[i].y * canvas.height)
        }
        ctx.stroke()
      }
    }

    // Draw current in-progress stroke
    if (currentPointsRef.current.length > 0) {
      ctx.globalAlpha = 1
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(currentPointsRef.current[0].x * canvas.width, currentPointsRef.current[0].y * canvas.height)
      for (let i = 1; i < currentPointsRef.current.length; i++) {
        ctx.lineTo(currentPointsRef.current[i].x * canvas.width, currentPointsRef.current[i].y * canvas.height)
      }
      ctx.stroke()
    }

    ctx.globalAlpha = 1

    if (stillVisible.length !== strokes.length) {
      setStrokes(stillVisible)
    }

    if (stillVisible.length > 0 || currentPointsRef.current.length > 0) {
      animFrameRef.current = requestAnimationFrame(redraw)
    }
  }, [strokes, color, width])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(redraw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [redraw])

  // Resize canvas to match parent
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
      redraw()
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [active])

  // Listen for remote draw events
  useEffect(() => {
    const onDrawReceived = (e: Event) => {
      const { stroke } = (e as CustomEvent).detail as { stroke: DrawStroke }
      setStrokes((prev) => [...prev, { ...stroke, fadeStart: Date.now() }])
    }
    const onDrawCleared = () => {
      setStrokes([])
    }
    window.addEventListener('wt:draw_received', onDrawReceived)
    window.addEventListener('wt:draw_cleared', onDrawCleared)
    return () => {
      window.removeEventListener('wt:draw_received', onDrawReceived)
      window.removeEventListener('wt:draw_cleared', onDrawCleared)
    }
  }, [])

  const getRelativePos = (e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    }
  }

  const handlePointerDown = (e: React.MouseEvent) => {
    if (!active) return
    e.preventDefault()
    e.stopPropagation()
    drawingRef.current = true
    currentPointsRef.current = [getRelativePos(e)]
    animFrameRef.current = requestAnimationFrame(redraw)
  }

  const handlePointerMove = (e: React.MouseEvent) => {
    if (!drawingRef.current) return
    e.preventDefault()
    e.stopPropagation()
    currentPointsRef.current.push(getRelativePos(e))
  }

  const handlePointerUp = (e: React.MouseEvent) => {
    if (!drawingRef.current) return
    e.preventDefault()
    e.stopPropagation()
    drawingRef.current = false

    if (currentPointsRef.current.length > 1) {
      const stroke: DrawStroke = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        points: currentPointsRef.current,
        color,
        width,
      }
      setStrokes((prev) => [...prev, { ...stroke, fadeStart: Date.now() }])
      sendDrawStroke(stroke)
    }
    currentPointsRef.current = []
  }

  const handleClear = () => {
    setStrokes([])
    sendDrawClear()
  }

  if (!currentRoom) return null

  return (
    <>
      {/* Canvas layer — always mounted to receive remote strokes */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-[62]"
        style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
      />

      {/* Toolbar */}
      <div
        className="absolute left-4 bottom-28 z-[65] flex flex-col gap-2"
        onClick={(e) => e.stopPropagation()}
        onMouseMove={(e) => e.stopPropagation()}
      >
        {/* Toggle draw mode */}
        <button
          onClick={() => setActive((v) => !v)}
          className={[
            'w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer border',
            active
              ? 'bg-accent/20 border-accent/40 text-accent'
              : 'bg-black/60 backdrop-blur-md border-white/10 text-white/60 hover:text-white',
          ].join(' ')}
          title={active ? 'Stop drawing' : 'Draw on screen'}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19l7-7 3 3-7 7-3-3z" />
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
            <path d="M2 2l7.586 7.586" />
            <circle cx="11" cy="11" r="2" />
          </svg>
        </button>

        {active && (
          <div className="flex flex-col gap-2 p-2 rounded-xl bg-black/60 backdrop-blur-xl border border-white/10">
            {/* Color picker */}
            <div className="grid grid-cols-4 gap-1">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={[
                    'w-6 h-6 rounded-full border-2 transition-all cursor-pointer',
                    color === c ? 'border-white scale-110' : 'border-transparent hover:border-white/40',
                  ].join(' ')}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>

            {/* Width picker */}
            <div className="flex items-center justify-center gap-2 pt-1 border-t border-white/10">
              {WIDTHS.map((w) => (
                <button
                  key={w}
                  onClick={() => setWidth(w)}
                  className={[
                    'flex items-center justify-center w-7 h-7 rounded-lg transition-all cursor-pointer',
                    width === w ? 'bg-white/20' : 'hover:bg-white/10',
                  ].join(' ')}
                  title={`${w}px`}
                >
                  <span
                    className="rounded-full bg-white"
                    style={{ width: w + 2, height: w + 2 }}
                  />
                </button>
              ))}
            </div>

            {/* Clear */}
            <button
              onClick={handleClear}
              className="text-[10px] font-semibold text-white/50 hover:text-red-400 transition-colors cursor-pointer pt-1 border-t border-white/10"
            >
              Clear All
            </button>
          </div>
        )}
      </div>
    </>
  )
}
