import { useEffect, useState, type RefObject } from 'react'

type VisibilityCallback = () => void

interface SharedObserver {
  observer: IntersectionObserver
  callbacks: Map<Element, VisibilityCallback>
}

const sharedObservers = new Map<string, SharedObserver>()

function getSharedObserver(rootMargin: string): SharedObserver {
  const existing = sharedObservers.get(rootMargin)
  if (existing) return existing

  const callbacks = new Map<Element, VisibilityCallback>()
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const callback = callbacks.get(entry.target)
      callbacks.delete(entry.target)
      observer.unobserve(entry.target)
      callback?.()
    }
  }, { rootMargin })
  const shared = { observer, callbacks }
  sharedObservers.set(rootMargin, shared)
  return shared
}

export function useVisibilityOnce<T extends Element>(
  ref: RefObject<T | null>,
  options: { eager?: boolean; rootMargin?: string } = {},
): boolean {
  const { eager = false, rootMargin = '200px' } = options
  const [visible, setVisible] = useState(eager)

  useEffect(() => {
    if (visible || eager) return
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }

    const shared = getSharedObserver(rootMargin)
    shared.callbacks.set(element, () => setVisible(true))
    shared.observer.observe(element)
    return () => {
      shared.callbacks.delete(element)
      shared.observer.unobserve(element)
    }
  }, [eager, ref, rootMargin, visible])

  return visible
}
