import { useEffect, useState } from 'react'
import { cachedImage, retryImageFromSource } from '../services/imageCache'

/** Decode the visible artwork behind the loading screen. URL-keyed state
 * prevents a previous title's completion from revealing the next title. */
export function useDetailArtworkReady(urls: Array<string | undefined>, attempt = 0) {
  const key = JSON.stringify([...new Set(urls.filter((url): url is string => Boolean(url)))])
  const [result, setResult] = useState<{ key: string; attempt: number; failed: boolean } | null>(null)
  useEffect(() => {
    let active = true
    const cleanups: Array<() => void> = []
    const sources = JSON.parse(key) as string[]
    void Promise.all(sources.map(url => new Promise<boolean>(resolve => {
      const image = new Image()
      image.decoding = 'async'
      let settled = false
      const finish = (success: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        clearTimeout(deadline)
        image.onload = null
        image.onerror = null
        resolve(success)
      }
      const fallback = setTimeout(() => retryImageFromSource(image, url), 3000)
      const deadline = setTimeout(() => finish(false), 12000)
      image.onload = () => {
        void image.decode().catch(() => undefined).then(() => finish(image.naturalWidth > 0))
      }
      image.onerror = () => { if (!retryImageFromSource(image, url)) finish(false) }
      cleanups.push(() => finish(false))
      image.src = cachedImage(url)
    }))).then(results => {
      if (active) setResult({ key, attempt, failed: results.some(success => !success) })
    })
    return () => { active = false; cleanups.forEach(cleanup => cleanup()) }
  }, [key, attempt])
  const current = result?.key === key && result.attempt === attempt
  return { ready: Boolean(current && !result.failed), failed: Boolean(current && result.failed) }
}
