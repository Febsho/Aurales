import { isSyncVaultUnlocked, queueEncryptedVault, vaultSettingCount } from '../../services/sync/encryptedVault'
import { syncNow } from '../../services/sync/auralesSync'

export default function EncryptedVaultSettings({ connected, onMessage }: { connected: boolean; onMessage: (message: string) => void }) {
  const backup = async () => {
    try {
      if (!isSyncVaultUnlocked()) { onMessage('Sign in with your Sync email and password to unlock connected-account backup.'); return }
      const count = await queueEncryptedVault()
      if (!connected) { onMessage(`Encrypted ${count} settings; sign in before syncing them`); return }
      await syncNow()
      onMessage(`Encrypted and synced ${count} connected-account settings`)
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Could not back up connected accounts') }
  }
  return <div className="rounded-2xl border border-amber-200/10 bg-amber-100/[.03] p-4"><h3 className="font-medium text-white">Encrypted connected accounts</h3><p className="mt-1 text-sm text-white/55">Backs up Trakt, SIMKL, AniList, Stremio, API keys, addon setup, and global settings. It uses your Sync account password as the encryption key, so there is no separate passphrase.</p><div className="mt-3 flex flex-wrap items-center gap-2"><button onClick={() => void backup()} className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/80">Back up connected accounts</button><span className="text-xs text-white/45">{isSyncVaultUnlocked() ? 'Unlocked for this session' : 'Sign in with email and password to unlock'}</span></div><p className="mt-2 text-xs text-white/40">{vaultSettingCount()} durable global settings will be encrypted. On a new device, sign in with the same email and password, then press Sync Now to restore them.</p></div>
}
