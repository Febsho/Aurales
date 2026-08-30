import { useState } from 'react'
import { DEFAULT_SYNC_ENDPOINT, getSyncConfig, getSyncOutbox, setSyncConfig, syncNow } from '../../services/sync/auralesSync'
import EncryptedVaultSettings from './EncryptedVaultSettings'
import { lockSyncVault, unlockSyncVault } from '../../services/sync/encryptedVault'
import { deleteSyncPassword, saveSyncPassword } from '../../services/sync/secureLogin'

export default function AuralesSyncSettings() {
  const [config, setConfig] = useState(() => getSyncConfig())
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState(config.email || '')
  const [password, setPassword] = useState('')
  const connected = Boolean(config.accessToken)

  const authenticate = async (action: 'register' | 'login') => {
    try {
      const response = await fetch(`${DEFAULT_SYNC_ENDPOINT}/v1/auth/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
      const result = await response.json() as { accessToken?: string; error?: string }
      if (!response.ok || !result.accessToken) throw new Error(result.error || 'Authentication failed')
      unlockSyncVault(password)
      await saveSyncPassword(email.trim().toLowerCase(), password)
      const next = { ...config, endpoint: DEFAULT_SYNC_ENDPOINT, accessToken: result.accessToken, email: email.trim().toLowerCase() }
      setConfig(next); setSyncConfig(next); setPassword('')
      setMessage(action === 'register' ? 'Account created — connected accounts are ready to back up' : 'Signed in — connected accounts unlocked')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Authentication failed') }
  }
  const sync = () => {
    if (!config.accessToken) { setMessage('Sign in to your Aurales Sync account first.'); return }
    void syncNow().then((result) => setMessage(`Synced ${result.uploaded} pending changes`)).catch((error) => setMessage(error.message))
  }
  const signOut = () => {
    lockSyncVault()
    if (config.email) void deleteSyncPassword(config.email)
    const next = { endpoint: DEFAULT_SYNC_ENDPOINT }
    setConfig(next); setSyncConfig({ accessToken: undefined, cursor: undefined, email: undefined, lastSyncAt: undefined, lastError: undefined })
    setPassword(''); setMessage('Signed out on this device')
  }

  return <section className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.025]">
    <div className="border-b border-white/[0.06] px-6 py-5"><h2 className="font-semibold text-white">Aurales Account</h2><p className="mt-1 text-sm text-white/60">Sign in once to sync profiles, library and watchlists, history and progress, Discover taste, playback preferences, and all durable app settings across your devices.</p></div>
    <div className="space-y-4 px-6 py-5">
      {connected ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[.08] bg-black/[.12] p-4"><p className="font-medium text-white">Signed in{config.email ? ` as ${config.email}` : ''}</p><button onClick={signOut} className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/75">Sign out</button></div> : <div className="grid gap-3 rounded-2xl border border-white/[.08] bg-black/[.12] p-4 sm:grid-cols-2"><label className="text-sm text-white/65">Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white outline-none" /></label><label className="text-sm text-white/65">Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={12} autoComplete="current-password" className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-white outline-none" /></label><div className="sm:col-span-2 flex gap-2"><button onClick={() => void authenticate('login')} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black">Sign in</button><button onClick={() => void authenticate('register')} className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white/75">Create account</button></div></div>}
      <div className="flex flex-wrap items-center gap-3"><button onClick={sync} disabled={!connected} className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40">Sync Now</button><span className="text-xs text-white/45">{message || `${getSyncOutbox().length} pending changes`}</span></div>
      <EncryptedVaultSettings connected={connected} />
    </div>
  </section>
}
