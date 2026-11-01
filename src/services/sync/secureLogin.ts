import { invoke } from '@tauri-apps/api/core'

function hasTauriBridge(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }

/** Password persistence uses the native OS keyring. Browser storage deliberately
 * does not retain the account password or vault-unlock secret. */
export function syncPasswordPersistenceAvailable(): boolean { return hasTauriBridge() }

export async function saveSyncPassword(email: string, password: string): Promise<void> {
  if (!hasTauriBridge()) return
  await invoke('sync_password_store', { email, password })
}
export async function loadSyncPassword(email: string): Promise<string | null> {
  if (!hasTauriBridge()) return null
  return invoke<string | null>('sync_password_load', { email })
}
export async function deleteSyncPassword(email: string): Promise<void> {
  if (!hasTauriBridge()) return
  await invoke('sync_password_delete', { email })
}

/** A keyring failure must not undo a successful server login. The password
 * remains in memory only and the user can unlock the vault again after restart. */
export async function trySaveSyncPassword(email: string, password: string): Promise<boolean> {
  try { await saveSyncPassword(email, password); return true }
  catch { return false }
}
