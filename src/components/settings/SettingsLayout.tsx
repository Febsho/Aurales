import { useState, type ReactNode } from 'react'

export interface SettingsCategory {
  id: string
  label: string
  icon: ReactNode
  group?: string
}

interface SettingsLayoutProps {
  categories: SettingsCategory[]
  activeCategory: string
  onCategoryChange: (id: string) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  children: ReactNode
}

export default function SettingsLayout({
  categories,
  activeCategory,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  children,
}: SettingsLayoutProps) {
  const groups = categories.reduce<Record<string, SettingsCategory[]>>((acc, cat) => {
    const group = cat.group || 'General'
    if (!acc[group]) acc[group] = []
    acc[group].push(cat)
    return acc
  }, {})

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="w-64 flex-shrink-0 border-r border-white/[0.06] bg-white/[0.02] overflow-y-auto">
        <div className="p-4">
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1">Settings</h1>
          <p className="text-xs text-white/35 mb-4">Configure your app</p>

          {/* Search */}
          <div className="relative mb-5">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search settings..."
              className="w-full pl-9 pr-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded-lg text-xs text-white placeholder-white/25 focus:outline-none focus:bg-white/[0.07] focus:border-white/[0.12] transition-all"
            />
          </div>
        </div>

        {/* Category nav */}
        <nav className="px-2.5 pb-4">
          {Object.entries(groups).map(([group, cats]) => (
            <div key={group} className="mb-4">
              <div className="px-3 mb-1.5">
                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/20">{group}</span>
              </div>
              {cats.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => onCategoryChange(cat.id)}
                  className={[
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left',
                    'transition-all duration-200 cursor-pointer text-[13px] font-medium',
                    activeCategory === cat.id
                      ? 'bg-accent/10 text-accent'
                      : 'text-white/50 hover:text-white/75 hover:bg-white/[0.04]',
                  ].join(' ')}
                >
                  <span className={`[&>svg]:w-4 [&>svg]:h-4 flex-shrink-0 ${activeCategory === cat.id ? 'text-accent' : 'text-white/35'}`}>
                    {cat.icon}
                  </span>
                  {cat.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-8">
          {children}
        </div>
      </div>
    </div>
  )
}

export function SettingsSection({
  title,
  description,
  children,
  danger,
}: {
  title: string
  description?: string
  children: ReactNode
  danger?: boolean
}) {
  return (
    <div className={[
      'rounded-2xl border p-6 mb-6',
      danger
        ? 'border-danger/15 bg-danger/[0.03]'
        : 'border-white/[0.06] bg-white/[0.02]',
    ].join(' ')}>
      <h3 className={`text-base font-bold mb-1 ${danger ? 'text-danger' : 'text-white'}`}>{title}</h3>
      {description && <p className="text-xs text-white/40 mb-5 leading-relaxed">{description}</p>}
      <div className="space-y-5">
        {children}
      </div>
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-white/85">{label}</div>
        {description && <div className="text-xs text-white/35 mt-0.5 leading-relaxed">{description}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}
