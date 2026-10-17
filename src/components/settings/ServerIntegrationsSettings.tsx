import { useCallback, useEffect, useState } from 'react'
import Switch from '../ui/Switch'
import SelectMenu from '../ui/SelectMenu'
import { useAppStore } from '../../stores/appStore'
import {
  listServerConnections,
  listServerCatalogs,
  serverCatalogListId,
  refreshServerCatalog,
  removeServerConnection,
  saveServerConnection,
  setServerConnectionEnabled,
  testServerConnection,
  type ServerAuthMode,
  type ServerConnectionInput,
  type ServerConnectionSummary,
  type ServerCatalogDescriptor,
  type ServerIntegrationKind,
} from '../../services/serverIntegrations'

const EMPTY_FORM: ServerConnectionInput = {
  kind: 'jellyfin', name: '', serverUrl: '', username: '', secret: '', authMode: 'password', baseDirectory: '', enabled: true,
}

function statusColor(status: ServerConnectionSummary['status']): string {
  if (status === 'connected') return 'bg-emerald-400'
  if (status === 'error') return 'bg-red-400'
  if (status === 'disconnected') return 'bg-white/30'
  return 'bg-amber-300'
}

function realLibraryCatalogs(connection: ServerConnectionSummary, catalogs: ServerCatalogDescriptor[]) {
  return catalogs.filter((catalog) => catalog.connectionId === connection.id
    && catalog.catalogId.startsWith('library:')
    // Every item belongs to an internal connection-wide catalog. Only expose
    // actual Jellyfin/WebDAV library names as Library shelves.
    && catalog.catalogId !== `library:${connection.name}`)
}

