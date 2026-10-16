import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { subscribeLocalWatchlist } from '../services/localWatchlist'
import { tmdbProvider } from '../services/tmdb'
import { useAppStore } from '../stores/appStore'
import { buildUpcomingEvents, getUpcomingPreferences, hideUpcomingRelease, isReleaseInHorizon, releaseTiming, type ReleaseEvent } from '../services/upcoming'
import { loadUpcomingSeeds, upcomingProgressSignature } from '../services/upcomingSources'
import { readUpcomingEventsCache, writeUpcomingEventsCache } from '../services/upcomingCache'
import { getActiveProfileId } from '../services/profiles'
import { cachedImage, retryImageFromSource } from '../services/imageCache'

export default function UpcomingPage() {
  const navigate = useNavigate(); const [events, setEvents] = useState<ReleaseEvent[]>([]); const [loading, setLoading] = useState(true); const prefs = getUpcomingPreferences(); const loadGeneration = useRef(0)
  const watchProgress = useAppStore((state) => state.watchProgress)
  const progressSeedSignature = useMemo(
    () => upcomingProgressSignature(watchProgress.values()),
    [watchProgress],
  )
  const load = useCallback(() => {
    const generation = ++loadGeneration.current
    const profileId = getActiveProfileId()
    const preferences = getUpcomingPreferences(profileId)
    setLoading(true)
    void (async () => {
      try {
        const cached = await readUpcomingEventsCache(profileId, preferences)
        if (generation !== loadGeneration.current) return
        if (cached) setEvents(cached)
        const seeds = await loadUpcomingSeeds(preferences)
        if (generation !== loadGeneration.current) return
        const next = await buildUpcomingEvents({ ...seeds, preferences, getShow: (id) => tmdbProvider.getShow(`tmdb-${id}`), getSeason: (id, season) => tmdbProvider.getSeason(`tmdb-${id}`, season) })
        if (generation !== loadGeneration.current) return
        void writeUpcomingEventsCache(next, profileId, preferences)
        setEvents(next)
      } finally {
        if (generation === loadGeneration.current) setLoading(false)
      }
    })().catch((error) => { if (generation === loadGeneration.current) console.warn('[Upcoming] could not load releases:', error) })
  }, [])
  useEffect(() => {
    load()
    const unsubscribe = subscribeLocalWatchlist(load)
    return () => { loadGeneration.current += 1; unsubscribe() }
  }, [progressSeedSignature, load])
  const visible = events.filter((event) => !prefs.hidden[event.id] && (isReleaseInHorizon(event, prefs.horizonDays) || !event.releaseDate))
  return <main className="min-h-full px-6 py-10 text-white"><div className="mb-8"><p className="text-xs font-bold uppercase tracking-[.22em] text-accent">Personalized release tracking</p><h1 className="mt-2 text-4xl font-black tracking-tight">Upcoming</h1><p className="mt-2 text-sm text-white/55">New releases connected to what this profile watches and saves.</p></div>{loading ? <p className="text-white/50">Loading release metadata…</p> : visible.length === 0 ? <div className="rounded-2xl border border-dashed border-white/15 bg-white/[.03] p-10 text-center text-white/60">Nothing tracked yet. Watch shows or add titles to your watchlist and Aurales will track releases you care about.</div> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((event) => <article key={event.id} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[.04]"><div className="aspect-video bg-white/[.04]">{event.artwork && <img src={cachedImage(event.artwork, 'backdrop')} alt="" className="h-full w-full object-cover" onError={(e) => retryImageFromSource(e.currentTarget, event.artwork)} />}</div><div className="p-4"><div className="flex justify-between gap-3"><div><h2 className="font-bold">{event.media.title}</h2><p className="mt-1 text-sm text-white/65">{event.type === 'season' ? `Season ${event.seasonNumber}` : event.type === 'episode' ? `S${event.seasonNumber}E${event.episodeNumber}` : event.type === 'movie' ? 'Movie' : 'Episode'} · <span className="font-semibold text-accent">{releaseTiming(event.releaseDate)}</span></p><p className="mt-1 text-xs text-white/45">{event.relevanceReasons[0]}</p></div><button aria-label="Hide from Upcoming" onClick={() => { hideUpcomingRelease(event.id); setEvents((items) => items.filter((item) => item.id !== event.id)); load() }} className="h-8 rounded-lg px-2 text-xs text-white/50 hover:bg-white/10 hover:text-white">Hide</button></div><button onClick={() => { const routeId = event.media.tmdbId ? `tmdb-${String(event.media.tmdbId).replace(/^tmdb[-:]/i, '')}` : event.media.id; navigate(`/${event.media.type === 'movie' ? 'movie' : 'series'}/${routeId}`, { state: { ...event.media, backdrop: event.media.backdrop || event.artwork, poster: event.media.poster || event.artwork } }) }} className="mt-4 text-sm font-semibold text-white/80 hover:text-white">View details →</button></div></article>)}</div>}</main>
}
