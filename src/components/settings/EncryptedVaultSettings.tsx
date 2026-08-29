import { useState } from 'react'
import { isSyncVaultUnlocked, queueEncryptedVault, unlockSyncVault, vaultSettingCount } from '../../services/sync/encryptedVault'
import { syncNow } from '../../services/sync/auralesSync'

export default function EncryptedVaultSettings({ connected, onMessage }: { connected: boolean; onMessage: (message: string) => void }) {
  const [passphrase, setPassphrase] = useState('')
  const unlock = () => {
    try { unlockSyncVault(passphrase); setPassphrase(''); onMessage('Encrypted vault unlocked for this session') }
    catch (error) { onMessage(error instanceof Error ? error.message : 'Could not unlock vault') }
  }
  const backup = async () => {
    try {
      if (!isSyncVaultUnlocked()) unlock()
      if (!isSyncVaultUnlocked()) return
      const count = await queueEncryptedVault()
      if (!connected) { onMessage(`Encrypted ${count} settings; sign in before syncing them`); return }
      await syncNow()
      onMessage(`Encrypted and synced ${count} connected-account settings`)
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Could not back up connected accounts') }
  }
  return <div className="rounded-2xl border border-amber-200/10 bg-amber-100/[.03] p-4"><h3 className="font-medium text-white">Encrypted connected accounts vault</h3><p className="mt-1 text-sm text-white/55">Backs up Trakt, SIMKL, AniList, Stremio, API keys, addon setup, and global settings with a passphrase only you know. The server receives ciphertext only.</p><div className="mt-3 flex flex-wrap items-center gap-2"><input value={passphrase} onChange={(event) => setPassphrase(event.target.value)} type="password" minLength={12} placeholder={isSyncVaultUnlocked() ? 'Vault unlocked for this session' : 'Vault passphrase (12+ characters)'} className="min-w-60 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30" /><button onClick={unlock} className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80">Unlock</button><button onClick={() => void backup()} className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80">Back up accounts</button></div><p className="mt-2 text-xs text-white/40">{vaultSettingCount()} durable global settings will be encrypted. On a new device, enter the same passphrase, then press Sync Now to restore them.</p></div>
}
