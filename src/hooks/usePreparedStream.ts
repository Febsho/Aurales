import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import type { StreamPreloadRequest } from '../services/streams/preloadManager'
import { canonicalStreamKey } from '../services/streams/preloadUtils'
import { preparedStreamRegistry } from '../services/streams/preparedStreams'

// Just enough to skip prepare while flipping through pages; the detail-page
// stream fetch (DETAILS_OPEN) is already in flight, so preparing early only
// costs one rank + probe.
const DWELL_MS = 250

// After the user has dwelled on a detail page for a moment (i.e. is not just
// flipping through pages), prepare the best direct stream so Play starts
// instantly. Only when auto-play is enabled — manual pickers see no benefit.
export function usePreparedStream(request: StreamPreloadRequest | null, title?: string): void {
  const mediaKey = request ? canonicalStreamKey(request) : null
  const autoPlayFirstStream = useAppStore((s) => s.autoPlayFirstStream)

  useEffect(() => {
    if (!request || !mediaKey || !autoPlayFirstStream) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (!navigator.onLine) return
      preparedStreamRegistry.prepare(request, { signal: controller.signal, title }).catch(() => undefined)
    }, DWELL_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // Keyed on the canonical media key: a new media (or episode target)
    // restarts the dwell timer; unmount cancels an in-flight prepare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey, autoPlayFirstStream])
}
