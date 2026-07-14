import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { hasMdblistOAuth } from '../services/mdblist'
import { enrichConnectedHistoryItems, estimateConnectedHistoryRuntime, loadConnectedHistory, persistConnectedHistorySnapshot, type ConnectedHistoryItem, type ConnectedHistoryMediaType, type ConnectedHistorySource } from '../services/connectedActivity'
import { getStremioAuth } from '../services/stremio'

const STORAGE_KEY = 'aurales_activity_history_sources'
const sourceLabels: Record<ConnectedHistorySource, string> = { trakt: 'Trakt', simkl: 'Simkl', anilist: 'AniList', pmdb: 'PMDB', mdblist: 'MDBList', stremio: 'Stremio' }
const sourceColors: Record<ConnectedHistorySource, string> = { trakt: 'text-red-300 bg-red-400/10 border-red-400/15', simkl: 'text-sky-300 bg-sky-400/10 border-sky-400/15', anilist: 'text-blue-300 bg-blue-400/10 border-blue-400/15', pmdb: 'text-purple-300 bg-purple-400/10 border-purple-400/15', mdblist: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/15', stremio: 'text-violet-300 bg-violet-400/10 border-violet-400/15' }
const PAGE_SIZE = 18

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const remainder = Math.round(minutes % 60)
  return hours ? `${hours.toLocaleString()}h${remainder ? ` ${remainder}m` : ''}` : `${remainder}m`
}

function localDateKey(value: string | number | Date) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function streaks(items: ConnectedHistoryItem[]) {
  const dates = [...new Set(items.flatMap((item) => item.watchedDates?.length ? item.watchedDates : item.watchedAt ? [item.watchedAt] : []).map(localDateKey))].sort()
  let longest = 0
  let running = 0
  let previous = ''
  for (const date of dates) {
    const expected = previous ? localDateKey(new Date(`${previous}T12:00:00`).getTime() + 86_400_000) : ''
    running = previous && date === expected ? running + 1 : 1
    longest = Math.max(longest, running)
    previous = date
  }
  const dateSet = new Set(dates)
  let cursor = new Date()
  if (!dateSet.has(localDateKey(cursor)) && dateSet.has(localDateKey(Date.now() - 86_400_000))) cursor = new Date(Date.now() - 86_400_000)
  let current = 0
  while (dateSet.has(localDateKey(cursor))) { current += 1; cursor = new Date(cursor.getTime() - 86_400_000) }
  return { current, longest }
}

function readSelection() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as ConnectedHistorySource[] } catch (_) { return [] }
}

