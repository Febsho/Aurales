import { useNavigate } from 'react-router-dom'
import { hasTmdbApiKey } from '../services/apiKeys'

// Safety net for the no-key state: a fresh device with no built-in, build-time,
// or user TMDB key can't load any TMDB-driven catalog (Home defaults + all of
// Discover). Rather than a wall of identical "Couldn't load" rows, show one
// clear, actionable banner. When a built-in key is shipped this never renders.
export default function CatalogKeyNotice() {
  const navigate = useNavigate()
  if (hasTmdbApiKey()) return null

  return (
    <div className="mx-6 mb-6 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-400/10 text-amber-300">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-8.48 14.7A1.5 1.5 0 003.11 21h17.78a1.5 1.5 0 001.3-2.44l-8.48-14.7a1.5 1.5 0 00-2.62 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-bold text-white/85">Catalogs need a TMDB key</h2>
            <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-white/45">
              No TMDB API key is configured, so trending, discovery, and recommendation
              catalogs can't load. Add a free key in Settings to get started.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="focus-ring flex-shrink-0 cursor-pointer rounded-xl border border-amber-300/25 bg-amber-400/15 px-4 py-2 text-xs font-bold text-amber-200 transition-colors hover:bg-amber-400/25"
        >
          Open Settings
        </button>
      </div>
    </div>
  )
}
