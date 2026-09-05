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

function IntegrationCard({ integration, onManage }: { integration: Integration; onManage: () => void }) {
  const status = integration.statusLabel ?? stateCopy[integration.state].label
  const open = () => {
    if (integration.manage || integration.setup || integration.onDisconnect) onManage()
    else integration.onPrimary()
  }
  return (
    <div className="group flex w-full items-center transition-colors hover:bg-white/[.055] focus-within:bg-white/[.055]">
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 items-center justify-between gap-5 px-4 py-4 text-left focus-visible:outline-none sm:px-5"
        aria-label={`${integration.name}, ${status}`}
      >
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight text-white/90">{integration.name}</h3>
          {(integration.account || integration.message) && (
            <p className={`mt-0.5 truncate text-xs ${integration.message && integration.state === 'needs-attention' ? 'text-amber-200/70' : 'text-white/40'}`}>
              {integration.message || integration.account}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!integration.inlineControl && (
          <span className={`text-sm font-medium ${integration.state === 'connected' ? 'text-emerald-200/80' : integration.state === 'needs-attention' ? 'text-amber-200/80' : 'text-white/48'}`}>
            {status}
          </span>
          )}
          <svg className="h-4 w-4 text-white/35 transition-transform group-hover:translate-x-0.5 group-hover:text-white/65" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
            <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>
      {integration.inlineControl && <div className="shrink-0 pr-4 sm:pr-5">{integration.inlineControl}</div>}
    </div>
  )
}

const groupCopy: Array<{ ids: Integration['group'][]; title: string }> = [
  { ids: ['history'], title: 'Accounts' },
  { ids: ['streaming'], title: 'Playback services' },
  { ids: ['ecosystem'], title: 'Media ecosystem' },
  { ids: ['playback', 'metadata', 'ai'], title: 'Optional services' },
]

function IntegrationList({ title, integrations, onManage }: { title: string; integrations: Integration[]; onManage: (id: string) => void }) {
  if (!integrations.length) return null
  return (
    <section aria-labelledby={`accounts-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <h3 id={`accounts-${title.toLowerCase().replace(/\s+/g, '-')}`} className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[.16em] text-white/38">{title}</h3>
      <div className="settings-panel-card divide-y divide-white/[.055] overflow-hidden rounded-2xl border border-white/[.075] bg-white/[.025]">
        {integrations.map((integration) => (
          <IntegrationCard key={integration.id} integration={integration} onManage={() => onManage(integration.id)} />
        ))}
      </div>
    </section>
  )
}

export default function AccountsHub({ integrations }: { integrations: Integration[] }) {
  const [managedId, setManagedId] = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const managed = integrations.find((item) => item.id === managedId)
  const connected = useMemo(() => integrations.filter((item) => item.isAccount && item.state === 'connected').length, [integrations])
  const configured = useMemo(() => integrations.filter((item) => item.isConfigured).length, [integrations])
  return (
    <section className="accounts-hub mx-auto w-full max-w-[820px]" aria-label="Connected services">
      <header className="mb-7 max-w-2xl">
        <h2 className="text-3xl font-black tracking-tight text-white">Accounts</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/55">Connect and manage the services Aurales uses.</p>
      </header>
      {connected === 0 && configured === 0 && <div className="settings-panel-card mb-8 rounded-2xl border border-white/[.08] bg-white/[.025] px-5 py-4 text-sm text-white/60"><strong className="font-semibold text-white/85">Connect your services.</strong> Aurales works without external accounts, but services can bring your existing library and activity with you.</div>}
      <div className="space-y-7">
        {groupCopy.map((group) => (
          <IntegrationList key={group.title} title={group.title} integrations={integrations.filter((item) => group.ids.includes(item.group))} onManage={setManagedId} />
        ))}
      </div>
      <p className="mt-7 max-w-3xl px-1 text-xs leading-relaxed text-white/45">Watchlists, lists, history, scrobbling, and resume positions sync with each connected tracker. Playback services such as TorBox only resolve playback links on this device.</p>
      {managed && (
        <Modal
          open
          onClose={() => { setManagedId(null); setConfirmDisconnect(false) }}
          size="md"
          className="accounts-service-modal overflow-hidden"
        >
          <div className="space-y-5">
            <header className="accounts-service-modal__hero">
              <div className="accounts-service-modal__icon"><IntegrationIcon service={managed.iconService} name={managed.name} /></div>
              <div className="min-w-0">
                <p className="accounts-service-modal__eyebrow">{managed.group === 'streaming' ? 'Playback service' : managed.group === 'history' ? 'Connected account' : 'Service settings'}</p>
                <h2 className="mt-1 text-2xl font-black tracking-tight text-white">{managed.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-white/55">
                  <span>{managed.account ?? managed.description}</span>
                  {managed.detail && <><span className="text-white/20">•</span><span>{managed.detail}</span></>}
                </div>
              </div>
              <span className={`accounts-service-modal__status accounts-service-modal__status--${managed.state}`}>
                {managed.statusLabel ?? stateCopy[managed.state].label}
              </span>
            </header>

            {managed.message && <div className={`accounts-service-modal__notice ${managed.state === 'needs-attention' ? 'accounts-service-modal__notice--warning' : ''}`}>{managed.message}</div>}

            {managed.state !== 'connected' && !managed.primaryOpensManage && !managed.hidePrimaryAction && (
              <div className="accounts-service-modal__action"><Button onClick={managed.onPrimary} loading={managed.state === 'syncing'}>{managed.primaryLabel}</Button></div>
            )}

            {managed.manage && <section className="accounts-service-modal__section">{managed.manage}</section>}
            {managed.setup && <section className="accounts-service-modal__section"><p className="accounts-service-modal__section-label">Setup & access</p>{managed.setup}</section>}
            {managed.state === 'connected' && managed.onSync && <div className="accounts-service-modal__action"><Button variant="secondary" onClick={managed.onSync}>{managed.syncLabel ?? 'Sync Now'}</Button></div>}

            {managed.state === 'connected' && managed.onDisconnect && (
              <section className="accounts-service-modal__disconnect">
                <p className="accounts-service-modal__section-label">Connection</p>
                {confirmDisconnect ? (
                  <div className="rounded-2xl border border-danger/20 bg-danger/[.07] p-4">
                    <p className="text-sm leading-relaxed text-white/75">Disconnect {managed.name}? Credentials will be removed from this profile; local viewing history stays in Aurales.</p>
                    <div className="mt-4 flex flex-wrap gap-2"><Button variant="danger" size="sm" onClick={() => { managed.onDisconnect?.(); setManagedId(null); setConfirmDisconnect(false) }}>Confirm disconnect</Button><Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>Cancel</Button></div>
                  </div>
                ) : <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Disconnect {managed.name}</Button>}
              </section>
            )}
          </div>
        </Modal>
      )}
    </section>
  )
}