export default function ConnectedHistory() {
  const navigate = useNavigate()
  const traktConnected = useAppStore((state) => state.traktConnected)
  const simklConnected = useAppStore((state) => state.simklConnected)
  const anilistConnected = useAppStore((state) => state.anilistConnected)
  const pmdbConnected = Boolean(useAppStore((state) => state.pmdbApiKey))
  const mdblistConnected = Boolean(useAppStore((state) => state.mdblistApiKey)) || hasMdblistOAuth()
  const stremioConnected = Boolean(getStremioAuth()?.authKey)
  const connected = useMemo(() => ([traktConnected && 'trakt', simklConnected && 'simkl', anilistConnected && 'anilist', pmdbConnected && 'pmdb', mdblistConnected && 'mdblist', stremioConnected && 'stremio'].filter(Boolean) as ConnectedHistorySource[]), [traktConnected, simklConnected, anilistConnected, pmdbConnected, mdblistConnected, stremioConnected])
  const [selected, setSelected] = useState<ConnectedHistorySource[]>(readSelection)
  const [items, setItems] = useState<ConnectedHistoryItem[]>([])
  const [errors, setErrors] = useState<Partial<Record<ConnectedHistorySource, string>>>({})
  const [counts, setCounts] = useState<Partial<Record<ConnectedHistorySource, number>>>({})
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [media, setMedia] = useState<'all' | ConnectedHistoryMediaType>('all')
  const [refreshToken, setRefreshToken] = useState(0)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [enrichingPosters, setEnrichingPosters] = useState(false)
  const [runtimeProgress, setRuntimeProgress] = useState({ completed: 0, total: 0 })

  useEffect(() => {
    setSelected((current) => {
      const available = current.filter((source) => connected.includes(source))
      return available.length || connected.length === 0 ? available : connected
    })
  }, [connected])

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)) }, [selected])

  useEffect(() => {
    if (!selected.length) { setItems([]); setErrors({}); return }
    let cancelled = false
    setLoading(true)
    setItems([])
    setRuntimeProgress({ completed: 0, total: 0 })
    loadConnectedHistory(selected, refreshToken > 0).then((result) => {
      if (cancelled) return
      setItems(result.items); setErrors(result.errors); setCounts(result.sourceCounts)
    }).catch((error) => { if (!cancelled) setErrors({ [selected[0]]: error instanceof Error ? error.message : 'Could not load history' }) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selected, refreshToken])

  const filtered = useMemo(() => items.filter((item) => {
    if (media !== 'all' && item.mediaType !== media) return false
    return !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase())
  }), [items, media, query])
  const statsItems = useMemo(() => items.filter((item) => media === 'all' || item.mediaType === media), [items, media])
  const visibleItems = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const visibleKey = visibleItems.map((item) => item.id).join('|')
  const runtimeKey = items.map((item) => `${item.id}:${item.watchedCount}`).join('|')
  const overlaps = items.filter((item) => item.sources.length > 1).length

  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [query, media, selected])

  useEffect(() => {
    const missing = visibleItems.filter((item) => !item.poster || !item.title)
    if (!missing.length) return
    let cancelled = false
    setEnrichingPosters(true)
    enrichConnectedHistoryItems(missing).then((enriched) => {
      if (cancelled) return
      const updates = new Map(enriched.map((item) => [item.id, item]))
      setItems((current) => {
        const next = current.map((item) => { const update = updates.get(item.id); return update ? { ...item, ...update, runtimeMinutes: item.runtimeMinutes || update.runtimeMinutes, genres: item.genres?.length ? item.genres : update.genres } : item })
        void persistConnectedHistorySnapshot(selected, next)
        return next
      })
    }).finally(() => { if (!cancelled) setEnrichingPosters(false) })
    return () => { cancelled = true }
  }, [visibleKey])

  useEffect(() => {
    if (!items.length || items.every((item) => item.runtimeMinutes != null || !item.tmdbId)) return
    let cancelled = false
    const updates = new Map<string, ConnectedHistoryItem>()
    estimateConnectedHistoryRuntime(items, (completed, total, item) => {
      if (cancelled) return
      updates.set(item.id, item)
      setRuntimeProgress({ completed, total })
      if (completed % 8 === 0 || completed === total) {
        setItems((current) => current.map((entry) => { const update = updates.get(entry.id); return update ? { ...entry, runtimeMinutes: update.runtimeMinutes, genres: update.genres?.length ? update.genres : entry.genres } : entry }))
        updates.clear()
      }
    }).then((enriched) => {
      if (cancelled) return
      const updates = new Map(enriched.map((item) => [item.id, item]))
      setItems((current) => {
        const next = current.map((item) => {
          const update = updates.get(item.id)
          return update ? { ...item, runtimeMinutes: update.runtimeMinutes, genres: update.genres?.length ? update.genres : item.genres } : item
        })
        void persistConnectedHistorySnapshot(selected, next)
        return next
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [runtimeKey])

  const moviePlays = statsItems.filter((item) => item.mediaType === 'movie').reduce((sum, item) => sum + item.watchedCount, 0)
  const episodePlays = statsItems.filter((item) => item.mediaType !== 'movie').reduce((sum, item) => sum + item.watchedCount, 0)
  const mediaCounts = (['movie', 'series', 'anime'] as ConnectedHistoryMediaType[]).map((type) => ({ type, count: statsItems.filter((item) => item.mediaType === type).length }))
  const maxMediaCount = Math.max(1, ...mediaCounts.map((entry) => entry.count))
  const monthly = [...statsItems.reduce((map, item) => {
    const month = item.watchedAt?.slice(0, 7)
    if (month) map.set(month, (map.get(month) || 0) + 1)
    return map
  }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)).slice(-12)
  const maxMonth = Math.max(1, ...monthly.map(([, count]) => count))
  const estimatedMinutes = statsItems.reduce((sum, item) => sum + (item.runtimeMinutes || 0), 0)
  const runtimeEligible = statsItems.filter((item) => item.tmdbId).length
  const runtimeCovered = statsItems.filter((item) => item.runtimeMinutes != null).length
  const streak = streaks(statsItems)
  const genreTotals = [...statsItems.reduce((map, item) => {
    if (!item.runtimeMinutes) return map
    ;(item.genres || []).forEach((genre) => map.set(genre, (map.get(genre) || 0) + item.runtimeMinutes!))
    return map
  }, new Map<string, number>())].map(([genre, minutes]) => ({ genre, minutes })).sort((left, right) => right.minutes - left.minutes).slice(0, 8)

  const toggleSource = (source: ConnectedHistorySource) => setSelected((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source])
  const openItem = (item: ConnectedHistoryItem) => {
    const id = item.tmdbId ? `tmdb-${item.tmdbId}` : item.imdbId || item.tvdbId
    if (!id) return
    navigate(item.mediaType === 'movie' ? `/movie/${id}` : `/series/${id}`, { state: { title: item.title, poster: item.poster, tmdbId: item.tmdbId, tvdbId: item.tvdbId, imdbId: item.imdbId, anilistId: item.anilistId, malId: item.malId } })
  }

  return <section className="space-y-4">
    <div className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.05] to-accent/[0.035] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-bold text-white">Connected History</h2><p className="mt-1 text-xs text-white/35">Combine watched history from selected services. Matching titles are shown once.</p></div><button onClick={() => setRefreshToken((value) => value + 1)} disabled={loading || !selected.length} className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-bold text-white/55 hover:bg-white/[0.08] disabled:opacity-30">{loading ? 'Refreshing...' : 'Refresh history'}</button></div>
      <div className="mt-5 flex flex-wrap gap-2">{connected.map((source) => <button key={source} onClick={() => toggleSource(source)} className={`rounded-xl border px-3 py-2 text-xs font-bold transition-all ${selected.includes(source) ? sourceColors[source] : 'border-white/[0.06] bg-white/[0.025] text-white/30 hover:text-white/60'}`}>{sourceLabels[source]}{counts[source] != null ? ` · ${counts[source]}` : ''}</button>)}{connected.length > 1 && <button onClick={() => setSelected(selected.length === connected.length ? [] : connected)} className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs font-bold text-white/35 hover:text-white/65">{selected.length === connected.length ? 'Clear all' : 'Use all'}</button>}</div>
      {connected.length === 0 && <p className="mt-5 rounded-xl border border-amber-400/15 bg-amber-400/[0.06] p-3 text-xs text-amber-200/70">Connect Trakt, Simkl, AniList, PMDB, MDBList, or Stremio in Settings to use combined history.</p>}
    </div>

    {Object.keys(errors).length > 0 && <div className="rounded-xl border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-100/65">Some services could not be loaded: {Object.keys(errors).map((source) => sourceLabels[source as ConnectedHistorySource]).join(', ')}. Results from available services are still shown.</div>}

    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">{[
      ['Estimated watch time', estimatedMinutes ? formatMinutes(estimatedMinutes) : runtimeProgress.total ? 'Calculating...' : '—', runtimeEligible ? `${runtimeCovered}/${runtimeEligible} titles with TMDB runtime` : 'No TMDB runtime IDs'],
      ['Unique titles', statsItems.length, 'After provider deduplication'],
      ['Movies watched', moviePlays, 'Includes recorded rewatches'],
      ['Episodes watched', episodePlays, 'Highest provider count per show'],
      ['Current streak', `${streak.current} ${streak.current === 1 ? 'day' : 'days'}`, 'Consecutive dated history days'],
      ['Best streak', `${streak.longest} ${streak.longest === 1 ? 'day' : 'days'}`, 'Longest connected-history streak'],
      ['Merged duplicates', overlaps, 'Found on multiple services'],
    ].map(([label, value, detail]) => <div key={String(label)} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-white/30">{label}</p><p className="mt-2 text-xl font-black text-white/85">{value}</p><p className="mt-1 text-[9px] text-white/22">{detail}</p></div>)}</div>

    <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5"><div className="mb-5 flex items-center justify-between"><div><h3 className="text-sm font-bold text-white/80">History timeline</h3><p className="mt-1 text-[10px] text-white/30">Unique titles by latest watched month</p></div><span className="text-xs font-bold text-accent/70">{statsItems.length} titles</span></div>{monthly.length ? <div className="flex h-40 items-end gap-2">{monthly.map(([month, count]) => <div key={month} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-2" title={`${month}: ${count} titles`}><div className="w-full min-h-1 rounded-t bg-accent/35 transition-colors group-hover:bg-accent" style={{ height: `${Math.max(4, count / maxMonth * 120)}px` }} /><span className="hidden text-[8px] text-white/25 sm:block">{month.slice(5)}</span></div>)}</div> : <div className="grid h-40 place-items-center text-sm text-white/25">No dated history from the selected services.</div>}</div>
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5"><h3 className="text-sm font-bold text-white/80">Content mix</h3><div className="mt-5 space-y-4">{mediaCounts.map(({ type, count }) => <div key={type}><div className="mb-1.5 flex justify-between text-xs"><span className="capitalize text-white/55">{type}</span><span className="font-semibold text-white/35">{count} titles</span></div><div className="h-2 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-accent/65" style={{ width: `${count / maxMediaCount * 100}%` }} /></div></div>)}</div></div>
    </div>

    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5"><div className="mb-5 flex items-center justify-between"><div><h3 className="text-sm font-bold text-white/80">Favorite genres</h3><p className="mt-1 text-[10px] text-white/30">Estimated watch time from TMDB metadata</p></div>{runtimeProgress.total > 0 && runtimeProgress.completed < runtimeProgress.total && <span className="text-[10px] font-semibold text-accent/65">Analyzing {runtimeProgress.completed}/{runtimeProgress.total}</span>}</div>{genreTotals.length ? <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">{genreTotals.map((item) => <div key={item.genre}><div className="mb-1.5 flex justify-between text-xs"><span className="text-white/55">{item.genre}</span><span className="text-white/30">{formatMinutes(item.minutes)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-accent/60" style={{ width: `${item.minutes / genreTotals[0].minutes * 100}%` }} /></div></div>)}</div> : <div className="py-8 text-center text-sm text-white/25">Genre insights appear as TMDB metadata is calculated.</div>}</div>

    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex rounded-xl border border-white/[0.08] bg-black/20 p-1">{(['all', 'movie', 'series', 'anime'] as const).map((value) => <button key={value} onClick={() => setMedia(value)} className={`rounded-lg px-3 py-1.5 text-[10px] font-bold capitalize ${media === value ? 'bg-accent/15 text-accent' : 'text-white/35 hover:text-white/65'}`}>{value}</button>)}</div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connected history..." className="w-64 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3.5 py-2.5 text-xs text-white outline-none placeholder:text-white/25 focus:border-accent/30" /></div>

    {loading && items.length === 0 ? <div className="py-16 text-center text-sm text-white/30">Combining connected history...</div> : selected.length === 0 ? <div className="py-16 text-center text-sm text-white/30">Select at least one connected service.</div> : <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{visibleItems.map((item) => <button key={item.id} onClick={() => openItem(item)} className="group flex min-w-0 items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3 text-left transition-all hover:border-accent/20 hover:bg-white/[0.055]">
      {item.poster ? <img src={item.poster} alt="" className="h-20 w-14 flex-none rounded-lg object-cover" loading="lazy" /> : <div className="grid h-20 w-14 flex-none animate-pulse place-items-center rounded-lg bg-white/[0.055] text-[9px] text-white/20">{enrichingPosters ? 'Loading' : 'No poster'}</div>}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-white/80">{item.title}</span><span className="mt-1 block text-[10px] capitalize text-white/30">{item.mediaType}{item.year ? ` · ${item.year}` : ''}</span><span className="mt-1 block text-[10px] font-semibold text-accent/65">{item.mediaType === 'movie' ? item.watchedCount > 1 ? `${item.watchedCount} plays` : 'Watched' : `${item.watchedCount} episodes watched`}{item.runtimeMinutes ? ` · ${formatMinutes(item.runtimeMinutes)} estimated` : ''}</span><span className="mt-2 flex flex-wrap gap-1">{item.sources.map((source) => <span key={source} className={`rounded-md border px-1.5 py-0.5 text-[8px] font-bold ${sourceColors[source]}`}>{sourceLabels[source]}</span>)}</span></span>
      {item.watchedAt && <span className="self-start whitespace-nowrap text-[9px] text-white/20">{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' }).format(new Date(item.watchedAt))}</span>}
    </button>)}</div>}
    {filtered.length > 0 && <div className="flex flex-col items-center gap-3 py-3"><p className="text-[10px] text-white/25">Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} deduplicated titles</p>{visibleCount < filtered.length && <button onClick={() => setVisibleCount((count) => count + PAGE_SIZE)} className="rounded-xl border border-accent/20 bg-accent/10 px-6 py-2.5 text-xs font-bold text-accent transition-all hover:bg-accent/20">Load {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more</button>}</div>}
    {!loading && selected.length > 0 && filtered.length === 0 && <div className="py-16 text-center text-sm text-white/30">No history matches these filters.</div>}
  </section>
}
