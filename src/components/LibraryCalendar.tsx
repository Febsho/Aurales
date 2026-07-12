import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { hasMdblistOAuth } from '../services/mdblist'
import { loadLibraryCalendar, type CalendarEntry } from '../services/libraryCalendar'

type CalendarView = 'month' | 'week' | 'agenda'
type MediaFilter = 'all' | 'movie' | 'episode'
type StateFilter = 'all' | 'upcoming' | 'released' | 'watched'

const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const keyForMonth = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
const keyForDate = (date: Date) => `${keyForMonth(date)}-${String(date.getDate()).padStart(2, '0')}`
const startOfWeek = (date: Date) => {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7))
  return result
}
const addDays = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount)
const monthCells = (month: Date) => Array.from({ length: 42 }, (_, index) => addDays(startOfWeek(new Date(month.getFullYear(), month.getMonth(), 1)), index))

function dayDistance(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const target = new Date(year, month - 1, day)
  const today = new Date()
  const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target.getTime() - localToday.getTime()) / 86_400_000)
}

function countdownLabel(date: string) {
  const days = dayDistance(date)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  return days > 0 ? `In ${days} days` : `${Math.abs(days)} days ago`
}

export default function LibraryCalendar() {
  const navigate = useNavigate()
  const watchProgress = useAppStore((state) => state.watchProgress)
  const traktConnected = useAppStore((state) => state.traktConnected)
  const simklConnected = useAppStore((state) => state.simklConnected)
  const anilistConnected = useAppStore((state) => state.anilistConnected)
  const mdblistConnected = Boolean(useAppStore((state) => state.mdblistApiKey)) || hasMdblistOAuth()
  const [anchor, setAnchor] = useState(() => new Date())
  const [view, setView] = useState<CalendarView>(() => (localStorage.getItem('aurales_calendar_view') as CalendarView) || 'month')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [entries, setEntries] = useState<CalendarEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<{ entry: CalendarEntry; x: number; y: number } | null>(null)

  const requestedMonths = useMemo(() => {
    if (view !== 'week') return [new Date(anchor.getFullYear(), anchor.getMonth(), 1)]
    const week = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor), index))
    return [...new Map(week.map((date) => [keyForMonth(date), new Date(date.getFullYear(), date.getMonth(), 1)])).values()]
  }, [anchor, view])

  useEffect(() => {
    localStorage.setItem('aurales_calendar_view', view)
  }, [view])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all(requestedMonths.map((month) => loadLibraryCalendar({ month, watchProgress, traktConnected, simklConnected, anilistConnected, mdblistConnected })))
      .then((results) => {
        if (cancelled) return
        const unique = new Map(results.flatMap((result) => result.entries).map((entry) => [entry.id, entry]))
        setEntries([...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)))
        setErrors(results.flatMap((result) => result.errors))
      })
      .catch((error) => { if (!cancelled) setErrors([error instanceof Error ? error.message : 'Could not load the calendar']) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [requestedMonths, watchProgress, traktConnected, simklConnected, anilistConnected, mdblistConnected])

  const filtered = useMemo(() => entries.filter((entry) => {
    if (mediaFilter !== 'all' && entry.kind !== mediaFilter) return false
    if (stateFilter === 'upcoming' && entry.releaseState !== 'upcoming' && entry.releaseState !== 'today') return false
    if (stateFilter === 'released' && entry.releaseState !== 'past' && entry.releaseState !== 'today') return false
    if (stateFilter === 'watched' && !entry.watched) return false
    return true
  }), [entries, mediaFilter, stateFilter])

  const entriesByDate = useMemo(() => filtered.reduce<Record<string, CalendarEntry[]>>((result, entry) => {
    ;(result[entry.date] ||= []).push(entry)
    return result
  }, {}), [filtered])

  const openEntry = (entry: CalendarEntry) => {
    const media = entry.media
    navigate(media.type === 'movie' ? `/movie/${media.id}` : `/series/${media.id}`, { state: { poster: media.poster, backdrop: media.backdrop, title: media.title, tmdbId: media.tmdbId, tvdbId: media.tvdbId, imdbId: media.imdbId, anilistId: media.anilistId, malId: media.malId } })
  }

  const showPreview = (entry: CalendarEntry, x: number, y: number) => {
    setPreview({ entry, x: Math.min(x + 16, window.innerWidth - 188), y: Math.min(y + 16, window.innerHeight - 312) })
  }

  const changePeriod = (direction: number) => {
    if (view === 'week') setAnchor((date) => addDays(date, direction * 7))
    else setAnchor((date) => new Date(date.getFullYear(), date.getMonth() + direction, 1))
  }

  const label = view === 'week'
    ? `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(startOfWeek(anchor))} - ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(addDays(startOfWeek(anchor), 6))}`
    : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(anchor)

  const renderEntry = (entry: CalendarEntry, compact = false) => (
    <button key={entry.id} type="button" onClick={() => openEntry(entry)} onMouseEnter={(event) => showPreview(entry, event.clientX, event.clientY)} onMouseMove={(event) => showPreview(entry, event.clientX, event.clientY)} onMouseLeave={() => setPreview(null)} className={`group flex w-full items-center gap-2 rounded-lg border text-left transition-all hover:border-accent/25 hover:bg-white/[0.10] ${compact ? 'border-transparent bg-white/[0.05] p-1.5' : 'border-white/[0.07] bg-white/[0.035] p-3'}`}>
      {entry.poster ? <img src={entry.poster} alt="" className={`${compact ? 'h-8 w-6' : 'h-16 w-11'} flex-none rounded object-cover`} loading="lazy" /> : <span className={`${compact ? 'h-8 w-6' : 'h-16 w-11'} flex-none rounded bg-white/[0.08]`} />}
      <span className="min-w-0 flex-1"><span className={`${compact ? 'text-[10px]' : 'text-sm'} block truncate font-bold text-white/82`}>{entry.title}</span><span className={`${compact ? 'text-[9px]' : 'text-xs'} block truncate text-white/38`}>{entry.subtitle}</span>{!compact && <span className="mt-1 block text-[10px] font-semibold text-accent/70">{countdownLabel(entry.date)}</span>}</span>
      {entry.watched && <span className="flex-none rounded-full bg-emerald-400/15 px-2 py-1 text-[9px] font-bold text-emerald-300">Watched</span>}
    </button>
  )

  const monthDates = monthCells(anchor)
  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor), index))
  const visibleDates = view === 'week' ? weekDates : monthDates
  const today = keyForDate(new Date())

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-lg font-bold text-white">Release Calendar</h2><p className="mt-1 text-xs text-white/35">Releases from your watchlists and active tracking.</p></div>
        <div className="flex rounded-xl border border-white/[0.08] bg-black/20 p-1">{(['month', 'week', 'agenda'] as CalendarView[]).map((item) => <button key={item} type="button" onClick={() => setView(item)} className={`rounded-lg px-3 py-1.5 text-[11px] font-bold capitalize transition-all ${view === item ? 'bg-accent/15 text-accent' : 'text-white/35 hover:text-white/70'}`}>{item}</button>)}</div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {([['all', 'All'], ['movie', 'Movies'], ['episode', 'Episodes']] as [MediaFilter, string][]).map(([value, text]) => <button key={value} onClick={() => setMediaFilter(value)} className={`rounded-lg border px-3 py-1.5 text-[10px] font-bold ${mediaFilter === value ? 'border-accent/25 bg-accent/12 text-accent' : 'border-white/[0.06] bg-white/[0.03] text-white/35'}`}>{text}</button>)}
          {([['all', 'Any state'], ['upcoming', 'Upcoming'], ['released', 'Released'], ['watched', 'Watched']] as [StateFilter, string][]).map(([value, text]) => <button key={value} onClick={() => setStateFilter(value)} className={`rounded-lg border px-3 py-1.5 text-[10px] font-bold ${stateFilter === value ? 'border-accent/25 bg-accent/12 text-accent' : 'border-white/[0.06] bg-white/[0.03] text-white/35'}`}>{text}</button>)}
        </div>
        <div className="flex items-center gap-2"><button onClick={() => changePeriod(-1)} className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-white/65">&lt;</button><button onClick={() => setAnchor(new Date())} className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs font-bold text-white/70">Today</button><button onClick={() => changePeriod(1)} className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-white/65">&gt;</button></div>
      </div>

      <h3 className="mb-3 text-center text-base font-bold text-white/85">{label}</h3>
      {errors.length > 0 && <p className="mb-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/75">Some sources could not be loaded. Available releases are still shown.</p>}

      {view !== 'agenda' ? <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-white/[0.07]">
        {weekdayNames.map((name) => <div key={name} className="border-b border-white/[0.07] bg-white/[0.035] px-1 py-2 text-center text-[10px] font-bold uppercase tracking-wide text-white/35 sm:text-xs">{name}</div>)}
        {visibleDates.map((date) => {
          const key = keyForDate(date)
          const dayEntries = entriesByDate[key] || []
          const visibleMonth = keyForMonth(date) === keyForMonth(anchor)
          const expanded = expandedDates.has(key)
          return <div key={key} className={`${view === 'week' ? 'min-h-64' : 'min-h-24 sm:min-h-32'} border-b border-r border-white/[0.06] p-1.5 sm:p-2 ${visibleMonth || view === 'week' ? 'bg-black/[0.08]' : 'bg-black/[0.22]'}`}>
            <div className={`mb-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[10px] font-bold ${key === today ? 'bg-accent text-black' : visibleMonth ? 'text-white/55' : 'text-white/20'}`}>{date.getDate()}</div>
            <div className="space-y-1">{dayEntries.slice(0, expanded || view === 'week' ? undefined : 3).map((entry) => renderEntry(entry, true))}{dayEntries.length > 3 && view !== 'week' && <button onClick={() => setExpandedDates((current) => { const next = new Set(current); expanded ? next.delete(key) : next.add(key); return next })} className="px-1 text-[9px] font-bold text-accent/80">{expanded ? 'Show less' : `+${dayEntries.length - 3} more`}</button>}</div>
          </div>
        })}
      </div> : <div className="space-y-5">{Object.entries(entriesByDate).map(([date, dayEntries]) => <div key={date}><div className="mb-2 flex items-center gap-3"><p className="text-sm font-bold text-white/75">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${date}T12:00:00`))}</p><span className="text-[10px] font-semibold text-accent/70">{countdownLabel(date)}</span><span className="h-px flex-1 bg-white/[0.06]" /></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{dayEntries.map((entry) => renderEntry(entry))}</div></div>)}</div>}

      {!loading && filtered.length === 0 && <div className="py-12 text-center text-sm text-white/35">No releases match these filters.</div>}
      {loading && <div className="py-5 text-center text-sm text-white/35">Loading your release calendar...</div>}
      {preview && <div className="pointer-events-none fixed z-[100] w-40 overflow-hidden rounded-xl border border-white/15 bg-[#12141b] shadow-2xl shadow-black/70" style={{ left: preview.x, top: preview.y }}>{preview.entry.poster ? <img src={preview.entry.poster} alt="" className="h-52 w-full object-cover" /> : <div className="h-52 bg-white/[0.06]" />}<div className="p-2.5"><p className="truncate text-xs font-bold text-white">{preview.entry.title}</p><p className="mt-1 text-[10px] text-white/45">{preview.entry.subtitle}</p><p className="mt-1 text-[10px] font-semibold text-accent/70">{countdownLabel(preview.entry.date)}</p></div></div>}
    </section>
  )
}
