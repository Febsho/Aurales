import { useEffect, useState } from 'react'
import { streamPreloadManager, StreamPreloadPriority, type PreloadedStream } from '../services/streams/preloadManager'
import type { StreamPreloadRequest } from '../services/streams/preloadManager'
import { canonicalStreamKey } from '../services/streams/preloadUtils'
import { detectStreamFeatures, type StreamFeature } from '../services/streams/streamFeatures'

// The badge row describes the release the user is most likely to get, i.e. the
// stream the picker lists first. An addon can lead with an entry whose name
// carries no tech info at all, so fall through a few before giving up.
const SCAN_LIMIT = 5

const EMPTY: StreamFeature[] = []

function featuresFromTopStream(streams: PreloadedStream[]): StreamFeature[] {
  for (const stream of streams.slice(0, SCAN_LIMIT)) {
    const features = detectStreamFeatures(stream)
    if (features.length > 0) return features
  }
  return []
}

/**
 * Tech-spec badges (4K, Dolby Vision, Atmos, CC…) for a detail page, read off
 * the top stream. Shares the detail page's existing DETAILS_OPEN preload — the
 * manager dedupes by media key, so this costs no extra addon calls.
 */
export function useStreamFeatures(request: StreamPreloadRequest | null): StreamFeature[] {
  // Keyed by media so a title switch reads as empty on the very first render,
  // without an effect that resets state and forces a second pass.
  const [resolved, setResolved] = useState<{ mediaKey: string; features: StreamFeature[] } | null>(null)
  const mediaKey = request ? canonicalStreamKey(request) : null

  useEffect(() => {
    if (!request || !mediaKey) return
    let cancelled = false
    const onUpdate = (streams: PreloadedStream[]) => {
      if (cancelled) return
      const next = featuresFromTopStream(streams)
      if (next.length === 0) return
      // Keep whatever the first responding addon gave us: later addons append
      // to the list and would otherwise make the row flicker between releases.
      setResolved((current) => (current?.mediaKey === mediaKey ? current : { mediaKey, features: next }))
    }
    streamPreloadManager
      .request(request, { priority: StreamPreloadPriority.DETAILS_OPEN, onUpdate })
      .then((streams) => onUpdate(streams))
      .catch(() => undefined)
    return () => { cancelled = true }
    // Keyed on the canonical media key so switching episode/title refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey])

  return resolved?.mediaKey === mediaKey ? resolved.features : EMPTY
}
