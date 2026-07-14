import { useEffect } from 'react'
import { cachedImage } from '../services/imageCache'

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
}