export default function ServerIntegrationsSettings() {
  const [connections, setConnections] = useState<ServerConnectionSummary[]>([])
  const [catalogs, setCatalogs] = useState<ServerCatalogDescriptor[]>([])
  const [form, setForm] = useState<ServerConnectionInput | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const homeRows = useAppStore((state) => state.homeRows)
  const addHomeRow = useAppStore((state) => state.addHomeRow)

  const reload = useCallback(async () => {
    try {
      const [nextConnections, nextCatalogs] = await Promise.all([listServerConnections(), listServerCatalogs()])
      setConnections(nextConnections)
      setCatalogs(nextCatalogs)
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // A server library is a first-class Aurales catalog. Add real server
  // libraries as shelves as soon as a completed scan exposes them, instead of
  // requiring a second, hidden manual step in the Library editor.
  useEffect(() => {
    connections.flatMap((connection) => realLibraryCatalogs(connection, catalogs).map((catalog) => ({ connection, catalog })))
      .filter(({ connection, catalog }) => !homeRows.some((row) => row.sourceType === connection.kind
        && row.providerListId === serverCatalogListId(connection.id, catalog.catalogId)))
      .forEach(({ connection, catalog }) => addHomeRow({
        title: catalog.title,
        sourceType: connection.kind,
        providerListId: serverCatalogListId(connection.id, catalog.catalogId),
        layout: 'poster',
        enabled: true,
      }))
  }, [connections, catalogs, homeRows, addHomeRow])

  const edit = (connection: ServerConnectionSummary) => setForm({
    id: connection.id,
    kind: connection.kind,
    name: connection.name,
    serverUrl: connection.serverUrl,
    username: connection.username || '',
    secret: '',
    authMode: connection.authMode,
    baseDirectory: connection.baseDirectory || '',
    enabled: connection.enabled,
  })

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setMessage('')
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(null) }
  }

  const save = () => form && run('save', async () => {
    if (!form.serverUrl.trim()) throw new Error('Enter a server URL.')
    if (!form.name.trim()) throw new Error('Enter a connection name.')
    if (!form.secret && !form.id) throw new Error(form.authMode === 'token' ? 'Enter an access token or API key.' : 'Enter a Jellyfin password.')
    const normalized = { ...form, serverUrl: form.serverUrl.trim(), name: form.name.trim() }
    const saved = await saveServerConnection(normalized)
    if (!saved.hasSecret) throw new Error('Aurales could not store the server credential in the system credential vault.')
    // Test through the saved id with no supplied secret. This verifies the
    // exact credential the catalog refresh will use, rather than only the
    // transient value held by the form.
    const testResult = await testServerConnection({ ...normalized, id: saved.id, secret: undefined })
    if (!testResult.ok) throw new Error(testResult.message || 'Authentication failed.')
    setForm(null)
    await reload()
    // A successful connection must stay visible even if its first catalog scan
    // fails (for example, when a server exposes no readable libraries yet).
    // The saved card provides a retryable Refresh catalog action in that case.
    try {
      await refreshServerCatalog(saved.id)
      await reload()
    } catch (error) {
      setMessage(`Server saved. Initial catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const test = () => form && run('test', async () => {
    const result = await testServerConnection(form)
    setMessage(result.ok ? `Connected${result.serverName ? ` to ${result.serverName}` : ''}${result.userName ? ` as ${result.userName}` : ''}.` : result.message || 'Connection failed.')
  })

  const addLibrariesToHome = (connection: ServerConnectionSummary) => {
    const libraries = realLibraryCatalogs(connection, catalogs)
    const missing = libraries.filter((catalog) => !homeRows.some((row) => row.sourceType === connection.kind
      && row.providerListId === serverCatalogListId(connection.id, catalog.catalogId)))
    missing.forEach((catalog) => addHomeRow({
      title: catalog.title,
      sourceType: connection.kind,
      providerListId: serverCatalogListId(connection.id, catalog.catalogId),
      layout: 'poster',
      enabled: true,
    }))
    setMessage(missing.length ? `Added ${missing.length} ${missing.length === 1 ? 'server library' : 'server libraries'} to Library.` : 'All server libraries are already in Library.')
  }

  return <div className="space-y-6">
    <section className="settings-panel-card rounded-2xl border border-white/[.06] bg-white/[.03] p-6">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="text-lg font-bold text-white">Media servers</h2><p className="mt-1 text-sm text-white/60">Jellyfin libraries and WebDAV folders become normal Aurales catalogs and playback sources.</p></div>
        <button type="button" onClick={() => setForm({ ...EMPTY_FORM })} className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-black">Add server</button>
      </div>
      <div className="mt-5 space-y-3">
        {connections.map((connection) => {
          const serverCatalogs = catalogs.filter((catalog) => catalog.connectionId === connection.id)
          const libraryCount = serverCatalogs.filter((catalog) => catalog.kind === 'library').length
          const continueWatchingCount = serverCatalogs.find((catalog) => catalog.kind === 'continue-watching')?.itemCount || 0
          const itemCount = serverCatalogs[0]?.connectionItemCount || 0
          return <article key={connection.id} className="rounded-xl border border-white/[.08] bg-black/15 p-4">
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${statusColor(connection.status)}`} aria-label={connection.status} />
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-white">{connection.name}</p><p className="truncate text-xs text-white/50">{connection.kind === 'jellyfin' ? 'Jellyfin' : 'WebDAV'} · {connection.serverName || connection.serverUrl}</p></div>
            <Switch checked={connection.enabled} onChange={(enabled) => void run(`toggle:${connection.id}`, async () => { await setServerConnectionEnabled(connection.id, enabled); await reload() })} label={`Enable ${connection.name}`} disabled={busy !== null} />
          </div>
          {connection.hasSecret && <p className="mt-2 text-xs text-white/45">{serverCatalogs.length ? `${libraryCount} ${libraryCount === 1 ? 'library' : 'libraries'} · ${serverCatalogs.length} catalogs · ${itemCount.toLocaleString()} indexed items${continueWatchingCount ? ` · ${continueWatchingCount} in progress` : ''}` : 'No catalogs indexed yet. Refresh catalog to scan this server.'}</p>}
          {(connection.statusMessage || connection.lastCatalogRefreshAt || !connection.hasSecret) && <p className="mt-2 text-xs text-white/45">{!connection.hasSecret ? 'Credential required. Edit this server to securely save its password or token.' : connection.statusMessage || `Catalog updated ${new Date(connection.lastCatalogRefreshAt!).toLocaleString()}`}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => edit(connection)} className="rounded-lg bg-white/[.07] px-3 py-1.5 text-xs font-semibold text-white/75 hover:bg-white/[.12]">Edit</button>
            <button type="button" disabled={!connection.hasSecret || busy !== null} onClick={() => void run(`test:${connection.id}`, async () => { const result = await testServerConnection({ ...connection, secret: undefined }); setMessage(result.ok ? `${connection.name} is reachable.` : result.message || 'Connection failed.'); await reload() })} className="rounded-lg bg-white/[.07] px-3 py-1.5 text-xs font-semibold text-white/75 disabled:opacity-40" title={!connection.hasSecret ? 'Edit the server to add its credential first' : undefined}>Test</button>
            <button type="button" disabled={!connection.enabled || !connection.hasSecret || busy !== null} onClick={() => void run(`refresh:${connection.id}`, async () => { await refreshServerCatalog(connection.id); await reload() })} className="rounded-lg bg-white/[.07] px-3 py-1.5 text-xs font-semibold text-white/75 disabled:opacity-40" title={!connection.hasSecret ? 'Edit the server to add its credential first' : undefined}>Refresh catalog</button>
            <button type="button" disabled={!realLibraryCatalogs(connection, serverCatalogs).length} onClick={() => addLibrariesToHome(connection)} className="rounded-lg bg-white/[.07] px-3 py-1.5 text-xs font-semibold text-white/75 disabled:opacity-40">Add libraries to Library</button>
            <button type="button" disabled={busy !== null} onClick={() => void run(`remove:${connection.id}`, async () => { await removeServerConnection(connection.id); await reload() })} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-300/75 hover:bg-red-500/10 disabled:opacity-40">Remove</button>
          </div>
        </article>
        })}
        {connections.length === 0 && <p className="rounded-xl border border-dashed border-white/[.1] px-4 py-8 text-center text-sm text-white/45">No media servers connected yet.</p>}
      </div>
      {message && <p role="status" className="mt-4 text-sm text-white/65">{message}</p>}
    </section>

    {form && <ConnectionEditor form={form} hasStoredSecret={Boolean(form.id && connections.find((item) => item.id === form.id)?.hasSecret)} busy={busy !== null} onChange={setForm} onCancel={() => setForm(null)} onSave={save} onTest={test} />}
  </div>
}

function ConnectionEditor({ form, hasStoredSecret, busy, onChange, onCancel, onSave, onTest }: { form: ServerConnectionInput; hasStoredSecret: boolean; busy: boolean; onChange: (value: ServerConnectionInput) => void; onCancel: () => void; onSave: () => void; onTest: () => void }) {
  const set = <K extends keyof ServerConnectionInput>(key: K, value: ServerConnectionInput[K]) => onChange({ ...form, [key]: value })
  const inputClass = 'mt-1.5 w-full rounded-xl border border-white/[.08] bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/50'
  return <section className="settings-panel-card rounded-2xl border border-white/[.08] bg-white/[.035] p-6">
    <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-white">{form.id ? 'Edit server' : 'Connect a server'}</h2><button type="button" onClick={onCancel} className="text-sm text-white/50 hover:text-white">Cancel</button></div>
    <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div><label className="text-xs font-semibold text-white/60">Type</label><SelectMenu value={form.kind} onChange={(e) => set('kind', e.target.value as ServerIntegrationKind)} aria-label="Server type" className="mt-1.5"><option value="jellyfin">Jellyfin</option><option value="webdav">WebDAV</option></SelectMenu></div>
      <label className="text-xs font-semibold text-white/60">Connection name<input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={form.kind === 'jellyfin' ? 'Home Jellyfin' : 'Media WebDAV'} className={inputClass} /></label>
      <label className="text-xs font-semibold text-white/60 md:col-span-2">Server URL<input type="url" value={form.serverUrl} onChange={(e) => set('serverUrl', e.target.value)} placeholder="https://media.example.com" className={inputClass} /></label>
      <label className="text-xs font-semibold text-white/60">Username<input value={form.username || ''} onChange={(e) => set('username', e.target.value)} autoComplete="username" className={inputClass} /></label>
      <div><label className="text-xs font-semibold text-white/60">Authentication</label><SelectMenu value={form.authMode} onChange={(e) => set('authMode', e.target.value as ServerAuthMode)} aria-label="Authentication method" className="mt-1.5"><option value="password">Username / password</option><option value="token">Access token / API key</option></SelectMenu></div>
      <label className="text-xs font-semibold text-white/60 md:col-span-2">{form.authMode === 'token' ? 'Token / API key' : 'Password'}<input type="password" value={form.secret || ''} onChange={(e) => set('secret', e.target.value)} autoComplete="new-password" placeholder={hasStoredSecret ? 'Leave blank to keep the securely stored credential' : ''} className={inputClass} /></label>
      {form.kind === 'webdav' && <label className="text-xs font-semibold text-white/60 md:col-span-2">Base directory <span className="font-normal text-white/35">(optional)</span><input value={form.baseDirectory || ''} onChange={(e) => set('baseDirectory', e.target.value)} placeholder="/Media" className={inputClass} /></label>}
    </div>
    <p className="mt-4 text-xs leading-relaxed text-white/40">Credentials are sent directly to the native Aurales backend and stored in the system credential vault; they are never written to browser storage.</p>
    <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onTest} className="rounded-xl bg-white/[.08] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">Test connection</button><button type="button" disabled={busy} onClick={onSave} className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-black disabled:opacity-40">{form.id ? 'Save changes' : 'Connect'}</button></div>
  </section>
}
