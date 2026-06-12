import type { ReactNode } from 'react'

interface Tab {
  id: string
  label: string
  icon?: ReactNode
}

interface TabsProps {
  tabs: Tab[]
  activeTab: string
  onChange: (id: string) => void
  variant?: 'pill' | 'underline'
  size?: 'sm' | 'md'
  className?: string
}

export default function Tabs({
  tabs,
  activeTab,
  onChange,
  variant = 'pill',
  size = 'md',
  className = '',
}: TabsProps) {
  if (variant === 'underline') {
    return (
      <div className={`flex gap-1 border-b border-white/8 ${className}`}>
        {tabs.map((tab) => {
          const active = tab.id === activeTab
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={[
                'flex items-center gap-2 px-4 pb-3 pt-1 text-sm font-medium',
                'transition-all duration-200 cursor-pointer relative',
                'border-b-2 -mb-[1px]',
                active
                  ? 'text-white border-accent'
                  : 'text-white/50 hover:text-white/75 border-transparent hover:border-white/15',
              ].join(' ')}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div
      className={[
        'inline-flex rounded-xl p-1 bg-white/5 border border-white/5',
        size === 'sm' ? 'gap-0.5' : 'gap-1',
        className,
      ].join(' ')}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={[
              'flex items-center gap-2 font-semibold rounded-lg',
              'transition-all duration-200 cursor-pointer',
              size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
              active
                ? 'bg-white/10 text-white shadow-sm'
                : 'text-white/50 hover:text-white/75 hover:bg-white/5',
            ].join(' ')}
          >
            {tab.icon}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
