import { useState, useEffect } from 'react'
import type { StreamResult } from '../types'
import { useAppStore } from '../stores/appStore'
import { getAddonStreams, getInstalledAddons } from '../services/addons'
import { launchPlayer } from '../services/player'

interface AddonStream extends StreamResult {
  addonName: string
  addonId: string
}

interface StreamSelectorProps {
  open: boolean
  onClose: () => void
  mediaType: 'movie' | 'series'
  mediaId: string
  title: string
  seasonEpisode?: { season: number; episode: number }
}

export default function StreamSelector({ open, onClose, mediaType, mediaId, title, seasonEpisode }: StreamSelectorProps) {
  const [streams, setStreams] = useState<AddonStream[]>([])
  const [loading, setLoading] = useState(true)
  const addons = useAppStore((s) => s.addons)

  useEffect(() => {
    if (!open) return
    setStreams([])
    setLoading(true)

    const installed = getInstalledAddons()
    const storeAddons = addons.filter((a) => a.enabled)
    const allAddons = installed.length > 0 ? installed : storeAddons

    const streamId = seasonEpisode
      ? `${mediaId}:${seasonEpisode.season}:${seasonEpisode.episode}`
      : mediaId

    const fetches = allAddons
      .filter((a) => a.manifest.resources.includes('stream'))
      .map(async (addon) => {
        try {
          const results = await getAddonStreams(addon.url, mediaType, streamId)
          return results.map((s) => ({
            ...s,
            addonName: addon.manifest.name,
            addonId: addon.manifest.id,
          }))
        } catch {
          return []
        }
      })

    Promise.all(fetches).then((results) => {
      setStreams(results.flat())
      setLoading(false)
    })
  }, [open, mediaId, mediaType, seasonEpisode, addons])

  if (!open) return null

  const handlePlay = (stream: AddonStream) => {
    const url = stream.url || (stream.infoHash ? `magnet:?xt=urn:btih:${stream.infoHash}` : '')
    if (url) {
      launchPlayer({ url, title })
      onClose()
    }
  }

  const displayTitle = seasonEpisode
    ? `${title} S${seasonEpisode.season}E${seasonEpisode.episode}`
    : title

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface-elevated border border-border-subtle rounded-2xl w-full max-w-lg max-h-[70vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <div>
            <h2 className="text-base font-semibold">Select Stream</h2>
            <p className="text-xs text-muted truncate max-w-sm">{displayTitle}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-hover transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted">Fetching streams from addons...</p>
            </div>
          )}

          {!loading && streams.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-muted mb-1">No streams found</p>
              <p className="text-xs text-muted">Install addons with stream support in Settings</p>
            </div>
          )}

          {!loading && streams.map((stream, i) => (
            <button
              key={`${stream.addonId}-${i}`}
              onClick={() => handlePlay(stream)}
              className="w-full flex items-center gap-3 p-3 bg-surface hover:bg-surface-hover rounded-xl transition-colors text-left group"
            >
              <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
                <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {stream.name || stream.title || `Stream ${i + 1}`}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="px-1.5 py-0.5 bg-white/5 rounded text-[10px]">{stream.addonName}</span>
                  {stream.infoHash && <span>Torrent</span>}
                  {stream.behaviorHints?.bingeGroup != null && (
                    <span>{String(stream.behaviorHints.bingeGroup as string)}</span>
                  )}
                </div>
              </div>
              <svg className="w-4 h-4 text-muted group-hover:text-accent transition-colors flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
