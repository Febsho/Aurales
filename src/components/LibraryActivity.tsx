import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { enrichViewingActivityGenres, seedViewingActivity, subscribeViewingActivity, summarizeViewingActivity, type ActivityMediaType } from '../services/viewingActivity'
import ConnectedHistory from './ConnectedHistory'

type Range = '7d' | '30d' | '12m' | 'all'
type Media = 'all' | ActivityMediaType

function durationLabel(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

export default function LibraryActivity() {
  const watchProgress = useAppStore((state) => state.watchProgress)
  const [range, setRange] = useState<Range>('30d')
  const [media, setMedia] = useState<Media>('all')
  const [revision, setRevision] = useState(0)
  const [activityView, setActivityView] = useState<'local' | 'connected'>('local')

  useEffect(() => {
    const unsubscribe = subscribeViewingActivity(() => setRevision((value) => value + 1))
    seedViewingActivity(watchProgress)
    enrichViewingActivityGenres().catch(() => {})
    return unsubscribe
  }, [watchProgress])

  const summary = useMemo(() => summarizeViewingActivity(range, media), [range, media, revision])
  const maxDaily = Math.max(1, ...summary.daily.map((day) => day.seconds))
  const totalByType = Math.max(1, Object.values(summary.mediaSeconds).reduce((sum, value) => sum + value, 0))
  const trackedSince = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(summary.trackingStartedAt))

  return (
    <>
      <div className="mb-5 ml-3 inline-flex rounded-xl border border-white/[0.07] bg-white/[0.03] p-1">
        <button onClick={() => setActivityView('local')} className={`rounded-lg px-4 py-2 text-xs font-bold transition-all ${activityView === 'local' ? 'bg-accent/15 text-accent' : 'text-white/35 hover:text-white/65'}`}>Local Activity</button>
        <button onClick={() => setActivityView('connected')} className={`rounded-lg px-4 py-2 text-xs font-bold transition-all ${activityView === 'connected' ? 'bg-accent/15 text-accent' : 'text-white/35 hover:text-white/65'}`}>Connected History</button>
      </div>
      {activityView === 'connected' ? <ConnectedHistory /> : <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.05] to-accent/[0.04] p-5 sm:p-6">
        <div><h2 className="text-lg font-bold text-white">Viewing Activity</h2><p className="mt-1 text-xs text-white/35">Private statistics from playback inside Aurales.</p></div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-xl border border-white/[0.08] bg-black/20 p-1">{(['7d', '30d', '12m', 'all'] as Range[]).map((value) => <button key={value} onClick={() => setRange(value)} className={`rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase ${range === value ? 'bg-accent/15 text-accent' : 'text-white/35 hover:text-white/65'}`}>{value}</button>)}</div>
          <div className="flex rounded-xl border border-white/[0.08] bg-black/20 p-1">{(['all', 'movie', 'series', 'anime'] as Media[]).map((value) => <button key={value} onClick={() => setMedia(value)} className={`rounded-lg px-3 py-1.5 text-[10px] font-bold capitalize ${media === value ? 'bg-accent/15 text-accent' : 'text-white/35 hover:text-white/65'}`}>{value}</button>)}</div>
        </div>
      </div>

      {summary.containsEstimates && <div className="rounded-xl border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-100/65">Older totals include estimates seeded from saved progress. Accurate playback tracking began {trackedSince}.</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ['Time watched', durationLabel(summary.totalSeconds)],
          ['Completed', String(summary.completions)],
          ['Active days', String(summary.activeDays)],
          ['Current streak', `${summary.currentStreak} days`],
          ['Best streak', `${summary.longestStreak} days`],
        ].map(([label, value]) => <div key={label} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-white/30">{label}</p><p className="mt-2 text-xl font-black text-white/85">{value}</p></div>)}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
          <div className="mb-5 flex items-center justify-between"><div><h3 className="text-sm font-bold text-white/80">Watch time</h3><p className="mt-1 text-[10px] text-white/30">Minutes watched by active day</p></div><span className="text-xs font-bold text-accent/75">{durationLabel(summary.totalSeconds)}</span></div>
          {summary.daily.length ? <div className="flex h-44 items-end gap-1.5">{summary.daily.slice(range === '7d' ? -7 : range === '30d' ? -30 : -90).map((day) => <div key={day.date} title={`${day.date}: ${durationLabel(day.seconds)}`} className="group flex min-w-0 flex-1 items-end"><div className="w-full min-h-1 rounded-t bg-accent/35 transition-colors group-hover:bg-accent" style={{ height: `${Math.max(3, day.seconds / maxDaily * 100)}%` }} /></div>)}</div> : <div className="grid h-44 place-items-center text-sm text-white/25">Watch something to start your activity chart.</div>}
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
          <h3 className="text-sm font-bold text-white/80">Content mix</h3>
          <div className="mt-5 space-y-4">{(['movie', 'series', 'anime'] as ActivityMediaType[]).map((type) => { const seconds = summary.mediaSeconds[type]; const percent = seconds / totalByType * 100; return <div key={type}><div className="mb-1.5 flex justify-between text-xs"><span className="capitalize text-white/55">{type}</span><span className="font-semibold text-white/35">{durationLabel(seconds)}</span></div><div className="h-2 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-accent/65" style={{ width: `${percent}%` }} /></div></div> })}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5"><h3 className="text-sm font-bold text-white/80">Top titles</h3><div className="mt-4 space-y-2">{summary.topTitles.length ? summary.topTitles.map((item, index) => <div key={item.mediaKey} className="flex items-center gap-3 rounded-xl bg-white/[0.025] p-2.5"><span className="w-5 text-center text-xs font-black text-white/20">{index + 1}</span>{item.poster ? <img src={item.poster} alt="" className="h-12 w-8 rounded object-cover" /> : <div className="h-12 w-8 rounded bg-white/[0.06]" />}<div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-white/75">{item.title}</p><p className="mt-1 text-[10px] capitalize text-white/30">{item.mediaType}{item.completions ? ` · ${item.completions} completed` : ''}</p></div><span className="text-[11px] font-bold text-accent/70">{durationLabel(item.seconds)}</span></div>) : <p className="py-10 text-center text-sm text-white/25">No titles tracked yet.</p>}</div></div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5"><h3 className="text-sm font-bold text-white/80">Favorite genres</h3><div className="mt-5 space-y-3">{summary.topGenres.length ? summary.topGenres.map((item) => <div key={item.genre}><div className="mb-1.5 flex justify-between text-xs"><span className="text-white/55">{item.genre}</span><span className="text-white/30">{durationLabel(item.seconds)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-accent/55" style={{ width: `${item.seconds / summary.topGenres[0].seconds * 100}%` }} /></div></div>) : <p className="py-10 text-center text-sm text-white/25">Genre insights appear as tracked titles are enriched.</p>}</div></div>
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5"><h3 className="text-sm font-bold text-white/80">Recent activity</h3><div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{summary.recent.map((record) => <div key={record.id} className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-white/[0.025] p-3">{record.poster ? <img src={record.poster} alt="" className="h-14 w-10 rounded object-cover" /> : <div className="h-14 w-10 rounded bg-white/[0.06]" />}<div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-white/75">{record.title}</p><p className="mt-1 text-[10px] text-white/30">{record.date}{record.season != null ? ` · S${record.season} E${record.episode}` : ''}</p><p className="mt-1 text-[10px] font-semibold text-accent/65">{durationLabel(record.seconds)}{record.estimated ? ' estimated' : ''}</p></div></div>)}</div>{summary.recent.length === 0 && <p className="py-10 text-center text-sm text-white/25">Your recent playback will appear here.</p>}</div>
      </section>}
    </>
  )
}
