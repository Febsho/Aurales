import { isSyncVaultUnlocked } from '../../services/sync/encryptedVault'

export default function EncryptedVaultSettings({ connected }: { connected: boolean }) {
  const status = !connected ? 'Sign in to enable automatic account sync.' : isSyncVaultUnlocked() ? 'Connected accounts, settings, and API keys sync automatically.' : 'Secure session is being restored automatically.'
  return <p className="text-xs text-white/45">{status}</p>
}
