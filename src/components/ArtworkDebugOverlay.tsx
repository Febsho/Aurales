import { useEffect, useState } from 'react'
import type { SearchResult } from '../types'
import { resolveArtFromProviders } from '../services/artwork'
import { useAppStore } from '../stores/appStore'

type ArtworkDebugDetail = {
  item: SearchResult
  displayed: { poster?: string; backdrop?: string; logo?: string }
  layers: {
    custom: { poster?: string; backdrop?: string; logo?: string }
    provider: { poster?: string; backdrop?: string }
    item: { poster?: string; backdrop?: string; logo?: string }
  }
}

function sourceName(url?: string): string {
  if (!url) return 'Not available'
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('fanart.tv')) return 'Fanart.tv'
    if (host.includes('thetvdb.com')) return 'TVDB'
    if (host.includes('tmdb.org')) return 'TMDB'
    if (host.includes('anilist')) return 'AniList'
    return host
  } catch {
    return 'Custom/local URL'
  }
}

function isCustom(url: string | undefined, custom: string | undefined) {
  return Boolean(url && custom && url === custom)
}

export default function ArtworkDebugOverlay() {
  const [detail, setDetail] = useState<ArtworkDebugDetail | null>(null)
  const artProviders = useAppStore((s) => s.artProviders)
  const [providerResult, setProviderResult] = useState<{ poster?: string; backdrop?: string; logo?: string }>({})

  useEffect(() => {
    const handler = (event: Event) => setDetail((event as CustomEvent<ArtworkDebugDetail>).detail)
    window.addEventListener('aurales:art-debug', handler)
    return () => window.removeEventListener('aurales:art-debug', handler)
  }, [])

  useEffect(() => {
    if (!detail) return
    let cancelled = false
    setProviderResult({})
    resolveArtFromProviders(
      detail.item.type === 'series' ? 'series' : 'movie',
      { tmdbId: detail.item.tmdbId, tvdbId: detail.item.tvdbId, imdbId: detail.item.imdbId },
      detail.item.isAnime,
    ).then((art) => { if (!cancelled) setProviderResult(art) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [detail])

  if (!detail) return null
  const prefix = detail.item.isAnime ? 'anime' : detail.item.type === 'series' ? 'series' : 'movie'
  const entries = [
    { label: 'Poster', value: detail.displayed.poster, custom: detail.layers.custom.poster, configured: artProviders[`${prefix}Poster` as keyof typeof artProviders], providerUrl: providerResult.poster, itemUrl: detail.layers.item.poster },
    { label: 'Background', value: detail.displayed.backdrop, custom: detail.layers.custom.backdrop, configured: artProviders[`${prefix}Backdrop` as keyof typeof artProviders], providerUrl: providerResult.backdrop, itemUrl: detail.layers.item.backdrop },
    { label: 'Logo', value: detail.displayed.logo, custom: detail.layers.custom.logo, configured: artProviders[`${prefix}Logo` as keyof typeof artProviders], providerUrl: providerResult.logo, itemUrl: detail.layers.item.logo },
  ]

  const copyReport = () => {
    const report = {
      title: detail.item.title,
      ids: { imdb: detail.item.imdbId, tmdb: detail.item.tmdbId, tvdb: detail.item.tvdbId, anilist: detail.item.anilistId, mal: detail.item.malId },
      artwork: entries.map(({ label, value, configured, providerUrl, itemUrl, custom }) => ({ label, displayed: value, detectedSource: sourceName(value), configuredProvider: configured, customOverride: custom, providerResolution: providerUrl, originalItemUrl: itemUrl })),
    }
    navigator.clipboard?.writeText(JSON.stringify(report, null, 2)).catch(() => undefined)
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" onMouseDown={() => setDetail(null)}>
      <section className="max-h-[85vh] w-full max-w-4xl overflow-auto rounded-2xl border border-cyan-300/30 bg-[#101217] p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.18em] text-cyan-300">Dev artwork inspector</p>
            <h2 className="mt-1 text-2xl font-bold text-white">{detail.item.title}</h2>
            <p className="mt-1 text-xs text-white/45">IMDb {detail.item.imdbId || '—'} · TMDB {detail.item.tmdbId || '—'} · TVDB {detail.item.tvdbId || '—'}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={copyReport} className="rounded-lg bg-cyan-300/15 px-3 py-2 text-xs font-bold text-cyan-100 hover:bg-cyan-300/25">Copy report</button>
            <button onClick={() => setDetail(null)} className="rounded-lg bg-white/10 px-3 py-2 text-xs font-bold text-white hover:bg-white/20">Close</button>
          </div>
        </div>
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.label} className="rounded-xl border border-white/10 bg-black/25 p-4">
              <div className="mb-2 flex items-center justify-between gap-4"><h3 className="font-bold text-white">{entry.label}</h3><span className="rounded bg-white/10 px-2 py-1 text-xs text-white/70">Configured: {entry.configured || 'TMDB fallback'}</span></div>
              <p className="text-xs font-semibold text-cyan-200">Displayed source: {isCustom(entry.value, entry.custom) ? 'Custom override' : sourceName(entry.value)}</p>
              <code className="mt-1 block break-all rounded bg-black/40 p-2 text-[11px] text-white/70">{entry.value || '—'}</code>
              <details className="mt-2 text-xs text-white/55"><summary className="cursor-pointer">Resolution details</summary><div className="mt-2 space-y-1"><p>Provider result: {sourceName(entry.providerUrl)}</p><code className="block break-all text-[10px] text-white/40">{entry.providerUrl || '—'}</code><p>Original item URL:</p><code className="block break-all text-[10px] text-white/40">{entry.itemUrl || '—'}</code></div></details>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-white/35">Open with Shift + right-click on any media card. This panel exists only in the development build.</p>
      </section>
    </div>
  )
}
