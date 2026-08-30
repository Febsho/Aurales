import { type ReactNode, useMemo, useState } from 'react'
import { getSelfhstIconUrl } from '../../services/serviceIcons'
import Button from '../ui/Button'
import Modal from '../ui/Modal'

export type IntegrationState = 'connected' | 'syncing' | 'not-connected' | 'needs-attention'

export interface Integration {
  id: string
  name: string
  iconService: string
  description: string
  group: 'history' | 'streaming' | 'ecosystem' | 'playback' | 'metadata' | 'ai'
  state: IntegrationState
  statusLabel?: string
  isAccount?: boolean
  isConfigured?: boolean
  account?: string
  detail?: string
  message?: string
  primaryLabel: string
  onPrimary: () => void
  primaryOpensManage?: boolean
  showAdvancedLink?: boolean
  hidePrimaryAction?: boolean
  inlineControl?: ReactNode
  onSync?: () => void
  syncLabel?: string
  onDisconnect?: () => void
  manage?: ReactNode
  setup?: ReactNode
  wide?: boolean
}

const stateCopy: Record<IntegrationState, { label: string; marker: string; className: string }> = {
  connected: { label: 'Connected', marker: '●', className: 'text-emerald-200 bg-emerald-400/10 border-emerald-300/15' },
  syncing: { label: 'Syncing…', marker: '↻', className: 'text-accent bg-accent/10 border-accent/20' },
  'not-connected': { label: 'Not connected', marker: '○', className: 'text-white/55 bg-white/[.045] border-white/[.08]' },
  'needs-attention': { label: 'Needs attention', marker: '⚠', className: 'text-amber-200 bg-amber-400/10 border-amber-300/15' },
}

function IntegrationIcon({ service, name }: { service: string; name: string }) {
  const icon = getSelfhstIconUrl(service)
  return (
    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/[.06] shadow-inner shadow-white/[.05]">
      {icon ? <img src={icon} alt={`${name} logo`} className="h-6 w-6 object-contain" /> : <span className="text-sm font-black tracking-tight text-white/80">{name.slice(0, 2)}</span>}
    </div>
  )
}

