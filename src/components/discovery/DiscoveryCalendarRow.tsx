import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { WatchProgress } from '../../types'
import { calendarProgressSignature, loadLibraryCalendar, type CalendarEntry } from '../../services/libraryCalendar'
import { hasMdblistOAuth } from '../../services/mdblist'
import { localDateKey } from '../../services/localDate'

interface DiscoveryCalendarRowProps {
  watchProgress: Map<string, WatchProgress>
  traktConnected: boolean
  simklConnected: boolean
  anilistConnected: boolean
  mdblistApiKey: string
}

type CalendarRange = 'today' | '30-days'

function markCalendarArtworkLoaded(event: import('react').SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.dataset.artworkLoaded = 'true'
}

function markCalendarArtworkFailed(event: import('react').SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.dataset.artworkFailed = 'true'
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() + days)
  return result
}

export default function DiscoveryCalendarRow({ watchProgress, traktConnected, simklConnected, anilistConnected, mdblistApiKey }: DiscoveryCalendarRowProps) {
  const navigate = useNavigate()
  const progressSignature = useMemo(() => calendarProgressSignature(watchProgress), [watchProgress])
  const today = localDateKey()
  const [range, setRange] = useState<CalendarRange>('30-days')
  const [entries, setEntries] = useState<CalendarEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [serverRevision, setServerRevision] = useState(0)
  const [selectedDate, setSelectedDate] = useState(today)
  const horizon = localDateKey(addDays(new Date(), 30))
  const mdblistConnected = Boolean(mdblistApiKey.trim()) || hasMdblistOAuth()

  useEffect(() => {
    const refresh = () => setServerRevision((current) => current + 1)
    window.addEventListener('aurales:server-catalogs-changed', refresh)
    return () => window.removeEventListener('aurales:server-catalogs-changed', refresh)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const months = [new Date(), addDays(new Date(), 30)]
      .map((date) => new Date(date.getFullYear(), date.getMonth(), 1))
      .filter((date, index, all) => all.findIndex((item) => item.getFullYear() === date.getFullYear() && item.getMonth() === date.getMonth()) === index)
    Promise.all(months.map((month) => loadLibraryCalendar({ month, watchProgress, traktConnected, simklConnected, anilistConnected, mdblistConnected, serverRevision })))
      .then((results) => {
        if (cancelled) return
        const unique = new Map(results.flatMap((result) => result.entries).map((entry) => [entry.id, entry]))
        setEntries([...unique.values()].filter((entry) => entry.date >= today && entry.date <= horizon).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)))
      })
      .catch(() => { if (!cancelled) setEntries([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // Progress signature intentionally tracks calendar-relevant identities, not playback position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressSignature, traktConnected, simklConnected, anilistConnected, mdblistConnected, serverRevision, today, horizon])

  const visibleEntries = range === 'today' ? entries.filter((entry) => entry.date === today) : entries
  const visibleDates = [...new Set(visibleEntries.map((entry) => entry.date))].slice(0, 6)
  const activeDate = visibleDates.includes(selectedDate) ? selectedDate : visibleDates[0] ?? today
  const selectedEntries = visibleEntries.filter((entry) => entry.date === activeDate)
  const dateLabel = range === 'today'
    ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())
    : `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date())} – ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(addDays(new Date(), 30))}`
  const emptyLabel = visibleEntries.length > 0
    ? ''
    : range === 'today'
      ? 'No releases scheduled today.'
      : 'No upcoming releases in the next 30 days.'
  const openCalendarButton = <button type="button" className="discover-calendar__open" onClick={() => navigate('/collections?tab=calendar')}>Open calendar <span aria-hidden="true">›</span></button>

  return <section className="discover-calendar row-contain" aria-labelledby="discover-calendar-title" aria-busy={loading}>
    <div className="discover-calendar__heading">
      <div><h2 id="discover-calendar-title">Calendar</h2><p>{dateLabel}</p></div>
      <div className="discover-calendar__actions" role="group" aria-label="Calendar range">
        <button type="button" aria-pressed={range === 'today'} onClick={() => { setRange('today'); setSelectedDate(today) }}>Today</button>
        <button type="button" aria-pressed={range === '30-days'} onClick={() => { setRange('30-days'); setSelectedDate(entries[0]?.date ?? today) }}>Next 30 days</button>
      </div>
    </div>
    {visibleEntries.length > 0 ? <div className="discover-calendar__content">
      <div className="discover-calendar__dates" role="group" aria-label="Release dates">
        {visibleDates.map((date) => {
          const dateValue = new Date(`${date}T12:00:00`)
          const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(dateValue)
          const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(dateValue)
          return <button key={date} type="button" className="discover-calendar__date-button" aria-pressed={date === activeDate} aria-label={`${date === today ? 'Today, ' : ''}${weekday}, ${day}`} onClick={() => setSelectedDate(date)}>
            <span>{date === today ? 'Today' : weekday}</span><strong>{new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(dateValue)}</strong>
          </button>
        })}
      </div>
      <div className="discover-calendar__items" aria-live="polite">
        {selectedEntries.slice(0, 8).map((entry) => <button key={entry.id} type="button" className="discover-calendar__item" onClick={() => navigate(entry.media.type === 'movie' ? `/movie/${entry.media.id}` : `/series/${entry.media.id}`)} aria-label={`${entry.title}, ${entry.subtitle || entry.date}`}>
          <span className="discover-calendar__poster">{entry.poster && <img src={entry.poster} alt="" loading="lazy" decoding="async" onLoad={markCalendarArtworkLoaded} onError={markCalendarArtworkFailed} />}
            <span className="discover-calendar__date"><strong>{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${entry.date}T12:00:00`))}</strong></span>
            <span className="discover-calendar__details"><strong>{entry.title}</strong><small>{entry.subtitle || (entry.kind === 'episode' ? 'New episode' : 'Movie')}</small></span>
          </span>
        </button>)}
      </div>
    </div> : <div className="discover-calendar__empty-row">
      <p className="discover-calendar__empty" role="status">{loading ? 'Checking your upcoming releases…' : emptyLabel}</p>
      {openCalendarButton}
    </div>}
    {visibleEntries.length > 0 && openCalendarButton}
  </section>
}
