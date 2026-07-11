import { useState, useEffect, useRef } from 'react'
import {
  DISCOVER_LANGUAGES,
  CANONICAL_GENRES,
  type DiscoverPrefs
} from '../stores/discoverPrefsStore'
import { searchTmdbKeywords, searchTmdbCompanies } from '../services/tmdb'

interface DiscoverPrefsPanelProps {
  localPrefs: DiscoverPrefs
  onChange: (patch: Partial<DiscoverPrefs>) => void
  onReset: () => void
}

const STREAMING_PROVIDERS = [
  'Netflix',
  'Amazon Prime',
  'Disney+',
  'Max',
  'Apple TV+',
  'Hulu',
  'Paramount+',
  'Peacock',
  'Crunchyroll',
  'AMC+',
  'Apple iTunes',
  'Google Play',
  'YouTube',
  'MUBI',
  'Curiosity Stream',
  'GuideDoc',
  'Criterion Channel',
  'Kanopy',
  'Tubi',
  'Pluto TV'
]

const SORT_OPTIONS = [
  { value: 'taste-ranked', label: 'Default (taste-ranked)' },
  { value: 'popularity.desc', label: 'Popularity (high to low)' },
  { value: 'vote_average.desc', label: 'Rating (high to low)' },
  { value: 'release_date.desc', label: 'Release Date (new to old)' }
]

