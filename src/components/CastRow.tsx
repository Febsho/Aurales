import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CastMember, CrewMember } from '../types'
import { searchTmdbPeople } from '../services/tmdb'

type PersonProvider = 'tmdb' | 'tvdb' | 'addon'
type PersonTarget = { id?: string; personProvider?: PersonProvider; name: string }
type OpenPerson = (person: PersonTarget) => void

interface CastRowProps {
  cast: CastMember[]
  crew?: CrewMember[]
}

export default function CastRow({ cast, crew }: CastRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showModal, setShowModal] = useState(false)
  const navigate = useNavigate()

  const openPerson: OpenPerson = async ({ id, personProvider, name }) => {
    if (personProvider === 'tmdb' && isTmdbPersonId(id)) {
      navigate(`/person/${id}`)
      return
    }

    // TVDB and addon people IDs are not valid TMDB IDs. Resolve anime cast by
    // name so their profile cards remain usable instead of linking to a 404.
    const matches = await searchTmdbPeople(name)
    const normalizedName = name.trim().toLocaleLowerCase()
    const match = matches.find((person) => person.name.trim().toLocaleLowerCase() === normalizedName) || matches[0]
    if (match) navigate(`/person/${match.id}`)
  }

  if (cast.length === 0) return null

  const directors = crew?.filter((c) => c.job === 'Director') ?? []
  const writers = crew?.filter((c) => c.department === 'Writing' || c.job === 'Writer' || c.job === 'Screenplay') ?? []
  const creators = crew?.filter((c) => c.job === 'Creator') ?? []
  const producers = crew?.filter((c) => c.job === 'Producer' || c.job === 'Executive Producer') ?? []

  const hasFullCredits = cast.length > 8 || directors.length > 0 || writers.length > 0

  return (
    <>
      <div className="mb-12">
        <div className="flex items-center justify-between px-8 mb-5">
          <h2 className="text-2xl font-bold text-white">Cast</h2>
          {hasFullCredits && (
            <button
              onClick={() => setShowModal(true)}
              className="text-xs font-semibold text-white/40 hover:text-white/70 transition-colors cursor-pointer"
            >
              View All
            </button>
          )}
        </div>
        <div
          ref={scrollRef}
          className="flex gap-6 overflow-x-auto px-8 pb-3"
          style={{ scrollbarWidth: 'none' }}
        >
          {directors.slice(0, 2).map((d) => (
            <PersonCard key={`dir-${d.id}`} id={d.id} personProvider={d.personProvider} name={d.name} subtitle={`Director`} label="Director" image={d.profilePath} onOpen={openPerson} />
          ))}
          {cast.slice(0, 20).map((member) => (
            <PersonCard key={member.id} id={member.id} personProvider={member.personProvider} name={member.name} subtitle={member.character} image={member.profilePath} onOpen={openPerson} />
          ))}
          {creators.slice(0, 2).map((c) => (
            <PersonCard key={c.id} id={c.id} personProvider={c.personProvider} name={c.name} subtitle="Creator" image={c.profilePath} onOpen={openPerson} />
          ))}
        </div>
      </div>

      {showModal && (
        <CreditsModal
          cast={cast}
          directors={directors}
          writers={writers}
          creators={creators}
          producers={producers}
          onClose={() => setShowModal(false)}
          onOpenPerson={(person) => {
            setShowModal(false)
            void openPerson(person)
          }}
        />
      )}
    </>
  )
}

function isTmdbPersonId(id?: string): boolean {
  return Boolean(id && /^\d+$/.test(id))
}

