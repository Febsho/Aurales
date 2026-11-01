import { useEffect, useState } from 'react'
import { getPlatformCapabilities } from './capabilities'

const MOBILE_WEB_QUERY = '(max-width: 700px)'

export function isMobileWebViewport(): boolean {
  return getPlatformCapabilities().platform === 'web'
    && typeof window !== 'undefined'
    && window.matchMedia(MOBILE_WEB_QUERY).matches
}

/** The compact mobile shell is a web-only responsive mode, never a desktop
 * Tauri preference. Subscribe so rotating or resizing updates navigation. */
export function useIsMobileWeb(): boolean {
  const [mobile, setMobile] = useState(isMobileWebViewport)

  useEffect(() => {
    const query = window.matchMedia(MOBILE_WEB_QUERY)
    const update = () => setMobile(getPlatformCapabilities().platform === 'web' && query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return mobile
}