export default function DiscoverPrefsPanel({
  localPrefs,
  onChange,
  onReset
}: DiscoverPrefsPanelProps) {
  // Autocomplete state for must-include keywords
  const [keywordIncludeQuery, setKeywordIncludeQuery] = useState('')
  const [keywordIncludeSuggestions, setKeywordIncludeSuggestions] = useState<{ id: number; name: string }[]>([])
  const [showKeywordIncludeDropdown, setShowKeywordIncludeDropdown] = useState(false)

  // Autocomplete state for exclude keywords
  const [keywordExcludeQuery, setKeywordExcludeQuery] = useState('')
  const [keywordExcludeSuggestions, setKeywordExcludeSuggestions] = useState<{ id: number; name: string }[]>([])
  const [showKeywordExcludeDropdown, setShowKeywordExcludeDropdown] = useState(false)

  // Autocomplete state for production companies
  const [companyQuery, setCompanyQuery] = useState('')
  const [companySuggestions, setCompanySuggestions] = useState<{ id: number; name: string }[]>([])
  const [showCompanyDropdown, setShowCompanyDropdown] = useState(false)

  const dropdownRef1 = useRef<HTMLDivElement>(null)
  const dropdownRef2 = useRef<HTMLDivElement>(null)
  const dropdownRef3 = useRef<HTMLDivElement>(null)

  // Hide autocomplete suggestions on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef1.current && !dropdownRef1.current.contains(event.target as Node)) {
        setShowKeywordIncludeDropdown(false)
      }
      if (dropdownRef2.current && !dropdownRef2.current.contains(event.target as Node)) {
        setShowKeywordExcludeDropdown(false)
      }
      if (dropdownRef3.current && !dropdownRef3.current.contains(event.target as Node)) {
        setShowCompanyDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Keyword Include search
  useEffect(() => {
    if (!keywordIncludeQuery.trim()) {
      setKeywordIncludeSuggestions([])
      return
    }
    const timer = setTimeout(async () => {
      const results = await searchTmdbKeywords(keywordIncludeQuery)
      setKeywordIncludeSuggestions(results.slice(0, 5))
    }, 300)
    return () => clearTimeout(timer)
  }, [keywordIncludeQuery])

  // Keyword Exclude search
  useEffect(() => {
    if (!keywordExcludeQuery.trim()) {
      setKeywordExcludeSuggestions([])
      return
    }
    const timer = setTimeout(async () => {
      const results = await searchTmdbKeywords(keywordExcludeQuery)
      setKeywordExcludeSuggestions(results.slice(0, 5))
    }, 300)
    return () => clearTimeout(timer)
  }, [keywordExcludeQuery])

  // Company search
  useEffect(() => {
    if (!companyQuery.trim()) {
      setCompanySuggestions([])
      return
    }
    const timer = setTimeout(async () => {
      const results = await searchTmdbCompanies(companyQuery)
      setCompanySuggestions(results.slice(0, 5))
    }, 300)
    return () => clearTimeout(timer)
  }, [companyQuery])

  const handleLanguageToggle = (code: string, listKey: 'onlyLanguages' | 'excludeLanguages') => {
    const list = localPrefs[listKey]
    if (list.includes(code)) {
      onChange({ [listKey]: list.filter((c) => c !== code) })
    } else {
      // If adding to only, remove from exclude, and vice versa
      const oppositeKey = listKey === 'onlyLanguages' ? 'excludeLanguages' : 'onlyLanguages'
      onChange({
        [listKey]: [...list, code],
        [oppositeKey]: localPrefs[oppositeKey].filter((c) => c !== code)
      })
    }
  }

  const handleGenreToggle = (name: string, listKey: 'onlyGenres' | 'excludeGenres') => {
    const list = localPrefs[listKey]
    if (list.includes(name)) {
      onChange({ [listKey]: list.filter((g) => g !== name) })
    } else {
      const oppositeKey = listKey === 'onlyGenres' ? 'excludeGenres' : 'onlyGenres'
      onChange({
        [listKey]: [...list, name],
        [oppositeKey]: localPrefs[oppositeKey].filter((g) => g !== name)
      })
    }
  }

  const handleProviderToggle = (name: string) => {
    const list = localPrefs.selectedProviders
    if (list.includes(name)) {
      onChange({ selectedProviders: list.filter((p) => p !== name) })
    } else {
      onChange({ selectedProviders: [...list, name] })
    }
  }

  const handleAddKeyword = (kw: { id: number; name: string }, listKey: 'mustIncludeKeywords' | 'excludeKeywords') => {
    const list = localPrefs[listKey]
    if (list.some((item) => item.id === kw.id)) return
    onChange({ [listKey]: [...list, kw] })
  }

  const handleRemoveKeyword = (id: number, listKey: 'mustIncludeKeywords' | 'excludeKeywords') => {
    onChange({ [listKey]: localPrefs[listKey].filter((kw) => kw.id !== id) })
  }

  const handleAddCompany = (c: { id: number; name: string }) => {
    const list = localPrefs.includeCompanies
    if (list.some((item) => item.id === c.id)) return
    onChange({ includeCompanies: [...list, c] })
  }

  const handleRemoveCompany = (id: number) => {
    onChange({ includeCompanies: localPrefs.includeCompanies.filter((c) => c.id !== id) })
  }

  const resetWeights = () => {
    onChange({
      weightGenre: 0,
      weightKeyword: 0,
      weightPeople: 0,
      weightQuality: 0,
      weightPopularity: 0,
      weightNovelty: 0,
      weightRecency: 0,
      weightEra: 0,
      weightLanguage: 0
    })
  }

  // Filter out TV genres for "Only these genres" as seen in the screenshots
  const onlyGenreList = CANONICAL_GENRES.filter(
    (g) => !['Kids', 'Reality', 'Soap', 'Talk', 'TV Movie'].includes(g.name)
  )

  interface WeightSlider {
    key: keyof DiscoverPrefs
    label: string
    isNovelty?: boolean
  }
  const weightSliders: WeightSlider[] = [
    { key: 'weightGenre', label: 'GENRE' },
    { key: 'weightKeyword', label: 'KEYWORD' },
    { key: 'weightPeople', label: 'PEOPLE' },
    { key: 'weightQuality', label: 'QUALITY' },
    { key: 'weightPopularity', label: 'POPULARITY' },
    { key: 'weightNovelty', label: 'NOVELTY', isNovelty: true },
    { key: 'weightRecency', label: 'RECENCY' },
    { key: 'weightEra', label: 'ERA' },
    { key: 'weightLanguage', label: 'LANGUAGE' }
  ]

  return (
    <div className="space-y-6">
      {/* 1. RANKING WEIGHTS */}
      <div>
        <div className="flex items-center justify-between mb-4 border-b border-white/[0.04] pb-2">
          <div>
            <h3 className="text-xs font-black tracking-wider text-white uppercase">Ranking weights</h3>
            <p className="text-[10px] text-white/35 mt-0.5">Blank fields use the recipe preset.</p>
          </div>
          <button
            type="button"
            onClick={resetWeights}
            className="flex items-center gap-1 text-[11px] font-black tracking-wide text-white/55 hover:text-white uppercase transition-all"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H17" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Reset
          </button>
        </div>

        <div className="space-y-3">
          {weightSliders.map(({ key, label, isNovelty }) => {
            const val = localPrefs[key] as number
            return (
              <div key={key} className="flex items-center gap-4">
                <span className="w-24 text-[10px] font-bold text-white/45 tracking-wider uppercase">
                  {label}
                </span>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.1"
                  value={val}
                  onChange={(e) => onChange({ [key]: parseFloat(e.target.value) })}
                  className="flex-grow accent-white bg-white/10 h-1 rounded-lg appearance-none cursor-pointer focus:outline-none"
                />
                <span className="w-8 text-right text-xs font-semibold text-white/60 tabular-nums">
                  {val >= 0 ? ` ${val.toFixed(1)}` : val.toFixed(1)}
                  {isNovelty && val !== 0 && <span className="text-[10px] text-white/35 ml-0.5">·p</span>}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* 2. ONLY THESE LANGUAGES */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-2">
          Only these languages <span className="text-[10px] text-white/20 normal-case font-medium">(leave empty for all)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {DISCOVER_LANGUAGES.map((lang) => {
            const active = localPrefs.onlyLanguages.includes(lang.code)
            return (
              <button
                key={`only-lang-${lang.code}`}
                type="button"
                onClick={() => handleLanguageToggle(lang.code, 'onlyLanguages')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  active
                    ? 'bg-white/10 text-white border-white/20'
                    : 'bg-white/[0.03] text-white/45 border-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                {lang.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* 3. EXCLUDE LANGUAGES */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-2">
          Exclude languages <span className="text-[10px] text-white/20 normal-case font-medium">(never recommend these)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {DISCOVER_LANGUAGES.map((lang) => {
            const active = localPrefs.excludeLanguages.includes(lang.code)
            return (
              <button
                key={`exclude-lang-${lang.code}`}
                type="button"
                onClick={() => handleLanguageToggle(lang.code, 'excludeLanguages')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  active
                    ? 'bg-red-950/20 text-red-400 border-red-900/40'
                    : 'bg-white/[0.03] text-white/45 border-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                {lang.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* 4. MIN VOTE COUNT & AVERAGE */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5">
            Min vote count
          </h3>
          <input
            type="number"
            placeholder="70"
            value={localPrefs.minVoteCount ?? ''}
            onChange={(e) => onChange({ minVoteCount: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
        </div>
        <div>
          <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5">
            Min vote average
          </h3>
          <input
            type="number"
            placeholder="7"
            min="1"
            max="10"
            step="0.5"
            value={localPrefs.minVoteAverage ?? ''}
            onChange={(e) => onChange({ minVoteAverage: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
        </div>
      </div>

      {/* 5. YEAR RANGE */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5">
          Year range (optional)
        </h3>
        <div className="flex items-center gap-3">
          <input
            type="number"
            placeholder="From"
            value={localPrefs.yearFrom ?? ''}
            onChange={(e) => onChange({ yearFrom: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
          <span className="text-white/35">—</span>
          <input
            type="number"
            placeholder="To"
            value={localPrefs.yearTo ?? ''}
            onChange={(e) => onChange({ yearTo: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
        </div>
      </div>

      {/* 6. ONLY THESE GENRES */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-2">
          Only these genres <span className="text-[10px] text-white/20 normal-case font-medium">(leave empty for all)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {onlyGenreList.map((g) => {
            const active = localPrefs.onlyGenres.includes(g.name)
            return (
              <button
                key={`only-genre-${g.name}`}
                type="button"
                onClick={() => handleGenreToggle(g.name, 'onlyGenres')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  active
                    ? 'bg-white/10 text-white border-white/20'
                    : 'bg-white/[0.03] text-white/45 border-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                {g.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* 7. EXCLUDE GENRES */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-2">
          Exclude genres <span className="text-[10px] text-white/20 normal-case font-medium">(never recommend these)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {CANONICAL_GENRES.map((g) => {
            const active = localPrefs.excludeGenres.includes(g.name)
            return (
              <button
                key={`exclude-genre-${g.name}`}
                type="button"
                onClick={() => handleGenreToggle(g.name, 'excludeGenres')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  active
                    ? 'bg-red-950/20 text-red-400 border-red-900/40'
                    : 'bg-white/[0.03] text-white/45 border-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                {g.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* 8. RUNTIME */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Runtime (minutes)
        </h3>
        <div className="flex items-center gap-3">
          <input
            type="number"
            placeholder="Min"
            value={localPrefs.runtimeMin ?? ''}
            onChange={(e) => onChange({ runtimeMin: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
          <span className="text-white/35">—</span>
          <input
            type="number"
            placeholder="Max"
            value={localPrefs.runtimeMax ?? ''}
            onChange={(e) => onChange({ runtimeMax: e.target.value ? Number(e.target.value) : null })}
            className="w-full bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
        </div>
      </div>

      {/* 9. MUST INCLUDE KEYWORDS */}
      <div ref={dropdownRef1} className="relative">
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5">
          Must include keywords <span className="text-[10px] text-white/20 normal-case font-medium">(e.g. cyberpunk, heist, time-travel)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {localPrefs.mustIncludeKeywords.map((kw) => (
            <span
              key={`kw-inc-${kw.id}`}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-white/10 text-white"
            >
              {kw.name}
              <button
                type="button"
                onClick={() => handleRemoveKeyword(kw.id, 'mustIncludeKeywords')}
                className="w-3.5 h-3.5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-[8px]"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type a keyword..."
            value={keywordIncludeQuery}
            onChange={(e) => {
              setKeywordIncludeQuery(e.target.value)
              setShowKeywordIncludeDropdown(true)
            }}
            onFocus={() => setShowKeywordIncludeDropdown(true)}
            className="flex-grow bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
        </div>
        {showKeywordIncludeDropdown && keywordIncludeSuggestions.length > 0 && (
          <div className="absolute z-[100] left-0 right-0 mt-1 bg-[#181818] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
            {keywordIncludeSuggestions.map((kw) => (
              <button
                key={`kw-inc-sug-${kw.id}`}
                type="button"
                onClick={() => {
                  handleAddKeyword(kw, 'mustIncludeKeywords')
                  setKeywordIncludeQuery('')
                  setShowKeywordIncludeDropdown(false)
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-white/80 hover:text-white hover:bg-white/[0.04] transition-colors"
              >
                {kw.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 10. EXCLUDE KEYWORDS */}
      <div ref={dropdownRef2} className="relative">
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5">
          Exclude keywords <span className="text-[10px] text-white/20 normal-case font-medium">(e.g. anime, sequel, remake)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {localPrefs.excludeKeywords.map((kw) => (
            <span
              key={`kw-exc-${kw.id}`}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-950/20 text-red-400 border border-red-900/40"
            >
              {kw.name}
              <button
                type="button"
                onClick={() => handleRemoveKeyword(kw.id, 'excludeKeywords')}
                className="w-3.5 h-3.5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-[8px]"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type a keyword..."
            value={keywordExcludeQuery}
            onChange={(e) => {
              setKeywordExcludeQuery(e.target.value)
              setShowKeywordExcludeDropdown(true)
            }}
            onFocus={() => setShowKeywordExcludeDropdown(true)}
            className="flex-grow bg-white/[0.03] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
          />
        </div>
        {showKeywordExcludeDropdown && keywordExcludeSuggestions.length > 0 && (
          <div className="absolute z-[100] left-0 right-0 mt-1 bg-[#181818] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
            {keywordExcludeSuggestions.map((kw) => (
              <button
                key={`kw-exc-sug-${kw.id}`}
                type="button"
                onClick={() => {
                  handleAddKeyword(kw, 'excludeKeywords')
                  setKeywordExcludeQuery('')
                  setShowKeywordExcludeDropdown(false)
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-white/80 hover:text-white hover:bg-white/[0.04] transition-colors"
              >
                {kw.name}
              </button>
            ))}
          </div>
        )}
        <p className="text-[10px] text-white/35 mt-1">Matched against TMDB keywords. Up to 10.</p>
      </div>

      {/* 11. STREAMING PROVIDERS */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-2 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Streaming providers <span className="text-[10px] text-white/20 normal-case font-medium">(leave empty for all)</span>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {STREAMING_PROVIDERS.map((prov) => {
            const active = localPrefs.selectedProviders.includes(prov)
            return (
              <button
                key={`prov-${prov}`}
                type="button"
                onClick={() => handleProviderToggle(prov)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  active
                    ? 'bg-white/10 text-white border-white/20'
                    : 'bg-white/[0.03] text-white/45 border-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                {prov}
              </button>
            )
          })}
        </div>
      </div>

      {/* 12. CONTENT RATING */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-2 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Content rating
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-white/45 font-medium">Up to</span>
          <div className="flex gap-1.5">
            {['G', 'PG', 'PG-13', 'R', 'NC-17'].map((rating) => {
              const active = localPrefs.contentRating === rating
              return (
                <button
                  key={`rating-${rating}`}
                  type="button"
                  onClick={() => onChange({ contentRating: active ? null : rating })}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    active
                      ? 'bg-white text-black border-white'
                      : 'bg-white/[0.03] text-white/55 border-white/10 hover:bg-white/[0.06]'
                  }`}
                >
                  {rating}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* 13. PRODUCTION COMPANY */}
      <div ref={dropdownRef3} className="relative">
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Production company
        </h3>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {localPrefs.includeCompanies.map((c) => (
            <span
              key={`comp-${c.id}`}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-white/10 text-white"
            >
              {c.name}
              <button
                type="button"
                onClick={() => handleRemoveCompany(c.id)}
                className="w-3.5 h-3.5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-[8px]"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-grow">
            <input
              type="text"
              placeholder="Search companies (A24, Ghibli, Blumhouse...)"
              value={companyQuery}
              onChange={(e) => {
                setCompanyQuery(e.target.value)
                setShowCompanyDropdown(true)
              }}
              onFocus={() => setShowCompanyDropdown(true)}
              className="w-full bg-white/[0.03] border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 placeholder:text-white/20"
            />
            <svg
              className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
        {showCompanyDropdown && companySuggestions.length > 0 && (
          <div className="absolute z-[100] left-0 right-0 mt-1 bg-[#181818] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
            {companySuggestions.map((c) => (
              <button
                key={`comp-sug-${c.id}`}
                type="button"
                onClick={() => {
                  handleAddCompany(c)
                  setCompanyQuery('')
                  setShowCompanyDropdown(false)
                }}
                className="w-full text-left px-4 py-2.5 text-sm text-white/80 hover:text-white hover:bg-white/[0.04] transition-colors"
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 14. SORT ORDER */}
      <div>
        <h3 className="text-[11px] font-black tracking-wider text-white/45 uppercase mb-1.5 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Sort order
        </h3>
        <select
          value={localPrefs.sortOrder}
          onChange={(e) => onChange({ sortOrder: e.target.value as DiscoverPrefs['sortOrder'] })}
          className="w-full bg-[#181818] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-white/20 cursor-pointer"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-[#181818] text-white">
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
