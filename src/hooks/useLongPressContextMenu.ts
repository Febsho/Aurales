import { useCallback, useEffect, useRef } from 'react'

/** Adds the browser-style context menu to touch targets without changing tap. */
export function useLongPressContextMenu(
  onContextMenu?: (event: React.MouseEvent) => void,
  delayMs = 520,
) {
  const callbackRef = useRef(onContextMenu)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  callbackRef.current = onContextMenu

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    originRef.current = null
  }, [])

  useEffect(() => clear, [clear])

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.pointerType !== 'touch' || !callbackRef.current) return
    firedRef.current = false
    originRef.current = { x: event.clientX, y: event.clientY }
    const x = event.clientX
    const y = event.clientY
    const currentTarget = event.currentTarget
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      callbackRef.current?.({
        preventDefault: () => undefined,
        clientX: x,
        clientY: y,
        shiftKey: false,
        currentTarget,
      } as React.MouseEvent)
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(12)
    }, delayMs)
  }, [delayMs])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const origin = originRef.current
    if (!origin) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 12) clear()
  }, [clear])

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!firedRef.current) return
    firedRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture,
  }
}
