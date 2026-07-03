import { useEffect } from 'react'

function highQualityBackdropUrl(url: string): string {
  return url.replace('/w780/', '/original/').replace('/w1280/', '/original/')
}

export function useGlobalBackdrop(url?: string | null) {
  useEffect(() => {
    const root = document.documentElement

    if (url) {
      root.style.setProperty('--hero-bg', `url(${highQualityBackdropUrl(url)})`)
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
