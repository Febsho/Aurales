import { useRef } from 'react'
import type { CastMember } from '../types'

interface CastRowProps {
  cast: CastMember[]
}

export default function CastRow({ cast }: CastRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  if (cast.length === 0) return null

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold px-6 mb-3">Cast</h2>
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto px-6 pb-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {cast.map((member) => (
          <div key={member.id} className="flex-shrink-0 w-28 text-center">
            <div className="w-20 h-20 mx-auto rounded-full overflow-hidden bg-surface-elevated mb-2">
              {member.profilePath ? (
                <img
                  src={member.profilePath}
                  alt={member.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted text-2xl">
                  {member.name[0]}
                </div>
              )}
            </div>
            <h3 className="text-xs font-medium truncate">{member.name}</h3>
            <p className="text-xs text-muted truncate">{member.character}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
