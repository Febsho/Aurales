import { enqueueSyncRecord } from './auralesSync'

const VAULT_ID = 'global-settings-v1'
const ITERATIONS = 600_000
let vaultPassphrase: string | null = null

export interface EncryptedVault {
  algorithm: 'AES-GCM'
  kdf: 'PBKDF2-SHA-256'
  iterations: number
  salt: string
  iv: string
  ciphertext: string
}

const excluded = (key: string) => key.startsWith('aurales_sync_')
  || key.includes(':profile:')
  || key.includes('cache')
  || key.includes('snapshot')
  || key.includes('prepared_stream')
  || key.includes('temporary_stream')

const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const bufferSource = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
async function vaultKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bufferSource(salt), iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Keeps the passphrase only in memory; it is never written to local or remote storage. */
export function unlockSyncVault(passphrase: string): void {
  if (passphrase.length < 12) throw new Error('Use a vault passphrase of at least 12 characters.')
  vaultPassphrase = passphrase
}
export function isSyncVaultUnlocked(): boolean { return Boolean(vaultPassphrase) }
export function lockSyncVault(): void { vaultPassphrase = null }
export function vaultSettingCount(): number { return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => Boolean(key && !excluded(key))).length }

export async function queueEncryptedVault(): Promise<number> {
  if (!vaultPassphrase) throw new Error('Unlock the encrypted vault first.')
  const entries: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key && !excluded(key)) entries[key] = localStorage.getItem(key) || ''
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferSource(iv) }, await vaultKey(vaultPassphrase, salt), new TextEncoder().encode(JSON.stringify(entries)))
  const payload: EncryptedVault = { algorithm: 'AES-GCM', kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) }
  enqueueSyncRecord('encrypted-vault', VAULT_ID, payload, '00000000-0000-0000-0000-000000000000')
  return Object.keys(entries).length
}

/** Applies only a vault encrypted with the passphrase currently in memory. */
export async function restoreEncryptedVault(payload: EncryptedVault): Promise<number> {
  if (!vaultPassphrase) throw new Error('Enter the vault passphrase to restore encrypted settings.')
  if (payload.algorithm !== 'AES-GCM' || payload.kdf !== 'PBKDF2-SHA-256' || !payload.salt || !payload.iv || !payload.ciphertext) throw new Error('Unsupported encrypted vault format.')
  const key = await vaultKey(vaultPassphrase, base64ToBytes(payload.salt))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferSource(base64ToBytes(payload.iv)) }, key, bufferSource(base64ToBytes(payload.ciphertext)))
  const entries = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid encrypted vault contents.')
  let restored = 0
  for (const [name, value] of Object.entries(entries)) {
    if (!excluded(name) && typeof value === 'string') { localStorage.setItem(name, value); restored += 1 }
  }
  return restored
}
