import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { subscribeLocalWatchlist } from '../services/localWatchlist'
import { tmdbProvider } from '../services/tmdb'
import { buildUpcomingEvents, getUpcomingPreferences, isReleaseInHorizon, releaseTiming, type ReleaseEvent } from '../services/upcoming'
import { loadUpcomingSeeds } from '../services/upcomingSources'
import { readUpcomingEventsCache, writeUpcomingEventsCache } from '../services/upcomingCache'

/** A landscape shelf deliberately sharing Continue Watching's size, controls, and card treatment. */
export default function UpcomingHomeRow() {
  const navigate = useNavigate()
  const progress = useAppStore((s) => s.watchProgress)
  const posterSize = useAppStore((s) => s.posterSize)
  const [events, setEvents] = useState<ReleaseEvent[]>([])
  const [preferencesRevision, setPreferencesRevision] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prefs = getUpcomingPreferences()
  // Upcoming is a primary, landscape Home shelf. Keep it larger than poster
  // rows at every density, while still respecting the user's size preference.
  const width = posterSize === 'compact' ? 'w-[300px]' : posterSize === 'large' ? 'w-[400px]' : posterSize === 'huge' ? 'w-[480px]' : 'w-[336px]'

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const cached = await readUpcomingEventsCache()
      if (cached && !cancelled) setEvents(cached)
      const seeds = await loadUpcomingSeeds(getUpcomingPreferences())
      const next = await buildUpcomingEvents({ ...seeds, getShow: (id) => tmdbProvider.getShow(`tmdb-${id}`), getSeason: (id, season) => tmdbProvider.getSeason(`tmdb-${id}`, season) })
      void writeUpcomingEventsCache(next)
      if (!cancelled) setEvents(next)
    }
    void load()
    return () => { cancelled = true }
  }, [progress, preferencesRevision])
  useEffect(() => {
    const refresh = () => setPreferencesRevision((value) => value + 1)
    window.addEventListener('aurales:upcoming-preferences-changed', refresh)
    return () => window.removeEventListener('aurales:upcoming-preferences-changed', refresh)
  }, [])
  useEffect(() => subscribeLocalWatchlist(() => {
    void loadUpcomingSeeds(getUpcomingPreferences())
      .then((seeds) => buildUpcomingEvents({
        ...seeds,
        getShow: (id) => tmdbProvider.getShow(`tmdb-${id}`),
        getSeason: (id, season) => tmdbProvider.getSeason(`tmdb-${id}`, season),
      }))
      .then((events) => { void writeUpcomingEventsCache(events); setEvents(events) })
  }), [])

  const visible = events.filter((event) => isReleaseInHorizon(event, prefs.horizonDays)).slice(0, 12)
  const scroll = (direction: number) => scrollRef.current?.scrollBy({ left: direction * Math.max(640, Math.floor(scrollRef.current.clientWidth * 0.85)), behavior: 'smooth' })

  return <section className="mb-8">
    <div className="mb-4 flex items-center justify-between px-6">
      <div><h2 className="text-xl font-bold tracking-tight text-white">Upcoming</h2><p className="mt-0.5 text-xs text-white/45">Personalized releases in the next {prefs.horizonDays} days</p></div>
      <div className="flex items-center gap-3"><button onClick={() => navigate('/upcoming')} className="text-sm font-semibold text-white/65 hover:text-white">View all</button><button aria-label="Scroll upcoming left" onClick={() => scroll(-1)} className="rounded-full bg-white/[.08] p-2 text-white/75 hover:bg-white/[.14]">‹</button><button aria-label="Scroll upcoming right" onClick={() => scroll(1)} className="rounded-full bg-white/[.08] p-2 text-white/75 hover:bg-white/[.14]">›</button></div>
    </div>
    {visible.length === 0 ? <div className="mx-6 rounded-xl border border-dashed border-white/[.12] bg-white/[.025] px-5 py-6 text-sm text-white/55">No releases are scheduled in the next {prefs.horizonDays} days for your tracked titles yet.</div> : <div ref={scrollRef} className="cw-track flex gap-4 overflow-x-auto px-6 pb-2" style={{ scrollbarWidth: 'none' }}>
      {visible.map((event) => <button key={event.id} onClick={() => {
        const routeId = event.media.tmdbId ? `tmdb-${String(event.media.tmdbId).replace(/^tmdb[-:]/i, '')}` : event.media.id
        navigate(`/${event.media.type === 'movie' ? 'movie' : 'series'}/${routeId}`, { state: { ...event.media, backdrop: event.media.backdrop || event.artwork, poster: event.media.poster || event.artwork } })
      }} className={`snap-start relative group ${width} flex-shrink-0 cursor-pointer text-left focus:outline-none`}>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-white/[.05] transition-all duration-300 ease-out group-hover:shadow-[0_8px_32px_rgba(0,0,0,0.5)] group-focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.5)]">{event.artwork && <img src={event.artwork} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] group-focus-within:scale-[1.04]" />}<div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent transition-opacity duration-300 group-hover:from-black/95 group-hover:via-black/35" />
          <div className="absolute inset-x-0 bottom-0 z-10 p-3 transition-transform duration-300 group-hover:-translate-y-1 group-focus-within:-translate-y-1"><p className="truncate text-sm font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{event.media.title}</p><div className="mt-1 flex items-center gap-1.5 text-xs opacity-80 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100"><span className="rounded bg-white/20 px-1.5 py-0.5 font-bold text-white/85">{event.type === 'season' ? `SEASON ${event.seasonNumber}` : event.type === 'episode' ? `S${event.seasonNumber} E${event.episodeNumber}` : 'MOVIE'}</span><span className="font-semibold text-white/80">{releaseTiming(event.releaseDate)}</span></div></div>
        </div>
      </button>)}
    </div>}
  </section>
}