function PersonCard({ id, personProvider, name, subtitle, label, image, onOpen }: PersonTarget & { subtitle?: string; label?: string; image?: string; onOpen?: OpenPerson }) {
  const [imgError, setImgError] = useState(false)
  const canOpen = Boolean(name.trim())
  const content = (
    <>
      <div className="relative w-full aspect-[3/4] rounded-2xl overflow-hidden bg-white/[0.06] mb-3 ring-1 ring-white/[0.08] group-hover:ring-white/20 transition-all duration-300 shadow-xl">
        {image && !imgError ? (
          <img
            src={image}
            alt={name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white/[0.04]">
            <span className="text-2xl font-bold text-white/15">{name[0]}</span>
          </div>
        )}
        {label && (
          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/70 text-[10px] font-bold uppercase tracking-wider text-white/80 backdrop-blur-sm">{label}</span>
        )}
      </div>
      <p className="text-base text-white/55 truncate leading-tight">{name}</p>
      {subtitle && <p className="text-lg font-semibold text-white/90 truncate mt-1">{subtitle}</p>}
    </>
  )

  return canOpen ? (
    <button onClick={() => onOpen?.({ id, personProvider, name })} className="cast-showcase-card flex-shrink-0 text-left group cursor-pointer focus-ring">
      {content}
    </button>
  ) : (
    <div className="cast-showcase-card flex-shrink-0 text-left group">
      {content}
    </div>
  )
}

interface CreditsModalProps {
  cast: CastMember[]
  directors: CrewMember[]
  writers: CrewMember[]
  creators: CrewMember[]
  producers: CrewMember[]
  onClose: () => void
  onOpenPerson: OpenPerson
}

function CreditsModal({ cast, directors, writers, creators, producers, onClose, onOpenPerson }: CreditsModalProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative bg-[#0a0a0a] border border-white/[0.08] rounded-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h2 className="text-lg font-bold text-white">Cast & Crew</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-white/50 hover:text-white transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-6 space-y-8" style={{ maxHeight: 'calc(80vh - 60px)', scrollbarWidth: 'none' }}>
          {cast.length > 0 && (
            <CreditsSection title="Cast" items={cast.map((c) => ({ id: c.id, personProvider: c.personProvider, name: c.name, role: c.character, image: c.profilePath }))} onOpenPerson={onOpenPerson} />
          )}
          {directors.length > 0 && (
            <CreditsSection title="Directors" items={directors.map((d) => ({ id: d.id, personProvider: d.personProvider, name: d.name, role: d.job, image: d.profilePath }))} onOpenPerson={onOpenPerson} />
          )}
          {creators.length > 0 && (
            <CreditsSection title="Creators" items={creators.map((c) => ({ id: c.id, personProvider: c.personProvider, name: c.name, role: c.job, image: c.profilePath }))} onOpenPerson={onOpenPerson} />
          )}
          {writers.length > 0 && (
            <CreditsSection title="Writers" items={writers.map((w) => ({ id: w.id, personProvider: w.personProvider, name: w.name, role: w.job, image: w.profilePath }))} onOpenPerson={onOpenPerson} />
          )}
          {producers.length > 0 && (
            <CreditsSection title="Producers" items={producers.map((p) => ({ id: p.id, personProvider: p.personProvider, name: p.name, role: p.job, image: p.profilePath }))} onOpenPerson={onOpenPerson} />
          )}
        </div>
      </div>
    </div>
  )
}

function CreditsSection({ title, items, onOpenPerson }: { title: string; items: (PersonTarget & { role?: string; image?: string })[]; onOpenPerson: OpenPerson }) {
  return (
    <div>
      <h3 className="text-sm font-bold uppercase tracking-wider text-white/40 mb-4">{title}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {items.map((item, i) => (
          <CreditsPerson key={`${item.name}-${i}`} {...item} onOpenPerson={onOpenPerson} />
        ))}
      </div>
    </div>
  )
}

function CreditsPerson({ id, personProvider, name, role, image, onOpenPerson }: PersonTarget & { role?: string; image?: string; onOpenPerson: OpenPerson }) {
  const [imgError, setImgError] = useState(false)
  const canOpen = Boolean(name.trim())
  const content = (
    <>
      <div className="w-11 h-11 rounded-full overflow-hidden bg-white/[0.06] flex-shrink-0">
        {image && !imgError ? (
          <img src={image} alt={name} className="w-full h-full object-cover" loading="lazy" onError={() => setImgError(true)} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-sm font-bold text-white/15">{name[0]}</span>
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white/80 truncate">{name}</p>
        {role && <p className="text-xs text-white/35 truncate">{role}</p>}
      </div>
    </>
  )

  return canOpen ? (
    <button onClick={() => onOpenPerson({ id, personProvider, name })} className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-white/[0.04] transition-colors text-left cursor-pointer focus-ring">
      {content}
    </button>
  ) : (
    <div className="flex items-center gap-3 p-2 rounded-xl">
      {content}
    </div>
  )
}
