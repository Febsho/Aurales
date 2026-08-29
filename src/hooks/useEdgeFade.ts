import { useCallback, useEffect, useRef } from 'react'

/**
 * Marks a horizontal scroller with `data-fade-start` / `data-fade-end` so CSS
 * can fade whichever edge still has content beyond it.
 *
 * The fade is painted by pseudo-elements on the scroller's wrapper rather than
 * by masking the scroller itself: `mask-image` on a container full of artwork
 * promotes it to its own compositing layer and forces a re-rasterise on every
 * scroll frame, which is exactly the cost WebKitGTK cannot absorb while mpv is
 * decoding. Two static gradients cost nothing to move.
 *
 * Returns a ref for the scrolling element. The wrapper is its parent. Pass an
 * existing ref when the scroller is already referenced for other reasons
 * (wheel handling, programmatic scrolling) rather than adding a second one.
 */
export function useEdgeFade<T extends HTMLElement = HTMLDivElement>(
  externalRef?: React.RefObject<T | null>,
  /**
   * Re-arm when the scroller itself mounts or unmounts. The effect's own
   * dependencies are stable callbacks, so without this it runs exactly once --
   * and on a page whose track only renders after its data resolves, that one
   * run happens while the ref is still null. Pass whatever gates the track's
   * existence (e.g. the loaded season) so the observers attach when it appears.
   */
  deps: unknown[] = [],
) {
  const ownRef = useRef<T>(null)
  const ref = externalRef ?? ownRef
  const frame = useRef(0)

  const sync = useCallback(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host) return
    // Browsers can retain a few pixels of scroll-snap/restore drift. Treat that
    // as the start: otherwise the left fade paints over the first card's corner
    // (especially the next unwatched episode) even though it is effectively
    // the first visible item.
    const overflows = el.scrollWidth > el.clientWidth + 2
    const atStart = el.scrollLeft <= 12
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2
    host.toggleAttribute('data-fade-start', overflows && !atStart)
    host.toggleAttribute('data-fade-end', overflows && !atEnd)
  }, [ref])

  const onScroll = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      sync()
    })
  }, [sync])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    sync()
    el.addEventListener('scroll', onScroll, { passive: true })

    // Card widths are fluid, so the track has to re-derive overflow on resize.
    const resize =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    resize?.observe(el)

    // Episodes, trailers and cast all arrive asynchronously. Observing only the
    // children present at mount misses the case that actually matters: a track
    // that does not overflow on first paint and does once its content lands.
    // The scroller's own box never changes, so ResizeObserver alone never fires.
    const mutation =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            sync()
            Array.from(el.children).forEach((child) => resize?.observe(child))
          })
        : null
    mutation?.observe(el, { childList: true })
    Array.from(el.children).forEach((child) => resize?.observe(child))

    return () => {
      el.removeEventListener('scroll', onScroll)
      resize?.disconnect()
      mutation?.disconnect()
      if (frame.current) cancelAnimationFrame(frame.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScroll, sync, ...deps])

  return ref
}

export default useEdgeFade
