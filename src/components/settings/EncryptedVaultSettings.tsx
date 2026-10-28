import { useEffect, useState, type FormEvent } from 'react'
import { isSyncVaultUnlocked, lockSyncVault, unlockSyncVault } from '../../services/sync/encryptedVault'
import { syncPasswordPersistenceAvailable } from '../../services/sync/secureLogin'
import { downloadSyncNow } from '../../services/sync/auralesSync'

const VAULT_STATE_EVENT = 'aurales:sync-vault-state-changed'

export default function EncryptedVaultSettings({ connected }: { connected: boolean }) {
  const [unlocked, setUnlocked] = useState(isSyncVaultUnlocked)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const update = () => setUnlocked(isSyncVaultUnlocked())
    window.addEventListener(VAULT_STATE_EVENT, update)
    update()
    return () => window.removeEventListener(VAULT_STATE_EVENT, update)
  }, [])

  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    try {
      unlockSyncVault(password)
      setPassword('')
      setBusy(true)
      const result = await downloadSyncNow()
      setMessage(`Encrypted settings unlocked. Downloaded ${result.downloaded} sync records.`)
    } catch (error) {
      lockSyncVault()
      setMessage(error instanceof Error ? error.message : 'Could not unlock encrypted settings.')
    } finally {
      setBusy(false)
    }
  }

  if (!connected) return <p className="text-xs text-white/45">Sign in to enable automatic account sync.</p>
  if (unlocked) return <p className="text-xs text-white/45">Encrypted settings are unlocked for this session.</p>

  return (
    <div className="mt-5 rounded-2xl border border-white/[.09] bg-white/[.025] p-4">
      <p className="text-sm font-semibold text-white">Unlock encrypted settings</p>
      <p className="mt-1 text-xs leading-5 text-white/50">
        Enter your Aurales Sync password to restore connected accounts and provider settings.
        {!syncPasswordPersistenceAvailable() && ' Browser sessions do not save this password, so unlock again after reloading.'}
      </p>
      <form onSubmit={(event) => void unlock(event)} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          minLength={12}
          autoComplete="current-password"
          aria-label="Aurales Sync password"
          placeholder="Aurales Sync password"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-white outline-none focus:border-white/30"
        />
        <button
          type="submit"
          disabled={busy || password.length < 12}
          className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40"
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      {message && <p role="status" className="mt-3 text-xs text-white/60">{message}</p>}
    </div>
  )
}
