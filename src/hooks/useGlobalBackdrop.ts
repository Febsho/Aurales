import { useEffect } from 'react'
import { cachedImage } from '../services/imageCache'
import { loadAmbientColor } from '../services/ambientColor'

function highQualityBackdropUrl(url: string): string {
  if (url.includes('image.tmdb.org/t/p/')) return url.replace(/\/t\/p\/(?:w\d+|h\d+|original)\//, '/t/p/original/')
  return url
}

export function useGlobalBackdrop(url?: string | null) {
  useEffect(() => {
    const root = document.documentElement

    if (url) {
      root.style.setProperty('--hero-bg', `url(${cachedImage(highQualityBackdropUrl(url))})`)
      root.classList.add('hero-bg-active')
    } else {
      root.classList.remove('hero-bg-active')
      root.style.removeProperty('--hero-bg')
    }

    return () => {
      root.classList.remove('hero-bg-active')
      root.style.removeProperty('--hero-bg')
    }
  }, [url])

  // Ambient colour is derived separately from the backdrop image itself: it is
  // best-effort, may resolve late, and must never block or alter the backdrop
  // above. When it cannot be read (cross-origin artwork taints the canvas) the
  // variable is simply removed and styling falls back to its neutral default.
  useEffect(() => {
    const root = document.documentElement
    if (!url) {
      root.style.removeProperty('--ambient-rgb')
      return
    }
    const controller = new AbortController()
    loadAmbientColor(cachedImage(url), controller.signal).then((color) => {
      if (controller.signal.aborted) return
      if (color) root.style.setProperty('--ambient-rgb', `${color.r} ${color.g} ${color.b}`)
      else root.style.removeProperty('--ambient-rgb')
    })
    return () => {
      controller.abort()
      root.style.removeProperty('--ambient-rgb')
    }
  }, [url])
}