function Status({ state, label }: { state: IntegrationState; label?: string }) {
  const value = stateCopy[state]
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${value.className}`}><span aria-hidden>{value.marker}</span>{label ?? value.label}</span>
}

function IntegrationCard({ integration, onManage }: { integration: Integration; onManage: () => void }) {
  const busy = integration.state === 'syncing'
  return (
    <article className={`group flex min-h-44 flex-col rounded-3xl border border-white/[.09] bg-white/[.035] p-5 shadow-[0_12px_35px_rgba(0,0,0,.14)] backdrop-blur-xl transition-[transform,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-white/[.16] hover:bg-white/[.055] motion-reduce:transform-none ${integration.wide ? 'md:col-span-2' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <IntegrationIcon service={integration.iconService} name={integration.name} />
          <div className="min-w-0">
            <h3 className="text-base font-bold tracking-tight text-white">{integration.name}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-white/55">{integration.description}</p>
          </div>
        </div>
        <Status state={integration.state} label={integration.statusLabel} />
      </div>
      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-5">
        <div className="min-h-5 text-xs text-white/50">
          {integration.account && <span>{integration.account}</span>}
          {integration.detail && <span className={integration.account ? 'ml-2 text-white/35' : ''}>{integration.detail}</span>}
          {integration.message && <span className="block text-amber-100/80">{integration.message}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {integration.inlineControl}
          {integration.onSync && integration.state === 'connected' && <Button variant="secondary" size="sm" onClick={integration.onSync}>{integration.syncLabel ?? 'Sync Now'}</Button>}
          {!integration.hidePrimaryAction && (integration.state === 'connected' ? <Button variant="ghost" size="sm" onClick={onManage}>Manage <span aria-hidden>›</span></Button> : <Button size="sm" onClick={integration.primaryOpensManage ? onManage : integration.onPrimary} loading={busy}>{integration.primaryLabel} <span aria-hidden>›</span></Button>)}
          {integration.showAdvancedLink && integration.state !== 'connected' && integration.setup && <button type="button" onClick={onManage} className="px-1 py-1 text-xs font-semibold text-white/50 transition hover:text-white focus-ring">Advanced setup</button>}
        </div>
      </div>
    </article>
  )
}

export default function AccountsHub({ integrations }: { integrations: Integration[] }) {
  const [managedId, setManagedId] = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const managed = integrations.find((item) => item.id === managedId)
  const connected = useMemo(() => integrations.filter((item) => item.isAccount && item.state === 'connected').length, [integrations])
  const configured = useMemo(() => integrations.filter((item) => item.isConfigured).length, [integrations])
  const attention = integrations.filter((item) => item.state === 'needs-attention').length
  const groups = [
    ['history', 'Watch History & Lists'],
    ['streaming', 'Streaming & Debrid'],
    ['ecosystem', 'Media Ecosystem'],
    ['playback', 'Playback Enhancements'],
    ['metadata', 'Artwork & Metadata'],
    ['ai', 'AI & Intelligence'],
  ] as const
  const summaryParts = [connected ? `${connected} account${connected === 1 ? '' : 's'} connected` : '', configured ? `${configured} service${configured === 1 ? '' : 's'} configured` : ''].filter(Boolean)
  const summary = summaryParts.length ? `${summaryParts.join(' · ')}${attention ? ` · ${attention} needs attention` : ' · All services healthy'}` : 'No services configured'
  return (
    <section className="accounts-hub mx-auto w-full max-w-[1120px]" aria-label="Connected services">
      <header className="mb-9 max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-[.22em] text-accent/80">Your services</p>
        <h2 className="mt-2 text-3xl font-black tracking-tight text-white">Accounts</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">Connect Aurales to the services you already use. Bring your history, lists, anime progress, and streaming together.</p>
        <p className="mt-4 text-xs font-semibold text-white/65">{summary}</p>
      </header>
      {connected === 0 && configured === 0 && <div className="mb-8 rounded-2xl border border-white/[.08] bg-white/[.025] px-5 py-4 text-sm text-white/60"><strong className="font-semibold text-white/85">Connect your services.</strong> Aurales works without external accounts, but services can bring your existing library and activity with you.</div>}
      <div className="space-y-9">
        {groups.map(([id, label]) => {
          const items = integrations.filter((item) => item.group === id)
          if (!items.length) return null
          return <section key={id} aria-labelledby={`accounts-${id}`}><h3 id={`accounts-${id}`} className="mb-3 text-[11px] font-bold uppercase tracking-[.18em] text-white/35">{label}</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-2">{items.map((integration) => <IntegrationCard key={integration.id} integration={integration} onManage={() => setManagedId(integration.id)} />)}</div></section>
        })}
      </div>
      {managed && <Modal open onClose={() => { setManagedId(null); setConfirmDisconnect(false) }} title={managed.name} description={managed.statusLabel ?? stateCopy[managed.state].label} size="md"><div className="space-y-6"><div className="flex items-center gap-3"><IntegrationIcon service={managed.iconService} name={managed.name} /><div><p className="text-sm font-semibold text-white">{managed.account ?? managed.description}</p>{managed.detail && <p className="mt-1 text-xs text-white/55">{managed.detail}</p>}</div></div>{managed.manage}{managed.setup && <section className="border-t border-white/[.08] pt-5"><p className="mb-3 text-xs font-bold uppercase tracking-[.16em] text-white/40">Advanced</p>{managed.setup}</section>}{managed.state === 'connected' && managed.onSync && <Button variant="secondary" onClick={managed.onSync}>{managed.syncLabel ?? 'Sync Now'}</Button>}{managed.state === 'connected' && managed.onDisconnect && <section className="border-t border-white/[.08] pt-5"><p className="mb-3 text-xs font-bold uppercase tracking-[.16em] text-white/40">Danger zone</p>{confirmDisconnect ? <div className="rounded-xl border border-danger/20 bg-danger/[.06] p-3"><p className="text-sm text-white/75">Disconnect {managed.name}? Credentials will be removed from this profile; local viewing history stays in Aurales.</p><div className="mt-3 flex gap-2"><Button variant="danger" size="sm" onClick={() => { managed.onDisconnect?.(); setManagedId(null); setConfirmDisconnect(false) }}>Confirm disconnect</Button><Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>Cancel</Button></div></div> : <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>Disconnect {managed.name}</Button>}</section>}</div></Modal>}
    </section>
  )
}
