import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getTmdbPerson, type TmdbPersonDetails, type TmdbPersonCredit } from '../services/tmdb'

function formatDate(value?: string): string | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function ageText(person: TmdbPersonDetails): string | null {
  if (!person.birthday) return null
  const start = new Date(`${person.birthday}T00:00:00`)
  const end = person.deathday ? new Date(`${person.deathday}T00:00:00`) : new Date()
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  let years = end.getFullYear() - start.getFullYear()
  const beforeBirthday = end.getMonth() < start.getMonth() || (end.getMonth() === start.getMonth() && end.getDate() < start.getDate())
  if (beforeBirthday) years -= 1
  return person.deathday ? `${years} at death` : `${years}`
}

export default function PersonPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [person, setPerson] = useState<TmdbPersonDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'series'>('all')
  const [roleFilter, setRoleFilter] = useState<'all' | 'acting' | 'voice' | 'directing'>('all')
  const [viewMode, setViewMode] = useState<'grid' | 'timeline'>('grid')

  useEffect(() => {
    let cancelled = false
    if (!id) return
    setLoading(true)
    setError(null)
    getTmdbPerson(id)
      .then((data) => { if (!cancelled) setPerson(data) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load person') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  const credits = useMemo(() => person?.credits ?? [], [person])
  const filteredCredits = useMemo(() => credits.filter((item) => {
    if (mediaFilter !== 'all' && item.type !== mediaFilter) return false
    if (roleFilter !== 'all' && !item.creditTypes.includes(roleFilter)) return false
    return true
  }), [credits, mediaFilter, roleFilter])
  const timelineGroups = useMemo(() => {
    const groups = new Map<string, TmdbPersonCredit[]>()
    for (const credit of filteredCredits) {
      const year = credit.year ? String(credit.year) : 'Unknown'
      const items = groups.get(year)
      if (items) items.push(credit)
      else groups.set(year, [credit])
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === 'Unknown') return 1
      if (b === 'Unknown') return -1
      return Number(b) - Number(a)
    })
  }, [filteredCredits])
  const movieCount = credits.filter((item) => item.type === 'movie').length
  const seriesCount = credits.filter((item) => item.type === 'series').length
  const directingCount = credits.filter((item) => item.creditTypes.includes('directing')).length

  if (loading) return <div className="min-h-screen px-8 py-24 text-white/50">Loading...</div>

  if (error || !person) {
    return (
      <div className="min-h-screen px-8 py-24">
        <h1 className="text-2xl font-bold text-white mt-16">Person not found</h1>
        {error && <p className="mt-2 text-sm text-white/45">{error}</p>}
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20">
      <section className="px-6 sm:px-8 pt-16">
        <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)] max-w-7xl">
          <div className="w-[180px] sm:w-[220px]">
            <div className="aspect-[2/3] rounded-xl overflow-hidden bg-white/[0.06] border border-white/[0.08] shadow-2xl">
              {person.profile ? (
                <img src={person.profile} alt={person.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-6xl font-bold text-white/15">{person.name[0]}</span>
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 max-w-4xl">
            <p className="text-xs font-bold uppercase tracking-wider text-accent mb-3">{person.knownForDepartment || 'Person'}</p>
            <h1 className="text-4xl sm:text-6xl font-black text-white tracking-normal">{person.name}</h1>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/50">
              {person.birthday && <span>Born {formatDate(person.birthday)}</span>}
              {person.deathday && <span>Died {formatDate(person.deathday)}</span>}
              {ageText(person) && <span>Age {ageText(person)}</span>}
              {person.placeOfBirth && <span>{person.placeOfBirth}</span>}
            </div>
            {person.biography && (
              <p className="mt-6 text-sm sm:text-base leading-7 text-white/65 max-w-3xl line-clamp-[10]">{person.biography}</p>
            )}
            <div className="mt-6 flex flex-wrap gap-3">
              {person.homepage && (
                <a href={person.homepage} target="_blank" rel="noreferrer" className="px-4 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-sm font-semibold text-white/80 transition-colors">Homepage</a>
              )}
              {person.imdbId && (
                <a href={`https://www.imdb.com/name/${person.imdbId}`} target="_blank" rel="noreferrer" className="px-4 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-sm font-semibold text-white/80 transition-colors">IMDb</a>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 sm:px-8 mt-12">
        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 mb-5">
          <div>
            <h2 className="text-2xl font-bold text-white">Credits</h2>
            <p className="text-sm text-white/40 mt-1">{movieCount} movies · {seriesCount} series · {directingCount} directed · newest first</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SegmentedButton active={mediaFilter === 'all'} onClick={() => setMediaFilter('all')}>All</SegmentedButton>
            <SegmentedButton active={mediaFilter === 'movie'} onClick={() => setMediaFilter('movie')}>Movies</SegmentedButton>
            <SegmentedButton active={mediaFilter === 'series'} onClick={() => setMediaFilter('series')}>Shows</SegmentedButton>
            <div className="w-px h-8 bg-white/[0.08] mx-1" />
            <SegmentedButton active={roleFilter === 'all'} onClick={() => setRoleFilter('all')}>All Roles</SegmentedButton>
            <SegmentedButton active={roleFilter === 'acting'} onClick={() => setRoleFilter('acting')}>Acting</SegmentedButton>
            <SegmentedButton active={roleFilter === 'voice'} onClick={() => setRoleFilter('voice')}>Voice Acting</SegmentedButton>
            <SegmentedButton active={roleFilter === 'directing'} onClick={() => setRoleFilter('directing')}>Director</SegmentedButton>
            <div className="w-px h-8 bg-white/[0.08] mx-1" />
            <SegmentedButton active={viewMode === 'grid'} onClick={() => setViewMode('grid')}>Grid</SegmentedButton>
            <SegmentedButton active={viewMode === 'timeline'} onClick={() => setViewMode('timeline')}>Timeline</SegmentedButton>
          </div>
        </div>

        {filteredCredits.length > 0 && viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8 gap-x-4 gap-y-8">
            {filteredCredits.map((credit) => (
              <CreditCard key={`${credit.mediaType}-${credit.tmdbId}`} credit={credit} />
            ))}
          </div>
        ) : filteredCredits.length > 0 ? (
          <Timeline groups={timelineGroups} />
        ) : (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-8 text-white/45">No credits match these filters.</div>
        )}
      </section>
    </div>
  )
}

function SegmentedButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 px-3 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
        active ? 'bg-white text-black' : 'bg-white/[0.06] text-white/55 hover:bg-white/[0.12] hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function Timeline({ groups }: { groups: Array<[string, TmdbPersonCredit[]]> }) {
  return (
    <div className="max-w-5xl">
      {groups.map(([year, credits]) => (
        <div key={year} className="grid grid-cols-[72px_minmax(0,1fr)] gap-5">
          <div className="relative">
            <div className="sticky top-6 text-lg font-black text-white">{year}</div>
            <div className="absolute left-[35px] top-9 bottom-0 w-px bg-white/[0.08]" />
          </div>
          <div className="pb-7 space-y-3">
            {credits.map((credit) => (
              <TimelineItem key={`${credit.mediaType}-${credit.tmdbId}`} credit={credit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TimelineItem({ credit }: { credit: TmdbPersonCredit }) {
  const navigate = useNavigate()
  const path = credit.type === 'movie' ? `/movie/${credit.id}` : `/series/${credit.id}`
  return (
    <button
      onClick={() => navigate(path, { state: credit })}
      className="w-full grid grid-cols-[48px_minmax(0,1fr)] gap-3 p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.12] text-left transition-colors cursor-pointer focus-ring"
    >
      <div className="w-12 h-[72px] rounded-lg overflow-hidden bg-white/[0.06]">
        {credit.poster ? (
          <img src={credit.poster} alt={credit.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20 font-black">{credit.title[0]}</div>
        )}
      </div>
      <div className="min-w-0 self-center">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-white truncate">{credit.title}</h3>
          <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">{credit.type === 'movie' ? 'Movie' : 'Series'}</span>
          {credit.creditTypes.includes('directing') && <span className="text-[10px] font-bold uppercase tracking-wider text-accent">Director</span>}
          {credit.creditTypes.includes('voice') && <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">Voice</span>}
        </div>
        {credit.character && <p className="mt-1 text-xs text-white/55 truncate">{credit.character}</p>}
        {credit.job && <p className="mt-1 text-xs text-white/55 truncate">{credit.job}</p>}
        {credit.overview && <p className="mt-2 text-xs leading-5 text-white/40 line-clamp-2">{credit.overview}</p>}
      </div>
    </button>
  )
}

function CreditCard({ credit }: { credit: TmdbPersonCredit }) {
  const navigate = useNavigate()
  const [imgError, setImgError] = useState(false)
  const path = credit.type === 'movie' ? `/movie/${credit.id}` : `/series/${credit.id}`

  return (
    <button onClick={() => navigate(path, { state: credit })} className="group text-left min-w-0 cursor-pointer focus-ring">
      <div className="aspect-[2/3] rounded-xl overflow-hidden bg-white/[0.06] border border-white/[0.06] group-hover:border-white/20 transition-all duration-300 group-hover:-translate-y-1 shadow-lg">
        {credit.poster && !imgError ? (
          <img src={credit.poster} alt={credit.title} className="w-full h-full object-cover" loading="lazy" onError={() => setImgError(true)} />
        ) : (
          <div className="w-full h-full flex items-center justify-center px-3">
            <span className="text-3xl font-black text-white/15">{credit.title[0]}</span>
          </div>
        )}
      </div>
      <h3 className="mt-2 text-sm font-bold text-white/85 truncate group-hover:text-white">{credit.title}</h3>
      <div className="mt-1 flex items-center gap-2 text-xs text-white/40">
        {credit.year && <span>{credit.year}</span>}
        <span>{credit.type === 'movie' ? 'Movie' : 'Series'}</span>
        {credit.creditTypes.includes('directing') && <span className="text-accent">Director</span>}
        {credit.creditTypes.includes('voice') && <span className="text-blue-400">Voice</span>}
      </div>
      {credit.character && <p className="mt-1 text-xs text-white/55 truncate">{credit.character}</p>}
      {credit.job && <p className="mt-1 text-xs text-white/55 truncate">{credit.job}</p>}
    </button>
  )
}
