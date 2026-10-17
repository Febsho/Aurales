import { invoke } from '@tauri-apps/api/core'

function hasTauriBridge(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }

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
